// Offline docs layout regressions. All fixtures live in temporary directories.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

const root = mkdtempSync(join(tmpdir(), 'docsai-doc-layouts-'));
after(() => rmSync(root, { recursive: true, force: true }));
const source = readFileSync(new URL('./build-chunks.mjs', import.meta.url), 'utf8');
const ctx = { readFileSync, existsSync, join };
vm.runInNewContext(source.slice(source.indexOf('const slug ='), source.indexOf('// MCP cards')) +
    source.slice(source.indexOf('function splitHeadings('), source.indexOf('// --- Source: official addon')) +
    '\nglobalThis.docs = chunkDocs; globalThis.concepts = chunkForAi;', ctx);
const docs = dir => JSON.parse(JSON.stringify(ctx.docs(dir)));
const files = [
    ['../README.md', '../README.md', 'doc:trussc-usage'],
    ['ARCHITECTURE.md', 'architecture/README.md', 'doc:architecture-usage'],
    ['GET_STARTED.md', 'GET_STARTED.md', 'doc:get-started-usage'],
    ['GET_STARTED_CONSOLE_MODE.md', 'guides/HEADLESS_LINUX.md', 'doc:get-started-console-mode-usage'],
    ['TrussC_vs_openFrameworks.md', 'guides/TrussC_vs_openFrameworks.md', 'doc:trussc-vs-openframeworks-usage'],
    ['ADDONS.md', 'guides/ADDONS.md', 'doc:addons-usage'],
    ['BUILD_SYSTEM.md', 'guides/BUILD_SYSTEM.md', 'doc:build-system-usage'],
    ['AI_AUTOMATION.md', 'guides/AI_AUTOMATION.md', 'doc:ai-automation-mcp-usage'],
    ['INSTALLATION_WINDOWS.md', 'guides/INSTALLATION_WINDOWS.md', 'doc:installation-windows-usage'],
    ['ROADMAP.md', 'ROADMAP.md', 'doc:roadmap-usage'],
    ['MIGRATION_0_8.md', 'guides/MIGRATION_0_8.md', 'doc:migrating-to-v0-8-usage'],
];
function write(path, text = '## Usage\nUse this doc.\n### Details\nMore details.\n') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}
function fixture(layout) {
    const dir = join(mkdtempSync(join(root, 'repo-')), 'docs');
    mkdirSync(dir);
    for (const paths of files) write(join(dir, paths[layout]));
    return dir;
}

test('old and new layouts keep the same doc cards and stable ids', () => {
    const old = docs(fixture(0)), current = docs(fixture(1));
    assert.deepEqual(current, old);
    assert.deepEqual(old.map(c => c.id), files.flatMap(([, , id]) => [id, id + '-details']));
    assert.equal(old[6].title, 'Get Started (console mode) > Usage');
});
test('the first existing candidate wins when both layouts are present', () => {
    const dir = fixture(0);
    write(join(dir, 'architecture/README.md'), '## New architecture\nPreferred content.\n');
    assert.deepEqual(docs(dir).filter(c => c.id.startsWith('doc:architecture-')).map(c => c.id), ['doc:architecture-new-architecture']);
});
test('a missing entry in an existing docs directory names the label and every candidate', () => {
    const dir = fixture(1);
    rmSync(join(dir, 'architecture/README.md'));
    assert.throws(() => docs(dir), error => {
        for (const text of ['Architecture', join(dir, 'architecture/README.md'), join(dir, 'ARCHITECTURE.md')])
            assert.ok(error.message.includes(text), error.message);
        return true;
    });
    const empty = join(root, 'empty'); mkdirSync(empty);
    assert.throws(() => docs(empty), /Missing doc "TrussC"/);
});
test('an absent docs directory yields zero docs even with a repo README', () => {
    const dir = fixture(0);
    rmSync(dir, { recursive: true });
    assert.deepEqual(docs(dir), []);
});
test('FOR_AI defaults prefer the new layout, preserve overrides and fail on missing files', async () => {
    const repo = mkdtempSync(join(root, 'config-'));
    const saved = { TRUSSC_REPO: process.env.TRUSSC_REPO, FOR_AI: process.env.FOR_AI };
    let probe = 0;
    const configured = async () => (await import(`./config.mjs?doc-layout=${probe++}`)).FOR_AI;
    try {
        process.env.TRUSSC_REPO = repo; delete process.env.FOR_AI;
        const old = join(repo, 'docs/FOR_AI_ASSISTANT.md'), current = join(repo, 'docs/guides/FOR_AI_ASSISTANT.md');
        assert.equal(await configured(), old);
        assert.throws(() => ctx.concepts(old), /ENOENT/);
        write(old); assert.equal(await configured(), old);
        write(current); assert.equal(await configured(), current);
        assert.deepEqual(Array.from(ctx.concepts(old), c => c.id), Array.from(ctx.concepts(current), c => c.id));
        process.env.FOR_AI = join(repo, 'override.md');
        assert.equal(await configured(), process.env.FOR_AI);
        assert.throws(() => ctx.concepts(process.env.FOR_AI), /ENOENT/);
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});
