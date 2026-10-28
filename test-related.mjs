// Synthetic corpus only. No network or credentials.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { computeNeighbours } from './embed.mjs';
import { RELATED_MIX } from './config.mjs';
import { buildRelatedList, relatedCandidates, formatSearchResults, relatedText } from './mcp-core.mjs';
import { coverage, main as coverageMain } from './eval/related/coverage.mjs';

const source = readFileSync(new URL('./build-chunks.mjs', import.meta.url), 'utf8');
const ctx = { Buffer };
vm.runInNewContext(`${source.slice(source.indexOf('// Bound (output): briefs fit'), source.indexOf('addBriefs(chunks);'))}\nglobalThis.extract = extractBrief; globalThis.add = addBriefs;`, ctx);
const brief = text => ctx.extract({ title: 'Title', id: 'test', text });
assert.equal(brief('# Title\nTitle\nSignatures:\n  void f()\nkeywords: test\nopenFrameworks: ofTest\n```cpp\nfake prose\n```\n~~~cpp\nalso code\n~~~\nActual   prose\t here.'), 'Actual prose here.');
assert.equal(ctx.extract({ title: 'Addon (addon README)', meta: { addon: 'Addon' }, text: 'Addon\n# Addon\nA helpful addon.' }), 'A helpful addon.');
assert.equal(brief('# Title\nValue: 42\nNested types: Nested\nExamples: a, b'), 'Title');
assert.equal(brief('# Title\nMethods: method\nSignatures:\n  void method()'), 'Title');
assert.equal(brief('# Title\n日本語の説明です。'), '日本語の説明です。');
assert.equal(brief('# Title\n### Details\n* First prose.'), 'First prose.');
const cut = brief('あ'.repeat(100));
assert(cut.endsWith('…') && !cut.includes('�') && Buffer.byteLength(cut) <= 160);
assert.equal(brief('a'.repeat(160)), 'a'.repeat(160));
assert.equal(brief('a'.repeat(161)), 'a'.repeat(157) + '…');
assert.equal(ctx.extract({ source: 'issue', title: 'Bug', text: '[Known bug]\n## Summary\nA [#fake]\u0000\u0085\u2028 injected tag.' }), 'A [ #fake] injected tag.');
const inherited = [
    { id: 'symbol:Child::f', title: 'Child::f', text: '`Child::f` — inherited from `Base::f`.', meta: { base: 'Base::f' } },
    { id: 'symbol:Base::f', title: 'Base::f', text: '# Base::f\nParent description.' },
    { id: 'symbol:MissingBase::f', title: 'MissingBase::f', text: '# MissingBase::f\nOnly copy of this prose.', meta: { inherited: 'Absent' } },
];
ctx.add(inherited);
assert.equal(inherited[0].meta.brief, 'Parent description.');
assert.equal(inherited[2].meta.brief, 'Only copy of this prose.');
const cycle = [{ id: 'symbol:A', title: 'A', meta: { base: 'B' } }, { id: 'symbol:B', title: 'B', meta: { base: 'A' } }];
ctx.add(cycle); assert(cycle.every(c => c.meta.brief));
const duplicates = [{ id: 'same', title: 'First' }, { id: 'same', title: 'Second' }];
ctx.add(duplicates); assert(duplicates.every(c => c.meta.brief));

const vec = (id, v, extra = {}) => ({ id, vectors: [v, [999, 999]], ...extra });
const vectors = [vec('a', [2, 0]), vec('c', [1, 0]), vec('b', [3, 0]), vec('d', [-1, 0]), vec('e', [0, 1]), vec('lua', [1, 0], { lang: 'lua' })];
const neighbours = computeNeighbours(vectors, 3);
assert.deepEqual(neighbours.get('a'), ['b', 'c', 'e']);
assert.deepEqual(neighbours, computeNeighbours(vectors.slice().reverse(), 3));
for (const [id, near] of neighbours) { assert(!near.includes(id)); assert(!near.includes('lua')); assert(near.length <= 3); }
assert.equal(neighbours.has('lua'), false);
assert.deepEqual(computeNeighbours([vec('single', [1])]).get('single'), []);
assert.deepEqual(computeNeighbours([vec('a', [0]), vec('b', [0])]).get('a'), ['b']);
for (const magnitude of [1e200, 1e-200, Number.MAX_VALUE, Number.MIN_VALUE]) {
    assert.equal(computeNeighbours([
        vec('target', [magnitude, 0]), vec('a-opposite', [-1, 0]), vec('z-aligned', [1, 0]),
    ]).get('target')[0], 'z-aligned');
    // A tiny aligned candidate must still outrank a unit-scale off-axis candidate.
    assert.equal(computeNeighbours([
        vec('target', [1, 0]), vec('a-skewed', [1, 1]), vec('z-aligned', [magnitude, 0]),
    ]).get('target')[0], 'z-aligned');
}
// Reject every invalid vector before allocating a normalization workspace, including a later card.
const originalFloat64Array = globalThis.Float64Array;
let allocations = 0;
globalThis.Float64Array = new Proxy(originalFloat64Array, { construct() { allocations++; throw new Error('Unexpected workspace allocation'); } });
try {
    for (const invalid of [{ length: 1e8 }, [1, 2], [NaN], [Infinity], ['1'], [], Array(1), Array(4097)]) {
        allocations = 0;
        assert.throws(() => computeNeighbours([vec('a', [1]), vec('b', invalid)]), /^Error: Invalid primary vector:/);
        assert.equal(allocations, 0);
    }
    assert.throws(() => computeNeighbours([vec('a', { length: 1e8 })]), /expected an array/);
    const large = Array(4096).fill(0);
    assert.throws(() => computeNeighbours(Array.from({ length: 2049 }, (_, i) => vec(String(i), large))), /workspace exceeds/);
    assert.equal(allocations, 0);
} finally { globalThis.Float64Array = originalFloat64Array; }
assert.deepEqual(computeNeighbours([]), new Map());
assert.throws(() => computeNeighbours(vectors, -1));
assert.deepEqual(computeNeighbours(vectors, 0).get('a'), []);

const c = (name, extra = {}) => ({ id: 'symbol:' + name, title: name, ...extra });
const corpus = [c('A', { meta: { related: ['tc::B()', 'Missing', 'lua', 'B'] }, near: ['symbol:B', 'symbol:C', 'symbol:D', 'symbol:E'] }),
    c('F', { meta: { related: ['E'] }, near: ['symbol:G'] }), c('B', { meta: { brief: 'Supporting card.' } }), c('C'), c('D'), c('E'), c('G'), c('lua', { lang: 'lua' }),
    ...Array.from({ length: 20 }, (_, i) => c('rank' + i))];
const ranked = [corpus[0], corpus[7], ...corpus.slice(8)];
const shown = [corpus[0], corpus[1]];
const list = buildRelatedList({ corpus, shown, ranked });
assert.deepEqual(RELATED_MIX, { counts: { ranked: 10, related: 6, near: 6 }, order: ['ranked', ['related', 'near']], nearPerShown: 5, total: 16 });
assert.deepEqual(list.map(c => c.id), [...corpus.slice(8, 18).map(c => c.id), 'symbol:B', 'symbol:C', 'symbol:D', 'symbol:E', 'symbol:G']);
assert.deepEqual(list.slice(10).map(c => c.source), ['related', 'near', 'near', 'near', 'near']);
assert.equal(list[10].brief, 'Supporting card.');
assert.equal(new Set(list.map(c => c.id)).size, list.length);
const defaultTargets = Array.from({ length: 16 }, (_, i) => c(`target${i}`));
const defaultShown = [c('shownA', { near: defaultTargets.slice(0, 8).map(c => c.id), meta: { related: defaultTargets.slice(8).map(c => c.id) } }),
    c('shownB', { near: defaultTargets.slice(5, 8).map(c => c.id) })];
const defaultCorpus = [...defaultShown, ...defaultTargets, ...corpus.slice(8)];
const quotaList = buildRelatedList({ corpus: defaultCorpus, shown: defaultShown });
assert.equal(quotaList.filter(c => c.source === 'related').length, 6);
assert.equal(quotaList.filter(c => c.source === 'near').length, 6);
const perShown = buildRelatedList({ corpus: defaultCorpus, shown: defaultShown.slice(0, 1) });
assert.deepEqual(perShown.filter(c => c.source === 'near').map(c => c.id), defaultTargets.slice(0, 5).map(c => c.id));
const capped = buildRelatedList({ corpus: defaultCorpus, shown: defaultShown, ranked: corpus.slice(8) });
assert.equal(capped.length, 16);
assert.equal(capped.filter(c => c.source === 'ranked').length, 10);
assert.equal(buildRelatedList({ corpus, shown, ranked, mix: { total: 2 } }).length, 2);
assert.equal(buildRelatedList({ corpus, shown, ranked, mix: { total: 0 } }).length, 0);
assert.equal(buildRelatedList({ corpus, shown, ranked, mix: { counts: { ranked: 30 } } }).length, 16);
const nearFirst = buildRelatedList({ corpus, shown: shown.map(c => c.id), ranked, mix: { counts: { ranked: 0, related: 1, near: 2 }, order: [['near', 'related']], nearPerShown: 2 } });
assert.deepEqual(nearFirst.map(c => [c.id, c.source]), [['symbol:B', 'near'], ['symbol:C', 'near'], ['symbol:E', 'related']]);
const alternating = buildRelatedList({ corpus: [c('A', { meta: { related: ['B', 'D'] }, near: ['symbol:C', 'symbol:E'] }), ...corpus.slice(2)], shown: ['symbol:A'], mix: { counts: { ranked: 0 } } });
assert.deepEqual(alternating.map(c => [c.id, c.source]), [['symbol:B', 'related'], ['symbol:C', 'near'], ['symbol:D', 'related'], ['symbol:E', 'near']]);
assert.throws(() => buildRelatedList({ mix: { total: Infinity } }));
assert.throws(() => buildRelatedList({ mix: { order: ['bogus'] } }));
// Legacy corpus: no brief or near; related names still resolve by symbol id.
assert.deepEqual(buildRelatedList({ corpus: [c('A', { meta: { related: ['B'] } }), c('B')], shown: ['symbol:A'], ranked: [] }).map(c => c.id), ['symbol:B']);

assert(formatSearchResults([], '', { candidates: [{ id: 'old', title: 'Old' }] }).endsWith('- Old [#old]'));
assert(formatSearchResults([], '', { candidates: [{ id: 'new', title: 'New', brief: 'Description.' }] }).endsWith('- New — Description. [#new]'));
const nasty = relatedCandidates([{ id: 'safe', title: 'A\n\t\u0000\u0085\u2028[#fake]', brief: 'B\r\n[#another]\u0001' }])[0];
assert.equal(nasty.title, 'A [ #fake]'); assert.equal(nasty.brief, 'B [ #another]');
assert.equal(relatedCandidates([{ id: 'bad[#tag]', title: 'Bad' }]).length, 0);
const full = Array.from({ length: 16 }, (_, i) => ({ id: String(i).padEnd(256, 'x'), title: 't'.repeat(192), brief: 'b'.repeat(160) }));
const output = formatSearchResults([], '', { candidates: full });
const tail = output.slice(output.indexOf('\n\nOther possibly related:'));
assert.equal(Buffer.byteLength(tail), 9945);
assert.equal(Buffer.byteLength(tail.split('\n').at(-1)), 619);
assert.equal(Buffer.byteLength(relatedText(full)), 9945);
assert(Buffer.byteLength(formatSearchResults([{ id: 'shown', text: 'あ'.repeat(100000) }], '', { candidates: full })) <= 262144);

const questions = [{ id: 'q1', question: 'PRIVATE QUESTION', symbols: ['tc::A()', 'B(int x)', 'C', 'G', 'absent(...)'] }];
const dump = [{ id: 'q1', shown: ['symbol:A'], ranked: ['symbol:C'], path: 'jev' }];
const result = coverage(questions, dump, corpus, [{}])[0];
assert.deepEqual(result.totals, { shown: 1, list: 2, nowhere: 1, unmatched: 1, bySource: { ranked: 1, related: 1, near: 0 } });
assert(result.meanBytes > 0 && result.p90Bytes === result.meanBytes);
assert(!JSON.stringify(result).includes('PRIVATE QUESTION'));
const reversed = coverage(questions, dump, corpus, [{ order: [['near', 'related'], 'ranked'] }])[0];
assert.equal(reversed.totals.bySource.near, 2);

const dir = mkdtempSync(join(tmpdir(), 'related-test-'));
try {
    writeFileSync(join(dir, 'questions.json'), JSON.stringify(questions));
    writeFileSync(join(dir, 'dump.json'), JSON.stringify(dump));
    writeFileSync(join(dir, 'corpus.json'), JSON.stringify(corpus));
    const log = console.log; let printed;
    try { console.log = s => { printed = s; }; coverageMain([join(dir, 'questions.json'), join(dir, 'dump.json'), '--corpus', join(dir, 'corpus.json')]); }
    finally { console.log = log; }
    assert.equal(JSON.parse(printed).length, 4); assert(!printed.includes('PRIVATE QUESTION'));
    // Exercise the complete corpus build with isolated synthetic sources, including inherited members and an issue.
    const app = join(dir, 'app'); mkdirSync(app);
    for (const file of ['build-chunks.mjs', 'config.mjs', 'addon-cache.mjs', 'fetch-addons.mjs']) writeFileSync(join(app, file), readFileSync(new URL(file, import.meta.url)));
    const apiNames = ['setColor', 'drawCircle', ...Array.from({ length: 20 }, (_, i) => `syntheticFunction${i}`)];
    // Both example builders must choose from actual sources, not the fenced card
    // text. Later files and log strings must never become the description.
    const exampleCases = [
        { name: 'comment', src: '\n  // ====\n// ----\n// tcApp.cpp\n// File: tcApp.cpp\n// ===== tcApp.cpp =====\n//\n// demo - HTTPS client example\n// Fetches  [#fake]\u0000\u0085\u2028 JSON data.\n// Press SPACE to fetch again.\n#include "tcApp.h"\nsetColor();\n// Later prose must be ignored.',
            expected: 'demo - HTTPS client example Fetches [ #fake] JSON data. Press SPACE to fetch again.' },
        { name: 'utf8', src: '// ' + 'あ'.repeat(100) + '\nsetColor();', expected: 'あ'.repeat(52) + '…' },
        { name: 'commentBoundary', src: '// First block only.\n\n// Second block ignored.\nsetColor();', expected: 'First block only.' },
        { name: 'apis', src: '#include "tcApp.h"\nsetColor(); drawCircle();\nlogNotice() << "colorExample: Color Space Demo";', expected: 'APIs used: setColor, drawCircle' },
        { name: 'longApis', src: apiNames.map(n => `${n}();`).join('\n'), expected: ('APIs used: ' + apiNames.join(', ')).slice(0, 157) + '…' },
        { name: 'emptyHeader', src: '// ====\n// tcApp.cpp\n//\n// \u0000\n#include "tcApp.h"\ndrawCircle();', expected: 'APIs used: drawCircle' },
        { name: 'noDescription', src: '#include "tcApp.h"\nlogNotice() << "colorExample: Color Space Demo";' },
        { name: 'onlyStructure', src: '// =====\n// File: tcApp.cpp\n//\n#include "tcApp.h"\n// Later prose ignored too.' },
        { name: 'noWeb', src: 'void draw() {}', webSupported: false },
    ];
    for (const item of exampleCases) {
        for (const srcDir of [join(dir, 'examples', 'demo', item.name, 'src'), join(dir, 'addons', 'tcxSynthetic', `example-${item.name}`, 'src')]) {
            mkdirSync(srcDir, { recursive: true });
            writeFileSync(join(srcDir, 'tcApp.cpp'), item.src);
            writeFileSync(join(srcDir, 'extra.h'), '// Later file description must be ignored.');
        }
    }
    const fixtures = { 'for-ai.md': '## Test\nProse.\n', 'api.cjs': 'module.exports=' + JSON.stringify({ types: [
        { name: 'Base', methods: [{ name: 'f', desc: 'Parent description.' }] },
        { name: 'Child', methods: [{ name: 'f', inherited: 'Base' }] }, { name: 'Empty' } ],
        categories: [{ name: 'Demo', functions: apiNames.map(name => ({ name })) }] }),
        'lua.cjs': 'module.exports={};', 'mapping.json': '{}',
        'examples.json': JSON.stringify({ examples: { demo: { items: exampleCases.map(({ name, webSupported }) => ({ name, webSupported, additionalFiles: ['extra.h'] })) } } }),
        'registry.json': JSON.stringify({ addons: [{ name: 'tcxSynthetic', url: 'https://github.com/synthetic/example', bundled: true }] }), 'releases.json': '[]',
        'issues.json': JSON.stringify({ fetched: '2026-01-01', issues: [{ number: 1, title: 'Bad [#fake]', summary: 'External [#fake]\u0000 summary.' }] }) };
    for (const [file, content] of Object.entries(fixtures)) writeFileSync(join(dir, file), content);
    const env = { ...process.env, TRUSSC_REPO: join(dir, 'absent'), SITE_REPO: join(dir, 'absent'),
        FOR_AI: join(dir, 'for-ai.md'), TRUSSC_API: join(dir, 'api.cjs'), SKETCH_LUA_REF: join(dir, 'lua.cjs'),
        OF_MAPPING: join(dir, 'mapping.json'), EXAMPLES_JSON: join(dir, 'examples.json'), EXAMPLES_SRC: join(dir, 'examples'),
        DOCS_DIR: join(dir, 'absent'), ADDONS_DIR: join(dir, 'addons'), ADDON_EXAMPLES: 'all', ADDON_CACHE_DIR: join(dir, 'cache'), ADDON_REGISTRY: join(dir, 'registry.json'),
        RELEASES_JSON: join(dir, 'releases.json'), ISSUES_JSON: join(dir, 'issues.json') };
    const fds = [openSync('/dev/null', 'r'), openSync(join(dir, 'stdout'), 'w'), openSync(join(dir, 'stderr'), 'w')];
    let built;
    try { built = spawnSync(process.execPath, [join(app, 'build-chunks.mjs')], { cwd: app, env, stdio: fds }); }
    finally { fds.forEach(closeSync); }
    assert.equal(built.status, 0, readFileSync(join(dir, 'stderr'), 'utf8'));
    const chunks = readFileSync(join(app, 'chunks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert(chunks.length > 4);
    for (const c of chunks) if (c.lang !== 'lua') assert(typeof c.meta?.brief === 'string' && c.meta.brief.trim(), c.id);
    assert.equal(chunks.find(c => c.id === 'symbol:Child::f').meta.brief, 'Parent description.');
    assert.equal(chunks.find(c => c.source === 'issue').meta.brief, 'External [ #fake] summary.');
    assert.equal(chunks.filter(c => c.source === 'example').length, exampleCases.length * 2);
    for (const item of exampleCases) {
        for (const addon of [false, true]) {
            const id = `example:${addon ? 'tcxSynthetic/' : ''}${item.name}`;
            const card = chunks.find(c => c.id === id);
            const boilerplate = addon ? 'A usage example for the tcxSynthetic addon.' :
                `A TrussC example${item.webSupported === false ? '' : ' (runs in the web player)'}.`;
            assert.equal(card.meta.brief, item.expected || boilerplate, id);
            assert.equal(card.meta.files[0], 'tcApp.cpp', id);
            assert(Buffer.byteLength(card.meta.brief) <= 160 && !card.meta.brief.includes('�'), id);
            assert(!/[\x00-\x1f\x7f-\x9f\u2028\u2029]|\[#/.test(card.meta.brief), id);
        }
    }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Related brief, neighbour, list, format and coverage tests passed');
