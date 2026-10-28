// Synthetic temp files only; no private stats directories or sockets.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, lstatSync, openSync, closeSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'docsai-retention-'));
const saved = { ...process.env };
try {
  Object.assign(process.env, { STATS: '1', STATS_DIR: dir, STATS_RETENTION_DAYS: '183' });
  const { pruneStats, statsFileDate } = await import('./stats.mjs');
  const config = new URL('./config.mjs', import.meta.url).href;
  function child(code, env = {}) {
    const out = openSync(join(dir, 'stdout'), 'w'), err = openSync(join(dir, 'stderr'), 'w');
    let result;
    try {
      result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, ...env }, stdio: ['ignore', out, err], timeout: 10000,
      });
    } finally { closeSync(out); closeSync(err); }
    result.stdout = readFileSync(join(dir, 'stdout'), 'utf8');
    result.stderr = readFileSync(join(dir, 'stderr'), 'utf8');
    assert.equal(result.error, undefined);
    return result;
  }
  for (const [value, expected] of [[undefined, 183], ['1', 1], ['183', 183], ['3650', 3650]]) {
    const result = child(`console.log((await import(${JSON.stringify(config)})).STATS_RETENTION_DAYS)`, { STATS_RETENTION_DAYS: value });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), expected);
  }
  for (const value of ['', ' ', '0', '-1', '3651', '1.5', '183days', 'NaN', 'Infinity', '1e2', '0x10', '1\n']) {
    const result = child(`await import(${JSON.stringify(config)})`, { STATS_RETENTION_DAYS: value });
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /STATS_RETENTION_DAYS must be an integer from 1 to 3650/);
  }
  assert.notEqual(child(`await import(${JSON.stringify(config)})`, { STATS: '0', STATS_RETENTION_DAYS: '0' }).status, 0);
  console.log('PASS retention default, inclusive bounds, invalid config fails startup');

  const archive = join(dir, 'stats'); mkdirSync(archive);
  // 2026-10-28 minus 183 UTC days is 2026-04-28, even late in the day.
  const keep = ['2026-04-28.jsonl', '2026-04-29.jsonl', '2026-10-28.jsonl', '2027-01-01.jsonl',
    '2026-04.jsonl', '2026-13.jsonl', '2026-00.jsonl', '2026-02-30.jsonl', '2025-02-29.jsonl',
    '2026-04-00.jsonl', '2026-4-01.jsonl', '2026-04-01.jsonl.bak', 'stats.jsonl', '.env', '2026-04-01.jsonl\n'];
  const remove = ['2026-04-27.jsonl', '2026-01-01.jsonl', '2026-03.jsonl', '2024-02-29.jsonl'];
  for (const name of [...keep, ...remove]) writeFileSync(join(archive, name), 'SYNTHETIC PRIVATE ROW\n');
  const outside = join(dir, 'outside'); writeFileSync(outside, 'UNCHANGED');
  symlinkSync(outside, join(archive, '2026-04-26.jsonl'));
  symlinkSync(join(dir, 'absent'), join(archive, '2026-04-25.jsonl'));
  mkdirSync(join(archive, '2026-04-24.jsonl'));
  writeFileSync(join(archive, '2026-04-24.jsonl', '2020-01-01.jsonl'), 'NESTED');
  const logs = [], log = console.log;
  console.log = line => logs.push(line);
  let result;
  try { result = await pruneStats({ dir: archive, now: () => new Date('2026-10-29T08:59:59.999+09:00') }); }
  finally { console.log = log; }
  assert.equal(result.deleted, remove.length);
  assert(Object.values(result.failures).every(n => n === 0));
  assert.equal(logs.length, 1); assert.match(logs[0], /deleted=4/);
  for (const name of remove) assert(logs[0].includes(name), 'deleted names are logged');
  for (const name of keep) assert(!logs[0].includes(name), 'kept names are not logged');
  assert(!logs[0].includes('SYNTHETIC')); assert(!logs[0].includes(dir));
  for (const name of keep) assert(readdirSync(archive).includes(name), name);
  for (const name of remove) assert(!readdirSync(archive).includes(name), name);
  assert(lstatSync(join(archive, '2026-04-26.jsonl')).isSymbolicLink());
  assert(lstatSync(join(archive, '2026-04-25.jsonl')).isSymbolicLink());
  assert.equal(readFileSync(outside, 'utf8'), 'UNCHANGED');
  assert.equal(readFileSync(join(archive, '2026-04-24.jsonl', '2020-01-01.jsonl'), 'utf8'), 'NESTED');
  // Month-end equality must keep the entire legacy month; only the prior month goes.
  const boundary = join(dir, 'boundary'); mkdirSync(boundary);
  for (const name of ['2026-03.jsonl', '2026-04.jsonl', '2026-04-29.jsonl', '2026-04-30.jsonl']) writeFileSync(join(boundary, name), '');
  result = await pruneStats({ dir: boundary, now: () => new Date('2026-10-30T00:00:00Z') });
  assert.equal(result.deleted, 2);
  assert.deepEqual(readdirSync(boundary).sort(), ['2026-04-30.jsonl', '2026-04.jsonl']);
  result = await pruneStats({ dir: boundary, now: () => new Date('2026-10-31T00:00:00Z') });
  assert.equal(result.deleted, 2);
  assert.equal(statsFileDate('0000-02-29.jsonl').day, '0000-02-29');
  assert.equal(statsFileDate('1900-02-29.jsonl'), null);
  assert(statsFileDate('2000-02-29.jsonl'));
  console.log('PASS UTC cutoff equality, legacy month ends, leap days, exact names, symlinks and directories');

  const error = () => { throw new Error('SECRET FILE CONTENT'); };
  const old = join(boundary, '2020-01-01.jsonl'); writeFileSync(old, '');
  logs.length = 0; console.log = line => logs.push(line);
  try {
    assert.equal((await pruneStats({ dir: boundary, io: { ...fs, opendir: error } })).failures.scan, 1);
    assert.equal((await pruneStats({ dir: boundary, io: { ...fs, lstat: path => path === boundary ? fs.lstat(path) : error() } })).failures.inspect, 1);
    assert.equal((await pruneStats({ dir: boundary, io: { ...fs, unlink: error } })).failures.delete, 1);
    assert.equal((await pruneStats({ dir: boundary, now: error })).failures.clock, 1);
    assert.equal((await pruneStats({ dir: boundary, now: () => NaN })).failures.clock, 1);
    assert.equal(logs.length, 5); assert(!logs.join('').includes('SECRET'));
    console.log = error;
    await assert.doesNotReject(pruneStats({ dir: boundary, io: { ...fs, opendir: error } }));
  } finally { console.log = log; }

  // Keep the old directory alive so a replacement cannot reuse its inode.
  const guarded = join(dir, 'guarded'); mkdirSync(guarded);
  let resolutions = 0, scans = 0, unlinks = 0;
  const guardedIo = { ...fs,
    realpath(path) { resolutions++; return fs.realpath(path); },
    opendir(path) { scans++; return fs.opendir(path); },
    unlink(path) { unlinks++; return fs.unlink(path); },
  };
  logs.length = 0; console.log = line => logs.push(line);
  try {
    await pruneStats({ dir: guarded, io: guardedIo });
    assert.equal(logs.length, 1); assert.match(logs[0], /deleted=0 files=\[\]/);
    renameSync(guarded, guarded + '-original');
    mkdirSync(guarded);
    writeFileSync(join(guarded, '2000-01-01.jsonl'), 'SYNTHETIC PRIVATE ROW');
    const skipped = async () => {
      logs.length = 0;
      const counts = await pruneStats({ dir: guarded, io: guardedIo });
      assert.equal(counts.deleted, 0); assert.equal(counts.failures.directory, 1);
      assert.equal(logs.length, 1); assert.match(logs[0], /skipped=directory-identity/);
      assert(!logs[0].includes('SYNTHETIC')); assert(!logs[0].includes(guarded));
      assert.equal(scans, 1); assert.equal(unlinks, 0);
    };
    await skipped(); // Different dev/ino at the recorded real path.
    assert.equal(readFileSync(join(guarded, '2000-01-01.jsonl'), 'utf8'), 'SYNTHETIC PRIVATE ROW');
    rmSync(guarded, { recursive: true });
    await skipped(); // Missing directory.
    writeFileSync(guarded, 'not a directory');
    await skipped(); // Non-directory replacement.
    rmSync(guarded);
    symlinkSync(guarded + '-original', guarded);
    await skipped(); // Even a symlink to the original directory is refused.
    assert.equal(resolutions, 1, 'realpath is resolved once across all maintenance runs');
  } finally { console.log = log; }
  console.log('PASS pinned directory skips swapped/missing/non-directory paths with one fixed log and no scan or deletion');

  const privateDir = join(dir, 'privacy'); mkdirSync(privateDir);
  const sentinel = 'SENTINEL_QUESTION_MUST_NEVER_REACH_JOURNAL_7fa209';
  writeFileSync(join(privateDir, '2000-01.jsonl'), JSON.stringify({ ts: '2000-01-01T00:00:00Z', q: sentinel, a: sentinel }) + '\n');
  const splitCli = new URL('./tools/split-stats.mjs', import.meta.url);
  const privacy = child(`
    import { fileURLToPath } from 'node:url';
    process.argv = [process.execPath, fileURLToPath(${JSON.stringify(splitCli.href)}), ${JSON.stringify(privateDir)}];
    await import(${JSON.stringify(splitCli.href)});
    const { pruneStats } = await import(${JSON.stringify(new URL('./stats.mjs', import.meta.url).href)});
    await pruneStats({ dir: ${JSON.stringify(privateDir)}, now: () => new Date('2026-10-28T00:00:00Z') });
  `);
  assert.equal(privacy.status, 0, privacy.stderr);
  assert.match(privacy.stdout, /split stats: files=1/); assert.match(privacy.stdout, /stats prune: deleted=1/);
  assert(!privacy.stdout.includes(sentinel)); assert(!privacy.stderr.includes(sentinel));
  assert.deepEqual(readdirSync(privateDir), [], 'both maintenance actions actually ran');
  console.log('PASS split and prune never print sentinel question/answer text to captured stdout/stderr (including console)');

  const disabled = child(`
    import assert from 'node:assert/strict';
    const { pruneStats, logStat } = await import(${JSON.stringify(new URL('./stats.mjs', import.meta.url).href)});
    const fail = () => { throw new Error('must not access stats'); };
    console.log = fail;
    const result = await pruneStats({ dir: '/does-not-exist', now: fail, io: new Proxy({}, { get: fail }) });
    assert.equal(result.deleted, 0); assert(Object.values(result.failures).every(n => n === 0));
    logStat({ ep: 'get' });
  `, { STATS: '0' });
  assert.equal(disabled.status, 0, disabled.stderr); assert.equal(disabled.stdout, '');
  console.log('PASS STATS=0 performs no I/O/logging; scan/inspect/delete/clock/log failures never reject');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
}
