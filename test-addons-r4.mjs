// Offline crash regressions: actual detached Git fixtures, never a network fetch.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = fs.mkdtempSync(join(tmpdir(), 'docs-addons-r4-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const cacheURL = new URL('./addon-cache.mjs', import.meta.url).href;

// Linux containers may have a PID 1 that does not reap. Reap continuously while
// the scenario runs, so ESRCH establishes exit rather than accepting zombies.
const reaper = join(root, 'reaper.py');
fs.writeFileSync(reaper, `import ctypes, os, subprocess, sys, time
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

async function scenario(mode, cacheURL, base) {
    const assert = (await import('node:assert/strict')).default;
    const fs = (await import('node:fs')).default;
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { hostname } = await import('node:os');
    const { syncBuiltinESMExports } = await import('node:module');
    const cache = await import(cacheURL);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code !== 'ESRCH') throw e; return false; } };
    async function until(predicate, message) {
        for (let i = 0; i < (mode === 'size' ? 800 : 200); i++) { if (predicate()) return; await wait(10); }
        assert.fail(message);
    }
    const cacheDir = join(base, 'cache'), bin = join(base, 'bin'), ready = join(base, 'ready'), status = join(base, 'status');
    fs.mkdirSync(bin);
    const addon = { name: 'Crash', url: 'https://github.com/Test/Crash', bundled: false };
    const isSize = mode === 'size';
    fs.writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv.at(-1); fs.mkdirSync(path.join(dir,'.git'),{recursive:true});
const fds=[fs.openSync(path.join(dir,'.git/pack-A'),'w'),fs.openSync(path.join(dir,'pack-B'),'w')];
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,dir}));
// Flush incompressible size-fixture writes so du sees allocated extents even
// on compressed filesystems with delayed allocation.
const buf=${isSize ? "require('node:crypto').randomBytes(128 * 1024)" : 'Buffer.alloc(1024 * 1024,1)'};
setInterval(()=>{for(const fd of fds)if(fs.fstatSync(fd).size<48*1024**2){fs.writeSync(fd,buf);${isSize ? 'fs.fsyncSync(fd);' : ''}}
fs.writeFileSync(${JSON.stringify(status)},JSON.stringify(fds.map(fd=>fs.fstatSync(fd).size)));},20);
`, { mode: 0o755 });
    const runner = join(base, 'refresh.mjs');
    fs.writeFileSync(runner, `import fs from 'node:fs';
import {refreshExternalAddons,LIMITS} from ${JSON.stringify(cacheURL)};
await refreshExternalAddons([${JSON.stringify(addon)}],{cacheDir:${JSON.stringify(cacheDir)},warn:w=>fs.writeFileSync(${JSON.stringify(join(base, 'warning'))},w),
limits:{...LIMITS,timeoutMs:${mode === 'deadline' ? 600 : mode === 'orphan' ? 300 : isSize ? 10000 : 5000},checkoutBytes:${isSize ? 2 * 1024 ** 2 : 64 * 1024 ** 2}}});`);
    let parent, parentExit, group, fixture, unrelated, unrelatedExit;
    const originalRm = fs.rmSync;
    try {
        parent = spawn(process.execPath, [runner], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });
        parentExit = once(parent, 'exit');
        await until(() => fs.existsSync(ready), 'fixture Git started');
        fixture = JSON.parse(fs.readFileSync(ready, 'utf8'));
        const lockDir = join(cacheDir, '.lock'), ownerFile = fs.readdirSync(lockDir)[0];
        const owner = JSON.parse(fs.readFileSync(join(lockDir, ownerFile), 'utf8'));
        group = owner.groups?.[0]?.pgid || fixture.pid; // Also clean up the red run.
        if (mode === 'deadline' || mode === 'size') {
            // Freeze only Node: its timers cannot enforce either bound.
            process.kill(parent.pid, 'SIGSTOP');
            // The shell's own zombie remains a child of stopped Node until Node
            // resumes/reaps it. The writer must already be gone independently.
            await until(() => !alive(fixture.pid), `shell independently enforces ${mode} while Node is stopped`);
            const bytes = fs.existsSync(status) ? fs.readFileSync(status, 'utf8') : '';
            await wait(100);
            assert.equal(fs.existsSync(status) ? fs.readFileSync(status, 'utf8') : '', bytes, 'open-file writes stopped');
            process.kill(parent.pid, 'SIGCONT');
            await parentExit;
            if (isSize) assert.match(fs.readFileSync(join(base, 'warning'), 'utf8'), /64 MiB.*poll/i, 'the size bound, not the later deadline, enforced termination');
            await until(() => !alive(-group), 'entire group exited and was reaped');
            return;
        }
        if (mode === 'takeover' || mode === 'mismatch') process.kill(-group, 'SIGSTOP');
        parent.kill('SIGKILL'); await parentExit;
        if (mode === 'orphan') {
            await until(() => !alive(-group), 'supervisor stops Git after owner death without a new refresher');
            assert.equal(alive(fixture.pid), false);
        }
        assert.equal(owner.groups?.length, 1, 'group is recorded before Git starts');
        assert.equal(owner.groups[0].staging, fixture.dir);
        assert.ok(owner.groups[0].startIdentity, 'portable process start identity is recorded');
        if (mode === 'mismatch') {
            // Model reuse with an actual unrelated process and the former
            // occupant's start identity; never rely on provoking kernel PID reuse.
            unrelated = spawn('/bin/sleep', ['20'], { detached: true, stdio: 'ignore' });
            unrelatedExit = once(unrelated, 'exit');
            owner.groups[0].pgid = unrelated.pid;
            owner.groups[0].startIdentity = 'Thu Jan  1 00:00:00 1970';
            fs.writeFileSync(join(lockDir, ownerFile), JSON.stringify(owner));
            await assert.rejects(cache.refreshExternalAddons([], { cacheDir, lockTimeoutMs: 500 }), /identity.*mismatch|cannot verify/i);
            assert.equal(alive(unrelated.pid), true, 'unrelated/reused group must not be killed');
            assert.equal(fs.existsSync(fixture.dir), true, 'unverifiable staging is retained');
            assert.equal(fs.existsSync(lockDir), true, 'unverifiable group record is retained');
            return;
        }
        fs.rmSync = (path, ...args) => {
            if (String(path) === fixture.dir) assert.equal(alive(-group), false, 'group exited BEFORE staging removal');
            return originalRm(path, ...args);
        };
        syncBuiltinESMExports();
        await cache.refreshExternalAddons([], { cacheDir });
        assert.equal(fs.existsSync(fixture.dir), false);
        assert.equal(cache.treeBytes(cacheDir), 0);
        const bytes = fs.existsSync(status) ? fs.readFileSync(status, 'utf8') : '';
        await wait(300);
        assert.equal(fs.existsSync(status) ? fs.readFileSync(status, 'utf8') : '', bytes, 'unlinked bytes cannot keep growing');
        assert.equal(alive(-group), false);
    } finally {
        fs.rmSync = originalRm; syncBuiltinESMExports();
        if (parent && parent.exitCode === null && parent.signalCode === null) { parent.kill('SIGKILL'); await parentExit; }
        if (group && alive(-group)) process.kill(-group, 'SIGKILL');
        if (unrelated) { if (alive(unrelated.pid)) unrelated.kill('SIGKILL'); await unrelatedExit; }
        if (fixture) await until(() => !alive(fixture.pid), 'fixture was reaped');
    }
}

for (const [mode, title] of [
    ['orphan', 'owner death independently stops Git and open-file growth before later takeover'],
    ['takeover', 'stale takeover kills and waits for a verified live group before deleting staging'],
    ['mismatch', 'reused group PID identity is refused without killing or deleting staging'],
    ['deadline', 'shell deadline holds while the Node owner is stopped'],
    ['size', 'shell aggregate bound counts .git while the Node owner is stopped'],
]) test(title, async () => {
    const base = fs.mkdtempSync(join(root, `${mode}-`)), runner = join(base, 'scenario.mjs');
    fs.writeFileSync(runner, `await (${scenario.toString()})(${JSON.stringify(mode)},${JSON.stringify(cacheURL)},${JSON.stringify(base)});`);
    const child = spawn('python3', [reaper, process.execPath, runner], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', b => { stderr += b; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
});

async function manyFilesScenario(mode, cacheURL, base) {
    const assert = (await import('node:assert/strict')).default;
    const fs = (await import('node:fs')).default;
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code !== 'ESRCH') throw e; return false; } };
    async function until(predicate, message) {
        // Generous tick-scale bound; no exact scheduling or elapsed-time assertion.
        for (let i = 0; i < 150; i++) { if (predicate()) return; await wait(10); }
        assert.fail(message);
    }
    const tree = join(base, 'tree'), bin = join(base, 'bin'), ready = join(base, 'ready');
    const status = join(base, 'status'), scanning = join(base, 'scanning'), groupFile = join(base, 'group');
    fs.mkdirSync(tree); fs.mkdirSync(bin);
    const count = mode === 'entries' ? 20001 : 15000;
    for (let i = 0; i < count; i++) fs.writeFileSync(join(tree, `file-${i}`), 'x');
    if (mode !== 'entries') {
        const du = fs.existsSync('/usr/bin/du') ? '/usr/bin/du' : '/bin/du';
        fs.writeFileSync(join(bin, 'du'), `#!${process.execPath}
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(scanning)},String(process.pid));
// Make a real scan deliberately slow, so owner/deadline expiry occurs inside it.
setTimeout(()=>{require('node:child_process').spawnSync(${JSON.stringify(du)},process.argv.slice(2),{stdio:'inherit'});},5000);
`, { mode: 0o755 });
    }
    fs.writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs=require('node:fs'),{spawn}=require('node:child_process');
const fds=['A','B'].map(name=>fs.openSync(${JSON.stringify(tree)}+'/'+name,'w'));
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,descendant.pid]));
const buf=Buffer.alloc(1024*1024,1);
setInterval(()=>{for(const fd of fds)if(fs.fstatSync(fd).size<48*1024**2)fs.writeSync(fd,buf);
fs.writeFileSync(${JSON.stringify(status)},JSON.stringify(fds.map(fd=>fs.fstatSync(fd).size)));},10);
`, { mode: 0o755 });
    const runner = join(base, 'run.mjs');
    fs.writeFileSync(runner, `import fs from 'node:fs';import {runGit} from ${JSON.stringify(cacheURL)};
try { await runGit(['clone'],{treeDir:${JSON.stringify(tree)},timeoutMs:${mode === 'scan-deadline' ? 600 : 10000},
maxBytes:256*1024**2,recordGroup:g=>fs.writeFileSync(${JSON.stringify(groupFile)},JSON.stringify(g))});
throw Error('writer unexpectedly completed'); } catch(e) { fs.writeFileSync(${JSON.stringify(join(base, 'error'))},e.message); }
`);
    let parent, exited, group, pids = [], scanner;
    try {
        parent = spawn(process.execPath, [runner], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });
        exited = once(parent, 'exit');
        await until(() => fs.existsSync(ready), 'many-file writer started');
        pids = JSON.parse(fs.readFileSync(ready, 'utf8'));
        group = JSON.parse(fs.readFileSync(groupFile, 'utf8')).pgid;
        // Disable Node enforcement. The scenario controller remains live.
        process.kill(parent.pid, 'SIGSTOP');
        if (mode !== 'entries') {
            await until(() => fs.existsSync(scanning), 'background du scan started');
            scanner = Number(fs.readFileSync(scanning, 'utf8'));
            assert.ok(alive(scanner), 'expiry is triggered while the scan is still running');
        }
        if (mode === 'scan-owner') { parent.kill('SIGKILL'); await exited; }
        await until(() => pids.every(pid => !alive(pid)) && (!scanner || !alive(scanner)), 'shell stops writer, descendant and scan within a generous tick-scale bound');
        const bytes = fs.readFileSync(status, 'utf8');
        await wait(100);
        assert.equal(fs.readFileSync(status, 'utf8'), bytes, 'writer stopped changing both open files');
        if (mode !== 'scan-owner') { process.kill(parent.pid, 'SIGCONT'); await exited; }
        await until(() => !alive(-group), 'entire group is gone');
        if (mode === 'entries') assert.match(fs.readFileSync(join(base, 'error'), 'utf8'), /20,000 entries/);
    } finally {
        if (parent && parent.exitCode === null && parent.signalCode === null) { parent.kill('SIGKILL'); await exited; }
        if (group && alive(-group)) process.kill(-group, 'SIGKILL');
        await until(() => pids.every(pid => !alive(pid)), 'fixture descendants were reaped');
    }
}
for (const mode of ['scan-owner', 'scan-deadline', 'entries']) test(
    mode === 'entries' ? 'shell rejects 20,001 staging files independently of Node' : `15,000 one-byte files: ${mode} stops the group during a slow size scan`, async () => {
        const base = fs.mkdtempSync(join(root, `${mode}-`)), runner = join(base, 'scenario.mjs');
        fs.writeFileSync(runner, `await (${manyFilesScenario.toString()})(${JSON.stringify(mode)},${JSON.stringify(cacheURL)},${JSON.stringify(base)});`);
        const child = spawn('python3', [reaper, process.execPath, runner], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', b => { stderr += b; });
        const [code] = await once(child, 'close');
        assert.equal(code, 0, stderr);
    });
