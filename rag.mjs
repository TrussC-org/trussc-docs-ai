// Shared RAG core: embeddings, retrieval, prompt assembly, streaming chat.
// Used by ask.mjs (CLI), server.mjs (HTTP), and eval.mjs (quality check).
import { readFileSync } from 'node:fs';
import { OLLAMA, GEN_MODEL, EMBED_MODEL, EMBEDDED, TOP_K, REF_BASE, NUM_CTX, EMBED_ON_CPU } from './config.mjs';

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
    'Keep it SHORT — 1 to 3 sentences. Style: "there is X — see the reference/example for details". Name the relevant API(s) by exact name (e.g. drawRect, Color::fromOKLab) or the example name.',
    'Include AT MOST one tiny code snippet (1–3 lines) and only when it truly helps; usually none. Do NOT paste full signatures or long examples.',
    'Do NOT invent links, URLs, anchors, function names, or signatures that are not in the context.',
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
        body: JSON.stringify({ model: GEN_MODEL, think: false, stream: true, messages, options: { num_ctx: NUM_CTX } }),
    });
    if (!r.ok) throw new Error(`chat ${r.status}: ${await r.text()}`);
    for await (const line of streamLines(r.body)) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (j.message?.content) yield j.message.content;
    }
}

// Retrieve + answer, with optional conversation history for follow-up chains.
// Retrieval uses the last couple of user turns + the new question, so a terse
// follow-up ("…by a specific device name?") still pulls the right topic (serial).
// Returns { retrieved, links, stream }.
export async function ask(question, history = [], k = TOP_K) {
    const recentUser = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
    const query = [...recentUser, question].join('\n');
    const retrieved = await retrieve(query, k);
    return { retrieved, links: buildLinks(retrieved), stream: chatStream(buildMessages(question, retrieved, history)) };
}
