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
const out = [];
for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const vecs = await embedBatch(slice.map((c) => c.text));
    slice.forEach((c, j) => { c.vector = vecs[j]; out.push(c); });
    process.stdout.write(`\rembedded ${out.length}/${chunks.length}`);
}
process.stdout.write('\n');
writeFileSync(EMBEDDED, JSON.stringify(out));
console.log(`wrote ${out.length} embedded chunks (dim ${out[0]?.vector.length}) → ${EMBEDDED}`);
