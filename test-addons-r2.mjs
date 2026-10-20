// Round 2 offline regressions: temporary remotes, caches and process stubs only.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, renameSync, symlinkSync, lstatSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { refreshExternalAddons, addonDirectories, cachePath, runGit, treeBytes, LIMITS, regularPath } from './addon-cache.mjs';

const root = mkdtempSync(join(tmpdir(), 'docs-addons-r2-'));
after(() => rmSync(root, { recursive: true, force: true }));
const temp = name => mkdtempSync(join(root, name));
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(name) {
    const base = temp('remote-'), author = join(base, 'author'), remote = join(base, 'remote.git'), cacheDir = join(base, 'cache');
    git(base, 'init', '--bare', '--initial-branch=main', remote);
    git(remote, 'config', 'uploadpack.allowFilter', 'true');
    git(base, 'clone', remote, author);
    writeFileSync(join(author, 'README.md'), '## Release\nSelected tag documentation.\n');
    git(author, 'add', '.'); git(author, 'commit', '-m', 'release'); git(author, 'tag', 'v1');
    git(author, 'push', 'origin', 'main', 'refs/tags/v1');
    const addon = { name, url: `https://github.com/Test/${name}`, bundled: false, latest_tag: 'v1' };
    const warnings = [], options = { cacheDir, rewrites: { [addon.url]: pathToFileURL(remote).href }, warn: s => warnings.push(s) };
    return { base, author, remote, addon, warnings, options, cacheDir, dir: cachePath(addon, cacheDir) };
}
function publish(f) {
    git(f.author, 'add', '.'); git(f.author, 'commit', '-m', 'next release');
    git(f.author, 'tag', 'v2'); git(f.author, 'push', 'origin', 'main', 'refs/tags/v2'); f.addon.latest_tag = 'v2';
}

test('same-named branch and tag select the tag commit for both fresh and refreshed caches', async () => {
    const f = fixture('sameRef');
    git(f.author, 'checkout', '-b', 'v1');
    writeFileSync(join(f.author, 'README.md'), '## Branch\nDifferent branch documentation.\n');
    git(f.author, 'commit', '-am', 'branch'); git(f.author, 'push', 'origin', 'refs/heads/v1');
    const commands = [];
    for (let i = 0; i < 2; i++) {
        await refreshExternalAddons([f.addon], { ...f.options, git: async (args, opts) => {
            commands.push(args); return runGit(args, opts);
        } });
        assert.deepEqual(f.warnings, []);
        assert.equal(git(f.dir, 'rev-parse', 'HEAD'), git(f.author, 'rev-parse', 'refs/tags/v1'));
        assert.match(readFileSync(join(f.dir, 'README.md'), 'utf8'), /Selected tag/);
        assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: f.dir, env: gitEnv }).status, 1);
    }
    assert.equal(commands.filter(a => a[0] === 'clone').length, 2);
    assert.ok(commands.every(a => !a.includes('--branch')));
    assert.equal(commands.filter(a => a.includes('fetch') && a.at(-1) === 'refs/tags/v1').length, 2);
});

test('metadata symlinks are discarded without changing outside objects or info', async () => {
    for (const metadata of ['objects', 'info']) {
        const f = fixture(`linked${metadata}`);
        await refreshExternalAddons([f.addon], f.options);
        const outside = join(f.base, 'outside');
        renameSync(join(f.dir, '.git', metadata), outside);
        symlinkSync(outside, join(f.dir, '.git', metadata));
        if (metadata === 'info') writeFileSync(join(outside, 'sparse-checkout'), 'outside marker\n');
        const before = treeBytes(outside);
        const sparseBefore = metadata === 'info' && readFileSync(join(outside, 'sparse-checkout'), 'utf8');
        writeFileSync(join(f.author, 'README.md'), '## Next\nNext release documentation.\n'); publish(f);
        await refreshExternalAddons([f.addon], f.options);
        assert.equal(treeBytes(outside), before, metadata);
        if (metadata === 'info') assert.equal(readFileSync(join(outside, 'sparse-checkout'), 'utf8'), sparseBefore);
        assert.ok(f.warnings.some(w => /symlink/i.test(w)), 'discard must be explained');
        assert.equal(lstatSync(join(f.dir, '.git', metadata)).isSymbolicLink(), false);
        assert.match(readFileSync(join(f.dir, 'README.md'), 'utf8'), /Next release/);
    }
});

test('symlink cache root is refused and offline admission deletes symlink entries', async () => {
    const f = fixture('rootLink'), outside = temp('outside-');
    symlinkSync(outside, f.cacheDir);
    await assert.rejects(refreshExternalAddons([f.addon], f.options), /cache root.*real directory.*owned by the current user/i);
    assert.deepEqual(readdirSync(outside), []);
    rmSync(f.cacheDir); mkdirSync(f.cacheDir); mkdirSync(f.dir);
    symlinkSync(outside, join(f.dir, '.git'));
    const dirs = addonDirectories([f.addon], join(f.base, 'absent'), f.options);
    assert.equal(dirs.size, 0); assert.equal(existsSync(f.dir), false);
    assert.deepEqual(readdirSync(outside), []);
});

// Observe completed files after every Git step and regularly while it writes.
// The production runner must impose the per-file limit, not this observer.
async function observedRefresh(f) {
    let largest = 0, failed = false, failureSignal, killedAlive = false, observedDir, group;
    const kill = process.kill;
    process.kill = (pid, signal) => {
        if (pid < 0 && signal === 'SIGKILL') {
            try { kill(pid, 0); killedAlive = true; } catch (e) { if (e.code !== 'ESRCH') throw e; }
        }
        return kill(pid, signal);
    };
    function inspect(path) {
        if (!path || !existsSync(path)) return;
        for (const name of readdirSync(path)) {
            const p = join(path, name); let st;
            try { st = lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
            if (st.isDirectory()) inspect(p);
            else if (st.isFile()) largest = Math.max(largest, st.size);
        }
    }
    try { await refreshExternalAddons([f.addon], { ...f.options, git: async (args, opts) => {
        if (args[0] === 'clone') observedDir = args.at(-1);
        const monitor = setInterval(() => inspect(observedDir), 5);
        try { await runGit(args, { ...opts, recordGroup: record => { group = record.pgid; opts.recordGroup?.(record); } }); }
        catch (e) {
            failed = true; failureSignal = e.signal;
            if (f.reapGroup) {
                // Let the fixture's subreaper reap killed descendants before
                // refresh inspects group identity or removes staging.
                for (let i = 0; ; i++) {
                    try { process.kill(-group, 0); }
                    catch (error) { if (error.code !== 'ESRCH') throw error; break; }
                    assert.ok(i < 150, 'the killed group must disappear within a generous bound');
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
            throw e;
        }
        finally { clearInterval(monitor); inspect(observedDir); }
    } }); } finally { process.kill = kill; }
    return { largest, failed, failureSignal, killedAlive, observedDir, group };
}

test('selected 64 MiB+1 README is stopped during Git, never completes above the per-file limit, and is removed', async () => {
    const f = fixture('largeReadme');
    writeFileSync(join(f.author, 'README.md'), Buffer.alloc(LIMITS.checkoutBytes + 1, 97)); publish(f);
    const result = await observedRefresh(f);
    assert.ok(result.failed, 'Git must fail before admission checks');
    assert.ok(result.killedAlive || result.failureSignal === 'SIGXFSZ', 'Git must be killed by the live monitor or the file-size limit');
    assert.ok(result.largest <= LIMITS.checkoutBytes, `completed file reached ${result.largest} bytes`);
    assert.ok(f.warnings.some(w => /failed|limit|exceeds/i.test(w)));
    assert.equal(existsSync(f.dir), false); assert.deepEqual(readdirSync(f.cacheDir), []);
    assert.notEqual(result.observedDir, f.dir, 'downloads must use a temporary directory');
});

test('sum of medium selected files is refused including Git bytes', async () => {
    const f = fixture('manyFiles');
    mkdirSync(join(f.author, 'example-many/src'), { recursive: true });
    // Compressible objects keep the source repository small; checkout crosses the total.
    for (let i = 0; i < 30; i++) writeFileSync(join(f.author, `example-many/src/file${i}.h`), Buffer.alloc(3 * 1024 ** 2, 65 + i));
    publish(f);
    const result = await observedRefresh(f);
    assert.ok(result.failed, 'the running Git process must be killed by polling');
    assert.match(f.warnings.join('\n'), /64 MiB.*poll|poll.*64 MiB/i);
    assert.ok(result.largest <= LIMITS.checkoutBytes);
    assert.equal(existsSync(f.dir), false); assert.deepEqual(readdirSync(f.cacheDir), []);
});

test('live polling kills gradual medium-file writes including .git before the Git command completes', async () => {
    // Run under a continuously reaping parent so group/descendant ESRCH is
    // meaningful on containers too, regardless of which enforcer wins.
    if (!process.env.DOCS_R2_LIVE_WRITER) {
        const dir = temp('live-reaper-'), supervisor = join(dir, 'reaper.py');
        writeFileSync(supervisor, `import ctypes, os, subprocess, sys, time
if sys.platform.startswith('linux'):
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
p = subprocess.Popen(sys.argv[1:])
code = None
while True:
    try:
        pid, status = os.waitpid(-1, os.WNOHANG)
        if pid == p.pid: code = os.waitstatus_to_exitcode(status)
        if pid == 0: time.sleep(0.005)
    except ChildProcessError: break
sys.exit(code if code is not None else 1)
`);
        const out = openSync(join(dir, 'out'), 'w'), err = openSync(join(dir, 'err'), 'w');
        let result;
        try { result = spawnSync('python3', [supervisor, process.execPath,
            '--test-name-pattern=live polling kills gradual', fileURLToPath(import.meta.url)], {
            env: { ...process.env, DOCS_R2_LIVE_WRITER: '1' }, stdio: ['ignore', out, err], timeout: 15000,
        }); } finally { closeSync(out); closeSync(err); }
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.status, 0, readFileSync(join(dir, 'out'), 'utf8') + readFileSync(join(dir, 'err'), 'utf8'));
        return;
    }
    const f = fixture('polledWrites'), bin = temp('polled-bin-'), completed = join(bin, 'completed');
    f.reapGroup = true;
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (!process.argv.includes('clone')) process.exit(0);
const dir = process.argv.at(-1);
fs.mkdirSync(path.join(dir, '.git/objects'), {recursive:true});
fs.mkdirSync(path.join(dir, 'example-many/src'), {recursive:true});
const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(join(bin, 'pids'))}, JSON.stringify([process.pid, descendant.pid]));
(async () => {
    for (let i = 0; i < 32; i++) {
        fs.writeFileSync(path.join(dir, i % 2 ? 'example-many/src/file' + i + '.h' : '.git/objects/medium' + i), Buffer.alloc(3 * 1024 ** 2, 65));
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    fs.writeFileSync(${JSON.stringify(completed)}, 'command completed');
})();
`, { mode: 0o755 });
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
    let result;
    try { result = await observedRefresh(f); } finally { process.env.PATH = oldPath; }
    assert.ok(result.failed);
    const pids = JSON.parse(readFileSync(join(bin, 'pids'), 'utf8'));
    assert.ok(result.group, 'the supervised group was recorded');
    for (const pid of [...pids, -result.group])
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'writer, descendant and group exited');
    assert.equal(existsSync(completed), false, 'the Git child must not finish its writes');
    assert.match(f.warnings.join('\n'), /64 MiB.*poll|poll.*64 MiB/i);
    assert.ok(f.warnings.length > 0, 'refresh issued a Warning');
    assert.ok(result.largest <= LIMITS.checkoutBytes);
    assert.equal(existsSync(result.observedDir), false, 'staging was removed');
    assert.equal(existsSync(f.dir), false); assert.deepEqual(readdirSync(f.cacheDir), []);
});

test('cache admission reserves 64 MiB before starting and counts Git bytes per addon', async () => {
    const f = fixture('reserve'); mkdirSync(f.cacheDir);
    const fd = openSync(join(f.cacheDir, 'old'), 'w');
    try { (await import('node:fs')).ftruncateSync(fd, LIMITS.cacheBytes - LIMITS.checkoutBytes + 1); }
    finally { closeSync(fd); }
    let calls = 0;
    await refreshExternalAddons([f.addon], { ...f.options, git: async () => calls++ });
    assert.equal(calls, 0); assert.match(f.warnings.join('\n'), /remaining.*64 MiB/i);
    rmSync(join(f.cacheDir, 'old'));
    mkdirSync(join(f.dir, '.git'), { recursive: true });
    const pack = openSync(join(f.dir, '.git', 'pack'), 'w');
    try { (await import('node:fs')).ftruncateSync(pack, LIMITS.checkoutBytes + 1); }
    finally { closeSync(pack); }
    assert.equal(addonDirectories([f.addon], join(f.base, 'absent'), f.options).size, 0);
});

// A supervisor reaps orphaned children on Linux, including containers whose PID 1
// does not reap. No /proc reads or zombie-as-success exceptions are used.
test('deadline kills the background grandchild by process group without /proc and rejects before inherited pipes close', () => {
    const dir = temp('deadline-'), runner = join(dir, 'runner.mjs'), bin = join(dir, 'bin'); mkdirSync(bin);
    const pidFile = join(dir, 'grandchild.pid'), parentFile = join(dir, 'git.pid');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho $$ > '${parentFile}'\n/bin/sleep 20 &\necho $! > '${pidFile}'\nwait\n`, { mode: 0o755 });
    writeFileSync(runner, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { runGit } from ${JSON.stringify(new URL('./addon-cache.mjs', import.meta.url).href)};
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => { if (String(path).startsWith('/proc/')) throw Object.assign(new Error('no proc'), {code:'ENOENT'}); return read(path, ...args); };
syncBuiltinESMExports();
let watchdog;
const bounded = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('deadline did not reject promptly')), 2000); });
try { await assert.rejects(Promise.race([runGit(['clone'], {cwd:${JSON.stringify(dir)},timeoutMs:150}), bounded]), /timeout/); }
finally { clearTimeout(watchdog); }
fs.writeFileSync(${JSON.stringify(join(dir, 'rejected'))}, 'yes');
`);
    const supervisor = join(dir, 'supervisor.py');
    writeFileSync(supervisor, `import ctypes, os, subprocess, sys\nif sys.platform.startswith('linux'):\n    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0\np = subprocess.Popen(sys.argv[1:])\ncode = p.wait()\nwhile True:\n    try: os.waitpid(-1, 0)\n    except ChildProcessError: break\nsys.exit(code)\n`);
    const out = openSync(join(dir, 'out'), 'w'), err = openSync(join(dir, 'err'), 'w');
    let result;
    try { result = spawnSync('python3', [supervisor, process.execPath, runner], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', out, err], timeout: 5000,
    }); } finally { closeSync(out); closeSync(err); }
    // Clean up explicit PIDs even when running this regression against the old code.
    for (const path of [pidFile, parentFile]) if ((result.error || result.status !== 0) && existsSync(path)) {
        const pid = Number(readFileSync(path, 'utf8'));
        try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, readFileSync(join(dir, 'err'), 'utf8'));
    assert.ok(existsSync(join(dir, 'rejected')));
    assert.ok(existsSync(pidFile), 'the background grandchild must actually have started');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

const source = readFileSync(new URL('./build-chunks.mjs', import.meta.url), 'utf8');
function headingContext() {
    const warnings = [], bundled = temp('bundled-');
    const ctx = { createHash, readFileSync, lstatSync, regularPath, ADDONS_DIR: bundled, console: { warn: s => warnings.push(s) } };
    vm.runInNewContext(source.slice(source.indexOf('function splitHeadings('), source.indexOf('// --- Source: FOR_AI')) + '\n' +
        source.slice(source.indexOf('const ADDON_README_CAP'), source.indexOf('// --- openFrameworks index')) +
        '\nglobalThis.chunk = chunkAddons; globalThis.id = sectionId;', ctx);
    return { ctx, warnings, bundled };
}
test('20,000 identical external README headings complete with 200 unique sections and one named warning', () => {
    const { ctx, warnings } = headingContext(), dir = temp('headings-');
    writeFileSync(join(dir, 'README.md'), '## A\nx\n'.repeat(20_000));
    const addon = { name: 'manyHeadings', bundled: false }, cards = ctx.chunk([addon], new Map([[addon.name, { dir, source: 'external', capped: true }]]));
    assert.equal(cards.length, 201); assert.equal(new Set(cards.map(c => c.id)).size, cards.length);
    assert.equal(warnings.length, 1); assert.match(warnings[0], /Warning:.*manyHeadings.*200/);
});
test('per-document suffix counters produce 20,000 unique IDs with linear membership work', () => {
    const { ctx } = headingContext(), used = new Set(), next = new Map(); let checks = 0;
    const has = used.has.bind(used); used.has = id => { checks++; return has(id); };
    for (let i = 0; i < 20_000; i++) ctx.id('addon:test#', 'A', used, next);
    assert.equal(used.size, 20_000); assert.ok(checks <= 100_000, `membership checks: ${checks}`);
});
test('bundled README cards and existing collision IDs remain byte-for-byte unchanged', () => {
    const { ctx, warnings, bundled } = headingContext(), dir = join(bundled, 'bundled'); mkdirSync(dir);
    const body = '## A\nx\n## A\ny\n## A\nz\n## A-2\nw\n## 日本語\nj\n' + '## More\nm\n'.repeat(205);
    writeFileSync(join(dir, 'README.md'), body);
    const addon = { name: 'bundled', bundled: false }, dirs = new Map([[addon.name, { dir, source: 'bundled', capped: false }]]);
    // Frozen SHA-256 of the complete Round 1 card JSON for this bundled input.
    const digest = createHash('sha256').update(JSON.stringify(ctx.chunk([addon], dirs))).digest('hex');
    assert.equal(digest, 'd7b9dbcb4e67f41445f71cce9385cf51c28dbac0c075681672510d3b2da4d9e4');
    assert.deepEqual(warnings, []);
});
