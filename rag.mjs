// Shared RAG core: embeddings, retrieval, prompt assembly, streaming chat.
// Used by ask.mjs (CLI), server.mjs (HTTP), and eval.mjs (quality check).
import { readFileSync } from 'node:fs';
import { OLLAMA, GEN_MODEL, EMBED_MODEL, EMBEDDED, TOP_K, REF_BASE, NUM_CTX, EMBED_ON_CPU, THINK, KEEP_ALIVE, GEN_BACKEND, ANTHROPIC_KEY, ANTHROPIC_MODEL } from './config.mjs';

let _chunks = null;
export function chunks() {
    if (!_chunks) _chunks = JSON.parse(readFileSync(EMBEDDED, 'utf8'));
    return _chunks;
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

export async function retrieve(question, k = TOP_K) {
    const qv = await embed(question);
    return chunks()
        .map((c) => ({ ...c, score: cosine(qv, c.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
}

// Multi-query retrieval: embed several query variants and score each chunk by its
// BEST similarity across them (max-pool). A chunk that matches ANY variant surfaces,
// so a casual query + a keyword-expanded query together find the right chunks.
// The original query is always one of the variants (anchor + best for already-good
// queries). Diagnosis: "おとをならすには？" alone retrieves Node noise; adding the
// expansion "音を鳴らす sound play beep" pulls in the real Sound API.
export async function retrieveMulti(queries, k = TOP_K) {
    const qs = [...new Set(queries.map((q) => (q || '').trim()).filter(Boolean))];
    if (qs.length <= 1) return retrieve(qs[0] || '', k);
    const vecs = await Promise.all(qs.map((q) => embed(q)));
    return chunks()
        .map((c) => {
            let best = -1;
            for (const v of vecs) { const s = cosine(v, c.vector); if (s > best) best = s; }
            return { ...c, score: best };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
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
    if (c.source !== 'reference') return null;       // concept chunks have no symbol page
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
].join(' ');

// Assemble the chat messages. The system message carries the constant rules +
// primer; prior turns (plain Q/A text) give conversational memory so follow-ups
// like "then how do I connect by device name?" resolve; only the CURRENT turn
// carries the freshly-retrieved context (keeps history compact).
export function buildMessages(question, retrieved, history = [], pageName = null) {
    const context = retrieved.map((c) => c.text).join('\n\n---\n\n');
    const sys = `${SYSTEM}\n\n${PRIMER}`;
    // Page context: the symbol the user is currently looking at. Only use it when the
    // question is referential ("this" / "explain this") — otherwise ignore it.
    const note = pageName
        ? `The user is currently viewing the reference page for \`${pageName}\`. If their question is referential ("this", "it", "explain this", "これ", "それ") without naming a specific API, assume it refers to ${pageName}. If the question names or is about something else, ignore this note. Answer directly — do not mention this note or that the question was "referential".\n\n`
        : '';
    const user = `${note}Context:\n\n${context}\n\n---\n\nQuestion: ${question}`;
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
async function* anthropicStream(messages, maxTokens = 1024) {
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

// Retrieve with conversational memory (last 2 user turns sharpen the query), then
// assemble the prompt. Shared by answer() and answerStream().
async function prep(question, history, k, page) {
    const recentUser = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
    const base = [...recentUser, question].join('\n');
    const expanded = await expandQuery(question);   // keyword-rich variant (English API terms)
    const retrieved = await retrieveMulti([base, expanded], k);
    // Force-include the chunk for the page the user is viewing (so "explain this"
    // has the actual symbol), unless retrieval already surfaced it.
    const pc = pageChunk(page);
    if (pc && !retrieved.some((c) => c.id === pc.id)) retrieved.unshift({ ...pc, score: 1 });
    return { retrieved, links: buildLinks(retrieved), messages: buildMessages(question, retrieved, history, pc ? pc.title : null) };
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
export async function answer(question, history = [], page = null, k = TOP_K) {
    const { retrieved, links, messages } = await prep(question, history, k, page);
    let text = await collect(chatStream(messages));
    let corrected = false;
    const bad = findFabrications(text);
    if (bad.size) {
        corrected = true;
        text = await collect(chatStream(correctionMessages(messages, text, bad)));
    }
    return { retrieved, links, text: resolveLinks(text), corrected };
}

// Streaming variant for the widget. Yields events:
//   { type:'meta', retrieved, links }   once, up front
//   { type:'delta', text }              per token chunk (append on the client)
//   { type:'replace', text }            ONLY if the check caught a fabrication →
//                                       the client swaps the whole bubble for the fix
//   { type:'final', text, corrected }   once, at the end (for logging)
// The draft streams live; the (rare) correction can't stream because the check needs
// the full draft first — so it's delivered as a single whole-text replace.
export async function* answerStream(question, history = [], page = null, k = TOP_K) {
    const { retrieved, links, messages } = await prep(question, history, k, page);
    yield { type: 'meta', retrieved, links };

    let text = '';
    for await (const d of chatStream(messages)) { text += d; yield { type: 'delta', text: d }; }

    const bad = findFabrications(text);
    if (bad.size) {
        text = resolveLinks(await collect(chatStream(correctionMessages(messages, text, bad))));
        yield { type: 'replace', text };   // fabrication fix (also link-resolved)
    } else {
        const resolved = resolveLinks(text);
        if (resolved !== text) { text = resolved; yield { type: 'replace', text }; }  // had tags/URLs → swap to resolved
    }
    yield { type: 'final', text, corrected: bad.size > 0 };
}
