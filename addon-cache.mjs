// Build-time only. No runtime module imports this file or accesses this cache.
import { existsSync, lstatSync, readdirSync, renameSync, mkdirSync, rmSync, realpathSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join, dirname, basename, sep } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export const CACHE_DIR = process.env.ADDON_CACHE_DIR || join(homedir(), '.cache/trussc-docs-ai/addons');
// Bound (security): consider at most 256 registry entries, first name/cache URL
// wins; at most 64 admitted external entries/run and 120 s for all Git steps.
// Every Git child inherits a hard 64 MiB per-file RLIMIT_FSIZE. Per-addon total
// logical bytes INCLUDING .git are polled by Node; a shell supervisor checks
// allocated bytes in a separate scan job even without Node. Owner/deadline
// enforcement takes at most one 0.2 s tick; size overshoot is one scan cycle
// of writes (not a filesystem quota). Reserve 64 MiB of the 512 MiB
// whole-cache budget before starting. Overflow kills the process group, deletes
// this run's staging and warns; insufficient remaining budget stops downloads.
// Refreshes and readers share a cache lock. Reclaim abandoned staging under it
// before accounting, after verifying/killing recorded Git groups and waiting for
// exit. Unverifiable groups retain their lock/staging and fail closed.
export const LIMITS = Object.freeze({ count: 64, timeoutMs: 120_000, checkoutBytes: 64 * 1024 ** 2, cacheBytes: 512 * 1024 ** 2 });
// Non-cone patterns: keep the requested example directory scope, then narrow it
// to exactly what chunkAddonExamples reads: immediate src/*.{cpp,h,glsl}, no main.cpp.
export const SPARSE_PATHS = ['/README.md', '/example*/', '!/example*/*', '/example-*/src/', '!/example-*/src/*',
    '/example-*/src/*.cpp', '/example-*/src/*.h', '/example-*/src/*.glsl', '!/example-*/src/main.cpp'];
const warnDefault = s => console.warn(`Warning: ${s}`);

// Match the original string, before URL normalization can hide credentials, dot
// segments, escaped slashes, extra paths, a port, query, fragment or whitespace.
export function githubRepo(url) {
    if (typeof url !== 'string') return null;
    const m = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
    if (!m || m[2] === '.' || m[2] === '..' || m[2].endsWith('.git')) return null;
    return `https://github.com/${m[1]}/${m[2]}`;
}
const safeName = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
export function cachePath(addon, root = CACHE_DIR) {
    const url = githubRepo(addon.url);
    return url ? join(root, createHash('sha256').update(url).digest('hex')) : null;
}

export const MAX_REGISTRY_ENTRIES = 256;
export function admitRegistryAddons(entries, warn = warnDefault) {
    const addons = [], names = new Set(), paths = new Set();
    if (entries.length > MAX_REGISTRY_ENTRIES) warn('registry exceeds 256 entries; overflow ignored');
    for (let i = 0; i < Math.min(entries.length, MAX_REGISTRY_ENTRIES); i++) {
        const a = entries[i];
        if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.name !== 'string' ||
            typeof a.url !== 'string' || typeof a.bundled !== 'boolean') {
            warn(`dropping malformed registry entry ${i}`); continue;
        }
        const name = a.name.toLowerCase(), path = cachePath(a, '/');
        if (names.has(name) || (path && paths.has(path))) {
            warn(`dropping duplicate registry entry ${i} (${a.name}): name or cache URL already admitted`); continue;
        }
        names.add(name);
        if (path) paths.add(path);
        addons.push(a);
    }
    return addons;
}

// Do not follow symlinks when measuring, or when reading downloaded content.
export function treeBytes(path, { limit = Infinity } = {}) {
    let size = 0;
    function visit(p) {
        let st;
        try { st = lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
        if (st.isSymbolicLink()) throw Object.assign(new Error(`symlink in addon cache: ${p}`), { code: 'CACHE_SYMLINK' });
        if (!st.isDirectory()) { size += st.size; return; }
        let names;
        try { names = readdirSync(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
        for (const name of names) {
            visit(join(p, name));
            if (size > limit) break;
        }
    }
    visit(path);
    return size;
}
export function regularPath(root, ...parts) {
    let path = root;
    try {
        if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return null;
        for (const part of parts) {
            path = join(path, part);
            if (lstatSync(path).isSymbolicLink()) return null;
        }
        return path;
    } catch { return null; }
}

function outsideWorktree(root) {
    // Resolve existing ancestors too, so an override through a symlink cannot put
    // a cache inside this checkout. Neither the service config nor HOME is changed.
    const here = dirname(fileURLToPath(import.meta.url));
    function physical(p) {
        if (existsSync(p)) return realpathSync(p);
        return join(physical(dirname(p)), basename(p));
    }
    const path = physical(resolve(root)), worktree = realpathSync(here);
    if (path === worktree || path.startsWith(worktree + sep)) throw new Error('ADDON_CACHE_DIR must be outside the worktree');
    return path;
}

// Check the requested root before resolving it: resolving first would hide a
// symlink. Existing ancestors may resolve, but the root itself must be owned and
// real. Readers create a missing root too, so they coordinate with a first refresh.
function checkedRoot(root, create = false) {
    const requested = resolve(root);
    const check = path => {
        let st;
        try { st = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
        if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid())
            throw new Error('addon cache root must be a real directory owned by the current user');
    };
    check(requested);
    const path = outsideWorktree(requested);
    if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
    check(path);
    return path;
}

// Bound (security): wait at most ten minutes, then fail clearly. Never infer
// staleness from age: only a dead PID on this hostname permits takeover. PID reuse
// and locks from other hosts conservatively wait/timeout. No flock or /proc needed.
export const CACHE_LOCK_TIMEOUT_MS = 600_000;
const activeLocks = new WeakSet();
function removeOwner(lockDir, ownerFile) {
    try { unlinkSync(join(lockDir, ownerFile)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Never recursively delete .lock: a successor may already own it. Its unique
    // owner filename cannot be unlinked above, and its nonempty dir cannot rmdir.
    try { rmdirSync(lockDir); } catch (e) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e;
    }
}
async function reapDeadLock(lockDir) {
    try {
        const st = lstatSync(lockDir);
        if (!st.isDirectory() || st.isSymbolicLink()) return;
        const files = readdirSync(lockDir);
        if (files.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(files[0])) return;
        const owner = JSON.parse(readFileSync(join(lockDir, files[0]), 'utf8'));
        if (owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
            !Number.isFinite(owner.startedAt) || files[0] !== `owner-${owner.token}.json`) return;
        try { process.kill(owner.pid, 0); }
        catch (e) {
            if (e.code === 'ESRCH') {
                await stopRecordedGroups(owner.groups === undefined ? [] : owner.groups, dirname(lockDir));
                removeOwner(lockDir, files[0]);
            }
            else if (e.code !== 'EPERM') throw e;
        }
    } catch (e) {
        if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
}
export async function withCacheLock({ cacheDir = CACHE_DIR, lockTimeoutMs = CACHE_LOCK_TIMEOUT_MS, retryMs = 100 } = {}, task) {
    const root = checkedRoot(cacheDir, true), lockDir = join(root, '.lock'), start = Date.now();
    const token = randomUUID(), ownerFile = `owner-${token}.json`;
    while (true) {
        // Prepare a NONEMPTY directory before the atomic rename. A competing
        // rename cannot replace a held lock, including during owner-file setup.
        const candidate = mkdtempSync(join(root, '.lock-wait-'));
        let acquired = false;
        try {
            writeFileSync(join(candidate, ownerFile), JSON.stringify({ pid: process.pid, startedAt: start, hostname: hostname(), token }), { flag: 'wx' });
            try { renameSync(candidate, lockDir); acquired = true; }
            catch (e) { if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
        } finally { rmSync(candidate, { recursive: true, force: true }); }
        if (acquired) break;
        await reapDeadLock(lockDir);
        const remaining = lockTimeoutMs - (Date.now() - start);
        if (remaining <= 0) throw new Error(`timed out waiting for addon cache lock (${lockTimeoutMs} ms): ${lockDir}`);
        await new Promise(r => setTimeout(r, Math.min(retryMs, remaining)));
    }
    const ownerPath = join(lockDir, ownerFile);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    owner.groups = [];
    const persist = () => {
        // Atomic owner-file replacement; a crash cannot leave half-written JSON.
        const temporary = mkdtempSync(join(root, '.lock-wait-'));
        try {
            const path = join(temporary, ownerFile);
            writeFileSync(path, JSON.stringify(owner), { flag: 'wx' });
            renameSync(path, ownerPath);
        } finally { rmSync(temporary, { recursive: true, force: true }); }
    };
    const lock = { root, recordGroup: group => { owner.groups.push(group); persist(); } };
    lock.stopGroups = async () => {
        await stopRecordedGroups(owner.groups, root);
        owner.groups.length = 0;
        persist();
    };
    activeLocks.add(lock);
    try {
        // Recover interruption between the two publication renames before any
        // reader can observe the gap. A published entry wins over its backup.
        for (const name of readdirSync(root)) {
            const match = /^\.backup-([a-f0-9]{64})-[a-f0-9-]+$/.exec(name);
            if (!match) continue;
            const dir = join(root, match[1]), backup = join(root, name);
            if (existsSync(dir)) rmSync(backup, { recursive: true, force: true });
            else renameSync(backup, dir);
        }
        return await task(lock);
    }
    finally {
        activeLocks.delete(lock);
        // Retain metadata and staging if verification/termination fails.
        await lock.stopGroups();
        removeOwner(lockDir, ownerFile);
    }
}

// No cached Git metadata is ever passed to Git. Remove entries containing any
// symlink before accounting/admission, including symlinks inside .git.
function cacheBytes(root, warn) {
    let total = 0;
    if (!existsSync(root)) return total;
    for (const name of readdirSync(root)) {
        // Coordination metadata is not addon content. Do count .addon-* until
        // refresh has physically removed abandoned staging, and count backups.
        if (name === '.lock' || name.startsWith('.lock-wait-')) continue;
        const entry = join(root, name);
        try { total += treeBytes(entry); }
        catch (e) {
            if (e.code !== 'CACHE_SYMLINK') throw e;
            rmSync(entry, { recursive: true, force: true });
            warn(`discarding cache entry ${name}: ${e.message}`);
        }
    }
    return total;
}
function gitEnv() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false' };
}
function killGroup(pid) {
    if (!pid) return;
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
function groupAlive(pgid) {
    try { process.kill(-pgid, 0); return true; }
    catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
// ps is available on Linux/macOS; neither /proc nor platform-specific start ticks
// are needed. Include PGID so only the recorded group leader can match.
function groupIdentity(pgid) {
    return new Promise((resolveIdentity, reject) => {
        const child = spawn('ps', ['-o', 'pgid=', '-o', 'lstart=', '-p', String(pgid)],
            { env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 1000 });
        let output = '';
        child.stdout.on('data', b => { output += b; });
        child.on('error', reject);
        child.on('close', code => {
            const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(output);
            resolveIdentity(code === 0 && Number(match?.[1]) === pgid ? match[2] : null);
        });
    });
}
async function stopRecordedGroups(groups, root) {
    if (!Array.isArray(groups)) throw new Error('cannot verify addon Git group records; retaining lock and staging');
    for (const group of groups) {
        const { pgid, startIdentity, staging } = group || {};
        const refuse = reason => new Error(`cannot verify/stop addon Git group ${pgid}: ${reason}; retaining lock and staging`);
        if (!Number.isSafeInteger(pgid) || pgid <= 1 || typeof startIdentity !== 'string' || !startIdentity ||
            typeof staging !== 'string' || dirname(staging) !== root || !basename(staging).startsWith('.addon-'))
            throw refuse('invalid identity or staging record');
        const alive = () => {
            try { return groupAlive(pgid); } catch (e) { throw refuse(e.message); }
        };
        if (!alive()) continue;
        let identity;
        try { identity = await groupIdentity(pgid); } catch (e) { throw refuse(e.message); }
        if (!alive()) continue;
        if (identity !== startIdentity) throw refuse('start identity mismatch or unavailable');
        try { killGroup(pgid); } catch (e) { throw refuse(e.message); }
        // Bound (security): do not unlink writable staging until the entire group
        // has exited. Zombies also keep the group live; never assume they exited.
        const deadline = Date.now() + 2000;
        while (alive()) {
            if (Date.now() >= deadline) throw refuse('group did not exit within 2 s');
            await new Promise(r => setTimeout(r, 20));
        }
    }
}

const GIT_SUPERVISOR = `
# Keep Git's diagnostics on the inherited pipe, but never send supervisor output
# there: a stopped owner may leave that pipe full. Enforcement uses a small
# regular status file, so diagnostic delivery cannot block the group kill.
status=$6
exec 3>&2
exec >"$status" 2>&1
ulimit -c 0
ulimit -f "$1" || exit
owner=$2; duration=$3; tree=$4; limit=$5
shift 6
die() {
    printf '%s\\n' "$*" >&2
    kill -KILL 0
    exit 1
}
# Scan outside the enforcement loop. Publish one small, atomic result; all scan
# processes inherit this group and are killed along with Git on a violation.
measurement=\${status%/*}
scan() {
    (
        # Bound (security): at most 20,000 staging entries, including .git.
        # Stop counting at 20,001; sparse README/example checkouts need fewer.
        entries=$(find "$tree" ! -path "$tree" -exec printf '%.0sx' {} + | head -c 20001 | wc -c) || exit 1
        usage=0
        if [ "$entries" -le 20000 ]; then
            du -sk "$tree" > "$measurement/du" 2>/dev/null || :
            read -r blocks rest < "$measurement/du" || exit 1
            case "$blocks" in ''|*[!0-9]*) exit 1;; esac
            usage=$((blocks * 1024))
        fi
        printf '%s %s\\n' "$usage" "$entries"
    ) > "$measurement/new"
    if [ "$?" -ne 0 ]; then echo invalid > "$measurement/new"; fi
    mv -f "$measurement/new" "$measurement/result"
}
# Node records our identity before releasing this barrier. EOF after owner death
# kills the group even if Node died between spawn and recording the identity.
read -r ready || die
[ "$ready" = go ] || die
sleep "$duration" & clock=$!
git "$@" >/dev/null 2>&3 3>&- & worker=$!
scanner=; finalScan=; failedScans=0
while :; do
    kill -0 "$owner" 2>/dev/null || die 'Git refresh owner exited'
    kill -0 "$clock" 2>/dev/null || die '120 s clone/update timeout'
    if [ -n "$tree" ]; then
        if [ -n "$scanner" ] && ! kill -0 "$scanner" 2>/dev/null; then
            wait "$scanner"
            scanner=
        fi
        if [ -f "$measurement/result" ]; then
            read -r usage entries < "$measurement/result"
            # Consume each published result exactly once. A vanished Git temp
            # file may make du fail; only five consecutive unmeasurable scans
            # fail closed. A failed final scan must also be retried.
            rm -f "$measurement/result"
            case "$usage:$entries" in
                *[!0-9:]*|:*|*:)
                    failedScans=$((failedScans + 1)); finalScan=
                    [ "$failedScans" -lt 5 ] || die 'cannot measure Git staging size'
                    ;;
                *)
                    failedScans=0
                    [ "$entries" -le 20000 ] || die 'addon staging exceeds 20,000 entries'
                    [ "$usage" -le "$limit" ] || die 'addon total exceeds 64 MiB (including .git; scan-cycle polling)'
                    ;;
            esac
        fi
    fi
    if ! kill -0 "$worker" 2>/dev/null; then
        # Start a final scan after Git exits, then drain it without suspending
        # owner/deadline enforcement. Fast commands must not evade entry limits.
        if [ -n "$tree" ] && [ -z "$finalScan" ]; then
            if [ -z "$scanner" ]; then scan & scanner=$!; finalScan=yes; fi
        else
            [ -n "$scanner" ] || break
        fi
    elif [ -n "$tree" ] && [ -z "$scanner" ]; then
        scan & scanner=$!
    fi
    sleep 0.2
done
wait "$worker"; result=$?
kill "$clock" 2>/dev/null
wait "$clock" 2>/dev/null
exit "$result"
`;
export function runGit(args, { cwd, timeoutMs = LIMITS.timeoutMs, allowFile = false,
    treeDir, maxBytes = LIMITS.checkoutBytes, recordGroup } = {}) {
    if (timeoutMs <= 0) return Promise.reject(new Error('120 s clone/update timeout'));
    return new Promise((resolveRun, reject) => {
        const gitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
            '-c', 'core.askPass=/bin/false', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never',
            '-c', 'protocol.https.allow=always', '-c', `protocol.file.allow=${allowFile ? 'always' : 'never'}`, ...args];
        // Exclusive control creation also refuses stale measurement results.
        const control = treeDir ? treeDir + '.usage' : mkdtempSync(join(tmpdir(), 'addon-git-'));
        if (treeDir) mkdirSync(control);
        const status = join(control, 'status');
        writeFileSync(status, '', { flag: 'wx', mode: 0o600 });
        // POSIX sh supervises this new group independently of Node. Git and all
        // transports inherit its 512-byte-block per-file limit on Linux/macOS.
        const child = spawn('/bin/sh', ['-c', GIT_SUPERVISOR, 'git-supervised',
            String(Math.floor(LIMITS.checkoutBytes / 512)), String(process.pid), String(timeoutMs / 1000),
            treeDir || '', String(maxBytes), status, ...gitArgs],
            { cwd, env: gitEnv(), detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '', settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer); clearInterval(poll);
            if (error) {
                killGroup(child.pid);
                // Reject at the deadline, even if descendants retained a pipe.
                child.stderr.destroy();
                reject(error);
            } else resolveRun();
        };
        const measure = () => {
            if (!treeDir) return;
            try {
                if (treeBytes(treeDir, { limit: maxBytes }) > maxBytes)
                    throw new Error('addon total exceeds 64 MiB (including .git; 200 ms polling)');
            } catch (e) { finish(e); }
        };
        child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-4000); });
        const timer = setTimeout(() => finish(new Error('120 s clone/update timeout')), timeoutMs);
        const poll = setInterval(measure, 200);
        child.stdin.on('error', finish);
        // Do not start Git until its group identity and staging path are durable.
        groupIdentity(child.pid).then(startIdentity => {
            if (settled) return;
            if (!startIdentity) throw new Error('cannot verify Git supervisor start identity');
            if (recordGroup) recordGroup({ pgid: child.pid, startIdentity, staging: treeDir });
            child.stdin.end('go\n');
        }).catch(finish);
        child.on('error', finish);
        child.on('close', (code, signal) => {
            let reason = '';
            try { reason = readFileSync(status, 'utf8').trim(); }
            catch (e) { if (e.code !== 'ENOENT') reason = `cannot read Git status: ${e.message}`; }
            finally { rmSync(control, { recursive: true, force: true }); }
            if (settled) return;
            if (code !== 0) finish(Object.assign(new Error(`git ${args[0]} failed (${signal || code}): ${reason || stderr.trim()}`), { signal }));
            else { measure(); if (!settled) finish(); }
        });
    });
}

function rewriteURL(url, rewrites) {
    const mapped = rewrites[url] || rewrites[url + '.git'];
    if (!mapped) return { url, allowFile: false };
    const local = new URL(mapped);
    if (local.protocol !== 'file:' || local.host || local.username || local.password || local.search || local.hash)
        throw new Error('ADDON_URL_REWRITES values must be local file:// URLs');
    return { url: local.href, allowFile: true };
}
export async function refreshExternalAddons(addons, options = {}) {
    const { cacheDir = CACHE_DIR, lock } = options;
    if (!lock) return withCacheLock(options, held => refreshExternalAddons(addons, { ...options, lock: held }));
    if (!activeLocks.has(lock) || checkedRoot(cacheDir) !== lock.root) throw new Error('refresh requires its active addon cache lock');
    const { rewrites = {}, limits = LIMITS, warn = warnDefault, git = runGit } = options;
    const root = lock.root;
    // No other refresh can own staging while we hold the lock. Remove every
    // abandoned download BEFORE measuring remaining budget; never just ignore it.
    for (const name of readdirSync(root)) {
        if (name.startsWith('.addon-')) rmSync(join(root, name), { recursive: true, force: true });
    }
    let count = 0;
    cacheBytes(root, warn);
    for (const addon of admitRegistryAddons(addons, warn)) {
        if (addon.bundled !== false) continue;
        if (++count > limits.count) { warn(`external addon count exceeds ${limits.count}; skipping further addons`); break; }
        const url = githubRepo(addon.url);
        if (!url || !safeName(addon.name)) { warn(`skipping addon ${JSON.stringify(addon.name)}: unsafe name or non-GitHub/odd repository URL`); continue; }
        const dir = cachePath(addon, root);
        const bytes = cacheBytes(root, warn);
        if (limits.cacheBytes - bytes < limits.checkoutBytes) {
            warn('addon cache has insufficient remaining budget for 64 MiB (512 MiB total); skipping further addons'); break;
        }
        const start = Date.now();
        let staging;
        try {
            const target = rewriteURL(url, rewrites);
            staging = mkdtempSync(join(root, '.addon-'));
            const run = args => git(args, { cwd: root, timeoutMs: limits.timeoutMs - (Date.now() - start),
                allowFile: target.allowFile, treeDir: staging, maxBytes: limits.checkoutBytes, recordGroup: lock.recordGroup });
            const tag = addon.latest_tag || '';
            if (typeof tag !== 'string' || (tag && (tag.startsWith('-') || /[\s~^:?*\[\\]|\.\.|@\{|\/\//.test(tag)))) throw new Error('invalid latest_tag');
            if (tag) await run(['check-ref-format', `refs/tags/${tag}`]);
            // Fresh and refreshed caches take exactly the same path. Never pass
            // --branch: Git prefers a same-named branch over a release tag.
            await run(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--no-recurse-submodules', '--template=',
                '--', target.url, staging]);
            await run(['-C', staging, 'fetch', '--depth', '1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules',
                'origin', tag ? `refs/tags/${tag}` : 'HEAD']);
            await run(['-C', staging, 'sparse-checkout', 'set', '--no-cone', '--', ...SPARSE_PATHS]);
            await run(['-C', staging, 'checkout', '--force', '--detach', 'FETCH_HEAD']);
            await lock.stopGroups();
            if (treeBytes(staging, { limit: limits.checkoutBytes }) > limits.checkoutBytes)
                throw new Error('addon total exceeds 64 MiB (including .git)');
            if (cacheBytes(root, warn) > limits.cacheBytes) throw new Error('addon cache exceeds 512 MiB');
            // Readers hold the same lock through ingestion, so the gap between
            // renames is invisible. Keep the old complete clone for rollback.
            const backup = join(root, `.backup-${basename(dir)}-${randomUUID()}`);
            const hadOld = existsSync(dir);
            if (hadOld) renameSync(dir, backup);
            try { renameSync(staging, dir); }
            catch (e) {
                if (hadOld) renameSync(backup, dir);
                throw e;
            }
            staging = null;
            if (hadOld) rmSync(backup, { recursive: true, force: true });
        } catch (e) {
            await lock.stopGroups();
            if (staging) {
                rmSync(staging, { recursive: true, force: true });
                rmSync(staging + '.usage', { recursive: true, force: true });
            }
            warn(`skipping addon ${addon.name}: ${e.message}`);
        }
    }
}

// The builder stays offline. Apply the same admission bounds to old caches too,
// including entries left over from older registries. Bundled directories win.
// Callers must hold withCacheLock through admission AND all content reads.
export function addonDirectories(addons, bundledDir, { cacheDir = CACHE_DIR, limits = LIMITS, warn = warnDefault } = {}) {
    const dirs = new Map();
    let root, cacheOK = false, count = 0;
    try {
        root = checkedRoot(cacheDir);
        cacheOK = cacheBytes(root, warn) <= limits.cacheBytes;
        if (!cacheOK) warn('addon cache exceeds 512 MiB; skipping cached external addons');
    } catch (e) { warn(e.message); }
    for (const addon of admitRegistryAddons(addons, warn)) {
        if (addon.bundled === false) {
            if (++count > limits.count) {
                if (count === limits.count + 1) warn(`external addon count exceeds ${limits.count}; further external content skipped`);
                continue;
            }
            if (!githubRepo(addon.url)) { warn(`non-GitHub/odd repository URL for ${addon.name}; content skipped`); continue; }
        }
        if (!safeName(addon.name)) { warn(`unsafe addon name ${JSON.stringify(addon.name)}; content skipped`); continue; }
        const bundled = regularPath(bundledDir, addon.name);
        if (bundled && lstatSync(bundled).isDirectory()) {
            dirs.set(addon.name, { dir: bundled, source: 'bundled', capped: false }); continue;
        }
        if (addon.bundled !== false || !cacheOK) continue;
        const dir = cachePath(addon, root);
        if (!regularPath(dir)) continue;
        if (treeBytes(dir, { limit: limits.checkoutBytes }) > limits.checkoutBytes) {
            warn(`addon total exceeds 64 MiB (including .git) for ${addon.name}; content skipped`); continue;
        }
        dirs.set(addon.name, { dir, source: 'external', capped: true });
    }
    return dirs;
}
