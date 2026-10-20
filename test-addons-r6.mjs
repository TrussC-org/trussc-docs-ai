// Offline R6 regressions. Actual shell enforcement runs under a fixture reaper.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = fs.mkdtempSync(join(tmpdir(), 'docs-addons-r6-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const cacheURL = new URL('./addon-cache.mjs', import.meta.url).href;
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
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code !== 'ESRCH') throw e; return false; } };
    async function until(check, message) {
        for (let i = 0; i < 300; i++) { if (check()) return; await wait(10); }
        assert.fail(message);
    }
    const tree = join(base, 'tree'), bin = join(base, 'bin'), ready = join(base, 'ready');
    const groupFile = join(base, 'group'), output = join(base, 'output'), attempts = join(base, 'attempts');
    fs.mkdirSync(tree); fs.mkdirSync(bin);
    if (mode === 'newline') for (let i = 0; i < 101; i++) fs.writeFileSync(join(tree, `f${i}` + '\n'.repeat(200) + '.h'), 'x');
    if (mode === 'entries' || mode === 'churn') for (let i = 0; i < (mode === 'entries' ? 20001 : 15000); i++) fs.writeFileSync(join(tree, `f${i}`), '');
    let git = 'setTimeout(()=>{},300);';
    if (mode === 'full') git = `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
setTimeout(()=>require('node:child_process').spawn('python3',['-c','import os\\nwhile True: os.write(2,b"x")'],{stdio:['ignore','ignore','inherit']}),100);
setInterval(()=>fs.appendFileSync(${JSON.stringify(join(tree, 'growth'))},'x'),20);`;
    if (mode === 'churn') git = `const fs=require('node:fs'),tree=${JSON.stringify(tree)};const end=Date.now()+2000;
while(Date.now()<end)for(let i=0;i<15000;i++){fs.unlinkSync(tree+'/f'+i);fs.writeFileSync(tree+'/f'+i,'');}`;
    if (['partial', 'retry', 'never'].includes(mode)) {
        git = 'setTimeout(()=>{},1800);';
        fs.writeFileSync(join(bin, 'du'), `#!/bin/sh
printf x >> ${JSON.stringify(attempts)}
${mode === 'partial' ? "printf '1 total\\n'; echo vanished >&2; exit 1" : mode === 'retry' ? `n=$(wc -c < ${JSON.stringify(attempts)}); if [ "$n" -le 2 ]; then exit 1; fi; printf '1 total\\n'` : 'echo cannot-measure >&2; exit 1'}
`, { mode: 0o755 });
    }
    fs.writeFileSync(join(bin, 'git'), `#!${process.execPath}\n${git}\n`, { mode: 0o755 });
    const runner = join(base, 'run.mjs');
    fs.writeFileSync(runner, `import fs from 'node:fs'; import {runGit} from ${JSON.stringify(cacheURL)};
try {await runGit(['clone'],{treeDir:${JSON.stringify(tree)},timeoutMs:${mode === 'full' ? 600 : 8000},recordGroup:g=>fs.writeFileSync(${JSON.stringify(groupFile)},JSON.stringify(g))});fs.writeFileSync(${JSON.stringify(output)},'ok');}
catch(e){fs.writeFileSync(${JSON.stringify(output)},e.message);}`);
    let parent, exited, group, writer;
    try {
        parent = spawn(process.execPath, [runner], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });
        exited = once(parent, 'exit');
        await until(() => fs.existsSync(groupFile), 'supervisor identity recorded');
        group = JSON.parse(fs.readFileSync(groupFile, 'utf8')).pgid;
        if (mode === 'full') {
            await until(() => fs.existsSync(ready), 'fixture writer ready');
            writer = Number(fs.readFileSync(ready, 'utf8'));
            process.kill(parent.pid, 'SIGSTOP');
            // The writer keeps running separately from the blocked stderr filler.
            await until(() => !alive(writer), 'deadline kills writer while owner is stopped and stderr is full');
            const size = fs.statSync(join(tree, 'growth')).size;
            await wait(100);
            assert.equal(fs.statSync(join(tree, 'growth')).size, size);
            process.kill(parent.pid, 'SIGCONT');
        }
        await exited;
        await until(() => !alive(-group), 'entire group exited and was reaped');
        const result = fs.readFileSync(output, 'utf8');
        if (mode === 'entries') assert.match(result, /20,000 entries/);
        else if (mode === 'never') {
            assert.match(result, /cannot measure Git staging size/);
            assert.equal(fs.readFileSync(attempts, 'utf8').length, 5, 'five distinct failed scans, not five readings of one result');
        } else if (mode === 'full') assert.match(result, /timeout/);
        else assert.equal(result, 'ok');
        if (mode === 'retry') assert.ok(fs.readFileSync(attempts, 'utf8').length > 2);
    } finally {
        if (parent && parent.exitCode === null && parent.signalCode === null) { parent.kill('SIGKILL'); await exited; }
        if (group && alive(-group)) process.kill(-group, 'SIGKILL');
        if (writer) await until(() => !alive(writer), 'fixture writer reaped');
    }
}
for (const [mode, title] of [
    ['full', 'full stderr cannot block deadline enforcement while Node is stopped'],
    ['newline', '101 newline-laden filenames remain below the entry limit'],
    ['entries', '20,001 plain entries still fail'],
    ['churn', 'actual du tolerates files deleted and recreated during scans'],
    ['partial', 'nonzero du with a numeric total remains a valid measurement'],
    ['retry', 'transient scans without a total are retried'],
    ['never', 'five consecutive scans without a total fail closed'],
]) test(title, async () => {
    const base = fs.mkdtempSync(join(root, `${mode}-`)), runner = join(base, 'scenario.mjs');
    fs.writeFileSync(runner, `await (${scenario.toString()})(${JSON.stringify(mode)},${JSON.stringify(cacheURL)},${JSON.stringify(base)});`);
    const child = spawn('python3', [reaper, process.execPath, runner], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', b => { stderr += b; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
});
