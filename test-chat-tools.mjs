// PR4: synthetic corpus, in-memory HTTP/providers, and a stubbed stdio proxy only.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { TOOLS, dispatch, formatResults, formatSearchResults } from './mcp-core.mjs';

const rpc = (args, name = 'trussc_search') => ({ id: 1, method: 'tools/call', params: { name, arguments: args } });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const tool = (id, name, input, index = 0) => frame({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input } });
const text = value => frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } });
const stop = frame({ type: 'message_stop' });
const corpus = [
    { id: 'symbol:drawCircle', title: 'drawCircle', source: 'reference', lang: 'cpp', meta: { kind: 'function', related: ['servePage'] }, text: 'CIRCLE_BODY', vector: [1, 0] },
    { id: 'symbol:servePage', title: 'servePage', source: 'reference', lang: 'cpp', brief: 'Serve a page.', meta: { kind: 'function' }, text: 'FETCHED_BODY', vector: [0, 1] },
    { id: 'lua:drawCircle', title: 'drawCircle', source: 'sketch-lua', lang: 'lua', meta: { kind: 'function' }, text: 'LUA_BODY', vector: [1, 0] },
];
async function fixture(run, options = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'docsai-chat-tools-'));
    const saved = { ...process.env }, savedFetch = globalThis.fetch;
    const haiku = [], jev = [], embeds = [], reranks = [];
    try {
        Object.assign(process.env, { EMBEDDED: join(dir, 'corpus.json'), STATS: '1', STATS_DIR: dir,
            RATE_MAX: '10000', TYPESAFE_API_KEY: 'synthetic-selector', ANTHROPIC_API_KEY: 'synthetic-generator',
            GEN_BACKEND: 'anthropic', RETRIEVAL: 'jev', RERANK: '0', HYBRID: '1',
            MAX_SEARCH_ROUNDS: '3', ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001', HAIKU_EFFORT: '', HAIKU_THINKING: '',
            JEV_PICK: 'fixed', JEV_PICK_K: '1', JEV_POOL_TOKENS: '28000', JEV_CARD_CHARS: '2000',
            JEV_TOKENS_PER_CHAR: '.4', JEV_RATE_MAX: '10000', JEV_DAILY_TOKENS: '1000000000',
            HAIKU_MAX_INPUT_TOKENS: '24000', HAIKU_CARD_CHARS: '8000', ...options.env });
        writeFileSync(process.env.EMBEDDED, JSON.stringify(options.corpus || corpus));
        for (const name of ['rag.mjs', 'config.mjs', 'jev.mjs', 'mcp-core.mjs', 'server.mjs', 'stats.mjs', 'debug.mjs'])
            writeFileSync(join(dir, name), readFileSync(new URL(name, import.meta.url)));
        let generate = () => text('Use [[drawCircle]].');
        globalThis.fetch = async (url, opts) => {
            const body = JSON.parse(opts.body);
            if (url.endsWith('/api/embed')) { embeds.push(body.input); return Response.json({ embeddings: [[1, 0]] }); }
            if (url.endsWith('/systemone')) {
                jev.push(body);
                return Response.json({ answers: { ...Object.fromEntries(body.state.cards.map((c, i) => [c.card, { noul: i === 0 ? .99 : .8 }])), exists: { noul: .2 } } });
            }
            if (url.endsWith('/rerank')) { reranks.push(body); return Response.json({ results: body.texts.map((_, index) => ({ index, score: .9 })) }); }
            assert.equal(url, 'https://api.anthropic.com/v1/messages');
            haiku.push(body);
            // Match the provider contract: reject invalid replay inputs before generating.
            for (const message of body.messages) for (const block of Array.isArray(message.content) ? message.content : []) {
                if (block.type === 'tool_use' && (block.input === null || typeof block.input !== 'object' ||
                    Object.getPrototypeOf(block.input) !== Object.prototype))
                    return Response.json({ error: 'tool_use.input must be a plain object' }, { status: 400 });
            }
            return new Response(generate(body, haiku.length) + stop);
        };
        const rag = await import(join(dir, 'rag.mjs'));
        const { stateTokens, perQuestionTokens } = await import(join(dir, 'jev.mjs'));
        const { server } = await import(join(dir, 'server.mjs'));
        const request = (path, body, headers = {}) => new Promise(resolve => {
            const req = new PassThrough(); Object.assign(req, { method: 'POST', url: path, headers, socket: { remoteAddress: 'synthetic' } });
            const res = new EventEmitter(); Object.assign(res, { status: 200, data: '', setHeader() {}, writeHead(s) { this.status = s; }, write(s) { this.data += s; }, end(s = '') { this.data += s; resolve(this); } });
            server.emit('request', req, res); req.end(JSON.stringify(body));
        });
        const rows = () => readFileSync(join(dir, new Date().toISOString().slice(0, 7) + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        await run({ ...rag, dir, request, rows, haiku, jev, embeds, reranks, stateTokens, perQuestionTokens,
            generate: fn => { generate = fn; } });
    } finally {
        globalThis.fetch = savedFetch;
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true });
    }
}

const schema = TOOLS[0].inputSchema;
assert(!schema.required?.includes('query') && !schema.required?.includes('queries'));
assert(!JSON.stringify(schema).includes('anyOf') && !JSON.stringify(schema).includes('oneOf'));
assert.equal(schema.properties.queries.maxItems, 3);
assert.equal(schema.properties.queries.items.maxLength, 200);
assert.equal(schema.properties.message.maxLength, 300);
const invalid = [
    {}, { query: 'circle', queries: ['circle'] }, { query: '', queries: ['circle'] },
    ...[null, 'circle', {}, [], ['a', 'b', 'c', 'd'], [1], [null], [{}], [''], [' \t\n'], ['x'.repeat(201)], ['x'.repeat(201) + ' ']].map(queries => ({ queries })),
    ...[null, 1, {}, [], 'x'.repeat(301)].map(message => ({ query: 'circle', message })),
    { query: '' }, { query: '   ' },
];
await fixture(async ({ request, embeds, jev }) => {
    for (const args of invalid) {
        const called = () => assert.fail('invalid input must not retrieve');
        assert.equal((await dispatch(rpc(args), { search: called })).result.isError, true, JSON.stringify(args));
        const http = { ...args };
        if (Object.hasOwn(http, 'query')) { http.question = http.query; delete http.query; }
        assert.equal((await request('/search', http)).status, 400, JSON.stringify(http));
        assert.equal(JSON.parse((await request('/mcp', rpc(args))).data).result.isError, true);
    }
    for (const question of [42, {}, null]) assert.equal((await request('/search', { question })).status, 400);
    assert.equal(embeds.length, 0); assert.equal(jev.length, 0);
    for (const args of [{ query: 'x'.repeat(201) }, { queries: ['a'.repeat(200)], message: 'x'.repeat(300) }, { query: 'circle', message: '' }]) {
        let call;
        assert(!(await dispatch(rpc(args), { search: async (...args) => { call = args; return []; } })).result.isError);
        assert.equal(call.length, 5); assert.deepEqual(call[4], args.queries, 'only queries occupy the optional fifth argument');
    }
});
console.log('PASS shared schema and every search validation error over MCP and HTTP');

await fixture(async ({ request, rows, retrieve, retrieveQueries, jev, embeds }) => {
    const legacy = await retrieve('circle');
    const single = await retrieveQueries(['circle']);
    assert.deepEqual(single, legacy);
    assert.deepEqual(jev[0], jev[1], '1-item queries uses exactly the retrieve request');
    assert.equal(formatSearchResults(single, 'circle', single.search), formatSearchResults(legacy, 'circle', legacy.search));
    const replies = [];
    for (const args of [{ query: 'circle' }, { queries: ['circle'] }]) replies.push(JSON.parse((await request('/mcp', rpc(args))).data));
    assert.deepEqual(replies[0], replies[1], 'query and one-item queries MCP output is identical');
    const old = JSON.parse((await request('/search', { question: 'circle' }, { 'user-agent': 'trussc-mcp-stdio/0.1.0' })).data);
    const current = JSON.parse((await request('/search', { queries: ['circle'] })).data);
    assert.deepEqual(old.results, current.results);
    const before = jev.length, count = embeds.length;
    const response = JSON.parse((await request('/mcp', rpc({ queries: ['alpha', 'beta', 'gamma'], message: 'PRIVATE_MESSAGE' }))).data);
    assert(!response.result.isError); assert.equal(jev.length, before + 1); assert.equal(embeds.length, count + 3);
    assert.equal(jev.at(-1).state.question, 'alpha beta gamma');
    assert(!JSON.stringify(jev.at(-1)).includes('PRIVATE_MESSAGE'));
    assert.equal(new Set(jev.at(-1).state.cards.map(c => c.title)).size, jev.at(-1).state.cards.length);
    assert.deepEqual(rows().at(-1).queries, ['alpha', 'beta', 'gamma']);
    assert.equal(rows().at(-1).q, 'alpha beta gamma');
    const e = embeds.length, j = jev.length;
    await retrieveQueries(['circle', 'circle']);
    assert.equal(embeds.length, e + 2, 'one embedding per supplied query, even with duplicate queries');
    assert.equal(jev.length, j + 1);
    assert.equal(new Set(jev.at(-1).state.cards.map(c => c.title)).size, jev.at(-1).state.cards.length);
    assert(!JSON.stringify(rows()).includes('PRIVATE_MESSAGE'));
    const http = JSON.parse((await request('/search', { queries: ['alpha', 'beta'], message: 'HTTP_PRIVATE' })).data);
    assert.deepEqual(http.queries, ['alpha', 'beta']); assert.equal(rows().at(-1).q, 'alpha beta');
    assert(!JSON.stringify(rows()).includes('HTTP_PRIVATE'));
});
console.log('PASS single-query equivalence, public multi-query one Jev, old proxy HTTP and stats');

const many = Array.from({ length: 100 }, (_, i) => ({ id: `symbol:card${i}`, title: `card${i}`, source: 'reference', text: 'x'.repeat(2000), vector: [1, 0] }));
await fixture(async ({ retrieveQueries, jev, embeds, stateTokens, perQuestionTokens }) => {
    for (const queries of [['alpha'], ['alpha', 'beta', 'gamma']]) {
        const n = jev.length, e = embeds.length;
        const results = await retrieveQueries(queries);
        assert.equal(jev.length, n + 1); assert.equal(embeds.length, e + queries.length);
        assert(JSON.stringify(jev.at(-1).state).length * .4 <= 28000);
        assert(stateTokens(queries.join(' '), results) <= 28000);
        assert(perQuestionTokens(queries.join(' '), results) <= 32000);
    }
}, { corpus: many });
await fixture(async ({ retrieveQueries, reranks, embeds }) => {
    await retrieveQueries(['alpha', 'beta', 'gamma']);
    assert.equal(embeds.length, 3); assert.equal(reranks.length, 1);
    assert.equal(reranks[0].texts.length, 30); assert.equal(reranks[0].query, 'alpha beta gamma');
}, { corpus: many, env: { TYPESAFE_API_KEY: '', RERANK: '1' } });
console.log('PASS unchanged token cap for 1/3 queries and one top-30 fallback rerank');

// Freeze pre-PR MCP bytes independently of the new formatter (including briefs/tags).
const cards = [{ id: 'a', source: 'api', title: 'A', p: .81, text: 'body', link: 'https://example.invalid/a' }];
const info = { path: 'jev', exists: .8, candidates: [{ id: 'b', title: 'B', brief: 'Brief.' }] };
const original = '### [api] A [#a]  ·  https://example.invalid/a  (relevance 0.81)\nbody\n\nOther possibly related:\n- B — Brief. [#b]';
assert.equal(formatSearchResults(cards, 'q', info), original);
assert.equal(formatSearchResults(cards, 'q', info, { maxBytes: 1000 }), original);
const ranked = [{ id: 'low', source: 'api', title: 'Low', p: .1, text: 'LOW'.repeat(30) }, { id: 'high', source: 'api', title: 'High', p: .9, text: 'HIGH'.repeat(20) }];
const packed = formatResults(ranked, 'q', { maxBytes: 160 });
assert(packed.startsWith('[#low]\n')); assert(packed.includes('HIGH')); assert(!packed.includes('LOW'));
assert.equal(formatResults(ranked, 'q', { maxBytes: 2 }), null);
assert(formatResults(cards, 'q', { shownIds: new Set(['a']), maxBytes: 100 }).includes('[#a] already shown above'));
const withRelated = formatSearchResults(cards, 'q', info, { maxBytes: Buffer.byteLength('[#a]\n\nOther possibly related:\n- B — Brief. [#b]') });
assert.equal(withRelated, '[#a]\n\nOther possibly related:\n- B — Brief. [#b]');
console.log('PASS budgeted shared formatter, p priority, UTF-8 related budget and unchanged MCP bytes');

const cjkCards = Array.from({ length: 16 }, (_, i) => ({
    id: `symbol:cjk${i}`, title: `cjk${i}`, source: 'reference', lang: 'cpp',
    p: i === 0 ? .99 : .8, meta: { kind: 'function' }, vector: [1, 0],
    text: `CARD_${i}_START\n${'漢'.repeat(7950)}\nCARD_${i}_END`,
}));
const capInfo = { ...info, exists: .2 };
// Frozen from origin/main, including the original truncation marker and related list.
assert.equal(createHash('sha256').update(formatSearchResults(cjkCards, 'circle', capInfo)).digest('hex'), 'd1ebb01150b7ff9e056d2c460e53c1f3cd004b7e658052b335a1253ade63f677');
let capPacked;
const capOutput = formatSearchResults(cjkCards, 'circle', capInfo, {
    fits: () => true, onPacked: value => { capPacked = value; },
});
assert(Buffer.byteLength(capOutput) <= 262144);
assert(capOutput.startsWith("These results probably don't answer the query."));
assert(capOutput.endsWith('Other possibly related:\n- B — Brief. [#b]'));
assert(!capOutput.includes('search output truncated'));
assert(capPacked.idOnlyCards > 0);
assert.equal(capPacked.idOnlyCards, cjkCards.length - capPacked.added.length);
for (const card of cjkCards) {
    assert(capOutput.includes(`[#${card.id}]`), `${card.id} must retain its fetchable id`);
    assert.equal(capOutput.includes(card.text), capPacked.added.includes(card.id));
    if (!capPacked.added.includes(card.id)) assert(!capOutput.includes(card.text.split('\n')[0]));
}
await fixture(async ({ answer, haiku, jev, generate }) => {
    const target = cjkCards.at(-1);
    generate((_, n) => n === 1 ? tool('fetch-overflow', 'trussc_get', { ids: [target.id] }) : text('Done.'));
    const result = await answer('circle');
    assert.equal(jev.length, 1);
    assert.equal(result.traces[0].picked.length, 16);
    const initial = haiku[0].messages[0].content;
    const shown = cjkCards.filter(card => initial.includes(card.text));
    assert(shown.length > 0 && shown.length < 16);
    assert.equal(result.traces[0].idOnlyCards, 16 - shown.length);
    for (const card of cjkCards) assert(initial.includes(`[#${card.id}]`));
    assert(!initial.includes(target.text.split('\n')[0]));
    const fetched = haiku[1].messages.at(-1).content[0].content;
    assert(fetched.includes(target.text));
    assert(!fetched.includes('already shown above'));
    assert.equal(result.traces[1].idOnlyCards, 0);
}, { corpus: cjkCards, env: { HAIKU_MAX_INPUT_TOKENS: '100000', JEV_PICK_K: '16' } });
console.log('PASS 256 KiB packing preserves every id, accurate counts and later get; unbudgeted MCP bytes unchanged');

for (const question of ['circle', '円を描く']) await fixture(async ({ answerStream, haiku, jev, generate }) => {
    generate((_, n) => n === 1 ? tool('search', 'trussc_search', { query: 'missing', lang: 'cpp', k: 1, full: true }) : text('Use [[drawCircle]].'));
    const events = []; for await (const ev of answerStream(question, [], 'sketch')) events.push(ev);
    assert.deepEqual(haiku[0].tools, TOOLS.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })));
    assert(haiku[0].messages[0].content.includes('Other possibly related:'));
    assert(haiku[0].system.includes('Fetch [#id]'));
    assert.equal(jev.length, 2); assert.equal(jev[1].state.question, question);
    assert.deepEqual(jev[1].state.trussc_search.queries, ['missing']);
    assert(jev[1].state.cards.some(c => c.text === 'LUA_BODY'));
    assert(!jev[1].state.cards.some(c => c.text === 'CIRCLE_BODY'));
    const event = events.find(e => e.type === 'research');
    assert.deepEqual(Object.keys(event).sort(), ['type', 'round', 'message', 'queries'].sort());
    assert.equal(event.round, 2); assert.deepEqual(event.queries, ['missing']);
    assert.equal(event.message, question === 'circle' ? 'Looking for more documentation.' : '関連する資料を調べます。');
    assert.equal(events.at(-1).traces[1].tool, 'trussc_search');
});
console.log('PASS native search tools/schema, page Lua policy, original question and fallback research shape');

await fixture(async ({ answer, request, haiku, jev, embeds, generate, rows }) => {
    generate((_, n) => n === 1 ? tool('get', 'trussc_get', { ids: ['#symbol:servePage'] }) : text('Use [[servePage]].\n\n@@USED: symbol:servePage'));
    const result = await answer('circle');
    assert(haiku[0].messages[0].content.includes('- servePage — Serve a page. [#symbol:servePage]'));
    assert(haiku[1].messages.at(-1).content[0].content.includes('FETCHED_BODY'));
    assert(result.retrieved.some(c => c.id === 'symbol:servePage'));
    assert(result.usedIds.includes('symbol:servePage'));
    assert(result.links.some(l => l.url.endsWith('/reference/#function:servePage')));
    assert(result.text.includes('/reference/#function:servePage'));
    assert.equal(jev.length, 1); assert.equal(embeds.length, 1);
    assert.equal(result.rounds, 2); assert.equal(result.haikuCalls, 2);
    assert.equal(result.traces[1].tool, 'trussc_get');
    assert.deepEqual(result.traces[1].ids, ['#symbol:servePage']);
    assert.equal(result.jevEstimatedTokens, result.retrievals[0].jevEstimatedTokens);
    haiku.length = 0;
    const response = await request('/chat', { question: 'circle', debug: true });
    assert(!response.data.includes('event: research'));
    assert(response.data.includes('servePage'));
    const row = rows().at(-1);
    assert.equal(row.rounds, 2); assert.equal(row.retrievals[1].tool, 'trussc_get');
    assert.deepEqual(row.retrievals[1].ids, ['#symbol:servePage']);
    assert.deepEqual(row.queries, ['circle']);
    assert.deepEqual(Object.keys(row.retrievals[0]).sort(), Object.keys(row.retrievals[1]).filter(k => !['tool', 'ids'].includes(k)).sort());
});
console.log('PASS get from related list, retrieved/usedIds/links, no research event, stats and rounds');

await fixture(async ({ request, haiku, jev, generate }) => {
    const inputs = [null, [], 'bad', 42];
    generate((_, n) => n === 1 ? inputs.map((input, index) =>
        tool(`rejected${index}`, 'trussc_search', {}, index) +
        frame({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    ).join('') + tool('valid-get', 'trussc_get', { ids: ['symbol:servePage'] }, inputs.length) : text('Done.'));
    const response = await request('/ask', { question: 'circle', debug: true });
    assert.equal(response.status, 200, response.data);
    assert.equal(haiku.length, 2); assert.equal(jev.length, 1);
    const replay = haiku[1].messages.at(-2).content;
    assert.deepEqual(replay.map(block => block.id), ['rejected0', 'rejected1', 'rejected2', 'rejected3', 'valid-get']);
    for (const block of replay.slice(0, -1)) assert.deepEqual(block.input, {});
    assert.deepEqual(replay.at(-1).input, { ids: ['symbol:servePage'] });
    const results = haiku[1].messages.at(-1).content;
    assert.equal(results.length, 5);
    for (const [index, result] of results.entries()) {
        assert.equal(result.tool_use_id, replay[index].id);
        if (index < inputs.length) {
            assert.equal(result.is_error, true);
            assert.equal(result.content, 'call one tool per turn; put several searches into `queries`');
        } else {
            assert(!result.is_error); assert(result.content.includes('FETCHED_BODY'));
        }
    }
});
console.log('PASS rejected null/array/string/number inputs replay as objects beside a valid get');

await fixture(async ({ answer, haiku, jev, generate }) => {
    generate((_, n) => n === 1 ? [
        tool('unknown', 'unknown', {}, 0), tool('invalid', 'trussc_search', { queries: [] }, 1),
        tool('first', 'trussc_get', { ids: ['symbol:servePage'] }, 2),
        tool('later', 'trussc_search', { queries: ['must not run'] }, 3),
        tool('also', 'trussc_get', { ids: ['symbol:drawCircle'] }, 4),
    ].join('') : text('Use [[servePage]].'));
    const result = await answer('circle');
    assert.equal(result.rounds, 2); assert.equal(jev.length, 1);
    const messages = haiku[1].messages;
    assert.deepEqual(messages.at(-2).content.map(c => c.id), ['unknown', 'invalid', 'first', 'later', 'also']);
    const results = messages.at(-1).content;
    assert.equal(results.length, 5);
    for (const r of results) {
        if (r.tool_use_id === 'first') { assert(!r.is_error); assert(r.content.includes('FETCHED_BODY')); }
        else { assert.equal(r.is_error, true); assert.equal(r.content, 'call one tool per turn; put several searches into `queries`'); }
    }
});
for (const [name, input] of [['unknown', {}], ['trussc_search', { queries: [] }], ['trussc_get', { ids: [] }]]) await fixture(async ({ answer, haiku, jev, generate }) => {
    generate((_, n) => n === 1 ? tool('bad', name, input) : text('Use [[drawCircle]].'));
    const result = await answer('circle');
    assert.equal(result.haikuCalls, 2); assert.equal(result.rounds, 1); assert.equal(jev.length, 1); assert(!haiku[1].tools);
});
await fixture(async ({ answer, haiku, jev, generate }) => {
    generate((req, n) => req.tools ? tool(`t${n}`, n === 1 ? 'trussc_get' : 'trussc_search', n === 1 ? { ids: ['symbol:servePage'] } : { queries: ['gap'] }) : text('Use [[servePage]].'));
    const result = await answer('circle');
    assert.equal(result.rounds, 3); assert.equal(result.haikuCalls, 3); assert.equal(jev.length, 2); assert(!haiku.at(-1).tools);
});
await fixture(async ({ answer, haiku, generate }) => {
    const ids = [null, 7, {}, ...Array.from({ length: 21 }, (_, i) => `#symbol:card${i}`)];
    generate((_, n) => n === 1 ? tool('ids', 'trussc_get', { ids }) : text('Done.'));
    const result = await answer('circle');
    assert.deepEqual(result.traces[1].ids, ids.filter(id => typeof id === 'string').slice(0, 20));
    assert(result.retrieved.some(c => c.id === 'symbol:card19'));
    assert(!result.retrieved.some(c => c.id === 'symbol:card20'));
    assert(haiku[1].messages.at(-1).content[0].content.includes('[#symbol:card19]'));
}, { corpus: Array.from({ length: 21 }, (_, i) => ({ ...corpus[0], id: `symbol:card${i}`, title: `card${i}` })) });
await fixture(async ({ answer, haiku, generate }) => {
    generate((_, n) => n === 1 ? tool('missing', 'trussc_get', { ids: ['##symbol:servePage', ' symbol:servePage'] }) : text('Done.'));
    const result = await answer('circle');
    assert.equal(result.traces[1].picked.length, 0, 'only one leading # is stripped; whitespace is significant');
    const content = haiku[1].messages.at(-1).content[0].content;
    assert(content.includes('No chunks found for: ##symbol:servePage,  symbol:servePage'));
});
console.log('PASS first valid tool only, one result per id, invalid recovery and mixed-tool round cap');

// New proxy -> old reply, new proxy -> new reply; legacy question request -> new HTTP is above.
const dir = mkdtempSync(join(tmpdir(), 'docsai-proxy-tools-'));
try {
    for (const response of [cards, { results: cards }, { results: cards, ...info }]) {
        const preload = join(dir, 'preload.mjs'), payload = join(dir, 'payload.json');
        writeFileSync(preload, `import { writeFileSync } from 'node:fs'; globalThis.fetch = async (_, opts) => {writeFileSync(${JSON.stringify(payload)}, opts.body); return Response.json(${JSON.stringify(response)});};`);
        for (const args of [{ query: 'circle', message: 'ignored' }, { queries: ['alpha', 'beta'], message: 'ignored' }, { queries: ['circle'] }]) {
            writeFileSync(join(dir, 'input'), JSON.stringify(rpc(args)) + '\n');
            const fds = [openSync(join(dir, 'input'), 'r'), openSync(join(dir, 'output'), 'w'), openSync(join(dir, 'error'), 'w')];
            let child;
            try { child = spawnSync(process.execPath, ['--import', preload, 'mcp.mjs'], { cwd: process.cwd(), stdio: fds }); }
            finally { fds.forEach(closeSync); }
            assert.equal(child.error, undefined);
            assert.equal(child.status, 0, readFileSync(join(dir, 'error'), 'utf8'));
            const sent = JSON.parse(readFileSync(payload, 'utf8'));
            assert(!Object.hasOwn(sent, 'message'));
            if (args.queries) { assert.deepEqual(sent.queries, args.queries); assert(!Object.hasOwn(sent, 'question')); }
            else { assert.equal(sent.question, 'circle'); assert(!Object.hasOwn(sent, 'queries')); }
            const query = args.query || args.queries.join(' ');
            assert.equal(JSON.parse(readFileSync(join(dir, 'output'), 'utf8')).result.content[0].text, formatSearchResults(cards, query, response));
        }
    }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('PASS stdio forwarding and old/new single-query server compatibility');
