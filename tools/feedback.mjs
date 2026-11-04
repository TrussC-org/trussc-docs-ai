// Read-only operator view. Feedback content goes only to stdout, never to a log.
//   STATS_DIR=/path/to/stats node tools/feedback.mjs [--days N]
import { constants, readdirSync, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { STATS_DIR } from '../config.mjs';
import { statsFileDate } from '../stats.mjs';

const args = process.argv.slice(2);
let cutoff = -Infinity;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--days' || !/^[1-9]\d*$/.test(args[1]) ||
      !Number.isSafeInteger(Number(args[1])) || !Number.isFinite(new Date(Date.now() - Number(args[1]) * 86400000).getTime())) {
    console.error('Usage: node tools/feedback.mjs [--days N] (positive integer)');
    process.exit(1);
  }
  cutoff = Date.now() - Number(args[1]) * 86400000;
}

try {
  for (const name of readdirSync(STATS_DIR).sort()) {
    const date = name.startsWith('feedback-') && statsFileDate(name, true);
    if (!date || date.lastDay + 86400000 <= cutoff) continue;
    const fd = openSync(join(STATS_DIR, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let lines;
    try {
      if (!fstatSync(fd).isFile()) continue;
      lines = readFileSync(fd, 'utf8').split('\n');
    } finally { closeSync(fd); }
    const rows = [];
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const time = typeof row?.ts === 'string' ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(time) || time < cutoff || new Date(time).toISOString().slice(0, 10) !== date.day) continue;
      const { ts, kind, ids, version, text } = row;
      rows.push({ ts, kind, ids, version, text });
    }
    rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    // Bound (memory): wait for stdout to drain, so a pipe holds about one day's rows, not the whole history.
    for (const row of rows) if (!process.stdout.write(JSON.stringify(row) + '\n')) await once(process.stdout, 'drain');
  }
} catch {
  console.error('Could not read feedback.');
  process.exitCode = 1;
}
