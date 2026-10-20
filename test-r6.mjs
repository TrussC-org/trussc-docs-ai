// Offline ingress/startup regressions: no sockets or provider calls.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const dir = mkdtempSync(join(tmpdir(), 'docsai-r6-'));
let failures = 0;
async function test(name, fn) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
}
try {
    const app = join(dir, 'with space'); mkdirSync(app);
    for (const name of ['server.mjs', 'config.mjs', 'stats.mjs', 'debug.mjs', 'mcp-core.mjs']) {
        writeFileSync(join(app, name), readFileSync(new URL(name, import.meta.url)));
    }
    writeFileSync(join(app, 'rag.mjs'), `
export const chunks = () => [];
export const refLink = () => ''; export const leanText = () => '';
export const getByIds = () => []; export const retrievalInfo = () => ({});
export const retrieve = async () => [];
export const calls = [];
export const answer = async (...args) => { calls.push(args); return {text:'ok', retrieved:[], links:[]}; };
export async function* answerStream(...args) { calls.push(args); yield {type:'final', text:'ok'}; }
`);
    const preload = join(dir, 'no-listen.mjs');
    writeFileSync(preload, `import { Server } from 'node:http'; import { writeFileSync } from 'node:fs'; Server.prototype.listen = function () { writeFileSync(process.env.LISTEN_MARKER, 'LISTEN_STUB_CALLED'); return this; };`);
    const entry = join(app, 'server.mjs'), link = join(dir, 'entry.mjs'); symlinkSync(entry, link);
    const env = { ...process.env, STATS: '0', TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '' };
    for (const [name, path] of [['space startup', entry], ['symlink startup', link]]) await test(name, async () => {
        const marker = join(dir, `${name}.marker`);
        const status = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--import', preload, path], { env: {...env, LISTEN_MARKER:marker}, stdio:'inherit' });
            child.on('error', reject); child.on('close', resolve);
        });
        assert.equal(status, 0); assert(existsSync(marker), 'entry never reached listen');
        assert.equal(readFileSync(marker, 'utf8'), 'LISTEN_STUB_CALLED');
    });
    process.env.MAX_BODY_BYTES = '262144'; process.env.RATE_MAX = '1000';
    process.env.STATS = '1'; process.env.STATS_LOG = join(dir, 'stats.jsonl');
    await test('body-limit default and invalid numeric configuration', async () => {
        const warn = console.warn, warnings = [];
        console.warn = value => warnings.push(value);
        try {
            for (const [i, raw] of [undefined, 'NaN', '-1', 'Infinity', '4096.9', '0'].entries()) {
                if (raw === undefined) delete process.env.MAX_BODY_BYTES; else process.env.MAX_BODY_BYTES = raw;
                const cfg = await import(`${pathToFileURL(join(app, 'config.mjs'))}?limit=${i}`);
                assert.equal(cfg.MAX_BODY_BYTES, i < 4 ? 262144 : i === 4 ? 4096 : 0);
            }
            assert.equal(warnings.filter(w => w.includes('MAX_BODY_BYTES')).length, 3);
        } finally { console.warn = warn; process.env.MAX_BODY_BYTES = '262144'; }
    });
    const { server } = await import(pathToFileURL(entry));
    const { calls } = await import(pathToFileURL(join(app, 'rag.mjs')));
    function request(path) {
        const req = new EventEmitter(); Object.assign(req, { method:'POST', url:path, headers:{}, socket:{remoteAddress:'offline'} });
        req.drained = false; req.resume = () => { req.drained = true; };
        const res = { status:200, data:'', setHeader() {}, writeHead(status) { this.status = status; }, write(s) { this.data += s; } };
        const done = new Promise(resolve => { res.end = s => { if(s) res.data += s; resolve(res); }; });
        server.emit('request', req, res); return { req, done };
    }
    const limit = 262144;
    const payload = n => Buffer.from(JSON.stringify({ question:'q', padding:'x'.repeat(n - 29) }));
    assert.equal(payload(limit).length, limit);
    for (const path of ['/ask', '/chat', '/search', '/mcp', '/get']) {
        await test(`${path} just under byte cap`, async () => {
            const { req, done } = request(path); req.emit('data', payload(limit - 1)); req.emit('end');
            assert.equal((await done).status, path === '/mcp' ? 202 : 200);
        });
        await test(`${path} one byte over stops retention before EOF`, async () => {
            const { req, done } = request(path);
            const chunk = payload(limit);
            let retained = 0; const from = Buffer.from;
            // Count copies into the body reader, including the rejected chunk if copied.
            Buffer.from = function(value, ...args) { const b = from(value, ...args); retained += b.length; return b; };
            try { req.emit('data', chunk); req.emit('data', from('x')); }
            finally { Buffer.from = from; }
            const res = await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(Error('reader waited for EOF')), 80))]);
            assert.equal(res.status, 413); assert(retained <= limit, `retained ${retained}`);
            assert.equal(req.listenerCount('data'), 0); assert(req.drained);
            const body = JSON.parse(res.data);
            assert.deepEqual(body, path === '/mcp' ? {jsonrpc:'2.0', id:null, error:{code:-32000, message:'request too large'}} : {error:'request too large'});
            req.emit('data', Buffer.alloc(limit)); req.emit('end');
        });
    }
    await test('exact byte boundary accepts split UTF-8 JSON', async () => {
        const { req, done } = request('/ask');
        const prefix = Buffer.from('{"question":"あ","padding":"');
        const suffix = Buffer.from('"}');
        const body = Buffer.concat([prefix, Buffer.alloc(limit - prefix.length - suffix.length, 120), suffix]);
        const split = Buffer.from('{"question":"').length + 1;
        req.emit('data', body.subarray(0, split)); req.emit('data', body.subarray(split)); req.emit('end');
        assert.equal((await done).status, 200); assert.equal(calls.at(-1)[0], 'あ');
    });
    await test('chunked trickle cuts off without EOF', async () => {
        const { req, done } = request('/ask');
        req.emit('data', Buffer.alloc(limit - 2, 32));
        for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 2)); req.emit('data', Buffer.from(' ')); }
        const res = await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(Error('trickle not cut')), 80))]);
        assert.equal(res.status, 413); assert.equal(req.listenerCount('data'), 0); assert(req.drained);
    });
    for (const path of ['/ask', '/chat', '/search']) for (const field of ['question', 'history']) await test(`${path} ${field} character cap`, async () => {
        const { req, done } = request(path);
        const body = field === 'question' ? {question:'q'.repeat(8001)} : {question:'q', history:[{role:'user', content:'h'.repeat(8001)}]};
        const before = calls.length; req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end');
        assert.equal((await done).status, 400); assert.equal(calls.length, before);
    });
    await test('character caps accept exact boundary and six recent turns', async () => {
        const { req, done } = request('/ask');
        req.emit('data', Buffer.from(JSON.stringify({question:'q'.repeat(8000), history:Array.from({length:7}, () => ({role:'user', content:'h'.repeat(8000)}))}))); req.emit('end');
        assert.equal((await done).status, 200); assert.equal(calls.at(-1)[1].length, 6);
    });
    await test('body rejections record reason only', () => {
        const rows = readFileSync(process.env.STATS_LOG, 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.errorReason === 'body');
        assert.equal(rows.length, 6); for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['ep','errorReason','ts']);
    });
    await test('retained pool and tool limits have bound annotations', () => {
        for (const [file, fragment] of [['rag.mjs','export function buildPool'], ['rag.mjs','export function buildRoundPool'], ['rag.mjs','export function validSearchInput'], ['jev.mjs','if (perQuestionTokens']]) {
            const src = readFileSync(new URL(file, import.meta.url), 'utf8'), at = src.indexOf(fragment);
            assert.match(src.slice(Math.max(0, at-350), at), /\/\/ Bound \([a-z]+\):[^\n]+Overflow[^\n]+counted\./);
        }
    });
} finally { rmSync(dir, {recursive:true, force:true}); }
if (failures) process.exitCode = 1;
