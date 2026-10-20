// Embed every chunk's text with the Ollama embedding model → chunks.embedded.json.
// Run after build-chunks.mjs.
//
// Incremental: the previous chunks.embedded.json doubles as the cache. Each vector
// carries the hash of the text it was made from (chunk.vhash[i]), so an unchanged
// text reuses its old vector and only genuinely new/changed texts hit bge-m3. The
// hash keys on EMBED_MODEL too, so switching models invalidates everything.
// Force a full re-embed with EMBED_FORCE=1.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { OLLAMA, EMBED_MODEL, CHUNKS, EMBEDDED } from './config.mjs';

const BATCH = 16;   // /api/embed takes an array — batch for throughput
const FORCE = process.env.EMBED_FORCE === '1';
// Bound (cache): bge-m3 has a 2,048-token context; Ollama rejects inputs a little over it
// (400) and silently cuts much longer ones. Cut every input to an estimated budget first.
// Overflow is truncated and listed in the summary line.
const TOKEN_BUDGET = Number(process.env.EMBED_TOKEN_BUDGET || 1900);

// Conservative token estimate for bge-m3's XLM-R tokenizer: CJK/kana/hangul ≈ 1 token
// per character, everything else ≈ 2.5 characters per token (code and identifiers
// split finely). Returns the text cut at the budget, or the text itself if it fits.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
function fitBudget(text, budget = TOKEN_BUDGET) {
    let used = 0;
    for (let i = 0; i < text.length; i++) {
        used += CJK.test(text[i]) ? 1 : 0.4;
        if (used > budget) return text.slice(0, i);
    }
    return text;
}

// The hash keys on the budget too, so changing it re-embeds the inputs it affects.
const hashOf = (text) =>
    createHash('sha1').update(`${EMBED_MODEL}\0${TOKEN_BUDGET}\0${text}`).digest('hex').slice(0, 20);

class TooLong extends Error {}
async function embedRaw(texts) {
    const r = await fetch(`${OLLAMA}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    });
    if (r.status === 400) {
        const body = await r.text();
        if (/context length|input length/i.test(body)) throw new TooLong(body);
        throw new Error(`embed 400: ${body}`);
    }
    if (!r.ok) throw new Error(`embed ${r.status}: ${await r.text()}`);
    return (await r.json()).embeddings;
}

// The estimate rarely overshoots. On a length 400, embed that batch one input at a
// time and shorten only the failing input (to 90% each try) until it fits.
async function embedBatch(items) {
    try { return await embedRaw(items.map((f) => f.sent)); } catch (e) { if (!(e instanceof TooLong)) throw e; }
    const out = [];
    for (const f of items) {
        // Bound (cache): at most 20 shortenings (90% each, down to ~12%). Overflow fails the build with the input's id.
        for (let tries = 0; ; tries++) {
            try { out.push((await embedRaw([f.sent]))[0]); break; } catch (e) {
                if (!(e instanceof TooLong) || tries >= 20) throw new Error(`embed ${f.id}: ${e.message}`);
                f.sent = f.sent.slice(0, Math.floor(f.sent.length * 0.9));
                f.truncated = true;
            }
        }
    }
    return out;
}

// Cache: hash → vector, recovered from the previous corpus (skipped without vhash,
// i.e. a corpus written before this scheme — that run just re-embeds everything).
const cache = new Map();
if (!FORCE && existsSync(EMBEDDED)) {
    try {
        for (const c of JSON.parse(readFileSync(EMBEDDED, 'utf8'))) {
            if (!Array.isArray(c.vhash) || !Array.isArray(c.vectors)) continue;
            c.vhash.forEach((h, i) => { if (c.vectors[i]) cache.set(h, c.vectors[i]); });
        }
    } catch { /* unreadable/old corpus → treat as a cold cache */ }
}

const chunks = readFileSync(CHUNKS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Each chunk owns a BUNDLE of vectors: its combined text + any extra embedTexts
// (e.g. per-file slices of an example). Flatten every (chunk, text) into one list,
// batch-embed, then regroup so chunk.vectors holds all its vectors in order.
const flat = [];
for (let ci = 0; ci < chunks.length; ci++) {
    const texts = [chunks[ci].text, ...(chunks[ci].embedTexts || [])];
    texts.forEach((text, k) => {
        const sent = fitBudget(text);
        flat.push({ ci, id: k ? `${chunks[ci].id}#${k}` : chunks[ci].id, sent, truncated: sent !== text, hash: hashOf(text) });
    });
}

const vecs = new Array(flat.length);
const todo = [];                        // indices into flat that the cache can't cover
flat.forEach((f, idx) => {
    const hit = cache.get(f.hash);
    if (hit) vecs[idx] = hit; else todo.push(idx);
});
const hits = flat.length - todo.length;
console.log(`${flat.length} vectors: ${hits} cached, ${todo.length} to embed`);

for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const v = await embedBatch(slice.map((idx) => flat[idx]));
    slice.forEach((idx, j) => { vecs[idx] = v[j]; });
    process.stdout.write(`\rembedded ${Math.min(i + BATCH, todo.length)}/${todo.length} vectors`);
}
if (todo.length) process.stdout.write('\n');
const cut = todo.filter((idx) => flat[idx].truncated).map((idx) => flat[idx].id);
if (cut.length) console.log(`truncated ${cut.length} embed input(s) to ~${TOKEN_BUDGET} tokens: ${cut.slice(0, 40).join(', ')}${cut.length > 40 ? ', …' : ''}`);

for (const c of chunks) { c.vectors = []; c.vhash = []; }
flat.forEach((f, idx) => { chunks[f.ci].vectors.push(vecs[idx]); chunks[f.ci].vhash.push(f.hash); });
for (const c of chunks) delete c.embedTexts;

writeFileSync(EMBEDDED, JSON.stringify(chunks));
const totalVecs = chunks.reduce((n, c) => n + c.vectors.length, 0);
console.log(`wrote ${chunks.length} chunks / ${totalVecs} vectors (dim ${chunks[0]?.vectors[0]?.length}) → ${EMBEDDED}`);
