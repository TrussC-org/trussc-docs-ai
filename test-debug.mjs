// Offline allowlist, report and CLI checks. No model endpoints or credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, createReadStream } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { publicDebug } from './debug.mjs';
import { pipelineStat } from './stats.mjs';
import { main } from './ask-cli.mjs';

// Future internal fields must not expand the public schema, at any nesting level.
const privateFields = { ttftMs: 4, totalMs: 12, calls: [{ ttftMs: 4, totalMs: 12 }], thinking: 'off', reason: 'budget', remainingBudget: 123, rate: 20, prompt: 'system text', key: 'secret', ip: '192.0.2.1', pathOnDisk: '/private/file', thinkingTokens: 99, thinkingBudget: 1024, fillerTokens: 300, signature: 'private signature' };
const trace = {
    ...privateFields, queries: ['circle'],
    picked: [{ ...privateFields, id: 'symbol:drawCircle', title: 'drawCircle', p: .8, text: 'PRIVATE CARD TEXT' }],
    info: { ...privateFields, poolSize: 12, path: 'fallback', exists: null, jevMs: 0, jevTokens: 100 },
    haiku: { ...privateFields, estInputTokens: [120], ms: 12, inputTokens: [101], inputTokensTotal: 101, outputTokens: 17 }, message: null,
};
const expected = { idOnlyCardsTotal: 0, haikuCalls: 0, rounds: [{ idOnlyCards: 0, queries: ['circle'], poolSize: 12, picked: [{ id: 'symbol:drawCircle', title: 'drawCircle', p: .8 }], exists: null, hintShown: false, hintFollowed: null, path: 'fallback', haiku: { estInputTokens: [120], ms: 12, inputTokens: [101], inputTokensTotal: 101, outputTokens: 17 }, jev: { ms: 0, tokens: 100 }, message: null }] };
assert.deepEqual(publicDebug([trace]), expected);
assert.deepEqual(publicDebug([{ ...trace, hintShown: 'PRIVATE', hintFollowed: privateFields }]), expected);
assert.deepEqual(publicDebug([{ ...trace, hintShown: true, hintFollowed: privateFields }]).rounds[0].hintFollowed, null);
for (const [hintShown, hintFollowed, expectedFollowed] of [[true, true, true], [true, false, false], [false, true, null], ['PRIVATE', privateFields, null], [true, privateFields, null]]) {
    const stat = pipelineStat({ retrievals: [{ exists: .29 }], traces: [{ ...trace, hintShown, hintFollowed }] });
    assert.deepEqual(stat.retrievals, [{ exists: .29, hintShown: hintShown === true, hintFollowed: expectedFollowed }]);
    assert(!JSON.stringify(stat).includes('PRIVATE'));
}
assert(!/reason|budget|rate|prompt|key|private|192\.0\.2/i.test(JSON.stringify(publicDebug([trace]))));

const dir = mkdtempSync(join(tmpdir(), 'docsai-debug-'));
try {
    const statsLog = join(dir, 'stats.jsonl');
    const row = { ts: new Date().toISOString(), ep: 'ask', ip: 'hash', q: 'public question', ms: 10 };
    writeFileSync(statsLog, [row, { ...row, debug: true, q: 'debug question' }].map(r => JSON.stringify(r)).join('\n'));
    // Execute the real report with stubbed imports, keeping this test independent
    // of child-process capture and operator environment/configuration.
    const report = readFileSync(new URL('./report.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
    const runReport = async args => {
        const output = [];
        await vm.runInNewContext(`(async () => { ${report} })()`, { Buffer, Transform, createReadStream, createInterface, opendir, existsSync, homedir: () => dir, join, STATS_LOG: statsLog,
            process: { argv: ['node', 'report.mjs', ...args], env: {}, exit() { throw new Error('unexpected early exit'); } },
            console: { log: (...args) => output.push(args.join(' ')) },
        });
        return output.join('\n');
    };
    assert((await runReport([])).includes('(1 requests,'));
    assert(!(await runReport([])).includes('debug question'));
    for (const args of [['--include-debug'], ['7', '--include-debug'], ['--include-debug', '7']]) {
        assert((await runReport(args)).includes('(2 requests,'));
        assert((await runReport(args)).includes('debug question'));
    }

    // An in-memory HTTP stub server exercises the CLI's --json request/response
    // path without binding a socket (the sandbox may disallow loopback listeners).
    const raw = JSON.stringify({ answer: 'Use drawCircle.', debug: expected });
    let requests = 0;
    const stub = createServer(async (req, res) => {
        let body = ''; for await (const part of req) body += part;
        assert.equal(req.method, 'POST'); assert.equal(req.url, '/ask');
        assert.deepEqual(JSON.parse(body), { question: 'circle', debug: true });
        requests++;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(raw);
    });
    const stubFetch = async (url, options) => {
        assert.equal(url, 'http://stub.invalid/ask');
        assert.equal(options.redirect, 'manual');
        return new Promise(resolve => {
            const req = new PassThrough(); req.method = options.method; req.url = new URL(url).pathname;
            const res = new EventEmitter(); res.writeHead = () => {};
            res.end = data => resolve(new Response(data));
            stub.emit('request', req, res); req.end(options.body);
        });
    };
    const output = [];
    await main(['circle', '--json', '--url', 'http://stub.invalid/ask'], { fetchImpl: stubFetch, print: s => output.push(s) });
    assert.deepEqual(output, [raw]);
    assert.deepEqual(JSON.parse(output[0]), { answer: 'Use drawCircle.', debug: expected });
    output.length = 0;
    await main(['circle', '--url', 'http://stub.invalid/ask'], { fetchImpl: stubFetch, print: s => output.push(s) });
    assert(output.join('\n').includes('Round 1: fallback'));
    assert(output.join('\n').includes('Pool: 12 cards'));
    assert(output.join('\n').includes('tokens in=101 out=17'));
    assert(output.join('\n').includes('symbol:drawCircle | drawCircle | p=0.8'));
    const oldPort = process.env.PORT; process.env.PORT = '9999';
    try {
        await main(['circle', '--json'], { print() {}, fetchImpl: async (url, options) => {
            assert.equal(url, 'http://127.0.0.1:9999/ask');
            return stubFetch('http://stub.invalid/ask', options);
        } });
    } finally { if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort; }
    await assert.rejects(main(['circle', '--rounds', '10'], { fetchImpl: stubFetch }), /Usage:/);
    await assert.rejects(main(['circle', '--json'], { fetchImpl: async () => new Response('', { status: 429 }) }), /ask HTTP 429/);
    assert.equal(requests, 3);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('PASS debug allowlist, report exclusion/include flag, ask-cli --json/readable/default URL/stub HTTP server');
