// Run with node --test test-build-chunks.mjs; no corpus writes or embeddings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('./build-chunks.mjs', import.meta.url), 'utf8');
const ctx = {};
vm.runInNewContext(`const descBlock = o => (o.desc ? [o.desc] : []);\n${source.slice(source.indexOf('function chunkApi('), source.indexOf('// --- Source: examples'))}\nglobalThis.chunkApi = chunkApi;`, ctx);
const cards = (api, stats) => JSON.parse(JSON.stringify(ctx.chunkApi({ categories: [], types: [], constants: [], ...api }, new Map(), stats)));
const fields = { details: 'English details', details_ja: '日本語の詳細', details_ko: '한국어 설명', related: ['Target'], keywords: ['lookup'], snippet: 'use("```");', platformNote: 'platform', platformNote_ja: '環境', platformNote_ko: '환경' };
test('function, type, method, static, nested type and constant cards share all notes', () => {
    const api = {
        categories: [{ name: 'General', functions: [{ name: 'function', ...fields }] }],
        types: [{ name: 'Type', ...fields, methods: [{ name: 'method', ...fields }], static_methods: [{ name: 'staticMethod', ...fields }], nested: [{ name: 'Type::Nested', short: 'Nested', kind: 'type', ...fields }] }],
        constants: [{ name: 'CONSTANT', value: 1, ...fields }],
    };
    const result = cards(api);
    assert.equal(result.length, 6);
    for (const c of result) {
        for (const text of ['English details', 'Related: Target', 'keywords: lookup', 'Platform: platform', '````cpp\nuse("```");\n````']) assert.ok(c.text.includes(text), `${c.id}: ${text}`);
        // MCP cards are English only.
        for (const text of ['日本語の詳細', '한국어 설명', '環境', '환경']) assert.ok(!c.text.includes(text), `${c.id}: ${text}`);
    }
});
test('fieldless cards retain their exact existing text and metadata', () => {
    const [type, method] = cards({ types: [{ name: 'Type', methods: [{ name: 'method', desc: 'Does work.', signatures: [{ ret: 'bool', params: 'int count' }] }] }] });
    assert.equal(type.text, '# Type   (type)\nMethods: method');
    assert.equal(method.text, '# Type::method   (method of Type)\nDoes work.\nSignatures:\n  bool Type::method(int count)');
    assert.deepEqual(method.meta, { kind: 'method', owner: 'Type' });
});
test('old constructor snippet is used only when the canonical snippet is absent', () => {
    const type = { name: 'Type', constructor: { snippet: 'legacy();' }, snippet: 'canonical();' };
    assert.ok(cards({ types: [type] })[0].text.includes('canonical();'));
    assert.ok(!cards({ types: [type] })[0].text.includes('legacy();'));
    delete type.snippet;
    assert.ok(cards({ types: [type] })[0].text.includes('legacy();'));
});

const marker = '(details truncated; see the full reference)';
test('100,000-character details keep their start and report truncation for every card kind', () => {
    const details = 'start: ' + 'a'.repeat(100000 - 'start: '.length);
    const stats = { truncatedNotes: 0 };
    const result = cards({
        categories: [{ name: 'General', functions: [{ name: 'function', details }] }],
        types: [{ name: 'Type', details, methods: [{ name: 'method', details }], static_methods: [{ name: 'staticMethod', details }], nested: [{ name: 'Type::Nested', details }] }],
        constants: [{ name: 'CONSTANT', details }],
    }, stats);
    assert.equal(result.length, 6);
    assert.equal(stats.truncatedNotes, 6);
    for (const card of result) {
        const start = card.text.indexOf('start: ');
        assert.ok(start >= 0, card.id);
        assert.equal(card.text.slice(start), details.slice(0, 10000) + '\n' + marker, card.id);
    }
});
test('many separate backtick runs produce a bounded, complete fenced snippet', () => {
    const stats = { truncatedNotes: 0 };
    let result;
    assert.doesNotThrow(() => { result = cards({ types: [{ name: 'Type', snippet: '` '.repeat(150000) }] }, stats); });
    const text = result[0].text.split('\n').slice(1).join('\n');
    assert.ok(text.startsWith('```cpp\n` ` '));
    assert.ok(text.endsWith('\n```\n' + marker));
    assert.ok(text.length <= 10000 + 1 + marker.length);
    assert.equal(stats.truncatedNotes, 1);
});
test('continuous backticks fit both fences into the notes budget', () => {
    const text = cards({ types: [{ name: 'Type', snippet: '`'.repeat(100000) }] })[0].text;
    const [heading, open, snippet, close, truncated] = text.split('\n');
    assert.equal(heading, '# Type   (type)');
    assert.equal(open, close + 'cpp');
    assert.equal(close.length, snippet.length + 1);
    assert.equal(truncated, marker);
    assert.ok(open.length + snippet.length + close.length + 2 <= 10000);
});
test('note fields share one budget, with exact-limit notes unchanged; ja/ko are left out', () => {
    const stats = { truncatedNotes: 0 };
    const exact = cards({ types: [{ name: 'Type', details: 'a'.repeat(10000) }] }, stats)[0];
    assert.equal(exact.text, '# Type   (type)\n' + 'a'.repeat(10000));
    assert.equal(stats.truncatedNotes, 0);
    const fields = {
        related: ['Target'], examples: [{ name: 'Example' }], details: 'English', details_ja: '日本語', details_ko: '한국어',
        snippet: 'use();', platformNote: 'Linux', platformNote_ja: '環境', platformNote_ko: '환경', keywords: ['k'.repeat(100000)],
    };
    const text = cards({ types: [{ name: 'Type', ...fields }] }, stats)[0].text.split('\n').slice(1).join('\n');
    assert.ok(text.startsWith('Related: Target\nExamples: Example\nEnglish\n```cpp\nuse();\n```\nPlatform: Linux\nkeywords: '));
    assert.equal(text.length, 10000 + 1 + marker.length);
    assert.ok(text.endsWith('\n' + marker));
    assert.equal(stats.truncatedNotes, 1);
    for (const key of ['details_ja', 'details_ko', 'platformNote_ja', 'platformNote_ko'])
        assert.equal(cards({ types: [{ name: 'Type', [key]: 'a'.repeat(100000) }] })[0].text, '# Type   (type)', key);
    for (const key of ['platformNote', 'related']) {
        const value = key === 'related' ? ['a'.repeat(100000)] : 'a'.repeat(100000);
        const card = cards({ types: [{ name: 'Type', [key]: value }] })[0];
        assert.ok(card.text.endsWith('\n' + marker), key);
        assert.equal(card.text.length, '# Type   (type)\n'.length + 10000 + 1 + marker.length, key);
    }
});
test('nested member notes share the nested card budget and count once', () => {
    const stats = { truncatedNotes: 0 };
    const result = cards({ types: [{ name: 'Type', nested: [{ name: 'Type::Nested', short: 'Nested',
        methods: [{ name: 'first', details: 'a'.repeat(5000) }],
        static_methods: [{ name: 'second', details: 'b'.repeat(5000) }], details: 'later notes',
    }] }] }, stats);
    assert.equal(stats.truncatedNotes, 1);
    assert.equal(result[1].text.split('\n').slice(1).join('\n'), 'a'.repeat(5000) + '\n' + 'b'.repeat(4999) + '\n' + marker);
});
test('inherited members become short stubs pointing at the declaring card', () => {
    const result = cards({ types: [
        { name: 'Base', methods: [{ name: 'shared', desc: 'Long shared prose.', details: 'Details.', signatures: [{ ret: 'Vec3', params: '' }] }] },
        { name: 'Derived', methods: [{ name: 'shared', inherited: 'Base', desc: 'Long shared prose.', details: 'Details.', signatures: [{ ret: 'Vec3', params: '' }] }, { name: 'own', desc: 'Own.' }] },
    ] });
    const byId = Object.fromEntries(result.map(c => [c.id, c]));
    assert.ok(byId['symbol:Base::shared'].text.includes('Long shared prose.'));
    const stub = byId['symbol:Derived::shared'];
    assert.equal(stub.text, '# Derived::shared   (method of Derived, inherited from Base)\n`Derived::shared` — inherited from `Base::shared`. See that card for details.\nSignatures:\n  Vec3 Derived::shared()');
    assert.deepEqual(stub.meta, { kind: 'method', owner: 'Derived', inherited: 'Base', base: 'Base::shared' });
    assert.ok(byId['symbol:Derived::own'].text.includes('Own.'));
});
test('an inherited member keeps its full card when the declaring card is not emitted', () => {
    const result = cards({ types: [
        { name: 'Derived', methods: [{ name: 'shared', inherited: 'Outer::Base', desc: 'Only copy of this prose.' }] },
    ] });
    const card = result.find(c => c.id === 'symbol:Derived::shared');
    assert.ok(card.text.includes('Only copy of this prose.'));
    assert.equal(card.meta.base, undefined);
});

const rr = {};
vm.runInNewContext(`${source.slice(source.indexOf('const CJK = /'), source.indexOf('for (const c of chunks) c.rerankText'))}\nglobalThis.rerankRepr = rerankRepr; globalThis.RERANK_CHARS = RERANK_CHARS;`, rr);
test('rerank text keeps English lines past the old six-line limit and stops at the char cap', () => {
    const notes = Array.from({ length: 12 }, (_, i) => `note ${i}`);
    const text = ['# Type::method   (method of Type)', 'Does work.', '日本語の説明', '```cpp', ...notes, 'keywords: lookup'].join('\n');
    assert.equal(rr.rerankRepr({ source: 'symbol', title: 'Type::method', text }), ['Type::method', 'Does work.', '```cpp', ...notes].filter((t) => !t.startsWith('```')).join('\n'));
    assert.equal(rr.RERANK_CHARS, 800);   // chosen on the 815 improvement set (2026-10-27)
    const long = rr.rerankRepr({ source: 'symbol', title: 'T', text: 'x'.repeat(5000) });
    assert.equal(long.length, rr.RERANK_CHARS);
    const issue = rr.rerankRepr({ source: 'issue', title: 'Bug', text: '[open as of today]\n## Summary\n' + 'y'.repeat(5000) });
    assert.equal(issue.length, rr.RERANK_CHARS);
    assert.ok(issue.startsWith('Bug\nyyy'));
});
