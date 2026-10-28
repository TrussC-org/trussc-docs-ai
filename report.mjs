// Summarize daily and legacy monthly usage logs in STATS_DIR. No deps — just reads the JSONL.
//   node report.mjs                 # all-time
//   node report.mjs --include-debug # include debug requests
//   node report.mjs 7              # last 7 days
//   node report.mjs --live /path/stats.jsonl --archive-dir /path/archive
//   STATS_DIR=/path node report.mjs
//   EXCLUDE_IP=hash1,hash2 node report.mjs   # drop your own hashed IP(s) to see real users
import { createReadStream, existsSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { STATS_DIR } from './config.mjs';
import { statsFileDate } from './stats.mjs';

const args = process.argv.slice(2);
let live = new URL('./stats.jsonl', import.meta.url).pathname, archive = STATS_DIR, days = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--include-debug') continue;
  if (args[i] === '--live' || args[i] === '--archive-dir' || args[i] === '--stats-dir') {
    const flag = args[i], value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--live') live = value; else archive = value;
  } else if (/^\d+$/.test(args[i])) days = Number(args[i]);
  else throw new Error(`unknown argument: ${args[i]}`);
}
const cutoff = days > 0 ? Date.now() - days * 86400000 : -Infinity;
if (days > 0 && !Number.isFinite(new Date(cutoff).getTime())) throw new Error('date range out of bounds');
// Include one earlier month for archives created by the former external rotation.
// Direct writes always use the row timestamp's UTC day.
const cutoffMonth = days > 0 ? new Date(Date.UTC(new Date(cutoff).getUTCFullYear(), new Date(cutoff).getUTCMonth() - 1, 1)).toISOString().slice(0, 7) : '';
const includeDebug = args.includes('--include-debug');
const exclude = new Set((process.env.EXCLUDE_IP || '').split(',').map(s => s.trim()).filter(Boolean));

// Bound (report memory): read 16 KiB chunks and admit at most 256 KiB per line
// (excluding LF, including any CR). Discard/count longer lines BEFORE readline
// can buffer them, including oversized unterminated tails. Never retain rows.
const MAX_LINE_BYTES = 256 * 1024, READ_BYTES = 16 * 1024;
let oversized = 0, malformed = 0, excluded = 0, n = 0, first = Infinity, last = -Infinity;
function lineGuard() {
  const pending = Buffer.alloc(MAX_LINE_BYTES);
  let length = 0, dropping = false;
  return new Transform({
    transform(chunk, encoding, done) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        if (!dropping) {
          if (length + end - start > MAX_LINE_BYTES) {
            oversized++; dropping = true; length = 0;
          } else {
            chunk.copy(pending, length, start, end); length += end - start;
          }
        }
        if (newline >= 0) {
          if (!dropping) { this.push(Buffer.from(pending.subarray(0, length))); this.push('\n'); }
          length = 0; dropping = false;
        }
        start = end + 1;
      }
      done();
    },
    flush(done) {
      if (length && !dropping) { this.push(Buffer.from(pending.subarray(0, length))); this.push('\n'); }
      done();
    },
  });
}

// Bound (aggregate memory): each dimension keeps at most 256 distinct keys of
// at most 1024 UTF-16 code units. Additional/oversized keys fold into "other";
// count overflow observations, not distinct dropped keys (which are unknowable).
const MAX_KEYS = 256, MAX_KEY_UNITS = 1024;
const dimensions = Object.fromEntries(['endpoint', 'tool', 'client', 'visitor', 'conversation',
  'latency', 'question', 'API', 'category', 'day'].map(name => [name, { counts: new Map(), overflow: 0 }]));
function add(name, key) {
  if (key == null) return;
  const d = dimensions[name];
  if ((typeof key !== 'string' && typeof key !== 'number') || String(key).length > MAX_KEY_UNITS ||
      (!d.counts.has(key) && d.counts.size >= MAX_KEYS)) { d.overflow++; return; }
  const previous = d.counts.get(key);
  if (previous !== undefined) { d.counts.set(key, previous + 1); return; }
  // Copy new string keys so a short sliced string cannot pin a whole JSON line.
  if (typeof key === 'string') key = Buffer.from(key, 'utf16le').toString('utf16le');
  d.counts.set(key, 1);
}
let latencyMax = 0, answered = 0, corrected = 0;
async function read(file) {
  const input = createReadStream(file, { highWaterMark: READ_BYTES });
  const guarded = lineGuard();
  input.on('error', error => guarded.destroy(error));
  const lines = createInterface({ input: input.pipe(guarded), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row, ts;
      try {
        row = JSON.parse(line);
        ts = typeof row?.ts === 'string' ? Date.parse(row.ts) : NaN;
        if (!Number.isFinite(ts)) throw new Error('invalid timestamp');
      } catch { malformed++; continue; }
      if (ts < cutoff || (!includeDebug && row.debug === true)) continue;
      if (exclude.has(row.ip)) { excluded++; continue; }
      n++; first = Math.min(first, ts); last = Math.max(last, ts);
      add('endpoint', row.ep); add('tool', row.tool); add('client', row.client || 'unknown');
      if (row.ip) add('visitor', row.ip);
      if (row.cid) add('conversation', row.cid);
      if (Number.isFinite(row.ms) && row.ms >= 0) {
        add('latency', row.ms); latencyMax = Math.max(latencyMax, row.ms);
      }
      if (row.corrected != null) { answered++; if (row.corrected) corrected++; }
      add('question', row.q); add('day', row.ts.slice(0, 10));
      if (Array.isArray(row.sym)) for (const symbol of row.sym) {
        add('API', symbol?.name); add('category', symbol?.category);
      }
    }
  } finally { lines.close(); input.destroy(); guarded.destroy(); }
}

// Stream directory entries too: do not retain a list of every stats file.
// Keep the former rotation's month-selection compatibility and filter by row ts.
if (existsSync(archive)) {
  const directory = await opendir(archive);
  for await (const entry of directory) {
    if (statsFileDate(entry.name) && entry.name.slice(0, 7) >= cutoffMonth) {
      await read(join(archive, entry.name));
    }
  }
}
if (existsSync(live)) await read(live);
if (exclude.size) console.log(`(excluded ${excluded} rows from ${exclude.size} hashed IP(s))`);
if (oversized || malformed) console.log(`(skipped ${oversized} oversized lines; ${malformed} malformed lines)`);
for (const [name, d] of Object.entries(dimensions)) if (d.overflow) {
  console.log(`(${name}: ${d.overflow} observations folded into other; key limit ${MAX_KEYS}, key length ${MAX_KEY_UNITS})`);
}
if (!n) { console.log('no requests in range'); process.exit(0); }

const sorted = name => {
  const { counts, overflow } = dimensions[name];
  const entries = new Map(counts);
  if (overflow) entries.set('other', (entries.get('other') || 0) + overflow);
  return [...entries].sort((a, b) => b[1] - a[1]);
};
const bar = (name, max = 15) => sorted(name).slice(0, max).map(([k, c]) => `    ${String(c).padStart(4)}  ${k}`).join('\n');
const span = `${new Date(first).toISOString().slice(0, 10)} … ${new Date(last).toISOString().slice(0, 10)}`;
console.log(`\n=== TrussC docs-ai usage  (${n} requests, ${span}${days ? `, last ${days}d` : ''}) ===\n`);
for (const name of ['endpoint', 'tool', 'client']) console.log(`by ${name}:\n${bar(name)}\n`);
const visitors = dimensions.visitor;
console.log(`distinct visitors (hashed IP): ${visitors.overflow ? '>=' : ''}${visitors.counts.size}`);
const convs = dimensions.conversation;
if (convs.counts.size) {
  const sizes = [...convs.counts.values()];
  const avg = (sizes.reduce((a, b) => a + b, 0) / convs.counts.size).toFixed(1);
  console.log(`${convs.overflow ? 'tracked conversations' : 'conversations'}: ${convs.counts.size}  (avg ${avg} msgs/conv, max ${Math.max(...sizes)})`);
}
const lat = dimensions.latency;
if (lat.counts.size || lat.overflow) {
  const entries = [...lat.counts].sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const pct = p => {
    if (lat.overflow) return 'unavailable';
    const rank = Math.floor(total * p);
    let seen = 0;
    for (const [value, count] of entries) { seen += count; if (seen > rank) return value; }
  };
  console.log(`latency ms: p50=${pct(0.5)}  p95=${pct(0.95)}  max=${latencyMax}`);
}
if (answered) console.log(`verify-pass fired (corrected): ${corrected}/${answered} (${(100 * corrected / answered).toFixed(1)}%)`);
console.log(`\ntop questions:\n${bar('question', 20)}`);
console.log(`\ntop suggested APIs:\n${bar('API')}`);
console.log(`\ntop categories:\n${bar('category')}`);
console.log(`\nby day:\n${bar('day', 30)}\n`);
