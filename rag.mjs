// Shared RAG core: embeddings, retrieval, prompt assembly, streaming chat.
// Used by ask.mjs (CLI), server.mjs (HTTP), and eval.mjs (quality check).
import { readFileSync } from 'node:fs';
import { OLLAMA, GEN_MODEL, EMBED_MODEL, EMBEDDED, TOP_K, EXAMPLE_K, ADDON_K, PIN_K, REF_BASE, NUM_CTX, EMBED_ON_CPU, THINK, KEEP_ALIVE, GEN_BACKEND, ANTHROPIC_KEY, ANTHROPIC_MODEL } from './config.mjs';

let _chunks = null;
export function chunks() {
    if (!_chunks) _chunks = JSON.parse(readFileSync(EMBEDDED, 'utf8'));
    return _chunks;
}

// id → chunk lookup (lazy), for resolving carried-over "pinned" ids into context.
let _byId = null;
function chunkById(id) {
    if (!_byId) { _byId = new Map(); for (const c of chunks()) _byId.set(c.id, c); }
    return _byId.get(id) || null;
}

export async function embed(text) {
    const r = await fetch(`${OLLAMA}/api/embed`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: text, keep_alive: KEEP_ALIVE, ...(EMBED_ON_CPU ? { options: { num_gpu: 0 } } : {}) }),
    });
    if (!r.ok) throw new Error(`embed ${r.status}: ${await r.text()}`);
    return (await r.json()).embeddings[0];
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// A chunk owns a BUNDLE of vectors (combined text + per-file slices for examples).
// Its score = best cosine across (every query variant × every chunk vector): the
// chunk surfaces if ANY of its vectors matches ANY query. (Legacy single-vector
// chunks are tolerated via the c.vector fallback.)
function bundleScore(qvecs, c) {
    let best = -1;
    const vs = c.vectors || (c.vector ? [c.vector] : []);
    for (const qv of qvecs) for (const cv of vs) { const s = cosine(qv, cv); if (s > best) best = s; }
    return best;
}

// Per-source quota fill. examples (multi-file, one chunk = a whole example) and addon
// READMEs each get their own small cap so they can't crowd out the hand-written
// concept/reference chunks on a generic query; everything else shares otherK. Within
// each bucket, by score. Input must be score-sorted desc.
function fillQuota(sorted, otherK, exampleK, addonK) {
    const out = [];
    let ex = 0, ad = 0, other = 0;
    for (const c of sorted) {
        if (c.source === 'example') { if (ex >= exampleK) continue; ex++; }
        else if (c.source === 'addon') { if (ad >= addonK) continue; ad++; }
        else { if (other >= otherK) continue; other++; }
        out.push(c);
        if (ex >= exampleK && ad >= addonK && other >= otherK) break;
    }
    return out;
}

export async function retrieve(question, k = TOP_K) {
    return retrieveMulti([question], k);
}

// Multi-query retrieval: embed several query variants and score each chunk by its
// BEST similarity across them (max-pool over variants AND the chunk's own vector
// bundle). A chunk that matches ANY variant surfaces, so a casual query + a
// keyword-expanded query together find the right chunks. Diagnosis: "おとをならすには？"
// alone retrieves Node noise; adding "音を鳴らす sound play beep" pulls in the real
// Sound API. Result is then quota-filled (otherK non-example + exampleK examples).
export async function retrieveMulti(queries, k = TOP_K) {
    const qs = [...new Set(queries.map((q) => (q || '').trim()).filter(Boolean))];
    const vecs = await Promise.all((qs.length ? qs : ['']).map((q) => embed(q)));
    const sorted = chunks()
        .map((c) => ({ ...c, score: bundleScore(vecs, c) }))
        .sort((a, b) => b.score - a.score);
    return fillQuota(sorted, k, EXAMPLE_K, ADDON_K);
}

// Deterministic "see also" links built from the retrieved chunks (never from the
// model — it would mangle/hallucinate URLs). Maps each symbol's kind to the
// reference deep-link contract (#function:/#type:/#enum:/#macro:/#constant:),
// routes methods to their owner-type page, and examples to the player.
// meta.kind from build-chunks is 'function'/'type'/'enum'/'macro'/'var' — map each
// to its reference deep-link prefix. (Both 'function' and legacy 'func' / 'var' and
// 'constant' are accepted so a key mismatch never silently drops links.)
const HASH_KIND = { function: 'function', func: 'function', type: 'type', enum: 'enum', macro: 'macro', var: 'constant', constant: 'constant' };
export function refLink(c) {
    if (c.source === 'example') {
        const name = c.id.replace(/^example:/, '');
        const group = c.meta?.group || '';
        return `${REF_BASE}/examples/player.html?type=examples&group=${encodeURIComponent(group)}&name=${encodeURIComponent(name)}`;
    }
    if (c.source === 'addon') return c.meta?.url || `${REF_BASE}/addons/`;   // addon repo, else the catalog
    if (c.source !== 'reference') return null;       // concept/doc chunks have no symbol page
    const m = c.meta || {};
    if (m.owner) return `${REF_BASE}/reference/#type:${m.owner}`;   // any member (method/static/field) → its type page
    const hk = HASH_KIND[m.kind];
    return hk ? `${REF_BASE}/reference/#${hk}:${c.title}` : null;
}

// Top-N distinct reference/example links from the retrieved set, ranked by score.
export function buildLinks(retrieved, max = 3) {
    const out = [], seen = new Set();
    for (const c of retrieved) {
        const url = refLink(c);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push({ label: c.title.replace(/ \(example\)$/, ''), url, source: c.source });
        if (out.length >= max) break;
    }
    return out;
}

// Always-on primer: the few rules every answer must respect, injected regardless
// of retrieval. Cheap and high-value — stops the model from suggesting PI / 0-255
// colors / std:: even when the relevant chunk didn't surface ("memorize the core,
// look up the details").
export const PRIMER = `TrussC core conventions (always apply):
- Namespace tc (alias trussc) and tcx; user code does \`using namespace std; using namespace tc;\` — omit tc:: / std::.
- Angles in radians; use TAU (=2*PI) for a full turn, not PI.
- Colors are 0.0–1.0 floats, not 0–255.
- An app is 3 files (main.cpp, tcApp.h, tcApp.cpp): subclass App, override setup()/update()/draw() and input callbacks.
- Include with <TrussC.h>.

Common how-to — compose these primitives; if there is no direct API for something, BUILD it from these rather than inventing a function:
- Draw in draw(); clear(0.1f) wipes the frame; setColor(r,g,b) (0–1) or colors::name before a shape.
- Shapes: drawRect(x,y,w,h), drawCircle(x,y,r), drawEllipse, drawArc(x,y,r,angBegin,angEnd), drawTriangle. Thin 1px line: drawLine; thick: drawStroke (setStrokeWeight). Free-form filled polygon: beginShape()/vertex()/endShape(true). Thick path: beginStroke()/vertex()/endStroke(). Concave/holed fills or glyph outlines: Path + Path::drawFill().
- fill()/noFill() affect beginShape, NOT beginStroke (a stroke has no fill).
- Color: Color::fromHex/fromBytes/fromHSB/fromOKLCH; c1.lerp(c2,t) is perceptual (OKLab). For a gradient, lerp colors across position/time — there is no single "gradient fill" call.
- Transforms: pushMatrix(); translate(x,y); rotate(TAU*0.25); scale(2); ...; popMatrix().
- Text: drawBitmapString("hi",x,y) (built-in, UTF-8) or Font f; f.load("font.ttf",24); f.drawString(...). Default align is left/baseline — call setTextAlign(Direction::Center, Direction::Center) before drawing to center (bitmap & Font).
- Images: Image img; img.load("file.png") (from bin/data/); img.draw(x,y) or img.draw(x,y,w,h).
- Input: override App mousePressed(Vec2,int)/mouseDragged/keyPressed(int), or the rich form onMousePress(const MouseEventArgs& e) -> e.pos / e.globalPos / e.button. Poll with getMousePos()/getMouseX()/getMouseY().
- Scene graph: App is the root; make_shared<RectNode>(), setSize/setPos, enableEvents() (required for mouse), addChild(). In a Node subclass override onMousePress(Vec2 local,int){ return true; } to consume. Remove with destroy() (deferred, safe during iteration).
- Time/animation: animate in update() via getElapsedTime() (seconds). Delay/repeat: callAfter(sec,fn) / callEvery(sec,fn).
- 3D: the space is 3D perspective by default. EasyCam cam; cam.begin(); drawBox(size)/drawSphere(r); cam.end(). 2D drawn after 3D can hide behind it (z=0, depth-tested); for pure 2D use setupScreenOrtho().
- Which API: sound -> beep() or Sound; video -> VideoPlayer; webcam -> VideoGrabber; random/noise -> random()/noise(); save image -> Image::save(); screenshot -> saveScreenshot(); JSON -> loadJson()/saveJson(); quit -> requestExitApp() (cancellable) / exitApp(); window -> setWindowTitle()/setFullscreen().

Major classes (use the right one; if a name is not here or in the context, do not assume it exists):
- App & scene graph: App, Node, RectNode, RectNodeButton, ScrollContainer, Mod, Tween / TweenMod
- Math: Vec2, Vec3, Vec4, Mat4, Quaternion, Rect, Ray
- Color: Color, ColorHSB, ColorOKLCH, ColorOKLab
- Drawing & text: Path, Font, Pixels
- GPU: Image, Texture, Fbo, Shader, Mesh, Material, Light
- 3D camera: EasyCam
- Sound: Sound, SoundBuffer, AudioEngine, MicInput
- Video: VideoPlayer, VideoGrabber, VideoWriter
- Events: Event<T> / EventListener (+ per-kind args: MouseEventArgs, MouseMoveEventArgs, KeyEventArgs, ...)
- Data & IO: Xml, Serial, FileReader, FileWriter (JSON via loadJson/saveJson)
- Network: TcpClient, TcpServer, UdpSocket (OSC via the tcxOsc addon)
- Threading: Thread, ThreadChannel`;

export const SYSTEM = [
    'You are the TrussC documentation assistant for beginners.',
    'TrussC is a lightweight C++ creative-coding framework (openFrameworks-like, built on sokol).',
    'Answer ONLY from the provided context and the core conventions. If the context does not cover the question, say you are not sure instead of guessing.',
    'Keep it short (1–3 sentences). Name the relevant API(s) by their exact name (e.g. drawRect, Color::fromOKLab) and point to the reference or an example.',
    'A short code example is welcome when it helps. BUT every function, method, type, enum value, and parameter you mention — in prose OR code — MUST appear in the provided context. Never introduce or guess an API that is not shown; if you are not sure it exists, do not use it (describe it in words instead).',
    'When a task needs several APIs working together (e.g. a shape that follows the mouse, or animating a value over time), briefly SKETCH how they fit together — just the few essential lines (e.g. inside draw()), NOT a full runnable program. Name the APIs and show the key calls; keep it short. Use only APIs present in the context.',
    'Format your answer in Markdown: inline code in `backticks`, code in ```cpp fenced blocks```. Do not write HTML tags (no <code>, <kbd>, <br>, etc.).',
    // Links: the model only marks intent with a tag; we resolve it to the real URL.
    'To link to an API, wrap its EXACT name in double brackets like [[drawCircle]] — we turn it into the correct link for you. NEVER write a raw URL or a normal markdown link [..](..): any URL you write is wrong (you cannot know the real paths).',
    // Keep technical terms in their real (English/Latin) form — also stops multilingual bleed.
    "Write technical terms, API names, parameters, and code identifiers in their original English (Latin) form — do NOT transliterate them into katakana or other scripts (write `alpha`, not `アルファ`). Only the surrounding explanation is in the user's language; do not let other languages bleed in.",
    // Graduated confidence: answer outright when sure; offer one line / ask back when not.
    'Confidence: when you are clearly sure (~70%+), answer with the single best API and add no alternatives. When two valid approaches are roughly balanced (~60/40), answer with the best one and add ONE short final line offering the other (e.g. "there is also a simpler beep() if you do not want a sound file"). If the request is too vague or hard to answer well, do NOT guess — ask one short clarifying question instead. If it asks for a very advanced feature, first ask whether a simpler approach is acceptable. If there are many possible implementations, ask what they specifically want to do first.',
    "Reply in the user's language (a Japanese question gets a Japanese answer).",
    'Tone: talk like a friendly coder buddy, not a manual. In Japanese use casual plain form (タメ口: 〜だよ／〜できる／〜してみて), warm and human. When it fits, open with a small reaction (「お、それなら簡単だよ」「いいね」). Avoid stiff textbook phrasing like 「〜に対応しています」「〜を使用します」; say 「〜できるよ」「〜を使えばOK」 instead. Still concise, and do not overdo it (no emoji spam, not over-familiar). For other languages, use the equivalent relaxed, friendly register.',
].join(' ');

// Importance trail, appended to the END of the user message (most salient spot for
// format compliance — Haiku was dropping it when it sat mid-system, before PRIMER).
// Each context chunk is tagged [#id]; the model echoes the ids it relied on so the
// client can carry them across turns. We strip this line before showing the answer.
const USED_INSTRUCTION = 'After your whole answer, add ONE final line on its own, exactly: `@@USED: id1, id2, ...` — the [#id] tags of the context chunks you actually relied on, especially any worth keeping for later turns in this conversation. Use the exact ids from the [#...] tags; if none, write `@@USED:` alone. This line is internal bookkeeping, never prose, and must be the very last line.';

// Assemble the chat messages. The system message carries the constant rules +
// primer; prior turns (plain Q/A text) give conversational memory so follow-ups
// like "then how do I connect by device name?" resolve; only the CURRENT turn
// carries the freshly-retrieved context (keeps history compact).
export function buildMessages(question, retrieved, history = [], pageName = null) {
    // Tag each chunk with its [#id] so the model can cite which ones it used (the
    // @@USED trail). The tag is stripped from the corpus text the user never sees.
    const context = retrieved.map((c) => `[#${c.id}]\n${c.text}`).join('\n\n---\n\n');
    const sys = `${SYSTEM}\n\n${PRIMER}`;
    // Page context: the symbol the user is currently looking at. Only use it when the
    // question is referential ("this" / "explain this") — otherwise ignore it.
    const note = pageName
        ? `The user is currently viewing the reference page for \`${pageName}\`. If their question is referential ("this", "it", "explain this", "これ", "それ") without naming a specific API, assume it refers to ${pageName}. If the question names or is about something else, ignore this note. Answer directly — do not mention this note or that the question was "referential".\n\n`
        : '';
    const user = `${note}Context:\n\n${context}\n\n---\n\nQuestion: ${question}\n\n---\n${USED_INSTRUCTION}`;
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: user }];
}

// The corpus chunk for the symbol the user is viewing (a "kind:name" page hint,
// e.g. "type:Node"). Used to force-include it in the context — no new corpus chunk.
function pageChunk(page) {
    if (!page || typeof page !== 'string') return null;
    const name = page.includes(':') ? page.slice(page.indexOf(':') + 1) : page;
    if (!name) return null;
    return chunks().find((c) => c.source === 'reference' && c.title === name) || null;
}

async function* streamLines(stream) {
    const dec = new TextDecoder();
    let buf = '';
    for await (const part of stream) {
        buf += dec.decode(part, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) { yield buf.slice(0, nl); buf = buf.slice(nl + 1); }
    }
    if (buf) yield buf;
}

// Hosted Claude (Anthropic Messages API) streaming. Same text-delta contract as the
// Ollama path. Anthropic takes the system prompt top-level (not as a message role),
// so split it out of our messages array. Embeddings are unaffected (still bge-m3).
async function* anthropicStream(messages, maxTokens = 1536) {   // headroom so the @@USED trail isn't truncated on long answers
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const msgs = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: msgs, stream: true }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);
    for await (const line of streamLines(r.body)) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.type === 'content_block_delta' && j.delta?.text) yield j.delta.text;
    }
}

// Stream the assistant's answer token-by-token (async generator of text deltas).
// Dispatches to the configured backend; the rest of the pipeline is identical.
export async function* chatStream(messages) {
    if (GEN_BACKEND === 'anthropic') { yield* anthropicStream(messages); return; }
    const r = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: GEN_MODEL, think: THINK, stream: true, messages, keep_alive: KEEP_ALIVE, options: { num_ctx: NUM_CTX } }),
    });
    if (!r.ok) throw new Error(`chat ${r.status}: ${await r.text()}`);
    for await (const line of streamLines(r.body)) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (j.message?.content) yield j.message.content;
    }
}

async function collect(stream) { let s = ''; for await (const d of stream) s += d; return s; }

// One-shot, non-streaming generation with thinking off — for tiny fast side-calls
// (query expansion). Small num_ctx + capped num_predict keep it ~0.3–0.6s.
async function genQuick(messages, numPredict = 64) {
    if (GEN_BACKEND === 'anthropic') return collect(anthropicStream(messages, numPredict));
    const r = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: GEN_MODEL, think: false, stream: false, messages, keep_alive: KEEP_ALIVE, options: { num_ctx: 2048, num_predict: numPredict } }),
    });
    if (!r.ok) throw new Error(`gen ${r.status}: ${await r.text()}`);
    return (await r.json()).message?.content || '';
}

// Rewrite a casual/short/hiragana question into a keyword-rich search query so it
// matches the (English) reference chunks. Output is one short line; the original
// language words are kept, plus likely English API/domain terms. Best-effort — on
// any error returns '' and the caller falls back to the original query alone.
const EXPAND_SYS = 'You turn a beginner question about the TrussC C++ creative-coding framework (an openFrameworks-like library) into a short search query for a documentation index. Output ONE line of space-separated keywords only — no explanation. Include the likely ENGLISH API names and domain terms (e.g. sound play audio beep; mouse position drawCircle; gradient color lerp), and also keep the key words from the original question. Guess the relevant English terms even if the question is vague.';
export async function expandQuery(question) {
    try {
        const out = await genQuick([{ role: 'system', content: EXPAND_SYS }, { role: 'user', content: question }]);
        return out.replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch { return ''; }
}

// --- Deterministic ground-truth check ---------------------------------------
// The real symbol set, derived from the corpus itself (no extra file needed on
// the server). `types` = names usable before '::' (types + enums); `qualified` =
// known Owner::member (method/static chunk titles + enum values parsed from text).
let _api = null;
function apiIndex() {
    if (_api) return _api;
    const types = new Set(), qualified = new Set();
    for (const c of chunks()) {
        if (c.source !== 'reference') continue;
        const k = c.meta && c.meta.kind;
        if (k === 'type' || k === 'enum') types.add(c.title);
        if (c.title.includes('::')) qualified.add(c.title);
        if (k === 'enum') for (const m of c.text.matchAll(/\b[A-Z][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*\b/g)) qualified.add(m[0]);
    }
    _api = { types, qualified };
    return _api;
}

// Find fabricated APIs: a `Known::member` where the type is real but the member is
// not. High precision — user placeholders (MyClass::foo) are ignored because
// MyClass isn't a known type. Returns Map<owner, Set<badMember>> ({} = clean).
function findFabrications(text) {
    const { types, qualified } = apiIndex();
    const bad = new Map();
    for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const owner = m[1], member = m[2];
        if (types.has(owner) && !qualified.has(`${owner}::${member}`)) {
            if (!bad.has(owner)) bad.set(owner, new Set());
            bad.get(owner).add(member);
        }
    }
    return bad;
}
function validMembersOf(owner) {
    const pre = owner + '::';
    return [...apiIndex().qualified].filter((q) => q.startsWith(pre)).map((q) => q.slice(pre.length));
}

// Retrieve with conversational memory (last 2 user turns sharpen the query), merge
// in the carried-over "pinned" chunks the model flagged on earlier turns, then
// assemble the prompt. Shared by answer() and answerStream().
async function prep(question, history, k, page, pinned = []) {
    const recentUser = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
    const base = [...recentUser, question].join('\n');
    const expanded = await expandQuery(question);   // keyword-rich variant (English API terms)
    const fresh = await retrieveMulti([base, expanded], k);

    // Carried-over importance: resolve the LLM-curated pinned ids (recent-first) to
    // chunks, take the first PIN_K that still exist. They persist across turns so a
    // pronoun follow-up ("can it also do X?") keeps its context even when fresh
    // retrieval drifts to noise.
    const pinnedChunks = [];
    const pinSeen = new Set();
    for (const id of pinned) {
        if (pinnedChunks.length >= PIN_K) break;
        if (pinSeen.has(id)) continue;
        const c = chunkById(id);
        if (c) { pinSeen.add(id); pinnedChunks.push({ ...c, score: 1 }); }
    }

    // The page the user is viewing is the densest, highest-priority context — always
    // first. Then pinned (stable context). Then fresh LAST, so the current-turn hits
    // sit nearest the question (recency) — best when the topic just changed. Fresh
    // ids that duplicate a pinned/page id are dropped (pinned is authoritative; the
    // overlap IS the important stuff, so a smaller total is fine).
    const pc = pageChunk(page);
    const used = new Set();
    const ordered = [];
    const add = (c, extra) => { if (c && !used.has(c.id)) { used.add(c.id); ordered.push(extra ? { ...c, ...extra } : c); } };
    if (pc) add(pc, { score: 1 });
    for (const c of pinnedChunks) add(c);
    for (const c of fresh) add(c);

    // Links favor the freshly-retrieved (real scores) so "詳しくは" stays relevant to
    // the current question, with page/pinned as fallbacks.
    const links = buildLinks([...fresh, ...(pc ? [pc] : []), ...pinnedChunks]);
    return { retrieved: ordered, links, messages: buildMessages(question, ordered, history, pc ? pc.title : null) };
}

// Parse the model's `@@USED:` trail off the end of its answer → { answer, reported }.
const USED_RE = /\n+@@USED:[ \t]*([^\n]*)\s*$/;
function splitUsed(text) {
    const s = String(text);
    const m = s.match(USED_RE);
    if (!m) return { answer: s, reported: [] };
    const reported = m[1].split(',').map((x) => x.trim().replace(/^\[#|\]$/g, '')).filter(Boolean);
    return { answer: s.slice(0, m.index).replace(/\s+$/, ''), reported };
}

// Final carried-forward id set = the model's report ∪ ids whose symbol the answer
// [[linked]] (the user may click/view those), intersected with the ids we actually
// provided this turn (drops fabricated or stale ids).
function usedIdsOf(reported, answer, retrieved) {
    const provided = new Set(retrieved.map((c) => c.id));
    const out = new Set();
    for (const id of reported) if (provided.has(id)) out.add(id);
    const linked = new Set();
    for (const m of String(answer).matchAll(/\[\[\s*["“”']?([^\]]+?)["“”']?\s*\]\]/g)) linked.add(m[1].trim());
    if (linked.size) for (const c of retrieved) {
        if (linked.has(c.title) || linked.has(c.title.replace(/ \(example\)$/, ''))) out.add(c.id);
    }
    return [...out];
}

// Build the corrective follow-up turn from the ground-truth check result.
function correctionMessages(messages, draft, bad) {
    const notes = [...bad.entries()].map(([owner, members]) => {
        const wrong = [...members].map((m) => `${owner}::${m}`).join(', ');
        const valid = validMembersOf(owner);
        return valid.length ? `- ${wrong} do not exist. Real ${owner} members: ${valid.join(', ')}.`
                            : `- ${wrong} do not exist (${owner} has no such member).`;
    }).join('\n');
    return [...messages,
        { role: 'assistant', content: draft },
        { role: 'user', content: `Your previous answer used APIs that do NOT exist in TrussC:\n${notes}\nRewrite it using only real APIs from the context — remove or replace the invalid references. Keep it short and in the same language.` }];
}

// The model must NOT author URLs — it guesses them (e.g. a fake openframeworks.cc
// path). Instead it marks inline links as [[Name]] (wiki-style); we resolve each one
// deterministically: a known reference symbol → its real deep-link as markdown; an
// unknown name → plain text (so a wrong name degrades to text, never a broken link).
// Same spirit as the fabrication check. Name → deep-link index built once (lazy).
let _nameLink = null;
function nameLink(name) {
    if (!_nameLink) {
        _nameLink = new Map();
        for (const c of chunks()) {
            if (c.source !== 'reference') continue;
            const url = refLink(c);
            if (url && !_nameLink.has(c.title)) _nameLink.set(c.title, url);
        }
    }
    return _nameLink.get(name) || null;
}
export function resolveLinks(text) {
    // 1) strip the model's own (untrustworthy) links/URLs first, keeping visible labels
    let t = String(text)
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // [label](url) → label
        .replace(/<?https?:\/\/[^\s>)]+>?/g, '');     // <http://…> or bare URL → drop
    // 2) resolve our [[Name]] wiki-links into real deep-links (strip optional quotes)
    t = t.replace(/\[\[\s*["“”']?([^\]]+?)["“”']?\s*\]\]/g, (_, name) => {
        const n = name.trim();
        const url = nameLink(n);
        return url ? `[${n}](${url})` : n;            // known → markdown link, unknown → plain
    });
    return t.replace(/[ \t]{2,}/g, ' ');             // tidy gaps left behind
}

// Retrieve → draft (think:false, ~1s) → deterministic check → corrective pass ONLY
// when a fabricated API is detected (verifier is ground-truth membership, not an
// LLM, so the common clean case stays single-pass). History enables follow-ups.
// Returns { retrieved, links, text, corrected }. Buffered (used by /ask, CLI).
export async function answer(question, history = [], page = null, pinned = [], k = TOP_K) {
    const { retrieved, links, messages } = await prep(question, history, k, page, pinned);
    let { answer: text, reported } = splitUsed(await collect(chatStream(messages)));
    let corrected = false;
    const bad = findFabrications(text);
    if (bad.size) {
        corrected = true;
        ({ answer: text, reported } = splitUsed(await collect(chatStream(correctionMessages(messages, text, bad)))));
    }
    const usedIds = usedIdsOf(reported, text, retrieved);
    return { retrieved, links, text: resolveLinks(text), corrected, usedIds };
}

// Streaming variant for the widget. Yields events:
//   { type:'meta', retrieved, links }   once, up front
//   { type:'delta', text }              per token chunk (append on the client)
//   { type:'replace', text }            ONLY if the check caught a fabrication →
//                                       the client swaps the whole bubble for the fix
//   { type:'final', text, corrected }   once, at the end (for logging)
// The draft streams live; the (rare) correction can't stream because the check needs
// the full draft first — so it's delivered as a single whole-text replace.
export async function* answerStream(question, history = [], page = null, pinned = [], k = TOP_K) {
    const { retrieved, links, messages } = await prep(question, history, k, page, pinned);
    yield { type: 'meta', retrieved, links };

    // Stream tokens, but hold back the @@USED trail so it never reaches the user. A
    // small tail (MARK.length) is withheld each step so a marker split across deltas
    // is still caught before any of it is shown.
    const MARK = '@@USED:';
    let full = '', shown = '', emitted = 0, cut = -1;
    for await (const d of chatStream(messages)) {
        full += d;
        if (cut >= 0) continue;                  // already past the marker — swallow the rest
        const idx = full.indexOf(MARK);
        if (idx >= 0) {
            const piece = full.slice(emitted, idx).replace(/\s+$/, '');   // last answer bit, sans trailing ws before marker
            if (piece) { shown += piece; yield { type: 'delta', text: piece }; }
            emitted = full.length; cut = idx;
        } else {
            const safe = full.length - MARK.length;
            if (safe > emitted) { const piece = full.slice(emitted, safe); emitted = safe; shown += piece; yield { type: 'delta', text: piece }; }
        }
    }
    if (cut < 0 && emitted < full.length) { const piece = full.slice(emitted); shown += piece; yield { type: 'delta', text: piece }; }

    let { answer: text, reported } = splitUsed(full);
    const bad = findFabrications(text);
    if (bad.size) {
        ({ answer: text, reported } = splitUsed(await collect(chatStream(correctionMessages(messages, text, bad)))));
        text = resolveLinks(text);
        yield { type: 'replace', text };   // fabrication fix (also link-resolved)
    } else {
        const resolved = resolveLinks(text);
        if (resolved !== shown.replace(/\s+$/, '')) { text = resolved; yield { type: 'replace', text }; }  // had tags/URLs/trail → swap to resolved
        else text = resolved;
    }
    const usedIds = usedIdsOf(reported, text, retrieved);
    yield { type: 'final', text, corrected: bad.size > 0, usedIds };
}
