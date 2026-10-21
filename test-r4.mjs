// Round-4 regressions: synthetic corpus and in-memory transports only.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const stop = frame({ type: 'message_stop' });
const text = value => frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } });
const tool = (id, input = { message: 'Look again', queries: ['gap'] }) => frame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name: 'search_more', input } });
const baseCard = { id: 'symbol:drawCircle', title: 'drawCircle', source: 'reference', text: 'drawCircle draws a circle.', meta: { kind: 'function' }, vector: [1, 0] };
async function fixture(options, test) {
    const env = { ...process.env }, savedFetch = globalThis.fetch;
    const dir = mkdtempSync(join(tmpdir(), 'docsai-r4-'));
    const calls = [], output = [], savedConsole = { log: console.log, warn: console.warn, error: console.error };
    try {
        Object.assign(process.env, { TYPESAFE_API_KEY: 'fake-selector', ANTHROPIC_API_KEY: 'fake-generator',
            GEN_BACKEND: 'anthropic', RETRIEVAL: 'jev', HYBRID: '1', RERANK: '0', REF_BASE: 'https://trussc.org',
            MAX_SEARCH_ROUNDS: '3', JEV_PICK_MIN: '16', JEV_PICK_MAX: '16', JEV_RATE_MAX: '1000', JEV_DAILY_TOKENS: '100000000',
            JEV_POOL_TOKENS: '28000', JEV_CARD_CHARS: '2000', JEV_TOKENS_PER_CHAR: '.4', JEV_SEARCH_HINT_BELOW: '.7',
            HAIKU_TIMEOUT_MS: '1000', HAIKU_MAX_RESPONSE_BYTES: '1048576', HAIKU_CARD_CHARS: '8000', HAIKU_MAX_INPUT_TOKENS: '24000',
            STATS: '1', RATE_MAX: '1000', EMBEDDED: join(dir, 'corpus.json'), STATS_LOG: join(dir, 'stats.jsonl'), ...options.env });
        writeFileSync(process.env.EMBEDDED, JSON.stringify(options.corpus || [baseCard]));
        for (const name of ['config.mjs', 'rag.mjs', 'jev.mjs', 'server.mjs', 'mcp-core.mjs', 'stats.mjs', 'debug.mjs'])
            writeFileSync(join(dir, name), readFileSync(new URL(name, import.meta.url)));
        for (const k of Object.keys(savedConsole)) console[k] = (...args) => output.push(args.join(' '));
        globalThis.fetch = async (url, opts) => {
            const req = JSON.parse(opts.body);
            if (url.endsWith('/api/embed')) return Response.json({ embeddings: [[1, 0]] });
            if (url.endsWith('/systemone')) {
                if (options.jev) return options.jev(opts);
                return Response.json({ answers: { ...Object.fromEntries(req.state.cards.map((c, i) => [c.card, { noul: options.probability?.(c, i, calls.length) ?? .9 }])), exists: { noul: typeof options.exists === 'function' ? options.exists(calls.length) : options.exists ?? .1 } } });
            }
            assert.equal(url, 'https://api.anthropic.com/v1/messages'); calls.push(req);
            return options.generate ? options.generate(req, opts, calls.length) : new Response(text('Use [[drawCircle]].') + stop);
        };
        const rag = await import(join(dir, 'rag.mjs'));
        const { server } = await import(join(dir, 'server.mjs'));
        const request = (path, body = { question: 'circle', debug: true }) => new Promise(resolve => {
            const req = new PassThrough(); Object.assign(req, { method: 'POST', url: path, headers: {}, socket: { remoteAddress: 'fixture' } });
            const res = new EventEmitter(); Object.assign(res, { status: 200, data: '', setHeader() {}, writeHead(status) { this.status = status; }, write(data) { this.data += data; return true; }, end(data = '') { this.data += data; resolve(this); } });
            server.emit('request', req, res); req.end(JSON.stringify(body));
        });
        const rows = () => { try { return readFileSync(process.env.STATS_LOG, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
        const { selectCards } = await import(join(dir, 'jev.mjs'));
        await test({ ...rag, selectCards, request, calls, output, rows });
    } finally {
        globalThis.fetch = savedFetch; Object.assign(console, savedConsole);
        for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
        Object.assign(process.env, env); rmSync(dir, { recursive: true, force: true });
    }
}
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
for (const exists of [.29, .88, .70, 0, null]) test(`coverage hint in initial and search-result prompts: ${exists}`, async () => {
    await fixture({ exists, env: exists === null ? { TYPESAFE_API_KEY: '' } : {},
        generate: (_, __, n) => new Response((n === 1 ? tool('coverage') : text('Use [[drawCircle]].')) + stop) }, async ({ request, calls, rows }) => {
        const response = await request('/ask'); assert.equal(response.status, 200, response.data);
        const debug = JSON.parse(response.data).debug, stat = rows().at(-1);
        assert.equal(calls.length, 2);
        for (const [i, req] of calls.entries()) {
            assert.equal(req.tool_choice, undefined);
            const content = req.messages.at(-1).content;
            const prompt = typeof content === 'string' ? content : content[0].content;
            const hintShown = exists !== null && exists < .7;
            assert.equal(prompt.includes('An independent relevance checker estimates'), exists !== null);
            if (exists !== null) assert(prompt.includes(`cover about ${Math.round(exists * 100)}% of what is needed to answer every part of the question.`));
            const recommendation = "Instead of answering now, call search_more to look for the missing parts (for example a separate feature or library the question combines), unless the question does not need TrussC documentation (off-topic chat, greetings).";
            assert.equal(prompt.includes(recommendation), hintShown);
            assert(!prompt.includes('answer-exists probability'));
            if (i) assert(prompt.startsWith('Search completed.'));
            // The hint ends the initial turn and sits right before the answer instruction in a tool result.
            if (exists !== null) {
                const hint = prompt.slice(prompt.indexOf('An independent relevance checker'));
                if (i) assert(hint.split('\n')[1]?.startsWith('Answer the original question'), 'hint precedes the answer instruction');
                else assert(!hint.includes('\n'), 'hint ends the initial user turn');
            }
            const expected = { exists, hintShown, hintFollowed: hintShown ? i === 0 : null };
            for (const record of [debug.rounds[i], stat.retrievals[i]]) {
                for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value, `${key} round ${i + 1}`);
            }
        }
    });
});
test('configured hint threshold is honoured', async () => {
    for (const [threshold, exists, hintShown] of [[.2, .29, false], [.9, .88, true], [.29, .29, false]]) {
        await fixture({ exists, env: { JEV_SEARCH_HINT_BELOW: String(threshold) } }, async ({ request, calls, rows }) => {
            const response = await request('/ask'); assert.equal(response.status, 200);
            const prompt = calls[0].messages.at(-1).content;
            assert(prompt.includes(`cover about ${Math.round(exists * 100)}% of what is needed`));
            assert.equal(prompt.includes('Instead of answering now, call search_more'), hintShown);
            assert.equal(JSON.parse(response.data).debug.rounds[0].hintShown, hintShown);
            assert.equal(rows().at(-1).retrievals[0].hintShown, hintShown);
        });
    }
});
test('off-topic answer can decline a low-coverage search recommendation', async () => {
    await fixture({ exists: .29, generate: () => new Response(text('Hello!') + stop) }, async ({ request, calls, rows }) => {
        const response = await request('/ask', { question: 'Hello!', debug: true });
        assert.equal(response.status, 200);
        const result = JSON.parse(response.data), stat = rows().at(-1);
        assert.equal(result.answer, 'Hello!'); assert.equal(calls.length, 1);
        assert(calls[0].tools, 'Haiku must be free to choose search_more');
        const messageSchema = calls[0].tools[0].input_schema.properties.message;
        assert(messageSchema.description.startsWith('One short line shown to the user while you search, written in the same language as the user\'s question (an English question gets English, Japanese gets Japanese)'));
        assert.equal(messageSchema.maxLength, 300);
        assert.equal(result.debug.rounds.length, 1); assert.equal(stat.rounds, 1);
        for (const record of [result.debug.rounds[0], stat.retrievals[0]]) {
            assert.equal(record.exists, .29); assert.equal(record.hintShown, true); assert.equal(record.hintFollowed, false);
        }
    });
});
test('each round uses its current coverage estimate and hint decision', async () => {
    await fixture({ exists: n => n === 0 ? .29 : n === 1 ? .88 : .1,
        generate: (_, __, n) => new Response((n < 3 ? tool(`coverage${n}`) : text('Use [[drawCircle]].')) + stop) }, async ({ request, calls, rows }) => {
        const response = await request('/ask'); assert.equal(response.status, 200);
        const debug = JSON.parse(response.data).debug, stat = rows().at(-1);
        assert.equal(calls.length, 3);
        for (const [i, exists] of [.29, .88, .1].entries()) {
            const content = calls[i].messages.at(-1).content;
            const prompt = typeof content === 'string' ? content : content[0].content;
            assert(prompt.includes(`cover about ${Math.round(exists * 100)}% of what is needed`));
            // Round 3 is the last (MAX_SEARCH_ROUNDS=3): search_more is not offered, so it is not recommended.
            assert.equal(prompt.includes('Instead of answering now, call search_more'), i === 0);
            for (const record of [debug.rounds[i], stat.retrievals[i]]) {
                assert.equal(record.exists, exists); assert.equal(record.hintShown, i === 0);
                assert.equal(record.hintFollowed, i === 0 ? true : null);
            }
        }
    });
});
test('no recommendation when search_more is not offered (single round)', async () => {
    await fixture({ exists: .29, env: { MAX_SEARCH_ROUNDS: '1' }, generate: () => new Response(text('Use [[drawCircle]].') + stop) }, async ({ request, calls, rows }) => {
        const response = await request('/ask'); assert.equal(response.status, 200, response.data);
        assert.equal(calls.length, 1); assert.equal(calls[0].tools, undefined);
        const prompt = calls[0].messages.at(-1).content;
        assert(prompt.includes('cover about 29% of what is needed'));
        assert(!prompt.includes('Instead of answering now, call search_more'));
        for (const record of [JSON.parse(response.data).debug.rounds[0], rows().at(-1).retrievals[0]]) {
            assert.equal(record.hintShown, false); assert.equal(record.hintFollowed, null);
        }
    });
});
test('invalid-tool recovery stays out of the hint metric', async () => {
    await fixture({ exists: .29, generate: (req, _, n) => new Response((n === 1 ? tool('bad', { message: '', queries: [] }) : text('Use [[drawCircle]].')) + stop) }, async ({ request, calls, rows }) => {
        const response = await request('/ask'); assert.equal(response.status, 200, response.data);
        assert.equal(calls.length, 2); assert(calls[0].tools); assert.equal(calls[1].tools, undefined);
        assert(calls[0].messages.at(-1).content.includes('Instead of answering now, call search_more'));
        for (const record of [JSON.parse(response.data).debug.rounds[0], rows().at(-1).retrievals[0]]) {
            assert.equal(record.hintShown, true); assert.equal(record.hintFollowed, null);
        }
    });
});
test('implicit used IDs in ask/chat, including correction', async () => {
    for (const correction of [false, true]) await fixture({ corpus: [baseCard, { ...baseCard, id: 'symbol:Node', title: 'Node', meta: { kind: 'type' } }],
        generate: (_, __, n) => new Response(text(correction && n % 2 ? 'Node::invented' : 'Use [[drawCircle]].') + stop) }, async ({ request }) => {
        const ask = await request('/ask'); assert(JSON.parse(ask.data).usedIds.includes(baseCard.id));
        const chat = await request('/chat'); const done = chat.data.match(/event: done\ndata: ([^\n]+)/);
        assert(done && JSON.parse(done[1]).usedIds.includes(baseCard.id));
    });
});
test('message_stop cancels an open upstream body immediately', async () => {
    let cancelled = false, controller;
    await fixture({ generate: () => new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(text('Use [[drawCircle]].') + stop)); }, cancel() { cancelled = true; } })) }, async ({ answer }) => {
        let settled = false;
        const result = answer('circle').then(r => { settled = true; return r; });
        await new Promise(r => setTimeout(r, 100));
        // Close only to release a broken implementation; the assertion still fails.
        if (!settled) controller.close();
        await result; assert(settled && cancelled, 'must finish and cancel without waiting for EOF');
    });
});
for (const kind of ['connect', 'abort-connect', 'forever', 'oversize', 'line', 'event', 'tool-json', 'tool-map']) test(`Anthropic bound: ${kind}`, async () => {
    let aborted = false, cancelled = false, timer;
    await fixture({ env: { ...(['connect', 'abort-connect', 'forever'].includes(kind) ? { HAIKU_TIMEOUT_MS: '40' } : {}), ...(['line', 'event'].includes(kind) ? { HAIKU_MAX_RESPONSE_BYTES: '2000000' } : {}) }, generate: (_, opts) => {
        opts.signal?.addEventListener('abort', () => { aborted = true; });
        if (kind === 'abort-connect') return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new DOMException('synthetic upstream detail', 'AbortError'))));
        if (kind === 'connect') return new Promise(() => {});
        if (kind === 'forever') return new Response(new ReadableStream({ start(c) { timer = setInterval(() => c.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 2); }, cancel() { clearInterval(timer); cancelled = true; } }));
        if (kind === 'tool-map') return new Response(Array.from({ length: 20 }, (_, i) => tool(String(i)).replace('"index":1', `"index":${i}`)).join('') + stop);
        if (kind === 'tool-json') return new Response(tool('t', {}) + Array.from({ length: 30 }, () => frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(1000) } })).join('') + stop);
        if (kind === 'line') return new Response('data: ' + 'x'.repeat(1100000));
        if (kind === 'event') return new Response(Array.from({ length: 2000 }, () => 'data: ' + 'x'.repeat(600) + '\n').join('') + '\n');
        let chunks = 0;
        const part = new TextEncoder().encode(text('x'.repeat(1000)));
        return new Response(new ReadableStream({ pull(c) { if (chunks++ < 1100) c.enqueue(part); else { c.enqueue(new TextEncoder().encode(stop)); c.close(); } } }));
    } }, async ({ request, rows }) => {
        // A watchdog releases the old implementation without hanging the test suite.
        let watchdog;
        const timeout = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('missing transport bound')), 2000); });
        try {
            const r = await Promise.race([request('/ask'), timeout]);
            assert.equal(r.status, 500); assert.equal(JSON.parse(r.data).error, 'generation service error');
            assert.equal(rows().at(-1).errorReason, ['connect', 'abort-connect', 'forever'].includes(kind) ? 'timeout' : kind === 'tool-json' ? 'tool-input' : kind === 'tool-map' ? 'tool-blocks' : 'oversize');
            assert(aborted || cancelled || !['connect', 'abort-connect', 'forever'].includes(kind));
        } finally { clearTimeout(watchdog); clearInterval(timer); }
    });
});
for (const stage of ['headers', 'fetch', 'body']) test(`credential-safe keyed exceptions: ${stage}`, async () => {
    const secret = 'SYNTHETIC_HEADER_PREFIX\nSYNTHETIC_HEADER_SUFFIX';
    const throwSecret = opts => {
        if (stage === 'headers') new Headers(opts.headers);
        if (stage === 'fetch') throw new TypeError(secret);
        return new Response(new ReadableStream({ start(c) { c.error(new TypeError(secret)); } }));
    };
    await fixture({ env: { ANTHROPIC_API_KEY: secret, TYPESAFE_API_KEY: secret }, jev: opts => throwSecret(opts), generate: (_, opts) => throwSecret(opts) }, async ({ request, rows, output, selectCards }) => {
        const selected = await selectCards('circle', [baseCard]);
        assert.equal(selected.error, 'selection service error');
        assert.equal(selected.errorClass, 'TypeError');
        const badCard = { ...baseCard, get text() { throw new TypeError(secret); } };
        const buildError = await selectCards('circle', [badCard]);
        assert.equal(buildError.error, 'selection service error');
        assert.equal(buildError.errorClass, 'TypeError');
        const ask = await request('/ask'), chat = await request('/chat');
        const all = JSON.stringify([ask.data, chat.data, rows(), output, selected, buildError]);
        for (const part of secret.split('\n')) assert(!all.includes(part), 'credential fragment escaped');
        assert.equal(JSON.parse(ask.data).error, 'generation service error');
        assert(chat.data.includes('event: error\ndata: "generation service error"'));
        assert.equal(rows().at(-1).errorClass, 'TypeError');
        assert.equal(rows().at(-1).errorReason, 'transport');
    });
});
test('generation card cap and whole request budget, p priority and id references', async () => {
    const corpus = Array.from({ length: 16 }, (_, i) => ({ ...baseCard, id: `card:${i}`, title: `entry${i}`, text: (`CARD_${i}\n` + 'payload line\n'.repeat(8000)).slice(0, 100000) }));
    await fixture({ corpus }, async ({ answer, calls }) => {
        const result = await answer('circle');
        assert(result.idOnlyCardsTotal > 0);
        assert.equal(result.idOnlyCardsTotal, result.idOnlyCards.reduce((a, b) => a + b, 0));
        assert.deepEqual(result.estInputTokens, calls.map(req => JSON.stringify(req).length * .4));
        assert(JSON.stringify(calls[0]).length * .4 <= 24000);
        assert(calls[0].messages[0].content.includes('(truncated; use trussc_get for the full text)'));
    });
    await fixture({ corpus, env: { HAIKU_MAX_INPUT_TOKENS: '15000' }, probability: (_, i) => .5 + i / 40 }, async ({ answer, calls }) => {
        await answer('circle'); const req = calls[0];
        assert(JSON.stringify(req).length * .4 <= 15000, 'entire serialized request must fit');
        assert(req.messages[0].content.includes('(truncated; use trussc_get for the full text)'));
        assert(req.messages[0].content.includes('CARD_15\n'), 'highest p gets full capped text first');
        assert(!req.messages[0].content.includes('CARD_0\n'), 'overflow cards are id only');
        assert(req.messages[0].content.includes('[#card:0]'));
        for (const match of req.messages[0].content.matchAll(/\[#card:\d+\]\n([\s\S]*?)(?=\n\n---|$)/g)) assert(match[1].length <= 8000);
    });
});
test('multi-round input stays bounded, prior user turn preserved, fixed overflow stops searches', async () => {
    const corpus = Array.from({ length: 48 }, (_, i) => ({ ...baseCard, id: `card:${i}`, title: `entry${i}`, text: `CARD_${i}\n` + 'payload line\n'.repeat(8000) }));
    await fixture({ corpus, env: { HAIKU_MAX_INPUT_TOKENS: '24000', MAX_SEARCH_ROUNDS: '5' }, probability: (_, i, n) => Math.floor(i / 16) === n % 3 ? .9 : .01,
        generate: (req, _, n) => new Response((req.tools ? tool(`tool${n}`) : text('Use [[drawCircle]].')) + stop) }, async ({ answer, calls }) => {
        const r = await answer('circle'); assert(calls.length >= 3, 'exercise accumulated native history');
        for (const req of calls) assert(JSON.stringify(req).length * .4 <= 24000);
        for (const req of calls.slice(1)) assert.deepEqual(req.messages[0], calls[0].messages[0]);
        assert(!calls.at(-1).tools); assert(r.haikuCalls <= 6);
    });
    await fixture({ env: { HAIKU_MAX_INPUT_TOKENS: '12000' } }, async ({ answer, calls }) => {
        await answer('circle', [{ role: 'user', content: 'history '.repeat(50000) }]);
        assert(calls.every(req => JSON.stringify(req).length * .4 <= 12000));
        assert(!calls[0].tools, 'fixed overflow must disable further searches');
    });
});
test('correction input fits beside accumulated native context', async () => {
    const corpus = Array.from({ length: 32 }, (_, i) => ({ ...baseCard, id: `card:${i}`, title: i ? `entry${i}` : 'Node',
        meta: { kind: i ? 'function' : 'type' }, text: `CARD_${i}\n` + 'payload line\n'.repeat(8000) }));
    await fixture({ corpus, generate: (req, _, n) => new Response((req.tools ? tool(`tool${n}`) : text('Node::invented; use [[drawCircle]].')) + stop) }, async ({ answer, calls }) => {
        const result = await answer('circle'); assert.equal(result.corrected, true);
        assert(calls.length >= 3); assert(calls.length <= 4);
        for (const req of calls) assert(JSON.stringify(req).length * .4 <= 24000);
        for (const req of calls.slice(1)) assert.deepEqual(req.messages[0], calls[0].messages[0]);
    });
});
test('id-only and per-call estimates reach request stats and public allowlist', async () => {
    const corpus = Array.from({ length: 16 }, (_, i) => ({ ...baseCard, id: `card:${i}`, title: `entry${i}`, text: 'payload line\n'.repeat(9000) }));
    await fixture({ corpus, generate: (req, _, n) => new Response((req.tools ? tool(`t${n}`) : text('Use [[drawCircle]].')) + stop) }, async ({ request, calls, rows }) => {
        const response = await request('/ask'); assert.equal(response.status, 200, response.data);
        const debug = JSON.parse(response.data).debug, stat = rows().at(-1);
        assert(stat.idOnlyCardsTotal > 0);
        assert.deepEqual(stat.idOnlyCards, debug.rounds.map(r => r.idOnlyCards));
        assert.equal(stat.idOnlyCardsTotal, debug.idOnlyCardsTotal);
        assert.equal(stat.idOnlyCardsTotal, stat.idOnlyCards.reduce((a, b) => a + b, 0));
        const estimates = calls.map(req => JSON.stringify(req).length * .4);
        assert.deepEqual(stat.estInputTokens, estimates);
        assert.deepEqual(debug.rounds.flatMap(r => r.haiku.estInputTokens), estimates);
        for (const [i, round] of debug.rounds.entries()) {
            const content = calls[i].messages.at(-1).content;
            const context = typeof content === 'string' ? content : content[0].content;
            assert.equal(round.idOnlyCards, [...context.matchAll(/^\[#card:\d+\](?=\n\n(?:---|An independent))/gm)].length, 'count only budget omissions, excluding already-shown references');
        }
    });
});
test('hard Haiku ceiling includes invalid-tool recovery and fabrication correction; numeric stats/debug', async () => {
    for (const maxRounds of [1, 3, 10]) for (const invalid of [false, true]) await fixture({ env: { MAX_SEARCH_ROUNDS: String(maxRounds) }, corpus: [baseCard, { ...baseCard, id: 'symbol:Node', title: 'Node', meta: { kind: 'type' } }],
        generate: (req, _, n) => new Response((req.tools ? tool(`t${n}`, invalid && n === maxRounds - 1 ? { message: '', queries: [] } : undefined) : text('Node::invented')) + stop) }, async ({ request, calls, rows }) => {
        const r = await request('/ask'); assert.equal(r.status, 200, r.data);
        const debug = JSON.parse(r.data).debug;
        assert.equal(calls.length, maxRounds + 1); assert.equal(rows().at(-1).haikuCalls, calls.length);
        assert.equal(debug.haikuCalls, calls.length); assert.equal(typeof debug.haikuCalls, 'number');
    });
});
let failures = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
}
assert.equal(failures, 0, `${failures} round-4 regressions failed`);
