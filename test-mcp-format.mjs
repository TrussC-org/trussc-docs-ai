// trussc_search output: the tool description and per-result score line stay caller-facing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, formatResults, formatSearchResults, createSymbolChecker, relatedCandidates, dispatch } from './mcp-core.mjs';

const search = TOOLS.find(tool => tool.name === 'trussc_search');
for (const internal of ['BM25', 'RRF', 'bge-m3', 'cross-encoder', 'reranker', 'Jev',
    'leading owner', 'ids/components', 'case-insensitive', 'whole-word', 'suppress',
    'syntax', 'namespace;', '256 KiB', 'not checked']) {
    assert(!search.description.includes(internal), `description leaks internals: ${internal}`);
}
for (const guidance of ['full:true', 'trussc_get', 'lang:"lua"', 'TAU not PI']) {
    assert(search.description.includes(guidance), `description keeps usage guidance: ${guidance}`);
}
for (const guidance of ['does not appear in the documentation', 'closest matches', 'Other possibly related'])
    assert(search.description.includes(guidance), `description explains visible output: ${guidance}`);
const withP = formatResults([{ source: 'api', title: 'drawCircle', p: 0.873, rrf: 0.0123, score: 0.51, rerank: 0.9, text: 'body' }], 'circle');
assert(withP.includes('(relevance 0.87)'));
for (const internal of ['rrf', 'cos ', 'rr ']) assert(!withP.includes(internal), `score line leaks ${internal}`);
const fallback = formatResults([{ source: 'api', title: 'drawCircle', rrf: 0.0123, score: 0.51, text: 'body' }], 'circle');
assert(!fallback.includes('(') || !/\((cos|rrf|rr|relevance)/.test(fallback), 'fallback results show no internal score');
const check = createSymbolChecker(['drawCircle', 'Fbo::begin', 'Fbo', 'CudaGraphs', 'CudaGrap', 'CudaGraps', 'CudaGraphic'].map(name => ({ id: `symbol:${name}` })));
const unknown = check('How do I use tc::CudaGraph?');
assert.deepEqual(unknown.map(c => c.name), ['CudaGraph']);
assert.equal(unknown[0].suggestions.length, 3);
assert.deepEqual(unknown[0].suggestions, ['CudaGrap', 'CudaGraphs', 'CudaGraps']);
for (const query of ['drawCircle', 'Fbo::begin', 'tc::Fbo', 'tcx::Fbo', 'TC::fBO', 'FBO::BEGIN', 'draw a circle in a color', 'How can I draw a circle?', 'e.g. draw a circle', 'load docs from trussc.org', 'TrussC and openFrameworks on macOS']) assert.deepEqual(check(query), [], query);
for (const name of ['std', 'chrono', 'filesystem', 'this_thread', 'ranges']) {
    for (const query of [name, `${name}::someFunction()`, `tc::${name}`]) assert.deepEqual(check(query), [], query);
}
assert.deepEqual(check('UnknownClass::method').map(c => c.name), ['UnknownClass']);
assert.equal(check('tc::' + 'X'.repeat(100)).length, 0);
assert.equal(check(Array.from({ length: 30 }, (_, i) => `missingName${i}`).join(' ')).length, 8);
assert.equal(check(' '.repeat(8000) + 'tc::CudaGraph').length, 0);
assert.equal(check(' '.repeat(7990) + 'tc::CudaGraph').length, 0, 'scan limit does not invent a partial name');
const lateKnown = createSymbolChecker([...Array.from({ length: 3000 }, (_, i) => ({ id: `symbol:SomeType${i}` })), { id: 'symbol:KnownLate' }]);
assert.deepEqual(lateKnown('KnownLate'), [], 'suggestion budget never limits exact membership');
const cards = [{ id: 'symbol:drawCircle', source: 'api', title: 'drawCircle', p: .8, text: 'body' }];
const candidates = [{ id: cards[0].id, title: 'shown' }, ...Array.from({ length: 50 }, (_, i) => ({ id: `symbol:Other${i}`, title: 'あ'.repeat(200) }))];
candidates.splice(2, 0, candidates[1]);
const info = { path: 'jev', exists: .29, missingSymbols: unknown, candidates };
const formatted = formatSearchResults(cards, 'tc::CudaGraph', info);
assert(formatted.startsWith('No TrussC symbol named `CudaGraph` appears in the documentation. The results below are the closest matches.'));
assert(formatted.includes('Near names: `CudaGrap`, `CudaGraphs`, `CudaGraps`.'));
assert(formatted.includes("These results probably don't answer the query."));
assert(formatted.includes('Closest matches:'));
const relatedLines = formatted.split('Other possibly related:\n')[1].split('\n');
assert.equal(relatedLines.length, 16);
assert.equal(new Set(relatedLines).size, 16);
assert(!relatedLines.some(line => line.includes('symbol:drawCircle')));
assert.deepEqual(relatedLines.map(line => line.match(/\[#(.+)\]/)[1]), Array.from({ length: 16 }, (_, i) => `symbol:Other${i}`));
assert(relatedLines.every(line => Buffer.byteLength(line.split(' [#')[0].slice(2)) <= 192));
assert(relatedCandidates([{ id: 'x'.repeat(257), title: 'bad' }]).length === 0);
for (const exists of [.3, .9, null]) {
    const output = formatSearchResults(cards, 'circle', { ...info, exists, missingSymbols: [] });
    assert(!output.includes("probably don't answer"));
    assert(!output.includes('Closest matches:'));
    assert(!output.includes('No TrussC symbol'));
}
assert(!formatSearchResults(cards, 'circle', { path: 'fallback', exists: null }).includes('probably'));
const bounded = formatSearchResults([{ ...cards[0], text: 'あ'.repeat(300000) }], 'tc::CudaGraph', info);
assert(Buffer.byteLength(bounded) <= 262144);
assert(bounded.includes('search output truncated'));
assert(bounded.includes('Other possibly related:'));
assert(!bounded.includes('�'));
const rpc = await dispatch({ id: 1, method: 'tools/call', params: { name: 'trussc_search', arguments: { query: 'tc::CudaGraph', k: 1 } } }, {
    search: async () => ({ results: [...cards, { id: 'extra', title: 'extra' }], ...info }),
});
assert.equal(rpc.result.content[0].text, formatted);
// Exercise the stdio entry point with an in-memory HTTP stub, including /get.
// The child exits on stdin EOF; no sockets, real credentials or process signals.
function stdioSearch(upstream) {
    const preload = 'globalThis.fetch = async (url) => Response.json(url.endsWith("/search") ? ' +
        JSON.stringify(upstream) + ' : {results:' + JSON.stringify(cards) + '});';
    const dir = mkdtempSync(join(tmpdir(), 'docsai-mcp-format-'));
    try {
        writeFileSync(join(dir, 'preload.mjs'), preload);
        writeFileSync(join(dir, 'input'), [
            { id: 1, method: 'tools/call', params: { name: 'trussc_search', arguments: { query: 'tc::CudaGraph', k: 1 } } },
            { id: 2, method: 'tools/call', params: { name: 'trussc_get', arguments: { ids: [cards[0].id] } } },
        ].map(JSON.stringify).join('\n') + '\n');
        // File descriptors also work where child Node stdio pipes return no output.
        const fds = [openSync(join(dir, 'input'), 'r'), openSync(join(dir, 'output'), 'w'), openSync(join(dir, 'error'), 'w')];
        let result;
        try { result = spawnSync(process.execPath, ['--import', join(dir, 'preload.mjs'), new URL('./mcp.mjs', import.meta.url).pathname], { stdio: fds }); }
        finally { fds.forEach(closeSync); }
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, readFileSync(join(dir, 'error'), 'utf8'));
        const replies = readFileSync(join(dir, 'output'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(replies.find(r => r.id === 2).result.content[0].text, formatResults(cards, cards[0].id));
        const search = replies.find(r => r.id === 1).result;
        assert(!search.isError, search.content[0].text);
        return search.content[0].text;
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
assert.equal(stdioSearch({ results: cards, ...info }), formatted);
assert.equal(stdioSearch({ results: cards }), formatResults(cards, 'tc::CudaGraph'));
assert.equal(stdioSearch(cards), formatResults(cards, 'tc::CudaGraph'));
const newServer = { results: cards, candidates: [{ id: 'extra', title: 'Title\n[#fake]', brief: 'Description\t[#fake]' }] };
assert.equal(stdioSearch(newServer), formatSearchResults(cards, 'tc::CudaGraph', newServer));
assert(stdioSearch(newServer).endsWith('- Title [ #fake] — Description [ #fake] [#extra]'));
// Upstream metadata must obey the same limits as locally generated metadata.
for (const missingSymbols of [
    [{ name: 'A'.repeat(300000), suggestions: [] }],
    [{ name: 'MissingName', suggestions: ['B'.repeat(300000)] }],
    Array.from({ length: 10000 }, (_, i) => ({ name: `MissingName${i}`, suggestions: [] })),
    [{ name: 'MissingName', suggestions: Array.from({ length: 10000 }, (_, i) => `NearName${i}`) }],
    [null, { name: 42 }, { name: 'bad`name' }, { name: 'MissingName', suggestions: [null, 42, 'bad\nname'] }],
]) {
    const output = stdioSearch({ results: [{ ...cards[0], text: 'あ'.repeat(300000) }], missingSymbols });
    assert(Buffer.byteLength(output) <= 262144, 'whole stdio text, including head, fits 256 KiB');
    assert(!output.includes('�'), 'UTF-8 truncation preserves characters');
    const notices = output.split('\n').filter(line => line.startsWith('No TrussC symbol named'));
    assert(notices.length <= 8);
    for (const line of notices) {
        const names = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]);
        assert(names.length <= 4, 'one name and at most three suggestions');
        assert(names.every(name => name.length <= 96 && /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)));
    }
}
const malformedRelated = stdioSearch({ results: cards, candidates: [null, { id: 42 }, { id: 'bad\nid' },
    { id: 'x'.repeat(257), title: 'oversized id' }, { id: 'valid', title: { nested: 'invalid' } },
    ...Array.from({ length: 100 }, (_, i) => ({ id: `related:${i}`, title: 'あ'.repeat(300) })),
] });
const safeTitles = malformedRelated.split('Other possibly related:\n')[1].split('\n');
assert.equal(safeTitles.length, 16);
assert(safeTitles.every(line => Buffer.byteLength(line.split(' [#')[0].slice(2)) <= 192));
assert(!malformedRelated.includes('bad\nid'));
assert(!stdioSearch({ results: cards, missingSymbols: {}, candidates: {} }).includes('error:'));
console.log('MCP format tests passed');
