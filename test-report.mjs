// Offline streaming/resource regressions: real CLI, temp archives, 32 MiB heap.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'docsai-report-'));
try {
  const archive = join(dir, 'archive'), live = join(dir, 'stats.jsonl');
  mkdirSync(archive);
  const now = new Date().toISOString(), month = now.slice(0, 7);
  const monthly = join(archive, month + '.jsonl');
  // Opening this old archive would fail with EISDIR. Its name must exclude it.
  mkdirSync(join(archive, '1999-01.jsonl'));
  const row = fields => JSON.stringify({ ts: now, ep: 'ask', client: 'widget', ip: 'visitor', ms: 10, ...fields }) + '\n';
  function report(args = [], env = {}) {
    const out = openSync(join(dir, 'out'), 'w'), err = openSync(join(dir, 'err'), 'w');
    let result;
    try {
      result = spawnSync(process.execPath, ['--max-old-space-size=32', fileURLToPath(new URL('./report.mjs', import.meta.url)),
        '1', '--live', live, '--archive-dir', archive, ...args], {
        env: { ...process.env, EXCLUDE_IP: '', ...env }, stdio: ['ignore', out, err], timeout: 30000,
      });
    } finally { closeSync(out); closeSync(err); }
    const stderr = readFileSync(join(dir, 'err'), 'utf8');
    assert.equal(result.error, undefined); assert.equal(result.signal, null, stderr); assert.equal(result.status, 0, stderr);
    return readFileSync(join(dir, 'out'), 'utf8');
  }
  // >55 MB of historical rows in an admitted (rotation-month) archive must be
  // streamed and date-filtered, even though none of these rows will be retained.
  const historical = row({ ts: '2000-01-01T00:00:00Z', q: 'h'.repeat(160) });
  writeFileSync(monthly, '');
  const batch = historical.repeat(1000);
  for (let i = 0; i < 240; i++) appendFileSync(monthly, batch);
  assert.match(report(), /no requests in range/);
  appendFileSync(monthly, row({ q: 'archive question', corrected: true, cid: 'thread', sym: [{ name: 'drawCircle', category: 'drawing' }] }));
  writeFileSync(live, row({ q: 'live question', ms: 100, cid: 'thread', corrected: false }) + row({ q: 'hidden debug', debug: true }) +
    row({ q: 'hidden IP', ip: 'excluded' }) + '{partial');
  let output = report([], { EXCLUDE_IP: 'excluded' });
  assert.match(output, /\(2 requests,/); assert.match(output, /excluded 1 rows/);
  assert.match(output, /latency ms: p50=100  p95=100  max=100/);
  assert.match(output, /conversations: 1  \(avg 2.0 msgs\/conv, max 2\)/);
  assert.match(output, /corrected\): 1\/2 \(50.0%\)/);
  assert.match(output, /drawCircle/); assert.match(output, /drawing/);
  assert(!output.includes('hidden')); assert(!output.includes('folded into other'));
  assert.match(report(['--include-debug'], { EXCLUDE_IP: 'excluded' }), /\(3 requests,/);
  console.log('PASS historical archive >55 MB streams under 32 MiB heap; month selection and early filters');

  // Neither readline nor JSON.parse may receive this 40 MiB line, including
  // an unterminated tail. Also exercise UTF-8 and valid rows after a long line.
  writeFileSync(monthly, ''); writeFileSync(live, '');
  const megabyte = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 40; i++) appendFileSync(monthly, megabyte);
  appendFileSync(monthly, '\n' + row({ q: '円を描く 😀' }));
  for (let i = 0; i < 40; i++) appendFileSync(live, megabyte);
  output = report();
  assert.match(output, /\(1 requests,/); assert.match(output, /skipped 2 oversized lines/);
  assert.match(output, /円を描く 😀/);

  // Exactly 256 KiB is admitted; one extra byte is skipped, then reading resumes.
  const base = row({ q: 'edge' }).trimEnd();
  writeFileSync(monthly, base + ' '.repeat(256 * 1024 - Buffer.byteLength(base)) + '\n' +
    base + ' '.repeat(256 * 1024 + 1 - Buffer.byteLength(base)) + '\n' + row({ q: 'after edge' }));
  writeFileSync(live, '');
  output = report();
  assert.match(output, /\(2 requests,/); assert.match(output, /skipped 1 oversized lines/);
  console.log('PASS line byte limit, large unterminated tail, UTF-8, exact boundary and recovery');

  // Filters must run before adding distinct aggregate keys.
  writeFileSync(monthly, '');
  for (let i = 0; i < 1000; i++) appendFileSync(monthly, row({ debug: true, q: `debug-${i}`, client: `debug-${i}` }) +
    row({ ip: 'excluded', q: `excluded-${i}`, client: `excluded-${i}` }));
  appendFileSync(monthly, row({ q: 'visible' }));
  output = report([], { EXCLUDE_IP: 'excluded' });
  assert.match(output, /\(1 requests,/); assert(!output.includes('folded into other'));

  writeFileSync(monthly, '');
  for (let i = 0; i < 10000; i++) appendFileSync(monthly, row({
    ep: `endpoint-${i}`, tool: `tool-${i}`, client: `client-${i}`, ip: `ip-${i}`, cid: `cid-${i}`,
    ms: i, q: `question-${i}`, sym: [{ name: `API-${i}`, category: `category-${i}` }],
  }));
  output = report();
  assert.match(output, /\(10000 requests,/);
  for (const name of ['endpoint', 'tool', 'client', 'visitor', 'conversation', 'latency', 'question', 'API', 'category']) {
    assert(output.includes(`(${name}: 9744 observations folded into other; key limit 256, key length 1024)`), name);
  }
  assert.match(output, /9744  other/); assert.match(output, /distinct visitors \(hashed IP\): >=256/);
  assert.match(output, /tracked conversations: 256/);
  assert.match(output, /p50=unavailable  p95=unavailable  max=9999/);
  writeFileSync(monthly, row({ q: 'a'.repeat(1024) }) + row({ q: 'b'.repeat(1025) }));
  output = report();
  assert.match(output, /question: 1 observations folded into other/);
  assert(output.includes('a'.repeat(1024))); assert(!output.includes('b'.repeat(1025)));
  // Large irrelevant fields must not remain alive via short aggregate keys.
  writeFileSync(monthly, '');
  for (let i = 0; i < 1000; i++) appendFileSync(monthly, row({
    q: `padded-question-${i}`, client: `padded-client-${i}`, a: 'z'.repeat(200000),
  }));
  output = report();
  assert.match(output, /\(1000 requests,/);
  assert.match(output, /question: 744 observations folded into other/);
  assert.match(output, /client: 744 observations folded into other/);

  // Day counts obey the same distinct-key bound in all-time reporting.
  rmSync(join(archive, '1999-01.jsonl'), { recursive: true });
  writeFileSync(monthly, '');
  for (let i = 0; i < 300; i++) appendFileSync(monthly, row({
    ts: new Date(Date.UTC(2000, 0, i + 1)).toISOString(), q: 'day question',
  }));
  output = report(['0']);
  assert.match(output, /\(300 requests,/); assert.match(output, /day: 44 observations folded into other/);
  console.log('PASS bounded distinct keys and key lengths; overflow counters and truthful visitor/latency summaries');
} finally { rmSync(dir, { recursive: true, force: true }); }
