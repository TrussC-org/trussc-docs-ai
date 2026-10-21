// No sockets, services, corpus or real credentials. Run: node test-jev.mjs
import assert from 'node:assert/strict';
import * as config from './config.mjs';
import { createSelector, cardState } from './jev.mjs';
const secret = 'test-secret-must-never-escape';
const base = { ...config, TYPESAFE_API_KEY: secret, JEV_RATE_MAX: 100, JEV_DAILY_TOKENS: 1e9,
    JEV_TOKENS_PER_CHAR: .4, JEV_CARD_CHARS: 2000, JEV_TIMEOUT_MS: 3000,
    JEV_PICK: 'threshold', JEV_PICK_K: 8, JEV_PICK_MIN_P: .5, JEV_PICK_MIN: 4, JEV_PICK_MAX: 16,
};
const pool = Array.from({ length: 20 }, (_, i) => ({ id: `id${i}`, title: `title${i}`, text: 'facts '.repeat(500) }));
let output = [], requests = [];
const originals = { warn: console.warn, log: console.log, error: console.error };
for (const k of Object.keys(originals)) console[k] = (...v) => output.push(v.join(' '));
const response = (ps, exists = .7, usage) => new Response(JSON.stringify({ answers: { ...Object.fromEntries(ps.map((p, i) => [`c${i + 1}`, { noul: p }])), exists: { noul: exists } }, usage }));
const ps = pool.map((_, i) => i / 20);
function selector(overrides = {}, fetchImpl = async (url, opts) => { requests.push({ url, opts }); return response(ps); }, extra = {}) {
    return createSelector({ cfg: { ...base, ...overrides }, fetchImpl, ...extra });
}
try {
    let s = selector(); let r = await s.selectCards('question', pool);
    assert.equal(r.tokens, r.estimatedTokens);
    assert.equal(r.path, 'jev'); assert.deepEqual(r.picked.map(c => c.p), ps.filter(p => p >= .5).reverse());
    const req = requests.at(-1); const body = JSON.parse(req.opts.body);
    assert.equal(req.opts.redirect, 'manual'); assert.equal(req.opts.headers.authorization, `Bearer ${secret}`);
    assert.equal(body.state.cards[0].card, 'c1'); assert.equal(body.state.cards[0].text.length, 2000);
    assert.equal(body.questions.c1.type, 'noul'); assert.equal(body.questions.exists.type, 'noul');
    const instructions = 'Do the cards in state.cards together contain all the information needed to answer every part of state.question correctly, without guessing?';
    const criteria = { true: 'Yes: every part of the question can be answered from the cards', false: 'No: at least one part of the question is missing from the cards or would have to be guessed' };
    assert.equal(body.questions.exists.instructions, instructions);
    assert.deepEqual(body.questions.exists.criteria, criteria);
    assert.equal(body.questions.c1.instructions, 'Does card c1 in state.cards contain information needed to answer state.question?');
    assert.deepEqual(body.questions.c1.criteria, { true: 'Yes', false: 'No' });
    await s.selectCards('question', pool, { searchMore: { message: 'Missing details', queries: ['details'] } });
    const round2 = JSON.parse(requests.at(-1).opts.body);
    const gap = ' Focus on the gap described by state.search_more.message and state.search_more.queries.';
    assert.equal(round2.questions.exists.instructions, instructions + gap);
    assert.deepEqual(round2.questions.exists.criteria, criteria);
    assert.equal(round2.questions.c1.instructions, body.questions.c1.instructions + gap);
    assert.deepEqual(round2.questions.c1.criteria, { true: 'Yes', false: 'No' });
    r = await selector({ JEV_PICK_MIN_P: 1 }).selectCards('q', pool); assert.equal(r.picked.length, 4);
    r = await selector({ JEV_PICK_MIN_P: 0 }).selectCards('q', pool); assert.equal(r.picked.length, 16);
    r = await selector({ JEV_PICK: 'fixed', JEV_PICK_K: 8 }).selectCards('q', pool); assert.equal(r.picked.length, 8); assert.equal(r.picked[0].id, 'id19');
    assert.equal((await selector({ JEV_PICK_MIN: 10, JEV_PICK_MAX: 2 }).selectCards('q', pool)).picked.length, 2);
    const failed = async (fetchImpl, reason, overrides = {}) => {
        const r = await selector(overrides, fetchImpl).selectCards('q', pool);
        assert.equal(r.path, 'fallback'); assert.equal(r.reason, reason); output.push(JSON.stringify(r));
    };
    await failed(async () => { throw new Error(secret); }, 'error');
    await failed(async () => new Response('oops', { status: 500 }), 'http');
    await failed(async () => new Response('no json'), 'invalid');
    for (const p of [-.1, 1.1, null, '0.9', true]) await failed(async () => response([p, ...ps.slice(1)]), 'invalid');
    await failed(async () => response(ps, 'no'), 'invalid');
    await failed(async () => response(ps.slice(1)), 'invalid');
    await failed(async () => new Response('x'.repeat(1048577)), 'oversize');
    await failed(async () => new Promise(() => {}), 'timeout', { JEV_TIMEOUT_MS: 10 });
    await failed(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } })), 'timeout', { JEV_TIMEOUT_MS: 10 });
    let redirectCalls = 0;
    await failed(async (_, opts) => { redirectCalls++; assert.equal(opts.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'http://never-follow' } }); }, 'redirect');
    assert.equal(redirectCalls, 1);
    await failed(async () => { throw new Error('should not call'); }, 'pool', { JEV_TOKENS_PER_CHAR: 100 });
    await failed(async () => { throw new Error('should not call'); }, 'nokey', { TYPESAFE_API_KEY: '' });
    let time = new Date(2026, 9, 20, 12).getTime();
    s = selector({ JEV_RATE_MAX: 2, JEV_RATE_WIN_MS: 100 }, undefined, { now: () => time, maxIps: 3 });
    await s.selectCards('q', pool, { ip: 'one' }); await s.selectCards('q', pool, { ip: 'one' });
    assert.equal((await s.selectCards('q', pool, { ip: 'one' })).reason, 'rate');
    assert.equal((await s.selectCards('q', pool, { ip: 'two' })).path, 'jev');
    time += 101; assert.equal((await s.selectCards('q', pool, { ip: 'one' })).path, 'jev');
    for (let i = 0; i < 10; i++) await s.selectCards('q', pool, { ip: String(i) });
    assert.equal(s.trackedIps(), 3);
    time += 101; await s.selectCards('q', pool); assert.equal(s.trackedIps(), 1);
    let warnings = [];
    s = selector({ JEV_DAILY_TOKENS: 1 }, undefined, { now: () => time, warn: v => warnings.push(v) });
    assert.equal((await s.selectCards('q', pool)).reason, 'budget'); await s.selectCards('q', pool); assert.equal(warnings.length, 1);
    time += 86400000; await s.selectCards('q', pool); assert.equal(warnings.length, 2);
    // Reported usage replaces the reservation, and a day rollover resets it.
    s = selector({ JEV_DAILY_TOKENS: 100000 }, async () => response(ps, .7, { total_tokens: 100000 }), { now: () => time });
    assert.equal((await s.selectCards('q', pool)).path, 'jev'); assert.equal((await s.selectCards('q', pool)).reason, 'budget');
    time += 86400000; assert.equal((await s.selectCards('q', pool)).path, 'jev');
    // Concurrent calls reserve their estimates before their first await.
    const small = pool.slice(0, 1); let resolve;
    s = selector({ JEV_DAILY_TOKENS: 1500 }, async () => new Promise(r => { resolve = r; }));
    const first = s.selectCards('q', small);
    assert.equal((await s.selectCards('q', small)).reason, 'budget'); resolve(response([.9])); await first;
    assert.equal(cardState('q', pool, base).cards[0].text.length, 2000);
    assert.equal((await selector().selectCards('q', [])).reason, 'pool');
    assert.equal((await selector({}, async () => response([.1])).selectCards('q', pool.slice(0, 1))).picked.length, 1);
    // Env validation warnings never echo invalid values, including credential-like input.
    const saved = Object.fromEntries(['JEV_POOL_TOKENS', 'JEV_PICK_K', 'MAX_SEARCH_ROUNDS', 'JEV_PICK_MIN_P', 'JEV_CARD_CHARS', 'JEV_DAILY_TOKENS', 'JEV_SEARCH_HINT_BELOW', 'HAIKU_TIMEOUT_MS', 'HAIKU_MAX_RESPONSE_BYTES', 'HAIKU_CARD_CHARS', 'HAIKU_MAX_INPUT_TOKENS'].map(k => [k, process.env[k]]));
    try {
        for (const name of Object.keys(saved)) delete process.env[name];
        const defaults = await import('./config.mjs?test=defaults');
        assert.equal(defaults.JEV_DAILY_TOKENS, 20000000);
        assert.equal(defaults.JEV_SEARCH_HINT_BELOW, .7);
        assert.equal(defaults.HAIKU_TIMEOUT_MS, 60000); assert.equal(defaults.HAIKU_MAX_RESPONSE_BYTES, 1048576);
        assert.equal(defaults.HAIKU_CARD_CHARS, 8000); assert.equal(defaults.HAIKU_MAX_INPUT_TOKENS, 24000);
        assert.equal(defaults.MAX_SEARCH_ROUNDS, 4); assert.equal(defaults.JEV_PICK_MIN_P, .4);
        assert.equal(defaults.JEV_POOL_TOKENS, 28000); assert.equal(defaults.JEV_CARD_CHARS, 2000);
        const threshold = createSelector({ cfg: { ...base, JEV_PICK_MIN_P: defaults.JEV_PICK_MIN_P }, fetchImpl: async () => response(ps) });
        assert.equal((await threshold.selectCards('q', pool)).picked.length, 12);
        process.env.HAIKU_TIMEOUT_MS = 'NaN'; process.env.HAIKU_MAX_RESPONSE_BYTES = '-1';
        process.env.HAIKU_CARD_CHARS = 'Infinity'; process.env.HAIKU_MAX_INPUT_TOKENS = '-1';
        process.env.JEV_POOL_TOKENS = 'NaN'; process.env.JEV_PICK_K = '-1'; process.env.MAX_SEARCH_ROUNDS = '99';
        let cfg = await import('./config.mjs?test=validation');
        assert.equal(cfg.HAIKU_TIMEOUT_MS, 60000); assert.equal(cfg.HAIKU_MAX_RESPONSE_BYTES, 1048576);
        assert.equal(cfg.HAIKU_CARD_CHARS, 8000); assert.equal(cfg.HAIKU_MAX_INPUT_TOKENS, 24000);
        assert.equal(cfg.JEV_POOL_TOKENS, 28000); assert.equal(cfg.JEV_PICK_K, 8); assert.equal(cfg.MAX_SEARCH_ROUNDS, 10);
        process.env.JEV_POOL_TOKENS = 'Infinity'; process.env.MAX_SEARCH_ROUNDS = '0';
        cfg = await import('./config.mjs?test=lower');
        assert.equal(cfg.JEV_POOL_TOKENS, 28000); assert.equal(cfg.MAX_SEARCH_ROUNDS, 1);
        for (const [i, [raw, expected]] of [['', .7], ['NaN', .7], ['Infinity', .7], ['-1', .7], ['2', 1], ['0', 0], ['1', 1], ['.42', .42], [secret, .7]].entries()) {
            process.env.JEV_SEARCH_HINT_BELOW = raw;
            cfg = await import(`./config.mjs?test=hint-${i}`);
            assert.equal(cfg.JEV_SEARCH_HINT_BELOW, expected);
        }
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }

    assert(!output.join('\n').includes(secret), 'credential leaked to output');
} finally { Object.assign(console, originals); }
console.log('PASS Jev selection, safety, bounds, rollover, credential redaction');
