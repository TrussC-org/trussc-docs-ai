// Embed every chunk's text with the Ollama embedding model → chunks.embedded.next.json (update-corpus.sh swaps it in after the guards).
// Run after build-chunks.mjs.
//
// Incremental: the previous chunks.embedded.json doubles as the cache. Each vector
// carries the hash of the text it was made from (chunk.vhash[i]), so an unchanged
// text reuses its old vector and only genuinely new/changed texts hit bge-m3. The
// hash keys on EMBED_MODEL too, so switching models invalidates everything.
// Force a full re-embed with EMBED_FORCE=1.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { OLLAMA, EMBED_MODEL, CHUNKS, EMBEDDED, EMBEDDED_NEXT } from './config.mjs';

const BATCH = 16;   // /api/embed takes an array — batch for throughput
const FORCE = process.env.EMBED_FORCE === '1';
// Bound (cache): bge-m3 has a 2,048-token context; Ollama rejects inputs a little over it
// (400) and silently cuts much longer ones. Cut every input to an estimated budget first.
// Overflow is truncated and listed in the summary line.
const TOKEN_BUDGET = Number(process.env.EMBED_TOKEN_BUDGET || 1900);
if (!Number.isInteger(TOKEN_BUDGET) || TOKEN_BUDGET < 100 || TOKEN_BUDGET > 8192) {
    console.error(`EMBED_TOKEN_BUDGET must be an integer from 100 to 8192 (got "${process.env.EMBED_TOKEN_BUDGET}")`);
    process.exit(2);
}
// Never split a UTF-16 surrogate pair when cutting.
const cutAt = (text, n) => (n > 0 && n < text.length && /[\ud800-\udbff]/.test(text[n - 1]) ? text.slice(0, n - 1) : text.slice(0, n));

// Conservative token estimate for bge-m3's XLM-R tokenizer: CJK/kana/hangul ≈ 1 token
// per character, everything else ≈ 2.5 characters per token (code and identifiers
// split finely). Returns the text cut at the budget, or the text itself if it fits.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
function fitBudget(text, budget = TOKEN_BUDGET) {
    let used = 0;
    for (let i = 0; i < text.length; i++) {
        used += CJK.test(text[i]) ? 1 : 0.4;
        if (used > budget) return cutAt(text, i);
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
        // truncate:false makes Ollama reject an overflow (400) instead of silently
        // cutting it, so an estimate that undershoots still reaches the fallback.
        body: JSON.stringify({ model: EMBED_MODEL, input: texts, truncate: false }),
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
                f.sent = cutAt(f.sent, Math.floor(f.sent.length * 0.9));
                f.truncated = true;
            }
        }
    }
    return out;
}

// Bound (cache): keep only the nearest 12 non-Lua primary-vector ids per card; lower similarities are discarded.
export const NEAR_STORE = 12;
// Bound (memory): primary dimensions must be 1..4096 and the normalization workspace at most 8,388,608 Float64 elements (64 MiB); reject the build before allocating on invalid shape, values or size.
const MAX_NEAR_DIM = 4096, MAX_NEAR_ELEMENTS = 8 * 1024 * 1024;
class InvalidPrimaryVector extends Error {}
export function computeNeighbours(chunks, count = NEAR_STORE) {
    // Bound (configuration): finite non-negative integer neighbour counts only; invalid values fail before computation.
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid neighbour count');
    const cards = chunks.filter(c => c.lang !== 'lua').slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const n = cards.length;
    let dim = 0;
    for (const c of cards) {
        const v = c.vectors?.[0] || c.vector;
        if (!Array.isArray(v)) throw new InvalidPrimaryVector('Invalid primary vector: expected an array of finite numbers');
        if (v.length < 1 || v.length > MAX_NEAR_DIM) throw new InvalidPrimaryVector('Invalid primary vector: dimension must be 1..4096');
        if (dim && v.length !== dim) throw new InvalidPrimaryVector('Invalid primary vector: dimensions must match');
        dim = v.length;
        if (n > Math.floor(MAX_NEAR_ELEMENTS / dim)) throw new InvalidPrimaryVector('Invalid primary vector: neighbour workspace exceeds 8388608 elements (64 MiB)');
        for (let k = 0; k < dim; k++) if (!Number.isFinite(v[k]))
            throw new InvalidPrimaryVector('Invalid primary vector: expected an array of finite numbers');
    }
    const data = new Float64Array(n * dim);
    cards.forEach((c, i) => {
        const v = c.vectors?.[0] || c.vector;
        // Scale first so squaring finite components cannot overflow or erase tiny vectors.
        let scale = 0;
        for (let k = 0; k < dim; k++) scale = Math.max(scale, Math.abs(v[k]));
        scale ||= 1;
        let norm = 0;
        for (let k = 0; k < dim; k++) {
            const value = v[k] / scale;
            data[i * dim + k] = value;
            norm += value * value;
        }
        norm = Math.sqrt(norm) || 1;
        for (let k = 0; k < dim; k++) data[i * dim + k] /= norm;
    });
    const keep = Math.min(count, Math.max(0, n - 1));
    const top = Array.from({ length: n }, () => []);
    function offer(i, j, score) {
        const list = top[i];
        let at = list.length;
        while (at > 0 && (score > list[at - 1].score || (score === list[at - 1].score && j < list[at - 1].j))) at--;
        if (at >= keep) return;
        list.splice(at, 0, { j, score });
        if (list.length > keep) list.pop();
    }
    // Normalize once, calculate each pair once, and retain only small sorted top-k lists.
    if (keep) for (let i = 0; i < n; i++) {
        const a = i * dim;
        for (let j = i + 1; j < n; j++) {
            const b = j * dim;
            let dot = 0;
            for (let k = 0; k < dim; k++) dot += data[a + k] * data[b + k];
            offer(i, j, dot); offer(j, i, dot);
        }
    }
    return new Map(cards.map((c, i) => [c.id, top[i].map(hit => cards[hit.j].id)]));
}

export async function main() {
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

    const nearStarted = performance.now();
    const neighbours = computeNeighbours(chunks);
    for (const c of chunks) if (c.lang !== 'lua') c.near = neighbours.get(c.id);
    console.log(`neighbours: ${neighbours.size} chunks, ${((performance.now() - nearStarted) / 1000).toFixed(3)} s`);

    // The live corpus (EMBEDDED) is only the vector cache; the result goes to EMBEDDED_NEXT.
    writeFileSync(EMBEDDED_NEXT, JSON.stringify(chunks));
    const totalVecs = chunks.reduce((n, c) => n + c.vectors.length, 0);
    console.log(`wrote ${chunks.length} chunks / ${totalVecs} vectors (dim ${chunks[0]?.vectors[0]?.length}) → ${EMBEDDED_NEXT}`);

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { await main(); } catch (error) {
        if (!(error instanceof InvalidPrimaryVector)) throw error;
        console.error(error.message); process.exitCode = 1;
    }
}
