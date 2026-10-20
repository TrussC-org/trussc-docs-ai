// Offline fragmented-body regression: real HTTP parser over in-memory sockets.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

if (!global.gc) {
    const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
        child.on('error', reject); child.on('close', resolve);
    });
    assert.equal(code, 0, 'fragmented-body GC worker failed');
} else {
    const dir = mkdtempSync(join(tmpdir(), 'docsai-r7-'));
    const sockets = [];
    let server, failures = 0;
    const turn = () => new Promise(resolve => setImmediate(resolve));
    async function collect() { await turn(); global.gc(); await turn(); global.gc(); }
    async function test(name, fn) {
        try { await fn(); console.log(`PASS ${name}`); }
        catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
    }
    try {
        for (const file of ['server.mjs', 'config.mjs', 'stats.mjs', 'debug.mjs', 'mcp-core.mjs']) {
            let source = readFileSync(new URL(file, import.meta.url), 'utf8');
            // Instrument only body-reader allocations, without retaining their targets.
            if (file === 'server.mjs') source = `import { Buffer } from './buffers.mjs';\n` + source;
            writeFileSync(join(dir, file), source);
        }
        writeFileSync(join(dir, 'buffers.mjs'), `
import { Buffer as Native } from 'node:buffer';
export let tracking = false;
export const refs = [];
export function track(value) { tracking = value; refs.length = 0; }
export const Buffer = new Proxy(Native, { get(target, name) {
    const value = target[name];
    if (['from', 'alloc', 'allocUnsafe', 'allocUnsafeSlow', 'concat'].includes(name)) return (...args) => {
        const buffer = value.apply(target, args);
        if (tracking) refs.push(new WeakRef(buffer));
        return buffer;
    };
    return value;
} });
`);
        writeFileSync(join(dir, 'rag.mjs'), `
export const chunks = () => [];
export const refLink = () => ''; export const leanText = () => '';
export const getByIds = () => []; export const retrievalInfo = () => ({});
export const retrieve = async () => [];
export const answer = async () => ({text:'ok', retrieved:[], links:[]});
export async function* answerStream() { yield {type:'final'}; }
`);
        Object.assign(process.env, { STATS:'0', RATE_MAX:'30', MAX_BODY_BYTES:'262144' });
        ({ server } = await import(pathToFileURL(join(dir, 'server.mjs'))));
        const instrument = await import(pathToFileURL(join(dir, 'buffers.mjs')));
        class Wire extends Duplex {
            constructor() { super(); this.remoteAddress = 'offline'; this.output = ''; this.request = null; }
            _read() {}
            _write(bytes, encoding, done) { this.output += bytes.toString(); done(); }
            setTimeout() { return this; }
            setNoDelay() { return this; }
            setKeepAlive() { return this; }
        }
        server.on('request', (req) => { req.socket.request = req; });
        function open() {
            const socket = new Wire(); sockets.push(socket); server.emit('connection', socket);
            socket.push(Buffer.from('POST /ask HTTP/1.1\r\nHost: offline\r\nTransfer-Encoding: chunked\r\n\r\n'));
            return socket;
        }
        const count = 65536, concurrent = 8, limit = 262144;
        const packet = Buffer.from('1\r\n \r\n'.repeat(count));
        await test('concurrent 65536-chunk bodies each retain O(1) accumulator Buffers', async () => {
            instrument.track(true);
            const groups = [];
            for (let i = 0; i < 4; i++) {
                const start = instrument.refs.length;
                const socket = open(); socket.push(packet); await turn();
                groups.push({ socket, refs: instrument.refs.slice(start) });
            }
            await collect();
            for (const { socket, refs } of groups) {
                const live = refs.map(ref => ref.deref()).filter(Boolean);
                console.log(`retained Buffers: ${live.length}, allocations: ${refs.length}`);
                assert(live.length <= 2, `retained ${live.length} Buffers for one pending request`);
                assert(refs.length <= 6, 'accumulator did not grow geometrically');
                assert(live.reduce((sum, buffer) => sum + buffer.length, 0) <= 2 * limit);
                assert.equal(socket.output, ''); assert.equal(socket.request.listenerCount('data'), 1);
                socket.destroy();
            }
        });
        instrument.track(false);
        await collect();
        await test('concurrent pending fragmented requests have bounded post-GC heap growth', async () => {
            const pending = [];
            await collect();
            const before = process.memoryUsage();
            for (let i = 0; i < concurrent; i++) {
                const socket = open(); pending.push(socket); socket.push(packet); await turn();
            }
            await collect();
            const after = process.memoryUsage(), payload = concurrent * count;
            const heapGrowth = after.heapUsed - before.heapUsed;
            console.log(`pending payload: ${payload}, post-GC heap growth: ${heapGrowth}, array-buffer growth: ${after.arrayBuffers - before.arrayBuffers}`);
            assert(heapGrowth <= 4 * payload, `heap growth ${heapGrowth} exceeds 4 x payload ${payload}`);
            assert(after.arrayBuffers - before.arrayBuffers <= 2 * payload, 'retained storage exceeds 2 x payload');
            for (const socket of pending) {
                assert.equal(socket.output, ''); assert.equal(socket.request.listenerCount('data'), 1);
                // Cross the cap without EOF; the response must arrive and collecting must stop.
                socket.push(Buffer.from(`${(limit - count + 1).toString(16)}\r\n${' '.repeat(limit - count + 1)}\r\n`));
                await turn();
                assert.match(socket.output, /HTTP\/1\.1 413/);
                assert.equal(socket.request.listenerCount('data'), 0);
                // More valid HTTP chunks still drain after the rejection.
                socket.push(Buffer.from('1\r\nX\r\n0\r\n\r\n')); await turn();
                assert.equal(socket.destroyed, false); socket.destroy();
            }
        });
    } finally {
        for (const socket of sockets) socket.destroy();
        server?.close(); rmSync(dir, { recursive:true, force:true });
    }
    if (failures) process.exitCode = 1;
}
