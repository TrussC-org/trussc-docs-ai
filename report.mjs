// Summarize the usage log (stats.jsonl). No deps — just reads the JSONL.
//   node report.mjs                 # all-time
//   node report.mjs 7              # last 7 days
//   STATS_LOG=/path node report.mjs
import { readFileSync, existsSync } from 'node:fs';
import { STATS_LOG } from './config.mjs';

const days = Number(process.argv[2] || 0);
if (!existsSync(STATS_LOG)) { console.log(`no stats yet (${STATS_LOG})`); process.exit(0); }

let rows = readFileSync(STATS_LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (days > 0) {
  const cutoff = Date.now() - days * 86400000;
  rows = rows.filter((r) => Date.parse(r.ts) >= cutoff);
}

const n = rows.length;
if (!n) { console.log('no requests in range'); process.exit(0); }

const count = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); if (k == null) continue; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
const pct = (sorted, p) => { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; };
const bar = (rowsArr, max = 15) => rowsArr.slice(0, max).map(([k, c]) => `    ${String(c).padStart(4)}  ${k}`).join('\n');

const span = `${rows[0].ts.slice(0, 10)} … ${rows[n - 1].ts.slice(0, 10)}`;
console.log(`\n=== TrussC docs-ai usage  (${n} requests, ${span}${days ? `, last ${days}d` : ''}) ===\n`);

console.log('by endpoint:');
console.log(bar(count(rows, (r) => r.ep)));

const visitors = new Set(rows.map((r) => r.ip).filter(Boolean));
console.log(`\ndistinct visitors (hashed IP): ${visitors.size}`);

const lat = rows.map((r) => r.ms).filter((x) => x != null).sort((a, b) => a - b);
if (lat.length) console.log(`latency ms: p50=${pct(lat, 0.5)}  p95=${pct(lat, 0.95)}  max=${lat[lat.length - 1]}`);

const answered = rows.filter((r) => r.corrected != null);
if (answered.length) {
  const corr = answered.filter((r) => r.corrected).length;
  console.log(`verify-pass fired (corrected): ${corr}/${answered.length} (${(100 * corr / answered.length).toFixed(1)}%)`);
}

console.log('\ntop questions:');
console.log(bar(count(rows, (r) => r.q), 20));

console.log('\ntop suggested APIs:');
console.log(bar(count(rows.flatMap((r) => r.sym || []), (s) => s.name)));

console.log('\ntop categories:');
console.log(bar(count(rows.flatMap((r) => r.sym || []), (s) => s.category)));

console.log('\nby day:');
console.log(bar(count(rows, (r) => r.ts.slice(0, 10)), 30));
console.log();
