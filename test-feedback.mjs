// Synthetic temp files and in-memory HTTP only; no real corpus, stats, sockets or keys.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
    openSync, closeSync, statSync, lstatSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { TOOLS, dispatch } from './mcp-core.mjs';

const dir = mkdtempSync(join(tmpdir(), 'docsai-feedback-'));
const saved = { ...process.env };
const rpc = args => ({ id: 1, method: 'tools/call', params: { name: 'trussc_feedback', arguments: args } });
const valid = { kind: 'wrong', text: 'Synthetic docs have the wrong signature.', ids: ['symbol:drawCircle'], version: 'v0.7.7' };
const ack = 'Feedback recorded. Thank you.', limited = 'error: feedback rate limited', failed = 'Feedback could not be recorded.';
const lines = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const toolText = response => response.result.content[0].text;
function child(args, env = {}, input = '') {
    writeFileSync(join(dir, 'stdin'), input);
    const fds = ['stdin', 'stdout', 'stderr'].map((name, i) => openSync(join(dir, name), i ? 'w' : 'r'));
    let result;
    try { result = spawnSync(process.execPath, args, { env: { ...process.env, ...env }, stdio: fds, timeout: 10000 }); }
    finally { fds.forEach(closeSync); }
    assert.equal(result.error, undefined);
    return { status: result.status, stdout: readFileSync(join(dir, 'stdout'), 'utf8'), stderr: readFileSync(join(dir, 'stderr'), 'utf8') };
}
async function fixture(enabled) {
    const app = join(dir, enabled ? 'enabled' : 'disabled'), stats = join(app, 'stats');
    mkdirSync(stats, { recursive: true });
    Object.assign(process.env, { STATS: enabled ? '1' : '0', STATS_DIR: stats, STATS_SALT: 'synthetic-salt', STATS_RETENTION_DAYS: '183', RATE_MAX: '10000' });
    for (const file of ['server.mjs', 'stats.mjs', 'config.mjs', 'mcp-core.mjs', 'debug.mjs'])
        writeFileSync(join(app, file), readFileSync(new URL(file, import.meta.url)));
    writeFileSync(join(app, 'rag.mjs'), `
export const chunks = () => [];
export const retrieve = exportUnused, retrieveQueries = exportUnused, answerStream = exportUnused;
export const refLink = exportUnused, leanText = exportUnused, getByIds = exportUnused, retrievalInfo = exportUnused;
function exportUnused() { throw new Error('feedback must not invoke retrieval/generation'); }
`);
    const { server } = await import(join(app, 'server.mjs'));
    const statsModule = await import(join(app, 'stats.mjs'));
    const request = async (body, headers = {}, address = '192.0.2.10') => {
        const response = await new Promise(resolve => {
            const req = new PassThrough();
            Object.assign(req, { method: 'POST', url: '/mcp', headers: { 'user-agent': 'Claude-Code/1.2', ...headers }, socket: { remoteAddress: address } });
            const res = new EventEmitter();
            Object.assign(res, { data: '', setHeader() {}, writeHead(status) { this.status = status; }, end(data = '') { this.data += data; resolve(this); } });
            server.emit('request', req, res); req.end(JSON.stringify(body));
        });
        assert.equal(response.status, 200);
        return JSON.parse(response.data);
    };
    return { stats, request, ...statsModule };
}
try {
    const { stats, request, createFeedbackRecorder, hashIp, hashNet, pruneStats, statsFileDate } = await fixture(true);
    const feedback = TOOLS.find(t => t.name === 'trussc_feedback');
    assert(feedback);
    assert.deepEqual(feedback.inputSchema.required, ['kind', 'text']);
    assert(!/anyOf|oneOf/.test(JSON.stringify(feedback.inputSchema)));
    assert.deepEqual((await dispatch({ id: 1, method: 'tools/list' })).result.tools.map(t => t.name), ['trussc_search', 'trussc_get']);
    assert.deepEqual((await request({ id: 1, method: 'tools/list' })).result.tools.map(t => t.name), ['trussc_search', 'trussc_get', 'trussc_feedback']);
    const proxy = child(['mcp.mjs'], {}, [
        { id: 1, method: 'tools/list' }, rpc(valid),
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(proxy.status, 0, proxy.stderr);
    const replies = proxy.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(replies[0].result.tools.map(t => t.name), ['trussc_search', 'trussc_get']);
    assert.equal(replies[1].error.code, -32602, 'stdio cannot call feedback');
    console.log('PASS remote feedback schema/list and real stdio list/call exclusion (chat covered by test-chat-tools.mjs)');

    const invalid = [undefined, null, [], 42, 'bad', {}, { text: 'x' }, { kind: 'other' },
        ...['bad', '', null, [], {}, 1].map(kind => ({ ...valid, kind })),
        ...['', ' \n', 'x'.repeat(2001), null, [], {}, 1, true].map(text => ({ ...valid, text })),
        ...[null, 'id', {}, 1, [null], [42], [{}], Array(11).fill('id'), ['x'.repeat(201)]].map(ids => ({ ...valid, ids })),
        ...[null, [], {}, 1, true, 'x'.repeat(101)].map(version => ({ ...valid, version })),
    ];
    for (const args of invalid) {
        const result = await request(rpc(args));
        assert.equal(result.result.isError, true, JSON.stringify(args));
        assert.match(toolText(result), /^error: /);
    }
    assert(!readdirSync(stats).some(name => name.startsWith('feedback-')), 'invalid input never stores feedback or consumes its limits');
    const umask = process.umask(0);
    try {
        assert.equal(toolText(await request(rpc(valid), { 'cf-connecting-ip': '2001:db8:1234:5678::1' })), ack);
        for (const args of [
            { kind: 'missing', text: 'x' },
            { kind: 'other', text: 'x'.repeat(2000), ids: Array(10).fill('x'.repeat(200)), version: 'v'.repeat(100) },
        ]) assert.equal(toolText(await request(rpc(args))), ack);
    } finally { process.umask(umask); }
    const day = new Date().toISOString().slice(0, 10), feedbackFile = join(stats, `feedback-${day}.jsonl`);
    const stored = lines(feedbackFile);
    assert.equal(stored.length, 3);
    assert.equal(statSync(feedbackFile).mode & 0o777, 0o600);
    assert.deepEqual(stored[0], { ts: stored[0].ts, ...valid, client: 'claude', ip: hashIp('2001:db8:1234:5678::1'), net: hashNet('2001:db8:1234:5678::1') });
    assert.equal(stored[0].ts.slice(0, 10), day);
    assert.deepEqual(stored[1].ids, []); assert.equal(stored[1].version, null);
    const usage = lines(join(stats, `${day}.jsonl`));
    for (const row of usage.filter(row => row.method === 'tools/call')) {
        assert.equal(row.ep, 'mcp'); assert.equal(row.tool, 'trussc_feedback');
        assert.equal(row.client, 'claude'); assert(!('q' in row)); assert(!('a' in row));
        assert(!('text' in row)); assert.equal(row.qLen, null); assert.equal(row.qLang, null);
        assert.equal(row.rounds, 0); assert.equal(row.haikuCalls, 0);
    }
    assert(!readFileSync(join(stats, `${day}.jsonl`), 'utf8').includes(valid.text));
    // The endpoint applies its limiter too, independently of the generic POST cap.
    for (let i = 0; i < 10; i++) assert.equal(toolText(await request(rpc(valid), {}, '192.0.2.99')), ack);
    const before = lines(feedbackFile).length;
    const rejected = await request(rpc(valid), {}, '192.0.2.99');
    assert.equal(toolText(rejected), limited); assert.equal(rejected.result.isError, true);
    assert.equal(lines(feedbackFile).length, before);
    console.log('PASS validation, inclusive field bounds, daily row shape/mode/hashes, text-free usage rows and endpoint per-IP limit');

    let clock = Date.parse('2026-01-01T23:30:00Z');
    const written = [];
    const record = createFeedbackRecorder({ now: () => clock, write: row => { written.push(row); return true; } });
    const report = { ...valid, client: 'claude', ip: hashIp('192.0.2.1'), net: hashNet('192.0.2.1') };
    for (let i = 0; i < 10; i++) assert.equal(record(report).text, ack);
    assert.deepEqual(record(report), { text: limited, isError: true });
    clock = Date.parse('2026-01-02T00:00:00Z');
    assert.equal(record(report).text, limited, 'UTC day reset does not reset hourly IP history');
    clock = Date.parse('2026-01-02T00:29:59.999Z');
    assert.equal(record(report).text, limited);
    clock++;
    assert.equal(record(report).text, ack, 'exact hour boundary expires old admissions');
    const daily = createFeedbackRecorder({ now: () => clock, write: row => { written.push(row); return true; } });
    for (let i = 0; i < 500; i++) assert.equal(daily({ ...report, ip: hashIp(`synthetic-${i}`) }).text, ack);
    const count = written.length;
    assert.deepEqual(daily({ ...report, ip: hashIp('another') }), { text: limited, isError: true });
    assert.equal(written.length, count);
    clock = Date.parse('2026-01-03T00:00:00Z');
    assert.equal(daily(report).text, ack, 'global limit resets on UTC midnight');
    const dated = createFeedbackRecorder({ now: () => '2026-01-04T08:59:59.999+09:00' });
    assert.equal(dated(report).text, ack);
    assert.equal(lines(join(stats, 'feedback-2026-01-03.jsonl'))[0].ts, '2026-01-03T23:59:59.999Z');
    console.log('PASS rolling-hour boundary, global 500/day cap, midnight reset and UTC filename');

    const outside = join(dir, 'outside'); writeFileSync(outside, 'UNCHANGED');
    symlinkSync(outside, join(stats, 'feedback-2026-02-01.jsonl'));
    const warnings = [], warn = console.warn;
    console.warn = message => warnings.push(message);
    try {
        assert.equal(createFeedbackRecorder({ now: () => '2026-02-01' })(report).text, failed);
        assert.equal(readFileSync(outside, 'utf8'), 'UNCHANGED');
        assert.equal(createFeedbackRecorder({ write: () => { throw new Error(valid.text); } })(report).text, failed);
        rmSync(stats, { recursive: true });
        assert.equal(toolText(await request(rpc(valid))), failed, 'missing-directory write failure reaches the endpoint as fixed text');
        assert(!existsSync(stats)); assert.equal(warnings.length, 1);
        assert(!warnings.join('').includes(valid.text));
    } finally { console.warn = warn; }
    console.log('PASS fixed failure result for symlink, thrown writer and missing directory; no content in warnings');

    const retention = join(dir, 'retention'); mkdirSync(retention);
    const keep = ['feedback-2026-04-28.jsonl', 'feedback-2026-04-29.jsonl', 'feedback-2026-02-30.jsonl',
        'feedback-2026-04.jsonl', 'feedback-2026-04-01.jsonl.bak', 'feedback-2026-04-01.jsonl\n'];
    for (const name of [...keep, 'feedback-2026-04-27.jsonl', '2026-04-27.jsonl']) writeFileSync(join(retention, name), 'SYNTHETIC ROW');
    symlinkSync(outside, join(retention, 'feedback-2026-04-26.jsonl'));
    mkdirSync(join(retention, 'feedback-2026-04-25.jsonl'));
    const result = await pruneStats({ dir: retention, now: () => '2026-10-28T23:59:59Z' });
    assert.equal(result.deleted, 2);
    for (const name of keep) assert(existsSync(join(retention, name)), name);
    assert(lstatSync(join(retention, 'feedback-2026-04-26.jsonl')).isSymbolicLink());
    assert(lstatSync(join(retention, 'feedback-2026-04-25.jsonl')).isDirectory());
    assert.equal(readFileSync(outside, 'utf8'), 'UNCHANGED');
    assert.equal(statsFileDate('feedback-2026-04-28.jsonl'), null, 'stats readers exclude feedback by default');
    console.log('PASS retention cutoff equality, calendar/exact names and regular-file-only pruning');

    mkdirSync(stats);
    writeFileSync(join(stats, `feedback-${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ep: 'mcp', q: 'MUST_NOT_BE_READ' }) + '\nINVALID\n');
    const summary = child(['report.mjs', '--stats-dir', stats, '--live', join(dir, 'absent')]);
    assert.equal(summary.status, 0, summary.stderr);
    assert.equal(summary.stdout.trim(), 'no requests in range', 'report must not parse even valid-looking stats or malformed feedback rows');

    const current = new Date().toISOString();
    const recent = { ...report, ts: current }, older = { ...report, ts: '2000-01-01T00:00:00Z', kind: 'missing', text: 'Synthetic older feedback' };
    writeFileSync(join(stats, `feedback-${day}.jsonl`), [recent, { ...recent, ts: `${day}T00:00:00.000Z`, kind: 'other' }].map(JSON.stringify).join('\n') + '\nINVALID\n');
    writeFileSync(join(stats, 'feedback-2000-01-01.jsonl'), JSON.stringify(older) + '\n');
    writeFileSync(join(stats, `${day}.jsonl`), JSON.stringify({ ts: current, text: 'NOT FEEDBACK' }));
    const view = child(['tools/feedback.mjs']);
    assert.equal(view.status, 0, view.stderr); assert.equal(view.stderr, '');
    const printed = view.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(printed.length, 3); assert.equal(printed[0].text, older.text);
    assert.equal(printed.at(-1).ts, current);
    for (const row of printed) assert.deepEqual(Object.keys(row), ['ts', 'kind', 'ids', 'version', 'text']);
    const recentView = child(['tools/feedback.mjs', '--days', '1']);
    assert.equal(recentView.status, 0, recentView.stderr);
    assert.equal(recentView.stdout.trim().split('\n').length, 2);
    for (const days of ['0', '-1', 'abc', '1.5']) assert.equal(child(['tools/feedback.mjs', '--days', days]).status, 1);
    assert.equal(child(['tools/feedback.mjs', '--days']).status, 1);
    console.log('PASS report ignores feedback, operator view fields/order/day filter and argument validation');

    const disabled = await fixture(false);
    assert.equal(toolText(await disabled.request(rpc(valid))), 'Feedback is not recorded on this server.');
    assert.deepEqual(readdirSync(disabled.stats), []);
    console.log('PASS STATS=0 fixed message and no writes');
} finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
}
