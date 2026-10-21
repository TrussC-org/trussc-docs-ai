// Round-4 regressions: synthetic corpus and in-memory transports only.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, openSync, closeSync, symlinkSync, truncateSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publicDebug } from './debug.mjs';
function runNode(args, env, dir) {
    const out = join(dir, 'child.stdout'), err = join(dir, 'child.stderr');
    const stdout = openSync(out, 'w'), stderr = openSync(err, 'w');
    let result;
    try { result = spawnSync(process.execPath, args, { env, stdio: ['ignore', stdout, stderr] }); }
    finally { closeSync(stdout); closeSync(stderr); }
    if (result.error) throw result.error;
    return { ...result, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
}
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const stop = frame({ type: 'message_stop' });
const text = value => frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } });
const tool = (id, input = { message: 'Look again', queries: ['gap'] }) => frame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name: 'search_more', input } });
const baseCard = { id: 'symbol:drawCircle', title: 'drawCircle', source: 'reference', text: 'drawCircle draws a circle.', meta: { kind: 'function' }, vector: [1, 0] };
async function fixture(options, test) {
    const env = { ...process.env }, savedFetch = globalThis.fetch;
    const dir = mkdtempSync(join(tmpdir(), 'docsai-r4-'));
    const calls = [], rawCalls = [], output = [], savedConsole = { log: console.log, warn: console.warn, error: console.error };
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
            assert.equal(url, 'https://api.anthropic.com/v1/messages'); calls.push(req); rawCalls.push(opts.body);
            return options.generate ? options.generate(req, opts, calls.length) : new Response(text('Use [[drawCircle]].') + stop);
        };
        const rag = await import(join(dir, 'rag.mjs'));
        const { server } = await import(join(dir, 'server.mjs'));
        const request = (path, body = { question: 'circle', debug: true }, headers = {}) => new Promise(resolve => {
            const req = new PassThrough(); Object.assign(req, { method: 'POST', url: path, headers, socket: { remoteAddress: 'fixture' } });
            const res = new EventEmitter(); Object.assign(res, { status: 200, data: '', setHeader() {}, writeHead(status) { this.status = status; }, write(data) { this.data += data; return true; }, end(data = '') { this.data += data; resolve(this); } });
            server.emit('request', req, res); req.end(JSON.stringify(body));
        });
        const rows = () => { try { return readFileSync(process.env.STATS_LOG, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
        const { selectCards } = await import(join(dir, 'jev.mjs'));
        await test({ ...rag, selectCards, request, calls, rawCalls, output, rows, dir });
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

test('variant options validate before any calls, default and explicit-off payloads match', async () => {
    await fixture({}, async ({ answer, answerStream, calls, rawCalls, validateVariants }) => {
        assert.deepEqual(validateVariants(), { fillerTokens: 0, thinkingBudget: 0 });
        for (const field of ['fillerTokens', 'thinkingBudget']) {
            for (const value of [null, NaN, Infinity, -1, .5, '1024', true, Number.MAX_SAFE_INTEGER]) {
                await assert.rejects(answer('circle', [], null, [], undefined, { [field]: value }), new RegExp(field));
                const stream = answerStream('circle', [], null, [], undefined, { [field]: value });
                await assert.rejects(stream.next(), new RegExp(field));
            }
        }
        for (const value of [1, 1023, 16385]) await assert.rejects(answer('circle', [], null, [], undefined, { thinkingBudget: value }), /thinkingBudget/);
        await assert.rejects(answer('circle', [], null, [], undefined, { fillerTokens: 4097 }), /fillerTokens/);
        assert.equal(calls.length, 0);
        await answer('circle');
        const result = await answer('circle', [], null, [], undefined, { fillerTokens: 0, thinkingBudget: 0 });
        assert.equal(rawCalls[0], rawCalls[1]);
        // Frozen against the pre-variant implementation using this synthetic fixture.
        assert.equal(createHash('sha256').update(rawCalls[0]).digest('hex'), 'bc731377fae5ac31bcaebbc89e9ec3f300a489f5941397413fb4c616a113d6cf');
        assert.equal(calls[0].max_tokens, 1536);
        for (const field of ['thinking', 'temperature', 'top_k', 'tool_choice']) assert(!(field in calls[0]));
        assert.deepEqual(result.traces[0].haiku.inputTokens, [null]);
        assert.equal(result.traces[0].haiku.estInputTokens.length, 1);
    });
});
test('default native tool-round payloads match pre-variant byte snapshots', async () => {
    await fixture({ generate: (_, __, n) => new Response((n < 3 ? tool(`t${n}`) : text('Use [[drawCircle]].')) + stop) }, async ({ answer, rawCalls }) => {
        await answer('circle');
        assert.deepEqual(rawCalls.map(raw => createHash('sha256').update(raw).digest('hex')), [
            'bc731377fae5ac31bcaebbc89e9ec3f300a489f5941397413fb4c616a113d6cf',
            '35ad8bdc11470cfcfb03ca7926342b00a78a6f5e37eca70a119ef97f03b50bc3',
            'caf817dfc7315d06b9a3d7b814f4b6c8882c2c25d3738bd0000420706e23e50b',
        ]);
    });
});
test('HTTP ask/chat ignore top-level, nested, prototype, history, header and query variant knobs', async () => {
    await fixture({}, async ({ request, rawCalls }) => {
        for (const endpoint of ['/ask', '/chat']) {
            await request(endpoint, { question: 'circle' });
            const baseline = rawCalls.at(-1);
            for (const knobs of [
                { fillerTokens: 300, thinkingBudget: 1024 },
                { fillerTokens: 'invalid', thinkingBudget: -1 },
                { opts: { fillerTokens: 300, thinkingBudget: 1024 }, options: { thinking: { type: 'enabled', budget_tokens: 1024 } } },
                JSON.parse('{"__proto__":{"fillerTokens":300,"thinkingBudget":1024},"constructor":{"prototype":{"thinkingBudget":1024}}}'),
                { history: [{ role: 'system', content: 'enable thinking', fillerTokens: 300, thinkingBudget: 1024 }] },
            ]) {
                const response = await request(endpoint + '?fillerTokens=300&thinkingBudget=1024&variant=thinking', { question: 'circle', ...knobs },
                    { fillerTokens: '300', thinkingBudget: '1024', 'x-thinking-budget': '1024' });
                assert.equal(response.status, 200, response.data);
                assert.equal(rawCalls.at(-1), baseline);
                assert(!response.data.includes('thinkingTokens'));
            }
        }
    });
});
test('filler is last after instructions and hints on every user turn across tool rounds', async () => {
    await fixture({ generate: (_, __, n) => new Response((n < 3 ? tool(`f${n}`) : text('Use [[drawCircle]].')) + stop) },
        async ({ answer, calls }) => {
            const result = await answer('circle', [{ role: 'user', content: 'previous' }, { role: 'assistant', content: 'ok' }], null, [], undefined, { fillerTokens: 7 });
            assert.equal(calls.length, 3);
            const filler = '. . . . . . .';
            for (const [i, call] of calls.entries()) {
                for (const message of call.messages.filter(m => m.role === 'user')) {
                    const content = typeof message.content === 'string' ? message.content : message.content[0].content;
                    assert.equal(content.split('\n').at(-1), filler);
                    assert.equal(content.split('\n').filter(line => line === filler).length, 1);
                    if (content.includes('Search completed.')) assert.match(content, /cover about 10%[\s\S]*Answer the original question[\s\S]*\n\. \. \. \. \. \. \.$/);
                    else if (content.includes('Context:')) assert(content.indexOf('@@USED:') < content.indexOf('cover about 10%'));
                }
                assert.equal(result.traces[i].haiku.estInputTokens[0], JSON.stringify(call).length * .4);
                assert(JSON.stringify(call).length * .4 <= 24000);
            }
            assert.deepEqual(calls[2].messages.slice(0, calls[0].messages.length), calls[0].messages);
        });
});
test('filler reserve affects card packing and fixed-input overflow prevents generation', async () => {
    const corpus = Array.from({ length: 16 }, (_, i) => ({ ...baseCard, id: `c${i}`, title: 'drawCircle', text: 'evidence\n'.repeat(900) }));
    await fixture({ corpus, env: { HAIKU_MAX_INPUT_TOKENS: '10500' } }, async ({ answer, calls }) => {
        const base = await answer('circle');
        const filler = await answer('circle', [], null, [], undefined, { fillerTokens: 4096 });
        assert(filler.idOnlyCardsTotal > base.idOnlyCardsTotal);
        assert(calls.every(c => JSON.stringify(c).length * .4 <= 10500));
        assert.equal(filler.estInputTokens[0], JSON.stringify(calls.at(-1)).length * .4);
    });
    await fixture({}, async ({ answer, calls }) => {
        await answer('circle');
        const baseChars = JSON.stringify(calls[0]).length;
        // With a fixed question sized just below the budget, the extra filler
        // cannot be paid for even after dropping cards and disabling search.
        const question = 'q'.repeat(Math.floor(24000 / .4 - baseChars - 1000));
        await answer(question);
        const before = calls.length;
        await assert.rejects(answer(question, [], null, [], undefined, { fillerTokens: 4096 }), e => e.errorReason === 'input');
        assert.equal(calls.length, before);
    });
});
const thinkingBlock = { type: 'thinking', thinking: 'PRIVATE reasoning\n秘密', signature: 'signed+/=尾' };
const redactedBlock = { type: 'redacted_thinking', data: 'opaque+/=秘密' };
const reasoningFrames = () => frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
    + frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE reasoning\n' } })
    + frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '秘密' } })
    + frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed+' } })
    + frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '/=尾' } })
    + frame({ type: 'content_block_stop', index: 0 })
    + frame({ type: 'content_block_start', index: 2, content_block: redactedBlock });
for (const separate of [true, false]) test(`thinking/signature/redacted blocks survive tools privately; separate usage=${separate}`, async () => {
    await fixture({ generate: (_, __, n) => new Response(
        frame({ type: 'message_start', message: { usage: { input_tokens: 90 + n, output_tokens: 1 } } })
        + reasoningFrames() + (n < 3 ? tool(`t${n}`) : text('Use [[drawCircle]].'))
        + frame({ type: 'message_delta', usage: { output_tokens: 110 + n, ...(separate ? { thinking_tokens: 100 } : {}) } }) + stop) },
        async ({ answerStream, calls }) => {
            const events = [];
            for await (const event of answerStream('circle', [], null, [], undefined, { thinkingBudget: 1024 })) events.push(event);
            const result = events.at(-1);
            assert.equal(result.rounds, 3); assert.equal(result.haikuCalls, 3);
            for (const [i, call] of calls.entries()) {
                assert.deepEqual(call.thinking, { type: 'enabled', budget_tokens: 1024 });
                assert.equal(call.max_tokens, 1536 + 1024);
                for (const field of ['tool_choice', 'temperature', 'top_k']) assert(!(field in call));
                if (i) {
                    for (const assistant of call.messages.filter(m => m.role === 'assistant')) {
                        assert.deepEqual(assistant.content.slice(0, 2), [thinkingBlock, redactedBlock]);
                        assert.equal(assistant.content[2].type, 'tool_use');
                    }
                }
                assert.deepEqual(result.traces[i].haiku.inputTokens, [91 + i]);
                assert.equal(result.traces[i].haiku.inputTokensTotal, 91 + i);
                assert.equal(result.traces[i].haiku.thinkingTokens, separate ? 100 : 'included in outputTokens');
                assert.equal(result.traces[i].haiku.estInputTokens[0], JSON.stringify(call).length * .4);
            }
            assert.equal(result.inputTokens, 276); assert.equal(result.outputTokens, 336);
            assert.equal(result.thinkingTokens, separate ? 300 : 'included in outputTokens');
            assert(!JSON.stringify(publicDebug(result.traces)).includes('thinking'));
            assert(!JSON.stringify(events).includes('PRIVATE reasoning'));
            assert(!JSON.stringify(events).includes('signed+'));
            assert(!JSON.stringify(events).includes('opaque+'));
        });
});
for (const separatelyReported of [true, false]) test(`recovery aligns per-call usage and mixed thinking accounting: ${separatelyReported}`, async () => {
    await fixture({ generate: (_, __, n) => new Response(
        (n === 1 ? frame({ type: 'message_start', message: { usage: { input_tokens: 101 } } }) + tool('invalid', { message: '', queries: [] }) : text('Use [[drawCircle]].'))
        + frame({ type: 'message_delta', usage: { output_tokens: n === 1 ? 12 : 15,
            ...(n === 1 ? { thinking_tokens: 9 } : separatelyReported ? { output_tokens_details: { thinking_tokens: 10 } } : {}) } }) + stop) },
        async ({ answer, calls }) => {
            const result = await answer('circle', [], null, [], undefined, { thinkingBudget: 16384 });
            assert.equal(calls.length, 2);
            assert(calls.every(call => call.max_tokens === 16384 + 1536));
            assert.equal(result.rounds, 1);
            assert.deepEqual(result.traces[0].haiku.inputTokens, [101, null]);
            assert.equal(result.traces[0].haiku.estInputTokens.length, 2);
            assert.equal(result.traces[0].haiku.inputTokensTotal, 101);
            assert.equal(result.inputTokens, 101); assert.equal(result.outputTokens, 27);
            assert.equal(result.thinkingTokens, separatelyReported ? 19 : 'included in outputTokens');
        });
});
for (const mode of ['total', 'line', 'event', 'tool-json', 'tool-blocks']) test(`thinking keeps existing stream ${mode} cap`, async () => {
    await fixture({ env: { HAIKU_MAX_RESPONSE_BYTES: mode === 'total' ? '1200' : '1048576' }, generate: () => {
        let content = reasoningFrames();
        if (mode === 'total' || mode === 'line') content += frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x'.repeat(mode === 'total' ? 1400 : 65536) } });
        if (mode === 'event') content += ': ' + 'x'.repeat(40000) + '\n: ' + 'x'.repeat(40000) + '\n\n';
        if (mode === 'tool-json') content += tool('large') + frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(8193) } });
        if (mode === 'tool-blocks') for (let i = 3; i < 12; i++) content += frame({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `t${i}`, name: 'search_more', input: {} } });
        return new Response(content + stop);
    } }, async ({ answer }) => {
        await assert.rejects(answer('circle', [], null, [], undefined, { thinkingBudget: 1024 }), e => e.errorReason === (mode.startsWith('tool-') ? mode === 'tool-json' ? 'tool-input' : 'tool-blocks' : 'oversize'));
    });
});
test('variant runner validates args and missing keys without calls or credential output', async () => {
    await fixture({}, async ({ dir, calls, output }) => {
        const runnerDir = join(dir, 'eval/answers'); mkdirSync(runnerDir, { recursive: true });
        const runner = join(runnerDir, 'run-variants.mjs');
        writeFileSync(runner, readFileSync(new URL('eval/answers/run-variants.mjs', import.meta.url)));
        const { main } = await import(runner);
        const args = [join(dir, 'questions.json'), join(dir, 'out.json'), '--variant', 'base'];
        const env = { ...process.env };
        try {
            delete process.env.ANTHROPIC_API_KEY;
            await assert.rejects(main(args), /Missing required environment variable: ANTHROPIC_API_KEY/);
            process.env.ANTHROPIC_API_KEY = 'dummy-generator-value-must-not-print';
            delete process.env.TYPESAFE_API_KEY;
            await assert.rejects(main(args), /Missing required environment variable: TYPESAFE_API_KEY/);
            const child = runNode([runner, ...args], process.env, dir);
            assert.equal(child.status, 1, JSON.stringify(child)); assert.match(child.stderr,  /Missing required environment variable: TYPESAFE_API_KEY/, JSON.stringify(child));
            assert(!child.stderr.includes(process.env.ANTHROPIC_API_KEY));
            for (const extra of [['--variant', 'other'], ['--filler', '-1'], ['--thinking', '3'], ['--thinking', '16385'], ['--filler', '4097'], ['--filler', '1.5'], ['--key', 'dummy']]) {
                await assert.rejects(main([...args, ...extra]));
            }
            assert.equal(calls.length, 0); assert(!output.join('\n').includes('dummy-generator-value'));
        } finally { Object.assign(process.env, env); }
    });
});
for (const variant of ['base', 'filler', 'thinking']) test(`variant runner CLI writes schema, subset and incremental atomic results: ${variant}`, async () => {
    await fixture({}, async ({ dir }) => {
        const runnerDir = join(dir, 'eval/answers'); mkdirSync(runnerDir, { recursive: true });
        const runner = join(runnerDir, 'run-variants.mjs');
        writeFileSync(runner, readFileSync(new URL('eval/answers/run-variants.mjs', import.meta.url)));
        const questions = join(dir, 'questions.json'), out = join(dir, 'out.json'), ids = join(dir, 'ids.txt'), preload = join(dir, 'fetch-stub.mjs');
        writeFileSync(questions, JSON.stringify([{ id: 'a', question: 'circle' }, { id: 2, question: 'second' }, { id: 'c', question: 'excluded' }]));
        writeFileSync(ids, 'a\r\n2\n');
        writeFileSync(preload, `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
const frame=${frame.toString()}; let calls=0;
globalThis.fetch=async (url, options)=>{
 const req=JSON.parse(options.body);
 if(url.endsWith('/api/embed')) {
  if(req.input==='second') {const rows=JSON.parse(readFileSync(${JSON.stringify(out)},'utf8'));assert.equal(rows.length,1);assert.equal(rows[0].id,'a');}
  return Response.json({embeddings:[[1,0]]});
 }
 if(url.endsWith('/systemone'))return Response.json({answers:{...Object.fromEntries(req.state.cards.map(c=>[c.card,{noul:.9}])),exists:{noul:.9}}});
 assert.equal(url,'https://api.anthropic.com/v1/messages');calls++;
 assert.equal(process.env.STATS,'0');
 if(${JSON.stringify(variant)}==='thinking')assert.deepEqual(req.thinking,{type:'enabled',budget_tokens:1024});else assert(!req.thinking);
 assert.equal(req.messages.at(-1).content.endsWith('\\n'+Array(300).fill('.').join(' ')),${variant === 'filler'});
 if(calls===2 && process.env.STUB_CRASH==='1')process.exit(7);
 if(calls===2 && process.env.STUB_ERROR==='1')throw Error(process.env.ANTHROPIC_API_KEY);
 return new Response(frame({type:'message_start',message:{usage:{input_tokens:101}}})+frame({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Use [[drawCircle]].'}})+frame({type:'message_delta',usage:{output_tokens:17}})+frame({type:'message_stop'}));
};`);
        const run = extras => runNode(['--import', preload, runner, questions, out, '--variant', variant, '--ids', ids],
            { ...process.env, STATS: '1', STUB_ERROR: '0', STUB_CRASH: '0', ...extras }, dir);
        let child = run({}); assert.equal(child.status, 0, child.stderr);
        const results = JSON.parse(readFileSync(out, 'utf8'));
        assert.equal(results.length, 2);
        assert.deepEqual(results.map(row => row.id), ['a', 2]);
        for (const result of results) {
            assert.deepEqual(Object.keys(result).sort(), ['id','variant','answer','rounds','haikuCalls','inputTokensPerCall','inputTokens','outputTokens','thinkingTokens','ms'].sort());
            assert.equal(result.variant, variant); assert.equal(result.rounds, 1); assert.equal(result.haikuCalls, 1);
            assert.deepEqual(result.inputTokensPerCall, [101]);
            assert.equal(result.inputTokens, 101); assert.equal(result.outputTokens, 17);
            assert.equal(result.thinkingTokens, variant === 'thinking' ? 'included in outputTokens' : 0);
            assert(result.answer.includes('drawCircle')); assert(result.ms >= 0);
        }
        assert(!existsSync(join(dir, 'stats.jsonl')));
        child = run({ STUB_CRASH: '1' }); assert.equal(child.status, 7, child.stderr);
        assert.equal(JSON.parse(readFileSync(out, 'utf8')).length, 1);
        child = run({ STUB_ERROR: '1' }); assert.equal(child.status, 1, child.stderr);
        const failure = JSON.parse(readFileSync(out, 'utf8'))[1]; assert.equal(failure.error, 'answer failed');
        const allOutput = child.stdout + child.stderr + readFileSync(out, 'utf8');
        assert(!allOutput.includes(process.env.ANTHROPIC_API_KEY)); assert(!allOutput.includes(process.env.TYPESAFE_API_KEY));
        assert(!existsSync(join(dir, 'stats.jsonl')));
    });
});
// Exercise the same failure boundary through both in-process APIs and the runner.
async function failureFor(consumer, api, opts, variant) {
    if (consumer === 'runner') {
        const runnerDir = join(api.dir, 'eval/answers'); mkdirSync(runnerDir, { recursive: true });
        const runner = join(runnerDir, 'run-variants.mjs');
        writeFileSync(runner, readFileSync(new URL('eval/answers/run-variants.mjs', import.meta.url)));
        const questions = join(api.dir, 'questions.json'), out = join(api.dir, 'out.json');
        writeFileSync(questions, JSON.stringify([{ id: 'failure', question: 'circle' }]));
        const { main } = await import(runner);
        assert.equal(await main([questions, out, '--variant', variant, '--filler', String(opts.fillerTokens ?? 0)]), 1);
        const row = JSON.parse(readFileSync(out, 'utf8'))[0];
        assert.equal(row.error, 'answer failed');
        return row;
    }
    let failure;
    try {
        if (consumer === 'answer') await api.answer('circle', [], null, [], undefined, opts);
        else for await (const event of api.answerStream('circle', [], null, [], undefined, opts)) {
            assert.notEqual(event.type, 'final');
        }
    } catch (error) { failure = error; }
    assert(failure instanceof Error, 'pipeline must throw');
    return failure;
}
for (const consumer of ['answer', 'answerStream', 'runner']) {
    test(`completed Haiku usage survives follow-up retrieval failure: ${consumer}`, async () => {
        await fixture({ generate: (_, __, n) => {
            if (n === 2) {
                const previous = globalThis.fetch;
                globalThis.fetch = async (url, options) => {
                    if (url.endsWith('/api/embed')) throw new Error('synthetic follow-up retrieval outage');
                    return previous(url, options);
                };
            }
            return new Response(frame({ type: 'message_start', message: { usage: { input_tokens: n * 101 } } })
                + tool(`search${n}`, { message: 'Search again', queries: [`gap${n}`] })
                + frame({ type: 'message_delta', usage: { output_tokens: n * 17, thinking_tokens: n * 5 } }) + stop);
        } }, async api => {
            const failure = await failureFor(consumer, api, { thinkingBudget: 1024 }, 'thinking');
            assert.equal(api.calls.length, 2);
            assert.equal(failure.rounds, 2); assert.equal(failure.haikuCalls, 2);
            assert.deepEqual(failure.inputTokensPerCall, [101, 202]);
            assert.equal(failure.inputTokens, 303); assert.equal(failure.outputTokens, 51);
            assert.equal(failure.thinkingTokens, 15);
        });
    });
    test(`completed Haiku usage survives correction-packing failure: ${consumer}`, async () => {
        const corpus = [baseCard, { ...baseCard, id: 'symbol:Node', title: 'Node', meta: { kind: 'type' } }];
        const opts = { fillerTokens: 4096 };
        let budget;
        await fixture({ corpus }, async ({ answer, calls }) => {
            await answer('circle', [], null, [], undefined, opts);
            budget = Math.ceil(JSON.stringify(calls[0]).length * .4) + 256;
        });
        await fixture({ corpus, env: { HAIKU_MAX_INPUT_TOKENS: String(budget) }, generate: () =>
            new Response(frame({ type: 'message_start', message: { usage: { input_tokens: 101 } } })
                + text('Node::invented') + frame({ type: 'message_delta', usage: { output_tokens: 17 } }) + stop)
        }, async api => {
            const failure = await failureFor(consumer, api, opts, 'filler');
            assert.equal(api.calls.length, 1, 'packing fails before a correction call');
            if (consumer !== 'runner') assert.equal(failure.errorReason, 'input');
            assert.equal(failure.rounds, 1); assert.equal(failure.haikuCalls, 1);
            assert.deepEqual(failure.inputTokensPerCall, [101]);
            assert.equal(failure.inputTokens, 101); assert.equal(failure.outputTokens, 17);
            assert.equal(failure.thinkingTokens, 0);
        });
    });
}
test('runner bounds questions/ids files before full reads and preserves existing output', async () => {
    await fixture({}, async ({ dir, calls }) => {
        const runnerDir = join(dir, 'eval/answers'); mkdirSync(runnerDir, { recursive: true });
        const runner = join(runnerDir, 'run-variants.mjs');
        writeFileSync(runner, readFileSync(new URL('eval/answers/run-variants.mjs', import.meta.url)));
        const { main } = await import(runner);
        const questions = join(dir, 'questions.json'), out = join(dir, 'out.json'), ids = join(dir, 'ids.txt');
        const valid = JSON.stringify([{ id: 'q1', question: 'circle' }]);
        writeFileSync(out, 'keep existing output');
        writeFileSync(questions, valid); truncateSync(questions, 4 * 1024 * 1024 + 1);
        const savedRead = fs.readFileSync, oversizedReads = [];
        fs.readFileSync = (path, ...args) => {
            if ([questions, ids].includes(path) && fs.statSync(path).size > 4 * 1024 * 1024) oversizedReads.push(path);
            return savedRead(path, ...args);
        };
        syncBuiltinESMExports();
        try {
            await assert.rejects(main([questions, out, '--variant', 'base']), /Questions file exceeds 4 MiB limit/);
            writeFileSync(questions, valid); writeFileSync(ids, 'q1'); truncateSync(ids, 4 * 1024 * 1024 + 1);
            await assert.rejects(main([questions, out, '--variant', 'base', '--ids', ids]), /Ids file exceeds 4 MiB limit/);
            assert.deepEqual(oversizedReads, [], 'oversized files must be rejected before readFileSync');
        } finally { fs.readFileSync = savedRead; syncBuiltinESMExports(); }
        assert.equal(readFileSync(out, 'utf8'), 'keep existing output'); assert.equal(calls.length, 0);
    });
});
test('runner rejects questions above 8000 code units before retrieval and continues', async () => {
    await fixture({}, async ({ dir, calls }) => {
        const runnerDir = join(dir, 'eval/answers'); mkdirSync(runnerDir, { recursive: true });
        const runner = join(runnerDir, 'run-variants.mjs');
        writeFileSync(runner, readFileSync(new URL('eval/answers/run-variants.mjs', import.meta.url)));
        const { main } = await import(runner);
        const questions = join(dir, 'questions.json'), out = join(dir, 'out.json'), embedded = [];
        writeFileSync(questions, JSON.stringify([{ id: 'long', question: '😀'.repeat(4001) },
            { id: 'limit', question: 'q'.repeat(8000) }, { id: 'next', question: 'circle' }]));
        const previous = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/api/embed')) embedded.push(JSON.parse(options.body).input);
            return previous(url, options);
        };
        assert.equal(await main([questions, out, '--variant', 'base']), 1);
        const results = JSON.parse(readFileSync(out, 'utf8'));
        assert.deepEqual(results.map(r => r.id), ['long', 'limit', 'next']);
        assert.equal(results[0].error, 'answer failed'); assert.equal(results[0].haikuCalls, 0);
        assert.deepEqual(results[0].inputTokensPerCall, []);
        assert.equal(results[1].error, undefined); assert.equal(results[2].error, undefined);
        assert.deepEqual(embedded, ['q'.repeat(8000), 'circle']); assert.equal(calls.length, 2);
    });
});
test('runner refuses output/input collisions through directory symlinks before any write', async () => {
    await fixture({}, async ({ dir, calls }) => {
        const runnerDir = join(dir, 'eval/answers'); mkdirSync(runnerDir, { recursive: true });
        const runner = join(runnerDir, 'run-variants.mjs');
        writeFileSync(runner, readFileSync(new URL('eval/answers/run-variants.mjs', import.meta.url)));
        const { main } = await import(runner);
        const questions = join(dir, 'questions.json'), ids = join(dir, 'ids.txt'), alias = join(dir, 'alias');
        const original = JSON.stringify([{ id: 'q1', question: 'circle' }]);
        writeFileSync(questions, original); writeFileSync(ids, 'q1'); symlinkSync(dir, alias, 'dir');
        for (const [q, out, subset] of [
            [questions, join(alias, 'questions.json'), ids],
            [join(alias, 'questions.json'), questions, ids],
            [questions, join(alias, 'ids.txt'), ids],
            [questions, ids, join(alias, 'ids.txt')],
        ]) await assert.rejects(main([q, out, '--variant', 'base', '--ids', subset]), /Output path must differ/);
        assert.equal(readFileSync(questions, 'utf8'), original); assert.equal(readFileSync(ids, 'utf8'), 'q1');
        assert.equal(calls.length, 0);
    });
});
test('runner refuses file-symlink collisions and non-regular inputs before any write', async () => {
    await fixture({}, async ({ dir, calls }) => {
        const runnerDir = join(dir, 'eval/answers'); mkdirSync(runnerDir, { recursive: true });
        const runner = join(runnerDir, 'run-variants.mjs');
        writeFileSync(runner, readFileSync(new URL('eval/answers/run-variants.mjs', import.meta.url)));
        const { main } = await import(runner);
        const questions = join(dir, 'questions.json'), ids = join(dir, 'ids.txt');
        const linkQ = join(dir, 'link-q.json'), linkIds = join(dir, 'link-ids.txt');
        const original = JSON.stringify([{ id: 'q1', question: 'circle' }]);
        writeFileSync(questions, original); writeFileSync(ids, 'q1');
        symlinkSync(questions, linkQ); symlinkSync(ids, linkIds);
        await assert.rejects(main([linkQ, questions, '--variant', 'base']), /Output path must differ/);
        await assert.rejects(main([questions, ids, '--variant', 'base', '--ids', linkIds]), /Output path must differ/);
        await assert.rejects(main([questions, linkQ, '--variant', 'base']), /Output path must differ/);
        assert.equal(readFileSync(questions, 'utf8'), original); assert.equal(readFileSync(ids, 'utf8'), 'q1');
        const fifo = join(dir, 'questions.fifo');
        const made = spawnSync('mkfifo', [fifo]);
        if (made.status === 0) {
            await assert.rejects(main([fifo, join(dir, 'out.json'), '--variant', 'base']), /must be a regular file/);
            assert.equal(existsSync(join(dir, 'out.json')), false);
        }
        assert.equal(calls.length, 0);
    });
});
let failures = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
}
assert.equal(failures, 0, `${failures} round-4 regressions failed`);
