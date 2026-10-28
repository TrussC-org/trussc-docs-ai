// Operator migration tests: synthetic rows, temp directories, no service or network.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { splitStats } from './tools/split-stats.mjs';

const dir = fs.mkdtempSync(join(tmpdir(), 'docsai-split-'));
const cli = fileURLToPath(new URL('./tools/split-stats.mjs', import.meta.url));
const row = (ts, id) => JSON.stringify({ ts, q: 'SYNTHETIC SECRET ' + id, a: 'answer', id });
const read = path => {
  const text = fs.readFileSync(path, 'utf8');
  return text ? text.replace(/\n$/, '').split('\n') : [];
};
const fixture = name => { const path = join(dir, name); fs.mkdirSync(path); return path; };
function run(path, args = [], extra = []) {
  const out = fs.openSync(join(dir, 'stdout'), 'w'), err = fs.openSync(join(dir, 'stderr'), 'w');
  let result;
  try { result = spawnSync(process.execPath, [...extra, cli, path, ...args], { stdio: ['ignore', out, err], timeout: 10000 }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  result.stdout = fs.readFileSync(join(dir, 'stdout'), 'utf8');
  result.stderr = fs.readFileSync(join(dir, 'stderr'), 'utf8');
  assert.equal(result.error, undefined);
  assert(!result.stdout.includes('SECRET')); assert(!result.stderr.includes('SECRET'));
  assert(!result.stdout.includes(path)); assert(!result.stderr.includes(path));
  return result;
}
try {
  const normal = fixture('normal with spaces');
  const source = join(normal, '2026-04.jsonl');
  const a = row('2026-04-01T23:59:59.999Z', 'a'), b = row('2026-04-02T00:00:00Z', 'b');
  const c = row('2026-04-02T09:00:00+09:00', 'c');
  fs.writeFileSync(source, [c, a, b].join('\n')); // An unterminated last line is still a row.
  let result = run(normal);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /files=1 outputs=2 lines=3 odd_rows=0/);
  assert.deepEqual(fs.readdirSync(normal).sort(), ['2026-04-01.jsonl', '2026-04-02.jsonl']);
  assert.deepEqual(read(join(normal, '2026-04-01.jsonl')), [a]);
  assert.deepEqual(read(join(normal, '2026-04-02.jsonl')), [c, b]); // Equal instants retain input order.
  for (const name of fs.readdirSync(normal)) assert.equal(fs.statSync(join(normal, name)).mode & 0o777, 0o600);
  assert.match(run(normal).stdout, /files=0 outputs=0 lines=0/);
  console.log('PASS CLI normal split, UTC boundaries, stable equal instants, unterminated source, counts and 0600');

  const merge = fixture('merge');
  const early = row('2026-04-02T00:00:00Z', 'early'), tie = row('2026-04-02T00:00:00Z', 'existing tie');
  const late = row('2026-04-02T23:59:59Z', 'late');
  const daily = join(merge, '2026-04-02.jsonl');
  fs.writeFileSync(daily, [late, tie].join('\n') + '\n', { mode: 0o644 });
  fs.writeFileSync(join(merge, '2026-04.jsonl'), early + '\n');
  result = run(merge);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(read(daily), [tie, early, late]);
  assert.equal(fs.statSync(daily).mode & 0o777, 0o600);
  console.log('PASS merge keeps existing lines and sorts all rows by ts with stable ties');

  const raw = fixture('raw bytes');
  const unusual = [
    Buffer.from(String.raw` { "q" : "SYNTHETIC SECRET \u65e5\u672c", "ts" : "2026-04-02T12:00:00Z", "a": "\u0061" } `),
    Buffer.from(String.raw`{"a":"日本語",  "q":"SYNTHETIC SECRET", "ts":"2026-04-01T00:00:00Z"}`),
    Buffer.from(String.raw`{ "ts":"2026-04-02T00:00:00Z", "n":1.00e+2, "q" : "SYNTHETIC SECRET" }`),
  ];
  unusual.forEach(line => assert.doesNotThrow(() => JSON.parse(line)));
  const existingRaw = Buffer.from(String.raw` {"q":"SYNTHETIC SECRET existing", "ts" : "2026-04-02T00:00:00Z"} `);
  const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]); // Odd rows also retain every byte.
  const input = [...unusual, unusual[0], invalidUtf8];
  fs.writeFileSync(join(raw, '2026-04.jsonl'), Buffer.concat(input.flatMap((line, i) =>
    i === input.length - 1 ? [line] : [line, Buffer.from(i % 2 ? '\n' : '\r\n')])));
  fs.writeFileSync(join(raw, '2026-04-02.jsonl'), Buffer.concat([existingRaw, Buffer.from('\r\n')]));
  const hashMultiset = lines => lines.map(line => createHash('sha256').update(line).digest('hex')).sort();
  result = run(raw);
  assert.equal(result.status, 0, result.stderr);
  const rawRead = name => {
    const bytes = fs.readFileSync(join(raw, name)), lines = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) {
      lines.push(bytes.subarray(start, i)); start = i + 1;
    }
    assert.equal(start, bytes.length, 'every output line ends with LF');
    return lines;
  };
  assert.deepEqual(rawRead('2026-04-01.jsonl'), [invalidUtf8, unusual[1]]);
  assert.deepEqual(rawRead('2026-04-02.jsonl'), [existingRaw, unusual[2], unusual[0], unusual[0]]);
  assert.deepEqual(hashMultiset(fs.readdirSync(raw).flatMap(rawRead)), hashMultiset([...input, existingRaw]));
  console.log('PASS raw spacing/key order/Unicode escapes and bytes survive sorting; SHA-256 multiset including duplicates unchanged');

  const odd = fixture('odd');
  const strange = [JSON.stringify({ id: 'missing' }), row(null, 'null'), row('invalid', 'invalid'),
    row('2026-05-01T00:00:00Z', 'other month'), row('2026-02-30T00:00:00Z', 'invalid calendar'),
    row('2026-04-01T00:30:00+01:00', 'UTC previous month'), '{bad json', '', 'null'];
  fs.writeFileSync(join(odd, '2026-04.jsonl'), [...strange, a].join('\n') + '\n');
  result = run(odd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lines=10 odd_rows=9/);
  const oddLines = read(join(odd, '2026-04-01.jsonl'));
  assert.equal(oddLines.length, strange.length + 1);
  assert.deepEqual([...oddLines].sort(), [...strange, a].sort());
  console.log('PASS missing/invalid/out-of-month timestamps and malformed/blank rows preserved and counted');

  const dry = fixture('dry');
  fs.writeFileSync(join(dry, '2026-04.jsonl'), [b, a].join('\n') + '\n');
  fs.writeFileSync(join(dry, '2026-04-02.jsonl'), c + '\n');
  const before = fs.readdirSync(dry).map(name => [name, fs.readFileSync(join(dry, name), 'utf8'), fs.statSync(join(dry, name)).mode]);
  result = run(dry, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /files=1 outputs=2 lines=2 odd_rows=0/);
  assert.deepEqual(fs.readdirSync(dry).map(name => [name, fs.readFileSync(join(dry, name), 'utf8'), fs.statSync(join(dry, name)).mode]), before);
  console.log('PASS dry run performs split/merge validation and writes nothing');

  const mismatch = fixture('mismatch');
  const monthly = join(mismatch, '2026-04.jsonl');
  fs.writeFileSync(monthly, a + '\n' + b + '\n');
  const preload = join(dir, 'short-write.mjs');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeFileSync;
    fs.writeFileSync = (fd, text, ...args) => write(fd, typeof fd === 'number' ? '' : text, ...args);
    syncBuiltinESMExports();
  `);
  result = run(mismatch, [], ['--import', preload]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /count=1/);
  assert.equal(fs.readFileSync(monthly, 'utf8'), a + '\n' + b + '\n');
  assert.deepEqual(fs.readdirSync(mismatch), ['2026-04.jsonl']);
  // Also verify the post-rename count check, before the source can be removed.
  const badRename = { ...fs, renameSync(temp, file) { fs.renameSync(temp, file); fs.writeFileSync(file, ''); } };
  const counts = splitStats(mismatch, { io: badRename });
  assert.equal(counts.failures.count, 1); assert(fs.existsSync(monthly));
  console.log('PASS staged and installed count mismatches keep monthly source and exit non-zero');

  const safe = fixture('safe');
  const target = join(dir, 'target'); fs.writeFileSync(target, 'UNCHANGED');
  fs.symlinkSync(target, join(safe, '2026-03.jsonl'));
  fs.mkdirSync(join(safe, '2026-02.jsonl'));
  for (const name of ['2026-13.jsonl', '2026-4.jsonl', 'stats.jsonl', '2026-04.jsonl.bak', '2026-04.jsonl\n']) fs.writeFileSync(join(safe, name), 'UNCHANGED');
  assert.equal(run(safe).status, 0);
  fs.writeFileSync(join(safe, '2026-04.jsonl'), a + '\n');
  fs.symlinkSync(target, join(safe, '2026-04-01.jsonl'));
  result = run(safe);
  assert.equal(result.status, 1); assert.match(result.stdout, /read=1/);
  assert(fs.existsSync(join(safe, '2026-04.jsonl')));
  assert.equal(fs.readFileSync(target, 'utf8'), 'UNCHANGED');
  assert(fs.lstatSync(join(safe, '2026-04-01.jsonl')).isSymbolicLink());
  const broken = fixture('broken');
  fs.writeFileSync(join(broken, '2026-04.jsonl'), a + '\n');
  const error = () => { throw new Error('SECRET'); };
  assert.equal(splitStats(broken, { io: { ...fs, fsyncSync: error } }).failures.write, 1);
  assert.deepEqual(fs.readdirSync(broken), ['2026-04.jsonl']);
  assert.equal(splitStats(broken, { io: { ...fs, renameSync: error } }).failures.write, 1);
  assert(fs.existsSync(join(broken, '2026-04.jsonl')));
  assert.equal(run(join(dir, 'missing')).status, 1);
  assert.equal(run(normal, ['--bad']).status, 1);
  console.log('PASS ignores unrelated/invalid names and monthly non-files; refuses unsafe daily targets; read/write failures keep source');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
