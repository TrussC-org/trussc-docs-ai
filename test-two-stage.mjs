// Entire pipeline uses injected fetch and synthetic vectors; no sockets or services.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

for (const mode of ['plain', 'tool', 'max1', 'max3', 'invalid', 'invalid-message', 'invalid-query', 'invalid-count', 'invalid-json', 'invalid-name', 'rerank', 'rate', 'pool', 'ollama', 'default', 'budget', 'request-rate']) {
    Object.assign(process.env, {
        TYPESAFE_API_KEY: 'synthetic-jev-secret', ANTHROPIC_API_KEY: 'synthetic-haiku-secret',
        GEN_BACKEND: mode === 'ollama' ? 'ollama' : 'anthropic', RETRIEVAL: mode === 'rerank' ? 'rerank' : 'jev',
        MAX_SEARCH_ROUNDS: mode === 'max1' ? '1' : mode === 'max3' ? '3' : '2',
        JEV_RATE_MAX: mode === 'rate' ? '2' : '1000', JEV_DAILY_TOKENS: mode === 'budget' ? '1' : '100000000',
        JEV_POOL_TOKENS: mode === 'pool' ? '100000' : '28000', JEV_CARD_CHARS: mode === 'pool' ? '100000' : '2000',
        RERANK: '1', STATS: '1', RATE_MAX: mode === 'request-rate' ? '5' : '1000', HYBRID: '1',
        JEV_URL: 'https://stub.invalid/systemone', JEV_MODEL: 'jev-latest',
        JEV_TOKENS_PER_CHAR: '.4', JEV_TIMEOUT_MS: '3000', JEV_RATE_WIN_MS: '60000',
        JEV_PICK: 'threshold', JEV_PICK_K: '8', JEV_PICK_MIN_P: '.4', JEV_PICK_MIN: '4', JEV_PICK_MAX: '16', JEV_SEARCH_HINT_BELOW: '.7',
    });
    if (mode === 'default') delete process.env.MAX_SEARCH_ROUNDS;
    await runMode(mode);
}
await testRoundPools();
{
    // Exercise the actual inline harness, including disabled controls across research.
    const elements = new Map(); let submit;
    const el = id => { if (!elements.has(id)) elements.set(id, { textContent: '', value: 'circle', disabled: false, children: [], append(...x) { this.children.push(...x); }, focus() {}, addEventListener(_, f) { submit = f; } }); return elements.get(id); };
    const html = readFileSync(new URL('./demo.html', import.meta.url), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const encoder = new TextEncoder(); let streamController;
    let body = new ReadableStream({ start(c) { streamController = c; } });
    vm.runInNewContext(script, {
        document: { getElementById: el, createElement: () => ({ children: [], style: {}, append(...x) { this.children.push(...x); } }) },
        navigator: { language: 'ja' }, TextDecoder,
        fetch: async path => path === '/health' ? { json: async () => ({ ok: true, chunks: 1 }) } : { ok: true, body },
    });
    const running = submit({ preventDefault() {} });
    await new Promise(r => setImmediate(r));
    streamController.enqueue(encoder.encode('event: research\ndata: {"round":2,"message":"調べます","queries":["drawCircle"]}\n\n'));
    await new Promise(r => setImmediate(r));
    assert(el('send').disabled && el('question').disabled); assert.equal(el('research').children.length, 1);
    assert(el('research').children[0].children[1].textContent.includes('再検索中'));
    streamController.enqueue(encoder.encode('event: token\ndata: "answer"\n\nevent: done\ndata: {}\n\n')); streamController.close();
    await running; assert(!el('send').disabled && !el('question').disabled); assert.equal(el('answer').textContent, 'answer');
    body = new ReadableStream({ start(c) { streamController = c; } });
    const failing = submit({ preventDefault() {} });
    await new Promise(r => setImmediate(r)); assert(el('send').disabled);
    streamController.enqueue(encoder.encode('event: error\ndata: "test failure"\n\n')); streamController.close();
    await failing; assert(!el('send').disabled && !el('question').disabled); assert(el('answer').textContent.includes('test failure'));
    console.log('PASS demo research rendering and disabled controls through done/error');
}

async function runMode(mode) {
const dir = mkdtempSync(join(tmpdir(), 'docsai-two-stage-'));
try {
    // Separate module graphs exercise real env-based configuration without child processes.
    for (const name of ['config.mjs', 'rag.mjs', 'jev.mjs', 'stats.mjs', 'server.mjs', 'mcp-core.mjs', 'debug.mjs']) writeFileSync(join(dir, name), readFileSync(new URL(name, import.meta.url)));
    process.env.STATS_LOG = join(dir, 'stats.jsonl');
    const statRows = () => readFileSync(process.env.STATS_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const corpus = [
        { id: 'symbol:drawCircle', title: 'drawCircle', source: 'reference', lang: 'cpp', meta: { kind: 'function' }, text: 'drawCircle draws a circle.', vector: [1, 0] },
        ...Array.from({ length: 7 }, (_, i) => ({ id: `example:${i}`, title: `circle example ${i}`, source: 'example', text: 'drawCircle example', vector: [1, .1] })),
        { id: 'issue:1', title: 'circle issue', source: 'issue', text: 'Unrelated known issue', meta: { number: 1 }, vector: [1, .2] },
        { id: 'lua:drawCircle', title: 'drawCircle', source: 'reference', lang: 'lua', text: 'Lua circle', vector: [1, 0] },
    ];
    if (mode === 'pool') for (const c of corpus) c.text = 'x'.repeat(90000);
    process.env.EMBEDDED = join(dir, 'corpus.json'); writeFileSync(process.env.EMBEDDED, JSON.stringify(corpus));
    let jevCalls = 0, haikuCalls = [], rerankCalls = 0, embeds = [], jevProbabilities = new Map();
    const frames = data => `data: ${JSON.stringify(data)}\n\n`;
    globalThis.fetch = async (url, options) => {
        const req = JSON.parse(options.body);
        if (url.endsWith('/api/embed')) { embeds.push(req.input); return Response.json({ embeddings: [[1, 0]] }); }
        if (url.endsWith('/rerank')) { rerankCalls++; return Response.json({ results: req.texts.map((_, index) => ({ index, score: index === 0 ? 1 : 0.001 })) }); }
        if (url.endsWith('/systemone')) {
            jevCalls++; assert.equal(req.state.question, 'circle');
            assert(!req.state.cards.some(c => c.text.includes('Lua')));
            jevProbabilities = new Map(req.state.cards.map((c, i) => [c.title, i === 0 ? .99 : .8]));
            return Response.json({ answers: { ...Object.fromEntries(req.state.cards.map((c) => [c.card, { noul: jevProbabilities.get(c.title) }])), exists: { noul: .3 } }, usage: { total_tokens: 123, secret: 'usage-key-must-not-leak' } });
        }
        if (url.endsWith('/api/chat')) {
            assert.equal(mode, 'ollama');
            return new Response(JSON.stringify({ message: { content: 'Use drawCircle.' } }) + '\n');
        }
        assert.equal(url, 'https://api.anthropic.com/v1/messages');
        haikuCalls.push(req);
        assert.equal(JSON.stringify(req.messages).includes('Jev coverage estimate:'), !['rerank', 'rate', 'pool', 'budget'].includes(mode));
        const tool = !['plain', 'rerank', 'rate', 'pool', 'budget', 'request-rate'].includes(mode) && req.tools;
        let content = frames({ type: 'message_start', message: { usage: { input_tokens: 101, output_tokens: 0 } } });
        if (tool) {
            // Text accompanying a tool call must never reach the user.
            content += frames({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MUST NOT LEAK' } });
            content += frames({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `tool${haikuCalls.length}`, name: mode === 'invalid-name' ? 'other' : 'search_more', input: {} } });
            const input = { message: mode === 'invalid-message' ? 'x'.repeat(301) : '調べます', queries: mode === 'invalid' ? [] : mode === 'invalid-count' ? ['a','b','c','d'] : mode === 'invalid-query' ? ['x'.repeat(201)] : ['drawCircle'] };
            const json = mode === 'invalid-json' ? '{broken' : JSON.stringify(input);
            for (const partial_json of [json.slice(0, 5), json.slice(5)]) content += frames({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } });
        } else content += frames({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Use [[drawCircle]].\n\n@@USED: symbol:drawCircle' } });
        content += frames({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 17 } });
        content += frames({ type: 'message_stop' });
        // Split SSE frames across network chunks.
        const bytes = new TextEncoder().encode(content);
        return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 73)); c.enqueue(bytes.slice(73)); c.close(); } }));
    };
    const { answerStream, mergeSelections, buildPool, retrieve, retrievalInfo } = await import(join(dir, 'rag.mjs'));
    assert.equal(mergeSelections([{ id: 'x', p: .1 }, { id: 'y', p: .8 }], [{ id: 'x', p: .9 }]).length, 2);
    assert.equal(mergeSelections([{ id: 'x', p: .8 }], [{ id: 'x', p: .1 }])[0].p, .8);
    const pool = buildPool(corpus, 'circle');
    if (mode !== 'pool') assert(pool.length === corpus.length);
    const many = Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: 'card', text: 'x'.repeat(4000) }));
    if (mode !== 'pool') {
        const bounded = buildPool(many, 'circle');
        const { stateTokens } = await import(join(dir, 'jev.mjs'));
        assert(stateTokens('circle', bounded) <= 28000);
        assert(stateTokens('circle', [...bounded, many[bounded.length]]) > 28000);
        assert.deepEqual(bounded.map(c => c.id), many.slice(0, bounded.length).map(c => c.id));
    }
    const { server } = await import(join(dir, 'server.mjs'));
    const request = (path, body) => new Promise((resolve, reject) => {
        const req = new PassThrough(); req.method = 'POST'; req.url = path; req.headers = { 'cf-connecting-ip': '203.0.113.99' }; req.socket = { remoteAddress: 'test-client' };
        const res = new EventEmitter(); res.status = 200; res.headers = {}; res.data = '';
        res.setHeader = (key, value) => { res.headers[key] = value; };
        res.writeHead = (status, headers) => { res.status = status; Object.assign(res.headers, headers); };
        res.write = value => { res.data += value; return true; };
        res.end = value => { if (value) res.data += value; resolve(res); };
        server.emit('request', req, res); req.end(JSON.stringify(body));
    });
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'trussc_search', arguments: { query: 'circle' } } };
    let res = await request('/search', { question: 'circle' }); assert.equal(res.status, 200);
    let search = JSON.parse(res.data);
    const fallback = ['rerank', 'pool', 'budget'].includes(mode);
    assert.equal(search.path, fallback ? 'fallback' : 'jev');
    assert(!('fallbackReason' in search));
    if (fallback) assert.equal(statRows().at(-1).fallbackReason, mode === 'rerank' ? 'operator' : mode);
    if (!fallback) { assert.equal(rerankCalls, 0); assert.equal(search.results.filter(c => c.source === 'example').length, 7); }
    else { assert(rerankCalls > 0); assert(search.results.filter(c => c.source === 'example').length <= 3); assert(!search.results.some(c => c.source === 'issue')); }
    const beforeHaiku = haikuCalls.length, beforeJev = jevCalls;
    res = await request('/mcp', rpc); assert.equal(res.status, 200); assert(!JSON.parse(res.data).result.isError);
    assert.equal(haikuCalls.length, beforeHaiku); assert.equal(jevCalls, beforeJev + (fallback ? 0 : 1));
    if (mode === 'rate') {
        res = await request('/search', { question: 'circle' });
        assert(!('fallbackReason' in JSON.parse(res.data))); assert.equal(statRows().at(-1).fallbackReason, 'rate'); assert.equal(jevCalls, 2);
    }
    res = await request('/ask', { question: 'circle', debug: true, rounds: mode === 'max1' ? 10 : 1 }); assert.equal(res.status, 200, res.data);
    const result = JSON.parse(res.data);
    const rounds = ['max3', 'default'].includes(mode) ? 3 : mode === 'tool' ? 2 : 1;
    assert.equal(result.rounds, rounds);
    assertTrace(result.debug, rounds);
    assert.equal(statRows().at(-1).debug, true);
    if (mode !== 'ollama') {
        assert.equal(result.debug.rounds[0].haiku.inputTokens, mode.startsWith('invalid') ? 202 : 101);
        assert.equal(result.debug.rounds[0].haiku.outputTokens, mode.startsWith('invalid') ? 34 : 17);
    }
    if (!fallback && mode !== 'rate') assert.equal(result.debug.rounds[0].jev.tokens, 123);
    if (['rate', 'budget'].includes(mode)) {
        assert.equal(result.debug.rounds[0].path, 'fallback');
        assert.equal(statRows().at(-1).fallbackReason, mode);
    } assert.equal(result.queries.length, rounds);
    assert(result.answer.includes('drawCircle')); assert(!result.answer.includes('@@USED')); assert(!result.answer.includes('MUST NOT LEAK'));
    if (mode !== 'ollama') assert(result.usedIds.includes('symbol:drawCircle'));
    if (mode === 'max1') assert(haikuCalls.every(r => !r.tools));
    if (mode === 'tool' || ['max3', 'default'].includes(mode)) {
        assert.equal(result.debug.rounds[0].message, '調べます');
        assert.equal(result.debug.rounds.at(-1).message, null);
        assert.deepEqual(result.debug.rounds[1].queries, ['circle', 'drawCircle']);
        assert(haikuCalls[0].tools); assert(!haikuCalls.at(-1).tools);
        const last = haikuCalls.at(-1).messages;
        assert(last.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')));
        for (const [i, call] of haikuCalls.entries()) {
            assert.deepEqual(call.messages[0], haikuCalls[0].messages[0]);
            if (i) assert.deepEqual(call.messages.slice(0, haikuCalls[i - 1].messages.length), haikuCalls[i - 1].messages);
        }
        const toolResult = last.find(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')).content[0];
        assert.equal(toolResult.tool_use_id, 'tool1');
        assert(toolResult.content.includes('[#symbol:drawCircle] already shown above'));
        assert(!toolResult.content.includes('drawCircle draws a circle.'));
        assert.equal(JSON.stringify(last).split('drawCircle draws a circle.').length - 1, 1);
        if (['max3', 'default'].includes(mode)) assert(haikuCalls[1].messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')));
        assert(embeds.includes('drawCircle')); assert.equal(embeds[0], 'circle');
    }
    if (mode.startsWith('invalid')) { assert.equal(haikuCalls.length, 2); assert(!haikuCalls[1].tools); assert.equal(result.queries.length, 1); }
    res = await request('/chat', { question: 'circle', debug: true, rounds: mode === 'max1' ? 10 : 1 });
    const events = res.data.trim().split('\n\n').map(frame => { const lines = frame.split('\n'); return { type: lines[0].slice(7), data: JSON.parse(lines[1].slice(6)) }; });
    assert.equal(events.at(-2).type, 'debug');
    assertTrace(events.at(-2).data, rounds);
    assert.equal(statRows().at(-1).debug, true);
    assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).data.rounds, rounds);
    assert(!res.data.includes('MUST NOT LEAK')); assert(!res.data.includes('@@USED'));
    const research = events.filter(e => e.type === 'research'); assert.equal(research.length, rounds - 1);
    if (rounds > 1) {
        assert(events.findIndex(e => e.type === 'research') < events.findIndex(e => e.type === 'token'));
        assert.equal(research[0].data.round, 2); assert.equal(research[0].data.message, '調べます');
        const all = []; for await (const e of answerStream('circle')) all.push(e);
        const selected = all.filter(e => e.type === 'meta').at(-1).retrieved;
        assert.equal(selected.length, new Set(selected.map(c => c.id)).size);
    }
    if (mode === 'plain') {
        const pinned = [];
        for await (const ev of answerStream('circle', [], 'function:drawCircle', ['symbol:drawCircle'])) pinned.push(ev);
        const selected = pinned.find(ev => ev.type === 'meta').retrieved;
        assert.equal(selected.filter(c => c.id === 'symbol:drawCircle').length, 1);
        assert.equal(selected.find(c => c.id === 'symbol:drawCircle').p, jevProbabilities.get('drawCircle'));
    }
    if (mode === 'rerank') assert.equal(jevCalls, 0);
    if (mode === 'request-rate' || mode === 'plain') {
        res = await request('/ask', { question: 'circle', debug: 'true', rounds: 10 });
        assert.equal(res.status, 200); assert(!('debug' in JSON.parse(res.data)));
        assert(!('debug' in statRows().at(-1)));
        if (mode === 'plain') {
            const chat = await request('/chat', { question: 'circle' });
            assert(!chat.data.includes('event: debug'));
        }
        if (mode === 'request-rate') {
            res = await request('/ask', { question: 'circle', debug: true });
            assert.equal(res.status, 429);
        }
    }
    console.log(`PASS pipeline ${mode}`);
} finally { rmSync(dir, { recursive: true, force: true }); }

}

async function testRoundPools() {
    const savedEnv = { ...process.env }, savedFetch = globalThis.fetch;
    const dir = mkdtempSync(join(tmpdir(), 'docsai-round-pools-'));
    try {
        Object.assign(process.env, { RETRIEVAL: 'jev', MAX_SEARCH_ROUNDS: '2', GEN_BACKEND: 'anthropic',
            JEV_POOL_TOKENS: '28000', JEV_CARD_CHARS: '2000', JEV_RATE_MAX: '1000', JEV_DAILY_TOKENS: '20000000' });
        const corpus = [
            { id: 'symbol:drawCircle', title: 'drawCircle', text: 'ORIGINAL_CARD draws a circle.', source: 'reference', meta: { kind: 'function' }, vector: [0, 0, 1] },
            ...['A', 'B'].flatMap(group => Array.from({ length: group === 'A' ? 160 : 30 }, (_, i) => ({
                id: `${group}:${i}`, title: 'entry', source: 'concept', lang: 'cpp',
                text: (group === 'A' && i === 25 ? 'ONLY_ROUND_ONE ' : `${group}_CARD `) + 'x'.repeat(2000),
                vector: group === 'A' ? [1, 0, 0] : [0, 1, 0],
            }))),
            { id: 'lua:hidden', title: 'Lua entry', text: 'HIDDEN_LUA', lang: 'lua', vector: [0, 1, 0] },
            { id: 'symbol:inherited', title: 'Inherited entry', text: 'INHERITED_STUB', meta: { base: 'drawCircle' }, vector: [0, 1, 0] },
        ];
        process.env.EMBEDDED = join(dir, 'corpus.json');
        writeFileSync(process.env.EMBEDDED, JSON.stringify(corpus));
        for (const name of ['config.mjs', 'rag.mjs', 'jev.mjs']) writeFileSync(join(dir, name), readFileSync(new URL(name, import.meta.url)));
        const jev = [], haiku = [], queries = ['alpha', 'beta'], message = 'Find both missing details.';
        globalThis.fetch = async (url, options) => {
            const req = JSON.parse(options.body);
            if (url.endsWith('/api/embed')) return Response.json({ embeddings: [{ circle: [0, 0, 1], alpha: [1, 0, 0], beta: [0, 1, 0] }[req.input]] });
            if (url.endsWith('/systemone')) {
                jev.push(req);
                return Response.json({ answers: { ...Object.fromEntries(req.state.cards.map(card => [card.card, { noul:
                    jev.length === 1 ? (card.text.includes('ONLY_ROUND_ONE') ? .99 : card.title === 'drawCircle' ? .9 : .01) : .8 }])), exists: { noul: .2 } } });
            }
            assert.equal(url, 'https://api.anthropic.com/v1/messages');
            haiku.push(req);
            const frame = value => `data: ${JSON.stringify(value)}\n\n`;
            return new Response((haiku.length === 1
                ? frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'gap-tool', name: 'search_more', input: { message, queries } } })
                : frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Use [[drawCircle]].\n\n@@USED: A:25, B:0, symbol:drawCircle' } }))
                + frame({ type: 'message_stop' }));
        };
        const { answer, buildPool, buildRoundPool, retrieveMulti } = await import(join(dir, 'rag.mjs'));
        const { stateTokens, perQuestionTokens } = await import(join(dir, 'jev.mjs'));
        const searchMore = { message, queries };
        const result = await answer('circle');
        assert.equal(jev.length, 2, 'one Jev call per round');
        assert.deepEqual(Object.keys(jev[0].state).sort(), ['cards', 'question']);
        assert.equal(jev[1].state.question, 'circle');
        assert.deepEqual(jev[1].state.search_more, searchMore);
        assert(jev[0].state.cards.some(card => card.text.includes('ONLY_ROUND_ONE')));
        assert(!jev[1].state.cards.some(card => card.text.includes('ONLY_ROUND_ONE')), 'no carried picks in gap state');
        assert(jev[1].state.cards.some(card => card.text.startsWith('B_CARD')), 'query B survives many strong A matches');
        assert(!JSON.stringify(jev[1]).includes('HIDDEN_LUA'));
        assert(!JSON.stringify(jev[1]).includes('INHERITED_STUB'));
        assert(jev[1].questions.c1.instructions.includes('state.search_more'));
        assert(stateTokens('circle', result.traces[1].picked, undefined, searchMore) <= 28000);
        assert(JSON.stringify(jev[1].state).length * .4 <= 28000);
        assert(result.traces[1].info.poolSize === jev[1].state.cards.length);
        assert(!result.traces[1].picked.some(card => card.id === 'A:25'));
        assert(result.usedIds.includes('A:25') && result.usedIds.includes('B:0'), 'used IDs resolve across all rounds');
        assert(result.text.includes('/reference/'));
        assert.deepEqual(haiku[1].messages[0], haiku[0].messages[0], 'round-1 user turn stays intact');
        assert(!haiku[1].tools);
        assert.deepEqual(haiku[1].messages[1], { role: 'assistant', content: [{ type: 'tool_use', id: 'gap-tool', name: 'search_more', input: searchMore }] });
        const toolResult = haiku[1].messages[2].content[0];
        assert.equal(toolResult.type, 'tool_result'); assert.equal(toolResult.tool_use_id, 'gap-tool');
        assert(toolResult.content.includes('B_CARD') && toolResult.content.includes('Jev coverage estimate: 0.20.'));
        assert(toolResult.content.includes('[#symbol:drawCircle] already shown above'));
        assert.equal(JSON.stringify(haiku[1].messages).split('ORIGINAL_CARD').length - 1, 1);
        assert.equal(jev[1].state.cards[0].title, 'drawCircle', 'original question pool comes first');
        // The old fused pool loses B on this corpus; the independent pool above does not.
        await retrieveMulti(['circle', ...queries], 8, { question: 'circle' });
        assert(!jev[2].state.cards.some(card => card.text.startsWith('B_CARD')));

        const pools = ['original', 'A', 'B'].map(prefix => Array.from({ length: 100 }, (_, i) => ({ id: `${prefix}:${i}`, title: 'same', text: 'x'.repeat(2000) })));
        const pool = buildRoundPool(pools, 'circle', searchMore);
        const counts = pools.map(part => pool.filter(card => part.some(c => c.id === card.id)).length);
        assert(counts.every(n => n === counts[0] && n > 0), 'equal per-pool shares');
        const overhead = stateTokens('circle', [], undefined, searchMore);
        const share = (28000 - overhead) / 3;
        let prefix = [];
        for (const [i, part] of pools.entries()) {
            const before = stateTokens('circle', prefix, undefined, searchMore);
            const selected = part.slice(0, counts[i]);
            assert(stateTokens('circle', [...prefix, ...selected], undefined, searchMore) - before <= share);
            assert(stateTokens('circle', [...prefix, ...selected, part[counts[i]]], undefined, searchMore) - before > share, 'each share fills in its RRF order');
            prefix.push(...selected);
        }
        assert(stateTokens('circle', pool, undefined, searchMore) <= 28000);
        assert(perQuestionTokens('circle', pool, undefined, searchMore) <= 32000);
        const overlap = buildRoundPool([[{ ...pools[0][0], score: .1 }], [{ ...pools[0][0], score: .9 }]], 'circle', searchMore);
        assert.equal(overlap.length, 1); assert.equal(overlap[0].score, .1, 'first occurrence keeps its slot');
        assert.equal(buildRoundPool(pools, 'x'.repeat(100000), searchMore).length, 0);
        assert(buildPool(pools[0], 'circle').length > counts[0]);

        // Raising the configured budget cannot exceed Jev's per-question limit.
        const largeDir = join(dir, 'large');
        const { mkdirSync } = await import('node:fs'); mkdirSync(largeDir);
        for (const name of ['config.mjs', 'rag.mjs', 'jev.mjs']) writeFileSync(join(largeDir, name), readFileSync(new URL(name, import.meta.url)));
        process.env.JEV_POOL_TOKENS = '100000';
        const large = await import(join(largeDir, 'rag.mjs'));
        const capped = large.buildRoundPool(pools, 'circle', searchMore);
        assert(stateTokens('circle', capped, undefined, searchMore) <= 32000);
        assert(perQuestionTokens('circle', capped, undefined, searchMore) <= 32000);
        console.log('PASS separate RRF pools, equal shares, ordering/dedupe, budget/32k, no carry, native history and cross-round used IDs');
    } finally {
        globalThis.fetch = savedFetch;
        for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
        Object.assign(process.env, savedEnv);
        rmSync(dir, { recursive: true, force: true });
    }
}

// Exact key snapshots at every object level of the public trace, including nulls.
function assertTrace(debug, rounds) {
    const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.slice().sort());
    keys(debug, ['haikuCalls', 'idOnlyCardsTotal', 'rounds']); assert.equal(typeof debug.haikuCalls, 'number'); assert.equal(debug.rounds.length, rounds);
    for (const round of debug.rounds) {
        keys(round, ['idOnlyCards', 'queries', 'poolSize', 'picked', 'exists', 'hintShown', 'hintFollowed', 'path', 'haiku', 'jev', 'message']);
        keys(round.haiku, ['estInputTokens', 'ms', 'inputTokens', 'outputTokens']);
        keys(round.jev, ['ms', 'tokens']);
        assert(['jev', 'fallback'].includes(round.path));
        for (const card of round.picked) keys(card, ['id', 'title', 'p']);
        assert(round.queries.every(q => typeof q === 'string'));
        assert(Number.isInteger(round.poolSize) && round.poolSize >= 0);
        assert(round.haiku.ms >= 0 && round.jev.ms >= 0);
    }
    assert(!/reason|budget|rate|prompt|key|secret|203\.0\.113|test-client|MUST NOT LEAK|drawCircle draws a circle|\/tmp\//i.test(JSON.stringify(debug)));
}
