// Operator-only migration: stop the service before running. Never print rows or paths.
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { statsFileDate } from '../stats.mjs';

function timestamp(line) {
  try {
    const ts = JSON.parse(line)?.ts;
    if (typeof ts !== 'string') return NaN;
    // Date.parse normalizes some impossible ISO calendar dates; reject those too.
    const date = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(ts);
    if (date && !statsFileDate(date[1] + '.jsonl')) return NaN;
    return Date.parse(ts);
  } catch { return NaN; }
}

function readLines(file, io) {
  const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!io.fstatSync(fd).isFile()) throw new Error('read');
    const bytes = io.readFileSync(fd), lines = [];
    // Keep raw bytes, including malformed UTF-8; only LF/CRLF terminators change.
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      lines.push(bytes.subarray(start, end > start && bytes[end - 1] === 13 ? end - 1 : end));
      start = end + 1;
    }
    if (start < bytes.length) lines.push(bytes.subarray(start));
    return lines;
  } finally { io.closeSync(fd); }
}

// Fixed failure reasons only. io injection lets tests simulate failed writes/count checks.
export function splitStats(dir, { dryRun = false, io = fs } = {}) {
  const counts = { files: 0, outputs: 0, lines: 0, oddRows: 0, failures: { scan: 0, read: 0, write: 0, count: 0, delete: 0 } };
  let entries;
  try { entries = io.readdirSync(dir).sort(); }
  catch { counts.failures.scan++; return counts; }
  for (const name of entries) {
    const date = statsFileDate(name);
    if (!date || date.day) continue;
    const source = join(dir, name), staged = [];
    let reason = 'read';
    try {
      if (!io.lstatSync(source).isFile()) continue;
      const lines = readLines(source, io), groups = new Map();
      counts.lines += lines.length;
      for (const line of lines) {
        const ts = timestamp(line);
        let day = Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : null;
        if (!day || day.slice(0, 7) !== date.month) { day = date.month + '-01'; counts.oddRows++; }
        if (!groups.has(day)) groups.set(day, []);
        groups.get(day).push(line);
      }
      const outputs = [];
      let existingCount = 0;
      for (const [day, added] of groups) {
        const file = join(dir, day + '.jsonl');
        let existing = [];
        try {
          if (!io.lstatSync(file).isFile()) throw new Error('read');
          existing = readLines(file, io);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        existingCount += existing.length;
        // Stable sort: existing lines precede new ones for equal timestamps.
        // Invalid timestamps sort first, retaining their original order.
        const merged = [...existing, ...added].map(line => ({ line, ts: timestamp(line) }));
        merged.sort((a, b) => {
          const left = Number.isFinite(a.ts) ? a.ts : -Infinity;
          const right = Number.isFinite(b.ts) ? b.ts : -Infinity;
          return left === right ? 0 : left < right ? -1 : 1;
        });
        outputs.push({ file, lines: merged.map(row => row.line) });
      }
      if (outputs.reduce((n, output) => n + output.lines.length, 0) !== existingCount + lines.length) {
        reason = 'count'; throw new Error(reason);
      }
      if (!dryRun) {
        reason = 'write';
        // Stage and check every output before replacing any daily file.
        for (const output of outputs) {
          const temp = join(dir, `.split-stats-${randomUUID()}.tmp`);
          const fd = io.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          staged.push({ ...output, temp });
          try {
            io.fchmodSync(fd, 0o600);
            // Sorting moves raw lines; never reserialize JSON (dashboard hashes raw bytes).
            const newline = Buffer.from('\n');
            io.writeFileSync(fd, Buffer.concat(output.lines.flatMap(line => [line, newline])));
            io.fsyncSync(fd);
          } finally { io.closeSync(fd); }
          reason = 'count';
          if (readLines(temp, io).length !== output.lines.length) throw new Error(reason);
          reason = 'write';
        }
        for (const output of staged) io.renameSync(output.temp, output.file);
        reason = 'count';
        const writtenCount = outputs.reduce((n, output) => n + readLines(output.file, io).length, 0);
        if (writtenCount !== existingCount + lines.length || readLines(source, io).length !== lines.length) throw new Error(reason);
        reason = 'write';
        // Make the output renames durable before removing their only source.
        const fd = io.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
        reason = 'delete';
        io.unlinkSync(source);
      }
      counts.files++;
      counts.outputs += outputs.length;
    } catch { counts.failures[reason]++; }
    finally {
      for (const output of staged) {
        try { io.unlinkSync(output.temp); } catch {}
      }
    }
  }
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // Bound (CLI arguments): accept one directory and optional --dry-run; extra arguments exit non-zero without migration.
  if (args.length < 1 || args.length > 2 || args[0].startsWith('--') || (args.length === 2 && args[1] !== '--dry-run')) {
    console.error('Usage: node tools/split-stats.mjs <dir> [--dry-run]');
    process.exitCode = 1;
  } else {
    const counts = splitStats(args[0], { dryRun: args[1] === '--dry-run' });
    const f = counts.failures;
    // Never print stats text (q, a, rows) to console/journal: journald has no
    // retention cap, so it would break the six-month deletion promise.
    console.log(`split stats: files=${counts.files} outputs=${counts.outputs} lines=${counts.lines} odd_rows=${counts.oddRows} failures(scan=${f.scan},read=${f.read},write=${f.write},count=${f.count},delete=${f.delete})`);
    if (Object.values(f).some(Boolean)) process.exitCode = 1;
  }
}
