// Usage stats: append one JSON line per request to STATS_DIR/YYYY-MM-DD.jsonl. Deliberately tiny —
// no DB, no deps, fire-and-forget. Logging must NEVER break a response, so every
// path is wrapped. Analyze later with jq (see README / report.mjs).
import { constants, openSync, writeSync, closeSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { STATS, STATS_DIR, STATS_SALT, STATS_RETENTION_DAYS } from './config.mjs';

// Bound (maintenance destinations): only exact daily/monthly calendar filenames are eligible; ignore every other name.
export function statsFileDate(name) {
  const match = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:-(\d{2}))?\.jsonl$/.exec(name);
  if (!match || match[0] !== name) return null;
  const month = match[1], day = match[2] ? `${month}-${match[2]}` : null;
  const date = new Date(`${day || month + '-01'}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || (day && date.toISOString().slice(0, 10) !== day)) return null;
  if (!day) { date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0); }
  return { month, day, lastDay: date.getTime() };
}

// Pin each maintenance directory once, including failed initialization (fail closed).
// Separate injected filesystems keep offline tests independent of production state.
const pruneDirectories = new WeakMap();
function pruneDirectory(dir, io) {
  if (!pruneDirectories.has(io)) pruneDirectories.set(io, new Map());
  const directories = pruneDirectories.get(io);
  if (!directories.has(dir)) directories.set(dir, (async () => {
    try {
      const path = await io.realpath(dir);
      const info = await io.lstat(path);
      return info.isDirectory() ? { path, dev: info.dev, ino: info.ino } : null;
    } catch { return null; }
  })());
  return directories.get(dir);
}

// Asynchronous directory-only maintenance; failures and diagnostics cannot break requests.
// Never print stats text (q, a, rows) to console/journal: journald has no retention
// cap, so doing so would break the six-month deletion promise.
// Inject the clock, directory and filesystem for offline boundary/failure tests.
export async function pruneStats({ dir = STATS_DIR, now = () => new Date(), io = fs } = {}) {
  const counts = { deleted: 0, failures: { directory: 0, clock: 0, scan: 0, inspect: 0, delete: 0 } };
  if (!STATS) return counts;
  const deleted = [];
  try {
    const pinned = await pruneDirectory(dir, io);
    // Check identity per run, not during a run. Production containment against
    // concurrent replacement comes from systemd's ProtectHome=tmpfs with the stats
    // directory bind-mounted: inside the service's mount namespace the path is a
    // mount point that cannot be renamed, and only the service sees its parent.
    // Outside that sandbox, the operator must own the directory exclusively.
    try {
      if (!pinned) throw new Error('directory identity');
      const info = await io.lstat(pinned.path);
      if (!info.isDirectory() || info.dev !== pinned.dev || info.ino !== pinned.ino) throw new Error('directory identity');
    } catch { counts.failures.directory++; return counts; }
    let cutoff;
    try {
      const today = new Date(now());
      today.setUTCHours(0, 0, 0, 0);
      cutoff = today.getTime() - STATS_RETENTION_DAYS * 86400000;
      if (!Number.isFinite(cutoff)) throw new Error('invalid clock');
    } catch { counts.failures.clock++; return counts; }
    try {
      const directory = await io.opendir(pinned.path);
      for await (const entry of directory) {
        const date = statsFileDate(entry.name);
        if (!date || date.lastDay >= cutoff) continue;
        const file = join(pinned.path, entry.name);
        let info;
        try { info = await io.lstat(file); }
        catch { counts.failures.inspect++; continue; }
        if (!info.isFile()) continue;
        // Node has no unlinkat with a directory fd: use the recorded real directory
        // and an exact-pattern name (no separators); unlink removes the entry itself.
        try { await io.unlink(file); counts.deleted++; deleted.push(entry.name); }
        catch { counts.failures.delete++; }
      }
    } catch { counts.failures.scan++; }
  } finally {
    const f = counts.failures;
    // One count line even for zero deletions; names are validated dates, never rows.
    try { console.log(`stats prune: deleted=${counts.deleted} files=[${deleted.join(',')}]${f.directory ? ' skipped=directory-identity' : ''} failures(directory=${f.directory},clock=${f.clock},scan=${f.scan},inspect=${f.inspect},delete=${f.delete})`); } catch {}
  }
  return counts;
}

// Pseudonymize the client IP: a salted hash, truncated. Lets us count distinct
// visitors / spot abuse without storing raw IPs.
export function hashIp(ip) {
  if (!ip) return null;
  return createHash('sha256').update(STATS_SALT + '|' + ip).digest('hex').slice(0, 16);
}

// Group IPv6 privacy addresses by /64 without persisting the address or prefix.
// Keep hashIp unchanged so existing per-address visitor hashes remain comparable.
export function hashNet(ip) {
  // Bound (address parsing): accept at most 128 UTF-16 code units, including
  // any zone id; oversized/non-string/invalid addresses return null, not a hash.
  if (typeof ip !== 'string' || ip.length > 128) return null;
  const family = isIP(ip);
  if (family === 4) return hashIp(ip);
  if (family !== 6) return null;
  let address = ip.split('%', 1)[0]; // isIP validated the optional zone id too.
  if (address.includes('.')) {
    const last = address.lastIndexOf(':');
    const octets = address.slice(last + 1).split('.').map(Number);
    address = address.slice(0, last + 1) +
      ((octets[0] << 8) | octets[1]).toString(16) + ':' +
      ((octets[2] << 8) | octets[3]).toString(16);
  }
  const [left, right] = address.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  // Bound (address expansion): isIP validation guarantees exactly eight words
  // after expanding ::, including a dotted IPv4 tail converted to two words.
  const words = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    .map(word => parseInt(word, 16));
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return hashIp([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'));
  }
  return hashIp(words.slice(0, 4).map(word => word.toString(16).padStart(4, '0')).join(':') + '::/64');
}

export function clientInfoValue(value) {
  if (value === undefined || value === null) return null;
  // Bound (stats output): each supplied initialize name/version must be 1..64
  // ASCII [A-Za-z0-9._ -] characters; invalid values become "other", never truncated.
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || /[^A-Za-z0-9._ -]/.test(value)) return 'other';
  return value;
}

// The reference symbols surfaced for a query → "which APIs/categories get asked
// about". category falls back to the owner type for methods (so members group
// under their type). Examples/concept chunks are skipped (no category).
export function suggested(retrieved) {
  return (retrieved || [])
    .filter((c) => c.source === 'reference')
    .map((c) => ({ name: c.title, kind: (c.meta && c.meta.kind) || null, category: (c.meta && (c.meta.category || c.meta.owner)) || null }))
    .slice(0, 6);
}

// A coarse script guess, not language detection. Kana takes precedence over Han.
export function queryLanguage(q) {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(q)) return 'ja';
  if (/\p{Script=Hangul}/u.test(q)) return 'ko';
  if (/\p{Script=Han}/u.test(q)) return 'zh';
  if (/[a-z]/i.test(q)) return 'en';
  return 'other';
}

export function clientName(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return 'unknown';
  const product = userAgent.trim().split(/\s/, 1)[0].toLowerCase()
    .split('/', 1)[0].replace(/[-_]v?\d+(?:\.\d+)*$/, '');
  // Bound (stats output): the version-stripped first product must be 1..32
  // ASCII [a-z0-9._-] characters; invalid/oversized products become "other",
  // never truncated or sanitized into a different valid client name.
  if (!/^[a-z0-9._-]{1,32}$/.test(product)) return 'other';
  const aliases = new Map([['claude-code', 'claude'], ['claude-desktop', 'claude'],
    ['claude-cli', 'claude'], ['visual-studio-code', 'vscode'], ['mcp-inspector', 'inspector']]);
  return aliases.get(product) || product;
}

export function requestClient(ep, headers, body = {}) {
  if (ep === 'mcp') return clientName(headers['user-agent']);
  if (ep === 'chat' || ep === 'ask') {
    // The canonical widget already supplies a page hint; same-site Origin is
    // also sufficient. Debug alone is not a widget signal (ask-cli sends it).
    if ((typeof body.page === 'string' && body.page.trim()) ||
        /^https:\/\/(?:www\.)?trussc\.org$/.test(headers.origin || '')) return 'widget';
  }
  return 'http';
}

const tokenCount = n => Number.isFinite(n) && n >= 0 ? n : null;

let warned = false;

export function logStat(rec) {
  if (!STATS) return;
  try {
    // Never print q, a or rows to console/journal: journald has no retention cap
    // and would break the six-month deletion promise. Whole-file retention is above.
    const { q, a, ...fields } = rec;
    const text = { ...(typeof q === 'string' ? { q } : {}),
      ...(typeof a === 'string' ? { a: a.slice(0, 4000) } : {}) };
    const ts = new Date().toISOString();
    const name = ts.slice(0, 10) + '.jsonl';
    // Bound (stats destination): only a four-digit UTC year/month/day filename; invalid names drop the row.
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) throw new Error('invalid stats day');
    const line = JSON.stringify({ ...fields,
      ts, ep: rec.ep, tool: rec.tool ?? null,
      client: rec.client ?? 'http', ms: rec.ms ?? null,
      path: rec.path ?? null, fallbackReason: rec.fallbackReason ?? null,
      rounds: rec.rounds ?? 0, haikuCalls: rec.haikuCalls ?? 0,
      haiku: { in: tokenCount(rec.haiku?.in), out: tokenCount(rec.haiku?.out), thinking: tokenCount(rec.haiku?.thinking) },
      jevTokens: tokenCount(rec.jevTokens), qLen: typeof q === 'string' ? q.length : rec.qLen ?? null,
      qLang: typeof q === 'string' ? queryLanguage(q) : rec.qLang ?? null, ip: rec.ip ?? null, net: rec.net ?? null,
      errorReason: rec.errorReason ?? null, errorClass: rec.errorClass ?? null,
      ...text }) + '\n';
    const fd = openSync(join(STATS_DIR, name),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(line);
      // One append per row; never retry a partial write as a separate append.
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('short stats write');
    } finally { closeSync(fd); }
  } catch {
    // A missing directory or any logging failure must never affect a response.
    if (!warned) {
      warned = true;
      try { console.warn('Warning: stats append failed; dropping usage stats'); } catch {}
    }
  }
}

// Explicit fields keep upstream response objects and credentials out of stats.
export function pipelineStat(result = {}) {
  const { path, reason, rounds = 0, queries = [], exists, jevMs = 0, haikuMs = 0, haikuCalls = 0, jevEstimatedTokens = 0, retrievals, traces = [], errorClass, idOnlyCards = [], idOnlyCardsTotal = 0, estInputTokens = [] } = result;
  const jevUsage = retrievals?.length ? retrievals.map(r => r.jevTokens ?? r.jevEstimatedTokens) : [result.jevTokens ?? result.jevEstimatedTokens];
  const jevTokens = jevUsage.every(n => tokenCount(n) !== null) ? jevUsage.reduce((a, b) => a + b, 0) : null;
  return { idOnlyCards, idOnlyCardsTotal, estInputTokens, path, fallbackReason: reason, rounds, queries, exists, jevMs, haikuMs, haikuCalls, jevEstimatedTokens,
    haiku: { in: tokenCount(result.inputTokens), out: tokenCount(result.outputTokens), thinking: haikuCalls ? tokenCount(result.thinkingTokens) : null }, jevTokens,
    ...(errorClass ? { errorClass } : {}), ...(retrievals ? { retrievals: retrievals.map((info, i) => ({ ...info,
      ...(traces[i]?.tool ? { tool: traces[i].tool } : {}),
      ...(traces[i]?.ids ? { ids: traces[i].ids } : {}),
      hintShown: traces[i]?.hintShown === true,
      hintFollowed: traces[i]?.hintShown === true && typeof traces[i]?.hintFollowed === 'boolean' ? traces[i].hintFollowed : null,
    })) } : {}) };
}
