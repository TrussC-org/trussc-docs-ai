// Offline resource/membership checks. Re-exec with GC to measure retained storage.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSymbolChecker } from './mcp-core.mjs';

if (!global.gc) {
    const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
        child.on('error', reject); child.on('close', resolve);
    });
    assert.equal(code, 0, 'symbol checker GC worker failed');
} else {
    test('all core card kinds index whole words, bounded before allocation, without reading vectors', () => {
        for (const id of ['symbol:Owner', 'lua:Owner', 'doc:owner', 'concept:owner', 'example:owner']) {
            const card = { id, title: 'TitleOwner',
                text: `${'x'.repeat(97)} sampleRate pre_CudaGraph_post CudaGraphSuffix` };
            Object.defineProperty(card, 'vector', { get() { throw Error('vectors must not be scanned'); } });
            const check = createSymbolChecker([card]);
            for (const name of ['TitleOwner', 'sampleRate']) {
                assert.deepEqual(check(`how do I use ${name}`), [], id);
                assert.deepEqual(check(`tcx::${name.toLowerCase()}::member`), [], id);
            }
            assert.deepEqual(check('tc::CudaGraph').map(m => m.name), ['CudaGraph'], id);
        }
    });

    test('production-size embedding-heavy corpus initializes with bounded time and retained memory', () => {
        const kinds = ['symbol', 'lua', 'doc', 'concept', 'example', 'addon'];
        const vector = Array(1024).fill(0.123456789);
        const prose = 'One documentation paragraph mentions fields and nested types, with comments and quoted strings. '.repeat(12);
        let fixture = Array.from({ length: 5002 }, (_, i) => ({
            id: `${kinds[i % kinds.length]}:OwnerType${i}`, title: `OwnerType${i}`,
            text: `onMouseDrag${i} sampleRate${i} EaseFunction${i} MatrixScope${i} earlyUpdate${i}\n${prose}`,
            vector,
        }));
        let json = JSON.stringify(fixture);
        const jsonBytes = Buffer.byteLength(json);
        assert(jsonBytes >= 64 * 1024 ** 2 && jsonBytes < 80 * 1024 ** 2, `unexpected fixture size: ${jsonBytes}`);
        fixture = null;
        const corpus = JSON.parse(json); json = null;
        const textCodeUnits = corpus.reduce((n, c) => n + c.title.length + c.text.length, 0);
        global.gc();
        const before = process.memoryUsage(), start = performance.now();
        const check = createSymbolChecker(corpus), initMs = performance.now() - start;
        const after = process.memoryUsage();
        global.gc();
        const retained = process.memoryUsage();
        // Query after GC: every last-card kind and inline-name family must still
        // work, and a true absence rules out accidentally disabling all checks.
        for (let i = 4996; i < 5002; i++) {
            assert.deepEqual(check(`OwnerType${i}`), []);
            for (const prefix of ['onMouseDrag', 'sampleRate', 'EaseFunction', 'MatrixScope', 'earlyUpdate'])
                assert.deepEqual(check(`${prefix}${i}`), []);
        }
        for (const name of ['CudaGraph', 'setupGui', 'loadFromUrlAsync', 'FboSettings', 'drawRoundedRect'])
            assert.deepEqual(check(`how do I use ${name}`).map(m => m.name), [name]);
        console.log(`MEASURE ${JSON.stringify({ cards: corpus.length, dimensions: 1024, jsonBytes, textCodeUnits,
            initMs, heapAdded: after.heapUsed - before.heapUsed, heapRetained: retained.heapUsed - before.heapUsed,
            rssAdded: after.rss - before.rss, maxRssKiB: process.resourceUsage().maxRSS })}`);
        // Generous regression guards, not production latency/peak-memory promises.
        assert(initMs < 10000, `initialization exceeded 10 seconds: ${initMs} ms`);
        assert(retained.heapUsed - before.heapUsed < 64 * 1024 ** 2, 'retained checker storage exceeded 64 MiB');
    });

    test('distinct-word bound includes core text and id components; overflow abstains once', () => {
        const words = Array.from({ length: 999999 }, (_, i) => `word${i}`).join(' ');
        const corpus = [{ id: 'symbol:KnownOwner', text: words }];
        const check = createSymbolChecker(corpus);
        assert.deepEqual(check('tc::word999998'), []);
        assert.deepEqual(check('tc::KnownOwner'), []);
        assert.deepEqual(check('tc::CudaGraph').map(m => m.name), ['CudaGraph']);
        // Exactly one million distinct entries above; the next word invalidates
        // the incomplete index globally, without leaking corpus content.
        const savedWarn = console.warn, warnings = [];
        try {
            console.warn = value => warnings.push(value);
            const overflow = createSymbolChecker([...corpus, { id: 'doc:overflow', text: 'ExtraWord' }]);
            assert.deepEqual(overflow('tc::CudaGraph'), []);
            assert.deepEqual(overflow('tc::CudaGraph'), []);
        } finally { console.warn = savedWarn; }
        assert.deepEqual(warnings, ['[symbol-check] unavailable; documentation name checks disabled']);
    });
}
