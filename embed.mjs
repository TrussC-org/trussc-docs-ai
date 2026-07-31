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

const hashOf = (text) =>
    createHash('sha1').update(`${EMBED_MODEL}\0${text}`).digest('hex').slice(0, 20);

async function embedBatch(texts) {
    const r = await fetch(`${OLLAMA}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    });
    if (!r.ok) throw new Error(`embed ${r.status}: ${await r.text()}`);
    return (await r.json()).embeddings;
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
    for (const text of texts) flat.push({ ci, text, hash: hashOf(text) });
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
    const v = await embedBatch(slice.map((idx) => flat[idx].text));
    slice.forEach((idx, j) => { vecs[idx] = v[j]; });
    process.stdout.write(`\rembedded ${Math.min(i + BATCH, todo.length)}/${todo.length} vectors`);
}
if (todo.length) process.stdout.write('\n');

for (const c of chunks) { c.vectors = []; c.vhash = []; }
flat.forEach((f, idx) => { chunks[f.ci].vectors.push(vecs[idx]); chunks[f.ci].vhash.push(f.hash); });
for (const c of chunks) delete c.embedTexts;

writeFileSync(EMBEDDED, JSON.stringify(chunks));
const totalVecs = chunks.reduce((n, c) => n + c.vectors.length, 0);
console.log(`wrote ${chunks.length} chunks / ${totalVecs} vectors (dim ${chunks[0]?.vectors[0]?.length}) → ${EMBEDDED}`);
