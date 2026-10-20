// Offline round 3 regressions: shared-cache processes, registry identities and crashes.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import * as cache from './addon-cache.mjs';
import { validateRegistry } from './fetch-addons.mjs';
const root = fs.mkdtempSync(join(tmpdir(), 'docs-addons-r3-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const temp = name => fs.mkdtempSync(join(root, name));
const wait = ms => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const addon = { name: 'tcxShared', url: 'https://github.com/Test/tcxShared', bundled: false };
function fakeGit(text, onClone = () => {}) {
    return async args => {
        if (args[0] !== 'clone') return;
        await onClone();
        fs.writeFileSync(join(args.at(-1), 'README.md'), text);
        fs.mkdirSync(join(args.at(-1), 'example-basic/src'), { recursive: true });
        fs.writeFileSync(join(args.at(-1), 'example-basic/src/tcApp.cpp'), `// ${text}`);
    };
}
function buildFixture(addons) {
    const base = temp('build-'), app = join(base, 'app'), cacheDir = join(base, 'cache'), bundled = join(base, 'bundled');
    for (const dir of [app, cacheDir, bundled]) fs.mkdirSync(dir);
    for (const name of ['build-chunks.mjs', 'config.mjs', 'addon-cache.mjs', 'fetch-addons.mjs'])
        fs.copyFileSync(new URL(name, import.meta.url), join(app, name));
    const data = { 'for-ai.md': '## Intro\nConcept\n', 'api.cjs': 'module.exports={};', 'lua.cjs': 'module.exports={};',
        'mapping.json': '{}', 'examples.json': '{}', 'releases.json': '[]', 'issues.json': '{"issues":[]}',
        'registry.json': JSON.stringify({ addons }) };
    for (const [name, text] of Object.entries(data)) fs.writeFileSync(join(base, name), text);
    const env = { ...process.env, TRUSSC_REPO: join(base, 'absent'), SITE_REPO: join(base, 'absent'),
        FOR_AI: join(base, 'for-ai.md'), TRUSSC_API: join(base, 'api.cjs'), SKETCH_LUA_REF: join(base, 'lua.cjs'),
        OF_MAPPING: join(base, 'mapping.json'), EXAMPLES_JSON: join(base, 'examples.json'), EXAMPLES_SRC: join(base, 'absent'),
        DOCS_DIR: join(base, 'absent'), ADDONS_DIR: bundled, ADDON_CACHE_DIR: cacheDir, ADDON_REGISTRY: join(base, 'registry.json'),
        ADDON_EXAMPLES: 'all', RELEASES_JSON: join(base, 'releases.json'), ISSUES_JSON: join(base, 'issues.json') };
    const cards = () => fs.readFileSync(join(app, 'chunks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    function build() {
        const out = fs.openSync(join(base, 'out'), 'w'), err = fs.openSync(join(base, 'err'), 'w');
        let result;
        try { result = spawnSync(process.execPath, [join(app, 'build-chunks.mjs')], { cwd: base, env, timeout: 5000, stdio: ['ignore', out, err] }); }
        finally { fs.closeSync(out); fs.closeSync(err); }
        const warnings = fs.readFileSync(join(base, 'err'), 'utf8');
        assert.equal(result.status, 0, warnings || result.error?.message);
        return { cards: cards(), warnings };
    }
    return { base, app, cacheDir, bundled, env, build, cards };
}

test('A stalls, B waits, A fails: B publishes and subsequent failure preserves B', async () => {
    const cacheDir = temp('interleave-'), paused = deferred(), resume = deferred(), warnings = [];
    let bEntered = false;
    const a = cache.refreshExternalAddons([addon], { cacheDir, warn: s => warnings.push(s), git: async () => {
        paused.resolve(); await resume.promise; throw new Error('A transport failure');
    } });
    await paused.promise;
    const b = cache.refreshExternalAddons([addon], { cacheDir, git: fakeGit('## New\nB complete\n', () => { bEntered = true; }) });
    let enteredWhileA;
    try { await wait(80); enteredWhileA = bEntered; }
    finally { resume.resolve(); await Promise.all([a, b]); }
    assert.equal(enteredWhileA, false, 'B must not enter Git while A owns the cache');
    const readme = join(cache.cachePath(addon, cacheDir), 'README.md');
    assert.match(fs.readFileSync(readme, 'utf8'), /B complete/);
    await cache.refreshExternalAddons([addon], { cacheDir, warn: s => warnings.push(s), git: async () => { throw new Error('next failure'); } });
    assert.match(fs.readFileSync(readme, 'utf8'), /B complete/);
    assert.match(warnings.join('\n'), /A transport failure/);
    assert.deepEqual(fs.readdirSync(cacheDir), [cache.cachePath(addon, cacheDir).split('/').at(-1)]);
});

test('actual builder waits for a refreshing process and reads complete new README and examples', async () => {
    const f = buildFixture([addon]), ready = join(f.base, 'ready'), resume = join(f.base, 'resume');
    const dir = cache.cachePath(addon, f.cacheDir); fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, 'README.md'), '## Old\nOld complete\n');
    const runner = join(f.base, 'refresh.mjs');
    fs.writeFileSync(runner, `import fs from 'node:fs'; import {join} from 'node:path';
import {refreshExternalAddons} from ${JSON.stringify(new URL('./addon-cache.mjs', import.meta.url).href)};
await refreshExternalAddons([${JSON.stringify(addon)}], {cacheDir:${JSON.stringify(f.cacheDir)}, git:async args=>{
 if(args[0] !== 'clone') return;
 fs.writeFileSync(${JSON.stringify(ready)}, 'yes');
 while(!fs.existsSync(${JSON.stringify(resume)})) await new Promise(r=>setTimeout(r,10));
 const dir=args.at(-1); fs.writeFileSync(join(dir,'README.md'),'## New\\nNew complete\\n');
 fs.mkdirSync(join(dir,'example-basic/src'),{recursive:true}); fs.writeFileSync(join(dir,'example-basic/src/tcApp.cpp'),'// New complete example');
}});`);
    const writer = spawn(process.execPath, [runner], { stdio: 'ignore' });
    const writerExit = once(writer, 'exit');
    let reader, readerExit;
    try {
        for (let i = 0; i < 300 && !fs.existsSync(ready); i++) await wait(10);
        assert.ok(fs.existsSync(ready), 'writer started');
        reader = spawn(process.execPath, [join(f.app, 'build-chunks.mjs')], { cwd: f.base, env: f.env, stdio: 'ignore' });
        readerExit = once(reader, 'exit');
        const exitedEarly = await Promise.race([readerExit.then(() => true), wait(250).then(() => false)]);
        fs.writeFileSync(resume, 'yes');
        assert.equal((await writerExit)[0], 0);
        assert.equal((await readerExit)[0], 0);
        assert.equal(exitedEarly, false, 'cache reader must wait on the writer lock');
        const cards = f.cards();
        assert.match(cards.find(c => c.id === 'addon:tcxShared#new').text, /New complete/);
        assert.match(cards.find(c => c.id === 'example:tcxShared/basic').text, /New complete example/);
        assert.equal(fs.existsSync(join(f.cacheDir, '.lock')), false);
    } finally {
        fs.writeFileSync(resume, 'yes');
        for (const child of [writer, reader]) if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await Promise.all([writerExit, readerExit].filter(Boolean));
    }
});

test('direct fetch CLIs in separate worktrees hold the shared lock through registry fetching', async () => {
    const a = buildFixture([]), b = buildFixture([]), cacheDir = a.cacheDir;
    const readyA = join(a.base, 'fetch-ready'), readyB = join(b.base, 'fetch-ready'), resume = join(a.base, 'resume');
    const children = [], exits = [];
    function start(f, ready) {
        const preload = join(f.base, 'fetch-stub.mjs');
        fs.writeFileSync(preload, `import fs from 'node:fs'; globalThis.fetch=async()=>{
fs.writeFileSync(${JSON.stringify(ready)},'yes');
while(!fs.existsSync(${JSON.stringify(resume)})) await new Promise(r=>setTimeout(r,10));
return new Response('{"addons":[]}');};`);
        const child = spawn(process.execPath, ['--import', preload, join(f.app, 'fetch-addons.mjs')], {
            env: { ...f.env, ADDON_CACHE_DIR: cacheDir }, stdio: 'ignore',
        });
        children.push(child); exits.push(once(child, 'exit'));
    }
    const watchdog = setTimeout(() => children.forEach(c => { if (c.exitCode === null) c.kill('SIGKILL'); }), 5000);
    try {
        start(a, readyA);
        for (let i = 0; i < 300 && !fs.existsSync(readyA); i++) await wait(10);
        assert.ok(fs.existsSync(readyA));
        start(b, readyB); await wait(250);
        const bFetchedWhileA = fs.existsSync(readyB);
        fs.writeFileSync(resume, 'yes');
        const results = await Promise.all(exits);
        assert.deepEqual(results.map(r => r[0]), [0, 0]);
        assert.equal(bFetchedWhileA, false, 'B must not fetch the registry while A owns the shared cache');
        assert.ok(fs.existsSync(readyB)); assert.equal(fs.existsSync(join(cacheDir, '.lock')), false);
    } finally {
        clearTimeout(watchdog); fs.writeFileSync(resume, 'yes');
        for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
        await Promise.all(exits);
    }
});

test('lock records ownership, bounds waiting, survives stale contention and releases after exceptions', async () => {
    assert.equal(typeof cache.withCacheLock, 'function', 'shared cache lock API required');
    assert.equal(cache.CACHE_LOCK_TIMEOUT_MS, 600_000);
    const cacheDir = temp('locks-'), ready = join(root, 'lock-ready'), runner = join(root, 'lock-owner.mjs');
    fs.writeFileSync(runner, `import fs from 'node:fs'; import {withCacheLock} from ${JSON.stringify(new URL('./addon-cache.mjs', import.meta.url).href)};
await withCacheLock({cacheDir:${JSON.stringify(cacheDir)}}, async()=>{fs.writeFileSync(${JSON.stringify(ready)},'yes'); await new Promise(()=>{});});`);
    // Keep the owner alive while its callback is pending.
    fs.appendFileSync(runner, '\n');
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,setInterval(()=>{},1000)', runner], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    try {
        for (let i = 0; i < 300 && !fs.existsSync(ready); i++) await wait(10);
        assert.ok(fs.existsSync(ready));
        const names = fs.readdirSync(join(cacheDir, '.lock'));
        const owner = JSON.parse(fs.readFileSync(join(cacheDir, '.lock', names[0]), 'utf8'));
        assert.equal(owner.pid, child.pid); assert.equal(owner.hostname, hostname()); assert.ok(Number.isFinite(owner.startedAt));
        await assert.rejects(cache.withCacheLock({ cacheDir, lockTimeoutMs: 40, retryMs: 5 }, () => assert.fail('entered live lock')), /timed out.*addon cache lock/i);
    } finally { child.kill('SIGKILL'); await exited; }
    let active = 0, max = 0, calls = 0;
    await Promise.all(Array.from({ length: 12 }, () => cache.withCacheLock({ cacheDir, retryMs: 2 }, async () => {
        max = Math.max(max, ++active); calls++; await wait(2); active--;
    })));
    assert.equal(max, 1); assert.equal(calls, 12); assert.deepEqual(fs.readdirSync(cacheDir), []);
    await assert.rejects(cache.withCacheLock({ cacheDir }, () => { throw new Error('callback failed'); }), /callback failed/);
    assert.deepEqual(fs.readdirSync(cacheDir), []);
    await cache.withCacheLock({ cacheDir }, () => {});
    assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test('competing processes recover a dead owner without removing a successor lock', async () => {
    assert.equal(typeof cache.withCacheLock, 'function');
    const cacheDir = temp('contended-'), lockDir = join(cacheDir, '.lock'), token = randomUUID();
    // Obtain a PID known to have exited, without assuming a fixed PID is unused.
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); await once(dead, 'exit');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(join(lockDir, `owner-${token}.json`), JSON.stringify({ pid: dead.pid, hostname: hostname(), startedAt: Date.now(), token }));
    const runner = join(cacheDir, 'waiter.mjs'), marker = join(root, 'critical-section'), log = join(root, 'critical-log');
    fs.writeFileSync(runner, `import fs from 'node:fs'; import {withCacheLock} from ${JSON.stringify(new URL('./addon-cache.mjs', import.meta.url).href)};
await withCacheLock({cacheDir:${JSON.stringify(cacheDir)},retryMs:2,lockTimeoutMs:4000}, async()=>{
 const fd=fs.openSync(${JSON.stringify(marker)},'wx');
 try { fs.appendFileSync(${JSON.stringify(log)},'entered\\n'); await new Promise(r=>setTimeout(r,15)); }
 finally {fs.closeSync(fd);fs.unlinkSync(${JSON.stringify(marker)});}
});`);
    const children = Array.from({ length: 8 }, () => spawn(process.execPath, [runner], { stdio: 'ignore' }));
    const exits = children.map(c => once(c, 'exit'));
    const watchdog = setTimeout(() => children.forEach(c => { if (c.exitCode === null) c.kill('SIGKILL'); }), 5000);
    try {
        assert.deepEqual((await Promise.all(exits)).map(r => r[0]), Array(8).fill(0));
        assert.equal(fs.readFileSync(log, 'utf8'), 'entered\n'.repeat(8));
        assert.equal(fs.existsSync(lockDir), false);
        assert.equal(fs.existsSync(marker), false);
    } finally {
        clearTimeout(watchdog);
        for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
        await Promise.all(exits);
    }
});

test('publication moves old entry to backup; failed staging rename restores it under the lock', async () => {
    const cacheDir = temp('publish-'), dir = cache.cachePath(addon, cacheDir), warnings = [];
    fs.mkdirSync(dir); fs.writeFileSync(join(dir, 'README.md'), 'old complete');
    const rename = fs.renameSync;
    let observed = false;
    fs.renameSync = (from, to) => {
        if (String(from).includes('/.addon-') && to === dir) {
            observed = true;
            assert.ok(fs.existsSync(join(cacheDir, '.lock')));
            assert.equal(fs.existsSync(dir), false);
            assert.ok(fs.readdirSync(cacheDir).some(n => n.startsWith('.backup-')));
            throw new Error('injected staging publication failure');
        }
        return rename(from, to);
    };
    syncBuiltinESMExports();
    try { await cache.refreshExternalAddons([addon], { cacheDir, git: fakeGit('new'), warn: s => warnings.push(s) }); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.ok(observed); assert.match(warnings.join('\n'), /injected staging publication failure/);
    assert.equal(fs.readFileSync(join(dir, 'README.md'), 'utf8'), 'old complete');
    assert.deepEqual(fs.readdirSync(cacheDir), [dir.split('/').at(-1)]);
});

test('interrupted publication backup is recovered before readers enter; a completed publication wins', async () => {
    assert.equal(typeof cache.withCacheLock, 'function');
    const cacheDir = temp('backup-recovery-'), dir = cache.cachePath(addon, cacheDir);
    const backup = join(cacheDir, `.backup-${dir.split('/').at(-1)}-${randomUUID()}`);
    fs.mkdirSync(backup); fs.writeFileSync(join(backup, 'README.md'), 'old complete');
    await cache.withCacheLock({ cacheDir }, () => assert.equal(fs.readFileSync(join(dir, 'README.md'), 'utf8'), 'old complete'));
    fs.mkdirSync(backup); fs.writeFileSync(join(backup, 'README.md'), 'old complete');
    fs.writeFileSync(join(dir, 'README.md'), 'new complete');
    await cache.withCacheLock({ cacheDir }, () => {
        assert.equal(fs.readFileSync(join(dir, 'README.md'), 'utf8'), 'new complete');
        assert.equal(fs.existsSync(backup), false);
    });
    assert.equal(fs.existsSync(join(cacheDir, '.lock')), false);
});

for (const [name, entries, duplicates] of [
    ['external plus bundled alias', [addon, { ...addon, bundled: true }], 1],
    ['65 identical external entries', Array.from({ length: 65 }, () => ({ ...addon })), 64],
    ['case insensitive name alias', [addon, { ...addon, name: addon.name.toUpperCase(), url: 'https://github.com/Test/Other' }], 1],
    ['same cache URL alias', [addon, { ...addon, name: 'another', url: addon.url + '.git' }], 1],
]) test(`${name}: one metadata card, at most 200 external sections and one example with unique IDs`, () => {
    const f = buildFixture(entries), dir = cache.cachePath(addon, f.cacheDir);
    fs.mkdirSync(join(dir, 'example-basic/src'), { recursive: true });
    fs.writeFileSync(join(dir, 'README.md'), '## A\nx\n'.repeat(205));
    fs.writeFileSync(join(dir, 'example-basic/src/tcApp.cpp'), '// example marker');
    const { cards, warnings } = f.build(), addons = cards.filter(c => c.source === 'addon');
    assert.equal(addons.filter(c => !c.id.includes('#')).length, 1);
    assert.equal(addons.filter(c => c.id.includes('#')).length, 200);
    assert.equal(cards.filter(c => c.id.startsWith('example:tcxShared/')).length, 1);
    assert.equal(new Set(cards.map(c => c.id)).size, cards.length);
    assert.equal(warnings.split('\n').filter(s => /Warning:.*duplicate registry/.test(s)).length, duplicates, warnings);
});

test('registry considers at most the first 256 entries; malformed and duplicate entries do not reserve identities', async () => {
    const warnings = [], a = { ...addon, name: 'first' };
    const reg = validateRegistry({ addons: [{ ...a, bundled: 'bad' }, a, { ...a, name: 'FIRST' },
        { ...a, name: 'alias', url: a.url + '.git' }, ...Array.from({ length: 254 }, (_, i) => ({ ...addon, name: `n${i}`, url: `https://github.com/Test/n${i}`, bundled: true }))] }, s => warnings.push(s));
    assert.equal(reg.addons.length, 253);
    assert.equal(warnings.filter(w => /256/.test(w)).length, 1);
    assert.equal(warnings.filter(w => /duplicate registry/.test(w)).length, 2);
    const cacheDir = temp('dedup-refresh-'); let clones = 0;
    await cache.refreshExternalAddons([addon, { ...addon, bundled: true }, ...Array.from({ length: 64 }, () => addon)], {
        cacheDir, warn: () => {}, git: fakeGit('one', () => { clones++; }),
    });
    assert.equal(clones, 1);
});

test('directory admission carries actual content origin and cap independently of consuming flags', () => {
    const f = buildFixture([addon]), dir = cache.cachePath(addon, f.cacheDir);
    fs.mkdirSync(dir); fs.writeFileSync(join(dir, 'README.md'), 'external');
    const source = cache.addonDirectories([addon], f.bundled, { cacheDir: f.cacheDir }).get(addon.name);
    assert.deepEqual(source, { dir, source: 'external', capped: true });
    // A consumer's bundled flag cannot uncap an admitted external source.
    fs.writeFileSync(join(dir, 'README.md'), '## A\nx\n'.repeat(205));
    const code = fs.readFileSync(new URL('./build-chunks.mjs', import.meta.url), 'utf8'), warnings = [];
    const ctx = { createHash, readFileSync: fs.readFileSync, lstatSync: fs.lstatSync, regularPath: cache.regularPath,
        ADDONS_DIR: f.bundled, console: { warn: s => warnings.push(s) } };
    vm.runInNewContext(code.slice(code.indexOf('function splitHeadings('), code.indexOf('// --- Source: FOR_AI')) + '\n' +
        code.slice(code.indexOf('const ADDON_README_CAP'), code.indexOf('// --- openFrameworks index')) + '\nglobalThis.chunk=chunkAddons;', ctx);
    assert.equal(ctx.chunk([{ ...addon, bundled: true }], new Map([[addon.name, source]])).length, 201);
    assert.equal(warnings.length, 1);
    fs.mkdirSync(join(f.bundled, addon.name));
    assert.deepEqual(cache.addonDirectories([addon], f.bundled, { cacheDir: f.cacheDir }).get(addon.name),
        { dir: join(f.bundled, addon.name), source: 'bundled', capped: false });
});

test('several killed refreshes leave staging; next refresh reclaims all staging before measuring budget', async () => {
    const cacheDir = temp('crashes-'), runner = join(root, 'crash-refresh.mjs'), ready = join(root, 'crash-ready');
    fs.writeFileSync(runner, `import fs from 'node:fs'; import {join} from 'node:path';
import {refreshExternalAddons} from ${JSON.stringify(new URL('./addon-cache.mjs', import.meta.url).href)};
await refreshExternalAddons([${JSON.stringify(addon)}],{cacheDir:${JSON.stringify(cacheDir)},git:async args=>{
 if(args[0]!=='clone') return;
 const path=join(args.at(-1),'partial-pack'); fs.writeFileSync(path,''); fs.truncateSync(path,60*1024**2);
 fs.writeFileSync(${JSON.stringify(ready)},'yes'); setInterval(()=>{},1000); await new Promise(()=>{});
}});`);
    for (let i = 0; i < 8; i++) {
        const child = spawn(process.execPath, [runner], { stdio: 'ignore' }), exited = once(child, 'exit');
        try {
            for (let n = 0; n < 300 && !fs.existsSync(ready); n++) await wait(10);
            assert.ok(fs.existsSync(ready), 'crash fixture entered Git');
        } finally { child.kill('SIGKILL'); await exited; }
        fs.rmSync(ready);
        // Accumulate actual crash leftovers from legacy runs; a fixed refresh
        // would otherwise reclaim the previous run before making its own staging.
        const staging = fs.readdirSync(cacheDir).find(n => n.startsWith('.addon-'));
        fs.renameSync(join(cacheDir, staging), join(root, `saved-crash-${i}`));
    }
    for (let i = 0; i < 8; i++) fs.renameSync(join(root, `saved-crash-${i}`), join(cacheDir, `.addon-crashed-${i}`));
    assert.equal(fs.readdirSync(cacheDir).filter(n => n.startsWith('.addon-')).length, 8);
    assert.ok(cache.treeBytes(cacheDir) >= 480 * 1024 ** 2);
    let clones = 0; const warnings = [];
    await cache.refreshExternalAddons([addon], { cacheDir, git: fakeGit('recovered', () => {
        clones++;
        // The only staging directory now belongs to this run.
        assert.equal(fs.readdirSync(cacheDir).filter(n => n.startsWith('.addon-')).length, 1);
    }), warn: s => warnings.push(s) });
    assert.equal(clones, 1, warnings.join('\n'));
    assert.equal(fs.readFileSync(join(cache.cachePath(addon, cacheDir), 'README.md'), 'utf8'), 'recovered');
    assert.equal(fs.readdirSync(cacheDir).filter(n => n.startsWith('.addon-')).length, 0);
    assert.equal(fs.existsSync(join(cacheDir, '.lock')), false);
});
