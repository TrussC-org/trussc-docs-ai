// Run with: node test-resolve-links.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tiny synthetic corpus: generated production data is absent in standalone clones.
const dir = mkdtempSync(join(tmpdir(), 'docsai-links-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
process.env.EMBEDDED = join(dir, 'corpus.json');
writeFileSync(process.env.EMBEDDED, JSON.stringify([
    { id: 'symbol:drawCircle', title: 'drawCircle', source: 'reference', meta: { kind: 'function' } },
    { id: 'symbol:setColor', title: 'setColor', source: 'reference', meta: { kind: 'function' } },
    { id: 'symbol:Node::removeMod', title: 'Node::removeMod', source: 'reference', meta: { kind: 'method', owner: 'Node' } },
    { id: 'issue:123', title: 'Known issue', source: 'issue', meta: { number: 123, url: 'https://github.com/TrussC-org/TrussC/issues/123' } },
    { id: 'concept:coordinates', title: 'Coordinates', source: 'concept' },
]));
process.env.REF_BASE = 'https://trussc.org';
const { chunks, resolveLinks } = await import('./rag.mjs');

let assertions = 0;
function check(actual, expected, message) {
    assert.strictEqual(actual, expected, message);
    assertions++;
}

const corpus = chunks();
const issue = corpus.find((c) => c.source === 'issue');
const concept = corpus.find((c) => c.id.startsWith('concept:'));
check(Boolean(issue), true, `the corpus must contain an issue fixture (chosen id: ${issue?.id ?? 'none'})`);
check(/^issue:\d+$/.test(issue.id), true, `the issue fixture must have a numeric issue id (chosen id: ${issue.id})`);
check(Boolean(concept), true, `the corpus must contain a concept fixture (chosen id: ${concept?.id ?? 'none'})`);
check(corpus.some((c) => c.id === 'issue:999999'), false, 'the unknown issue must be absent');
const issueNumber = issue.id.slice('issue:'.length);

const fenced = [
    '```cpp',
    '    auto listener = [this](MouseEventArgs& e) {',
    '        auto map = [&](int x) { return x; };',
    '        [[nodiscard]] int value = 1;',
    '        // [[drawCircle]] #symbol:setColor [label](http://x)',
    '        // https://example.com    keep these spaces',
    '    };',
    '```',
].join('\n');
check(resolveLinks(fenced), fenced, 'fenced C++ and indentation must pass through byte for byte');

const unclosedFence = fenced.slice(0, -3);
check(resolveLinks(unclosedFence), unclosedFence, 'an unclosed trailing fence must remain untouched');

for (const code of [
    '[this](MouseEventArgs& e) {',
    '[&](int x)',
    '[[nodiscard]]',
    '[[drawCircle]]',
    '#symbol:setColor',
    '[label](http://x)',
    'https://example.com',
    '    keep    spaces',
]) {
    const inline = '`' + code + '`';
    check(resolveLinks(inline), inline, `inline code must remain untouched: ${code}`);
}

check(
    resolveLinks('Before    [label](http://x)\n' + fenced + '\nAfter    https://example.com end'),
    'Before label\n' + fenced + '\nAfter end',
    'prose around a closed fence must still be cleaned',
);
check(
    resolveLinks('Before    [label](http://x)\n' + unclosedFence),
    'Before label\n' + unclosedFence,
    'prose before an unclosed fence must still be cleaned',
);
check(
    resolveLinks('Use    `[this](MouseEventArgs& e) {`    and    `[[nodiscard]]`.'),
    'Use `[this](MouseEventArgs& e) {` and `[[nodiscard]]`.',
    'multiple inline spans must preserve code while cleaning surrounding prose',
);
check(
    resolveLinks(fenced + '\nBetween    [label](http://x)\n' + fenced),
    fenced + '\nBetween label\n' + fenced,
    'multiple fences must preserve code while cleaning prose between them',
);

check(resolveLinks('[label](http://x)'), 'label', 'model-written markdown links must keep only their label');
check(resolveLinks('Before http://x after'), 'Before after', 'bare HTTP URLs must be dropped');
check(resolveLinks('Before https://example.com/path after'), 'Before after', 'bare HTTPS URLs must be dropped');
check(resolveLinks('Before <https://example.com/path> after'), 'Before after', 'angle-bracket URLs must be dropped');
check(resolveLinks('one    two\t\tthree\nnext    line'), 'one two three\nnext line', 'prose space runs must collapse without removing newlines');

const circleLink = '[drawCircle](https://trussc.org/reference/#function:drawCircle)';
check(resolveLinks('[[drawCircle]]'), circleLink, 'known symbols must resolve to the real reference link');
const unknownSymbol = 'notAReferenceSymbol';
check(corpus.some((c) => c.title === unknownSymbol), false, `the unknown symbol must be absent: ${unknownSymbol}`);
check(resolveLinks(`[[${unknownSymbol}]]`), unknownSymbol, 'an unknown symbol wiki-link must become plain text');
check(
    resolveLinks(`[[#${issueNumber}]]`),
    `[#${issueNumber}](https://github.com/TrussC-org/TrussC/issues/${issueNumber})`,
    `an issue present in the corpus must resolve to its GitHub page (chosen id: ${issue.id})`,
);
check(resolveLinks('[[#999999]]'), '#999999', 'an issue absent from the corpus must remain plain text');

check(
    resolveLinks('Use #symbol:setColor here.'),
    'Use [setColor](https://trussc.org/reference/#function:setColor) here.',
    'leaked symbol context tags must become reference links',
);
check(
    resolveLinks(`Read #${concept.id} here.`),
    `Read ${concept.title} here.`,
    `leaked concept context tags must become the chunk title as plain text (chosen id: ${concept.id})`,
);
check(
    resolveLinks('Use #sym:Node::removeMod|removeMod here.'),
    'Use [removeMod](https://trussc.org/reference/#type:Node) here.',
    'leaked sym aliases must resolve to the owner page with the supplied label',
);

console.log(`PASS resolveLinks: ${assertions} assertions`);
