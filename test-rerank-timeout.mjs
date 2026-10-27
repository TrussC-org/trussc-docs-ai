// Run with node test-rerank-timeout.mjs; local dummy reranker servers, synthetic vectors, no services.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const listen = (handler) => new Promise((resolve) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const servers = {
    silent: await listen(() => {}),   // accepts the connection, never answers
    stalled: await listen((_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"results":['); }),   // headers, then an unfinished body
    error: await listen((_, res) => { res.writeHead(500); res.end('boom'); }),
    badJson: await listen((_, res) => { res.end('{not json'); }),
    badIndex: await listen((_, res) => { res.end(JSON.stringify({ results: [{ index: 99, score: 1 }, { index: 0, score: .5 }] })); }),
    duplicate: await listen((_, res) => { res.end(JSON.stringify({ results: [{ index: 0, score: 1 }, { index: 0, score: .5 }] })); }),
    good: await listen((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
        const { texts } = JSON.parse(b); res.end(JSON.stringify({ results: texts.map((_, i) => ({ index: texts.length - 1 - i, score: 1 - i / 10 })) })); }); }),
};
const closed = await listen(() => {}); const closedPort = closed.address().port; closed.close();

// A missing or broken deadline must fail this test, not hang it.
const watchdog = setTimeout(() => { console.error('FAIL reranker request was not bounded'); process.exit(1); }, 10000);
const dir = mkdtempSync(join(tmpdir(), 'docsai-rerank-timeout-'));
const warnings = []; const warn = console.warn; console.warn = (m) => { warnings.push(String(m)); };
try {
    for (const name of ['config.mjs', 'rag.mjs', 'jev.mjs', 'stats.mjs', 'debug.mjs', 'mcp-core.mjs']) writeFileSync(join(dir, name), readFileSync(new URL(name, import.meta.url)));
    const corpus = [
        { id: 'symbol:a', title: 'a', source: 'reference', lang: 'cpp', meta: { kind: 'function' }, text: 'a', vector: [1, 0] },
        { id: 'symbol:b', title: 'b', source: 'reference', lang: 'cpp', meta: { kind: 'function' }, text: 'b', vector: [.5, .5] },
    ];
    Object.assign(process.env, { EMBEDDED: join(dir, 'corpus.json'), RETRIEVAL: 'rerank', RERANK: '1', RERANK_URL: 'http://127.0.0.1:1', RERANK_TIMEOUT_MS: '300', STATS: '0', HYBRID: '0' });
    writeFileSync(process.env.EMBEDDED, JSON.stringify(corpus));
    const realFetch = globalThis.fetch;
    let target = '';
    globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/api/embed')) return Response.json({ embeddings: [[1, 0]] });
        if (String(url).endsWith('/rerank')) return realFetch(`${target}/rerank`, options);
        throw new Error('unexpected fetch ' + url);
    };
    const { retrieve } = await import(join(dir, 'rag.mjs'));
    const order = async (t) => { target = t; warnings.length = 0; const t0 = Date.now(); const r = await retrieve('q', 2, { ip: 'test' }); return { ids: r.map((c) => c.id), ms: Date.now() - t0, reranked: r.some((c) => c.rerank != null) }; };
    const rrf = ['symbol:a', 'symbol:b'];

    for (const name of ['silent', 'stalled']) {
        const r = await order(`http://127.0.0.1:${servers[name].address().port}`);
        assert.deepEqual(r.ids, rrf, name); assert(!r.reranked, name);
        assert(r.ms >= 250 && r.ms < 3000, `${name}: timeout took ${r.ms} ms`);
        assert.deepEqual(warnings, ['Warning: reranker unavailable (timeout); keeping the RRF order'], name);
    }
    for (const [name, why] of [['error', 'HTTP 500'], ['badJson', 'bad JSON'], ['badIndex', 'malformed results'], ['duplicate', 'malformed results']]) {
        const r = await order(`http://127.0.0.1:${servers[name].address().port}`);
        assert.deepEqual(r.ids, rrf, name); assert(!r.reranked, name);
        assert.deepEqual(warnings, [`Warning: reranker unavailable (${why}); keeping the RRF order`], name);
    }
    const refused = await order(`http://127.0.0.1:${closedPort}`);
    assert.deepEqual(refused.ids, rrf); assert.deepEqual(warnings, ['Warning: reranker unavailable (unreachable); keeping the RRF order']);
    const good = await order(`http://127.0.0.1:${servers.good.address().port}`);
    assert.deepEqual(good.ids, [...rrf].reverse()); assert(good.reranked); assert.deepEqual(warnings, []);
    console.log('PASS reranker timeout, errors and malformed results keep the RRF order with one log line');
} finally {
    clearTimeout(watchdog);
    console.warn = warn;
    for (const s of Object.values(servers)) { s.closeAllConnections(); s.close(); }
    rmSync(dir, { recursive: true, force: true });
}
