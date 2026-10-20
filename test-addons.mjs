// Offline registry/cache/build regressions. All writes and Git remotes are temporary.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, truncateSync, symlinkSync, chmodSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { fetchRegistry, validateRegistry, REGISTRY_URL, MAX_REGISTRY_BYTES, REGISTRY_TIMEOUT_MS } from './fetch-addons.mjs';
import { refreshExternalAddons, addonDirectories, cachePath, githubRepo, regularPath, LIMITS, runGit } from './addon-cache.mjs';

const root = mkdtempSync(join(tmpdir(), 'docs-addons-'));
after(() => rmSync(root, { recursive: true, force: true }));
const temp = name => mkdtempSync(join(root, name));
// File descriptors also work in restricted shells that disallow child Node pipes.
function nodeResult(args, options) {
    const dir = temp('node-output-'), out = join(dir, 'stdout'), err = join(dir, 'stderr');
    const stdout = openSync(out, 'w'), stderr = openSync(err, 'w');
    let result;
    try { result = spawnSync(process.execPath, args, { ...options, stdio: ['ignore', stdout, stderr] }); }
    finally { closeSync(stdout); closeSync(stderr); }
    if (result.error) throw result.error;
    return { ...result, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
}
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const external = (name = 'tcxRemote') => ({ name, url: `https://github.com/Test/${name}`, bundled: false, latest_tag: 'v1' });
function fixture() {
    const dir = temp('remote-'), remote = join(dir, 'remote.git'), author = join(dir, 'author');
    git(dir, 'init', '--bare', '--initial-branch=main', remote);
    git(remote, 'config', 'uploadpack.allowFilter', 'true');
    git(dir, 'clone', remote, author);
    mkdirSync(join(author, 'example-basic/src/nested'), { recursive: true });
    mkdirSync(join(author, 'example-basic/bin'), { recursive: true });
    mkdirSync(join(author, 'data'), { recursive: true });
    const files = {
        'README.md': '# Remote\n## Usage\nExternal README marker.\n',
        'example-basic/src/tcApp.cpp': 'void setup() { /* External example marker */ }',
        'example-basic/src/tcApp.h': '#pragma once',
        'example-basic/src/effect.glsl': 'void main() {}',
        'example-basic/src/main.cpp': 'not read: boilerplate',
        'example-basic/src/data.bin': 'not read: source asset',
        'example-basic/src/nested/hidden.h': 'not read: nested header',
        'example-basic/bin/build.cpp': 'not read: build artifact',
        'example-basic/CMakeLists.txt': 'not read: build file',
        'root.cpp': 'not read: implementation',
        'data/big.bin': Buffer.alloc(2 * 1024 ** 2, 97),
    };
    for (const [p, text] of Object.entries(files)) writeFileSync(join(author, p), text);
    git(author, 'add', '.'); git(author, 'commit', '-m', 'initial'); git(author, 'tag', 'v1'); git(author, 'push', 'origin', 'main', '--tags');
    return { author, remote, bigBlob: git(author, 'rev-parse', 'HEAD:data/big.bin'), files };
}
const local = fixture();
const rewrite = addon => ({ [addon.url]: pathToFileURL(local.remote).href });
const warnings = () => { const list = []; return { list, warn: s => list.push(`Warning: ${s}`) }; };

test('registry URL and fixed production bounds', () => {
    assert.equal(REGISTRY_URL, 'https://raw.githubusercontent.com/TrussC-org/trussc-addons/gh-pages/registry.json');
    assert.equal(MAX_REGISTRY_BYTES, 2 * 1024 ** 2); assert.equal(REGISTRY_TIMEOUT_MS, 30_000);
    assert.deepEqual(LIMITS, { count: 64, timeoutMs: 120_000, checkoutBytes: 64 * 1024 ** 2, cacheBytes: 512 * 1024 ** 2 });
});
test('registry drops malformed entries, preserves valid metadata and writes atomically', async () => {
    const path = join(temp('registry-'), 'registry.json'), w = warnings(), addon = external();
    writeFileSync(path, 'old registry');
    const input = { last_updated: 'today', addons: [addon, null, {}, { name: 'a', url: 'b', bundled: 'false' }, { name: 1, url: 'b', bundled: false }] };
    const result = await fetchRegistry({ path, warn: w.warn, fetchImpl: async (url, opts) => {
        assert.equal(url, REGISTRY_URL); assert.equal(opts.redirect, 'manual'); assert.ok(opts.signal);
        assert.equal(readFileSync(path, 'utf8'), 'old registry');
        return new Response(JSON.stringify(input));
    } });
    assert.deepEqual(result, { last_updated: 'today', addons: [addon] });
    assert.deepEqual(JSON.parse(readFileSync(path)), result); assert.equal(w.list.length, 4);
    assert.deepEqual(readdirSync(resolve(path, '..')), ['registry.json']);
});
test('registry failures, redirects, shape, streamed oversize and overall timeouts preserve existing file', async () => {
    const path = join(temp('failure-'), 'registry.json');
    const streams = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_REGISTRY_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); } }));
    for (const [name, fetchImpl, timeoutMs] of [
        ['transport', async () => { throw new Error('offline'); }],
        ['redirect', async () => new Response(null, { status: 302, headers: { location: 'https://never.invalid' } })],
        ['http', async () => new Response('', { status: 503 })],
        ['json', async () => new Response('{bad')],
        ['array', async () => new Response('[]')],
        ['shape', async () => new Response('{"addons":{}}')],
        ['length', async () => new Response('{}', { headers: { 'content-length': MAX_REGISTRY_BYTES + 1 } })],
        ['stream', streams],
        ['request timeout', () => new Promise(() => {}), 20],
        ['body timeout', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([123])); } })), 20],
    ]) {
        writeFileSync(path, 'old registry'); const w = warnings();
        assert.equal(await fetchRegistry({ path, fetchImpl, timeoutMs, warn: w.warn }), null, name);
        assert.equal(readFileSync(path, 'utf8'), 'old registry', name);
        assert.equal(w.list.length, 1, name); assert.match(w.list[0], /Warning:.*keeping the existing/);
        assert.deepEqual(readdirSync(resolve(path, '..')), ['registry.json']);
    }
    assert.throws(() => validateRegistry(null), /addons array/);
});
test('only plain GitHub repository URLs are admitted before any rewrite', async () => {
    for (const url of ['https://github.com/owner/repo', 'https://github.com/owner/repo.git']) assert.equal(githubRepo(url), 'https://github.com/owner/repo');
    const bad = ['file:///tmp/repo', 'http://github.com/o/r', 'https://example.org/o/r', 'git@github.com:o/r',
        'https://user:pass@github.com/o/r', 'https://github.com:443/o/r', 'https://github.com/o/r/tree/main',
        'https://github.com/o/r/', 'https://github.com/o/../r', 'https://github.com/o/%2e%2e',
        'https://github.com/o/r?x=1', 'https://github.com/o/r#x', 'https://github.com/o/r\n',
        'https://github.com/o\\r', 'https://github.com/o/.', 'https://github.com/o/..', ' https://github.com/o/r'];
    for (const url of bad) assert.equal(githubRepo(url), null, url);
    const w = warnings(); let calls = 0;
    await refreshExternalAddons(bad.map((url, i) => ({ ...external(`bad${i}`), url })), {
        cacheDir: temp('urls-'), warn: w.warn, git: async () => calls++,
        rewrites: Object.fromEntries(bad.map(url => [url, pathToFileURL(local.remote).href])),
    });
    assert.equal(calls, 0); assert.equal(w.list.length, bad.length);
});
test('real filtered sparse clone downloads only README and immediate example usage sources', async () => {
    const addon = external(), cacheDir = temp('sparse-'), w = warnings();
    await refreshExternalAddons([addon], { cacheDir, rewrites: rewrite(addon), warn: w.warn });
    assert.deepEqual(w.list, []);
    const dir = cachePath(addon, cacheDir);
    for (const p of ['README.md', 'example-basic/src/tcApp.cpp', 'example-basic/src/tcApp.h', 'example-basic/src/effect.glsl']) assert.ok(existsSync(join(dir, p)), p);
    for (const p of Object.keys(local.files).filter(p => !['README.md', 'example-basic/src/tcApp.cpp', 'example-basic/src/tcApp.h', 'example-basic/src/effect.glsl'].includes(p))) assert.equal(existsSync(join(dir, p)), false, p);
    // Inspect downloaded packs without invoking lazy blob fetches.
    const indexes = readdirSync(join(dir, '.git/objects/pack')).filter(p => p.endsWith('.idx'));
    assert.ok(indexes.length);
    for (const idx of indexes) assert.ok(!git(dir, 'verify-pack', '-v', join(dir, '.git/objects/pack', idx)).includes(local.bigBlob), 'large unrelated blob was downloaded');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), git(local.author, 'rev-parse', 'v1'));
});
test('existing clone updates to latest tag without executing hooks, filters or config includes', async () => {
    const f = fixture(), addon = external(), cacheDir = temp('update-'), w = warnings();
    const rewrites = { [addon.url]: pathToFileURL(f.remote).href };
    await refreshExternalAddons([addon], { cacheDir, rewrites, warn: w.warn });
    const dir = cachePath(addon, cacheDir), marker = join(root, 'must-not-run');
    const evil = join(root, 'evil-hook'); writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(evil, 0o755);
    mkdirSync(join(dir, '.git/hooks'), { recursive: true });
    writeFileSync(join(dir, '.git/hooks/post-checkout'), readFileSync(evil)); chmodSync(join(dir, '.git/hooks/post-checkout'), 0o755);
    const include = join(root, 'evil-config'); writeFileSync(include, `[core]\n hooksPath = ${root}\n[filter "evil"]\n smudge = ${evil}\n required = true\n`);
    writeFileSync(join(dir, '.git/config'), `[include]\n path = ${include}\n[core]\n hooksPath = ${root}\n[credential]\n helper = !${evil}\n`);
    writeFileSync(join(f.author, 'README.md'), '## Usage\nUpdated external marker\n');
    writeFileSync(join(f.author, '.gitattributes'), 'README.md filter=evil\n');
    git(f.author, 'add', '.'); git(f.author, 'commit', '-m', 'new release'); git(f.author, 'tag', 'v2'); git(f.author, 'push', 'origin', 'main', '--tags');
    await refreshExternalAddons([{ ...addon, latest_tag: 'v2' }], { cacheDir, rewrites, warn: w.warn });
    assert.deepEqual(w.list, []); assert.equal(existsSync(marker), false);
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /Updated external/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), git(f.author, 'rev-parse', 'v2'));
    assert.equal(existsSync(join(dir, 'data/big.bin')), false);
});
test('missing latest_tag explicitly fetches remote HEAD, accepts .git suffix and replaces the cache', async () => {
    const f = fixture(), addon = { ...external(), latest_tag: '', url: external().url + '.git' }, cacheDir = temp('head-'), w = warnings();
    const rewrites = { [addon.url]: pathToFileURL(f.remote).href };
    await refreshExternalAddons([addon], { cacheDir, rewrites, warn: w.warn });
    const dir = cachePath(addon, cacheDir);
    writeFileSync(join(f.author, 'README.md'), '## Current\nRemote HEAD marker\n');
    git(f.author, 'commit', '-am', 'advance HEAD'); git(f.author, 'push', 'origin', 'main');
    await refreshExternalAddons([addon], { cacheDir, rewrites, warn: w.warn });
    assert.deepEqual(w.list, []); assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /Remote HEAD marker/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), git(f.author, 'rev-parse', 'HEAD'));
});
test('count limit skips entry 65 with a Warning', async () => {
    const addons = Array.from({ length: 65 }, (_, i) => external(`addon${i}`)), cacheDir = temp('count-'), w = warnings();
    let clones = 0;
    const stub = async args => {
        if (args[0] === 'clone') {
            clones++; const dir = args.at(-1); mkdirSync(join(dir, '.git'), { recursive: true }); writeFileSync(join(dir, 'README.md'), 'small');
        }
    };
    await refreshExternalAddons(addons, { cacheDir, git: stub, warn: w.warn });
    assert.equal(clones, 64); assert.equal(existsSync(cachePath(addons[64], cacheDir)), false);
    assert.match(w.list.join('\n'), /Warning:.*count exceeds 64/);
    assert.equal(addonDirectories(addons, join(root, 'none'), { cacheDir, warn: () => {} }).size, 64);
});
test('64 MiB checkout overflow deletes that clone and continues with the next addon', async () => {
    const addons = [external('oversize'), external('small')], cacheDir = temp('checkout-bound-'), w = warnings();
    let active;
    const stub = async args => {
        if (args[0] === 'clone') {
            active = active === undefined ? 0 : active + 1;
            const dir = args.at(-1); mkdirSync(join(dir, '.git'), { recursive: true }); writeFileSync(join(dir, 'README.md'), 'small');
        }
        if (args.includes('checkout') && active === 0) {
            const path = join(args[1], 'README.md'); truncateSync(path, LIMITS.checkoutBytes + 1);
        }
    };
    await refreshExternalAddons(addons, { cacheDir, git: stub, warn: w.warn });
    assert.equal(existsSync(cachePath(addons[0], cacheDir)), false);
    assert.equal(existsSync(cachePath(addons[1], cacheDir)), true);
    assert.match(w.list.join('\n'), /Warning:.*total exceeds 64 MiB/);
});
test('512 MiB whole-cache overflow skips further downloads with a Warning', async () => {
    const cacheDir = temp('cache-bound-'), path = join(cacheDir, 'old-cache'), w = warnings();
    writeFileSync(path, ''); truncateSync(path, LIMITS.cacheBytes + 1);
    let calls = 0;
    await refreshExternalAddons([external()], { cacheDir, git: async () => calls++, warn: w.warn });
    assert.equal(calls, 0); assert.match(w.list.join('\n'), /Warning:.*remaining budget.*512 MiB/);
    assert.equal(addonDirectories([external()], join(root, 'none'), { cacheDir, warn: w.warn }).size, 0);
    // A temporary clone crossing the per-addon total is discarded, including .git bytes.
    rmSync(path); const more = warnings(); let clones = 0;
    await refreshExternalAddons([external('first'), external('second')], { cacheDir, warn: more.warn, limits: { ...LIMITS, checkoutBytes: 200, cacheBytes: 400 }, git: async args => {
        if (args[0] === 'clone') { clones++; mkdirSync(join(args.at(-1), '.git'), { recursive: true }); writeFileSync(join(args.at(-1), '.git/pack'), 'x'.repeat(201)); }
    } });
    assert.equal(clones, 2); assert.equal(readdirSync(cacheDir).length, 0);
    assert.match(more.list.join('\n'), /Warning:.*total exceeds 64 MiB/);
});
test('timeout skips the addon and continues, leaving no partial cache', async () => {
    const bin = temp('bin-'), cacheDir = temp('timeout-'), w = warnings(), pidFile = join(bin, 'pid');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 20\n`); chmodSync(join(bin, 'git'), 0o755);
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
    let calls = 0;
    try {
        await refreshExternalAddons([{ ...external('slow'), latest_tag: '' }, external('next')], { cacheDir, warn: w.warn, limits: { ...LIMITS, timeoutMs: 100 }, git: async (args, opts) => {
            calls++;
            if (args[0] === 'clone') return runGit(args, opts);
            throw new Error('next addon was reached');
        } });
    } finally { process.env.PATH = oldPath; }
    assert.equal(calls, 2); assert.equal(readdirSync(cacheDir).length, 0);
    assert.match(w.list.join('\n'), /Warning:.*timeout/); assert.match(w.list.join('\n'), /next addon was reached/);
    // Let Node reap its direct child. The /proc-free grandchild regression is in
    // test-addons-r2.mjs, with a supervisor to reap on container hosts as well.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(pidFile));
    assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
});
test('cache must be outside worktree and symlinks cannot supply addon content', async () => {
    await assert.rejects(refreshExternalAddons([], { cacheDir: fileURLToPath(new URL('./cache-test', import.meta.url)) }), /outside the worktree/);
    const addon = external(), cacheDir = temp('symlink-'), dir = cachePath(addon, cacheDir), bundled = temp('bundled-');
    mkdirSync(dir); symlinkSync(local.author, join(bundled, addon.name));
    symlinkSync(join(local.author, 'README.md'), join(dir, 'README.md'));
    const w = warnings(), dirs = addonDirectories([addon], bundled, { cacheDir, warn: w.warn });
    assert.equal(dirs.has(addon.name), false); assert.equal(existsSync(dir), false);
    assert.match(w.list.join('\n'), /Warning:.*symlink/);
    assert.equal(regularPath(dir, 'README.md'), null);
});
test('builder ingests cached external README/example and prefers bundled content; metadata stays present', async () => {
    const dir = temp('build-'), app = join(dir, 'app'), cacheDir = join(dir, 'cache'), bundled = join(dir, 'bundled'), addon = external(), w = warnings();
    mkdirSync(app);
    for (const name of ['build-chunks.mjs', 'config.mjs', 'addon-cache.mjs', 'fetch-addons.mjs']) writeFileSync(join(app, name), readFileSync(new URL(name, import.meta.url)));
    await refreshExternalAddons([addon], { cacheDir, rewrites: rewrite(addon), warn: w.warn }); assert.deepEqual(w.list, []);
    mkdirSync(bundled);
    const data = {
        'for-ai.md': '## Intro\nA concept.\n', 'api.cjs': 'module.exports = {};', 'lua.cjs': 'module.exports = {};',
        'mapping.json': '{}', 'examples.json': '{}', 'releases.json': '[]', 'issues.json': '{"issues":[]}',
        'registry.json': JSON.stringify({ addons: [addon, { ...external('metadataOnly'), url: 'https://other.invalid/x/y' }] }),
    };
    for (const [name, text] of Object.entries(data)) writeFileSync(join(dir, name), text);
    const env = { ...process.env, TRUSSC_REPO: join(dir, 'nonexistent'), SITE_REPO: join(dir, 'nonexistent'),
        FOR_AI: join(dir, 'for-ai.md'), TRUSSC_API: join(dir, 'api.cjs'), SKETCH_LUA_REF: join(dir, 'lua.cjs'), OF_MAPPING: join(dir, 'mapping.json'),
        EXAMPLES_JSON: join(dir, 'examples.json'), EXAMPLES_SRC: dir, DOCS_DIR: join(dir, 'docs'), ADDONS_DIR: bundled,
        ADDON_CACHE_DIR: cacheDir, ADDON_REGISTRY: join(dir, 'registry.json'), ADDON_EXAMPLES: 'all',
        RELEASES_JSON: join(dir, 'releases.json'), ISSUES_JSON: join(dir, 'issues.json') };
    const build = () => {
        const result = nodeResult([join(app, 'build-chunks.mjs')], { cwd: dir, env });
        assert.equal(result.status, 0, result.stderr);
        return readFileSync(join(app, 'chunks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    };
    let cards = build();
    assert.match(cards.find(c => c.id === 'addon:tcxRemote#usage').text, /External README marker/);
    const example = cards.find(c => c.id === 'example:tcxRemote/basic');
    assert.match(example.text, /External example marker/);
    assert.deepEqual(new Set(example.meta.files), new Set(['tcApp.cpp', 'tcApp.h', 'effect.glsl']));
    assert.ok(cards.find(c => c.id === 'addon:metadataOnly')); assert.equal(existsSync(join(dir, 'stats.jsonl')), false);
    mkdirSync(join(bundled, addon.name)); writeFileSync(join(bundled, addon.name, 'README.md'), '## Usage\nBundled preference marker\n');
    cards = build(); assert.match(cards.find(c => c.id === 'addon:tcxRemote#usage').text, /Bundled preference marker/);
    assert.ok(!cards.some(c => c.text.includes('External README marker')));
});
test('operator-shell environment seams work through the fetch-addons CLI', () => {
    const dir = temp('cli-'), addon = external(), registry = join(dir, 'registry.json'), cacheDir = join(dir, 'cache');
    const preload = join(dir, 'fetch-stub.mjs');
    writeFileSync(preload, `globalThis.fetch = async (url, options) => { if (url !== 'https://registry.invalid/test' || options.redirect !== 'manual') throw new Error('bad options'); return new Response(${JSON.stringify(JSON.stringify({ addons: [addon] }))}); };`);
    const result = nodeResult(['--import', preload, fileURLToPath(new URL('./fetch-addons.mjs', import.meta.url))], {
        env: { ...process.env, ADDON_REGISTRY: registry, ADDON_REGISTRY_URL: 'https://registry.invalid/test', ADDON_CACHE_DIR: cacheDir, ADDON_URL_REWRITES: JSON.stringify(rewrite(addon)) }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr); assert.ok(existsSync(join(cachePath(addon, cacheDir), 'README.md')));
    writeFileSync(preload, "globalThis.fetch = async () => { throw new Error('offline test'); };\n");
    const old = readFileSync(registry, 'utf8');
    const fallback = nodeResult(['--import', preload, fileURLToPath(new URL('./fetch-addons.mjs', import.meta.url))], {
        env: { ...process.env, ADDON_REGISTRY: registry, ADDON_CACHE_DIR: cacheDir, ADDON_URL_REWRITES: JSON.stringify(rewrite(addon)) }, encoding: 'utf8',
    });
    assert.equal(fallback.status, 1); assert.equal(readFileSync(registry, 'utf8'), old); assert.match(fallback.stderr, /keeping the existing/);
});
