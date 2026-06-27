// Shared RAG core: embeddings, retrieval, prompt assembly, streaming chat.
// Used by ask.mjs (CLI), server.mjs (HTTP), and eval.mjs (quality check).
import { readFileSync } from 'node:fs';
import { OLLAMA, GEN_MODEL, EMBED_MODEL, EMBEDDED, TOP_K, REF_BASE, NUM_CTX, EMBED_ON_CPU, THINK } from './config.mjs';

let _chunks = null;
export function chunks() {
    if (!_chunks) _chunks = JSON.parse(readFileSync(EMBEDDED, 'utf8'));
    return _chunks;
}

export async function embed(text) {
    const r = await fetch(`${OLLAMA}/api/embed`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: text, ...(EMBED_ON_CPU ? { options: { num_gpu: 0 } } : {}) }),
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

// Deterministic "see also" links built from the retrieved chunks (never from the
// model — it would mangle/hallucinate URLs). Maps each symbol's kind to the
// reference deep-link contract (#function:/#type:/#enum:/#macro:/#constant:),
// routes methods to their owner-type page, and examples to the player.
const HASH_KIND = { func: 'function', type: 'type', enum: 'enum', macro: 'macro', var: 'constant' };
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
export const PRIMER = [
    'TrussC core conventions (always apply):',
    '- Namespace tc (alias of trussc) and tcx. User code does `using namespace std; using namespace tc;`, so omit tc:: and std:: prefixes.',
    '- Angles are in radians; use TAU (= 2*PI) for a full turn, not PI.',
    '- Colors are 0.0–1.0 floats, not 0–255.',
    '- An app is 3 files (main.cpp, tcApp.h, tcApp.cpp): subclass the app and override setup() / update() / draw() and input callbacks (mousePressed, keyPressed, …).',
    '- Include the framework with <TrussC.h>.',
].join('\n');

export const SYSTEM = [
    'You are the TrussC documentation assistant for beginners.',
    'TrussC is a lightweight C++ creative-coding framework (openFrameworks-like, built on sokol).',
    'Answer ONLY from the provided context and the core conventions. If the context does not cover the question, say you are not sure instead of guessing.',
    'Keep it short (1–3 sentences). Name the relevant API(s) by their exact name (e.g. drawRect, Color::fromOKLab) and point to the reference or an example.',
    'A short code example is welcome when it helps. BUT every function, method, type, enum value, and parameter you mention — in prose OR code — MUST appear in the provided context. Never introduce or guess an API that is not shown; if you are not sure it exists, do not use it (describe it in words instead).',
    'Do NOT invent links, URLs, or anchors.',
    "Reply in the user's language (a Japanese question gets a Japanese answer).",
].join(' ');

// Assemble the chat messages. The system message carries the constant rules +
// primer; prior turns (plain Q/A text) give conversational memory so follow-ups
// like "then how do I connect by device name?" resolve; only the CURRENT turn
// carries the freshly-retrieved context (keeps history compact).
export function buildMessages(question, retrieved, history = []) {
    const context = retrieved.map((c) => c.text).join('\n\n---\n\n');
    const sys = `${SYSTEM}\n\n${PRIMER}`;
    const user = `Context:\n\n${context}\n\n---\n\nQuestion: ${question}`;
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: user }];
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

// Stream the assistant's answer token-by-token (async generator of text deltas).
export async function* chatStream(messages) {
    const r = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: GEN_MODEL, think: THINK, stream: true, messages, options: { num_ctx: NUM_CTX } }),
    });
    if (!r.ok) throw new Error(`chat ${r.status}: ${await r.text()}`);
    for await (const line of streamLines(r.body)) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (j.message?.content) yield j.message.content;
    }
}

async function collect(stream) { let s = ''; for await (const d of stream) s += d; return s; }

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

// Retrieve → draft (think:false, ~1s) → deterministic check → corrective pass ONLY
// when a fabricated API is detected (verifier is ground-truth membership, not an
// LLM, so the common clean case stays single-pass). History enables follow-ups.
// Returns { retrieved, links, text, corrected }.
export async function answer(question, history = [], k = TOP_K) {
    const recentUser = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
    const retrieved = await retrieve([...recentUser, question].join('\n'), k);
    const links = buildLinks(retrieved);
    const messages = buildMessages(question, retrieved, history);

    let text = await collect(chatStream(messages));
    let corrected = false;
    const bad = findFabrications(text);
    if (bad.size) {
        corrected = true;
        const notes = [...bad.entries()].map(([owner, members]) => {
            const wrong = [...members].map((m) => `${owner}::${m}`).join(', ');
            const valid = validMembersOf(owner);
            return valid.length ? `- ${wrong} do not exist. Real ${owner} members: ${valid.join(', ')}.`
                                : `- ${wrong} do not exist (${owner} has no such member).`;
        }).join('\n');
        const fix = [...messages,
            { role: 'assistant', content: text },
            { role: 'user', content: `Your previous answer used APIs that do NOT exist in TrussC:\n${notes}\nRewrite it using only real APIs from the context — remove or replace the invalid references. Keep it short and in the same language.` }];
        text = await collect(chatStream(fix));
    }
    return { retrieved, links, text, corrected };
}
