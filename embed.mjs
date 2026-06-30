// Embed every chunk's text with the Ollama embedding model → chunks.embedded.json.
// Run after build-chunks.mjs. Re-run whenever chunks change (re-embeds all; the
// corpus is small so a full pass is fine for v0).
import { readFileSync, writeFileSync } from 'node:fs';
import { OLLAMA, EMBED_MODEL, CHUNKS, EMBEDDED } from './config.mjs';

const BATCH = 16;   // /api/embed takes an array — batch for throughput

async function embedBatch(texts) {
    const r = await fetch(`${OLLAMA}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    });
    if (!r.ok) throw new Error(`embed ${r.status}: ${await r.text()}`);
    return (await r.json()).embeddings;
}

const chunks = readFileSync(CHUNKS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Each chunk owns a BUNDLE of vectors: its combined text + any extra embedTexts
// (e.g. per-file slices of an example). Flatten every (chunk, text) into one list,
// batch-embed, then regroup so chunk.vectors holds all its vectors in order.
const flat = [];
for (let ci = 0; ci < chunks.length; ci++) {
    const texts = [chunks[ci].text, ...(chunks[ci].embedTexts || [])];
    for (const text of texts) flat.push({ ci, text });
}
const vecs = new Array(flat.length);
for (let i = 0; i < flat.length; i += BATCH) {
    const slice = flat.slice(i, i + BATCH);
    const v = await embedBatch(slice.map((f) => f.text));
    slice.forEach((f, j) => { vecs[i + j] = v[j]; });
    process.stdout.write(`\rembedded ${Math.min(i + BATCH, flat.length)}/${flat.length} vectors`);
}
process.stdout.write('\n');

for (const c of chunks) c.vectors = [];
flat.forEach((f, idx) => chunks[f.ci].vectors.push(vecs[idx]));
for (const c of chunks) delete c.embedTexts;

writeFileSync(EMBEDDED, JSON.stringify(chunks));
const totalVecs = chunks.reduce((n, c) => n + c.vectors.length, 0);
console.log(`wrote ${chunks.length} chunks / ${totalVecs} vectors (dim ${chunks[0]?.vectors[0]?.length}) → ${EMBEDDED}`);
