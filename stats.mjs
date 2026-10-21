// Usage stats: append one JSON line per request to STATS_LOG. Deliberately tiny —
// no DB, no deps, fire-and-forget. Logging must NEVER break a response, so every
// path is wrapped. Analyze later with jq (see README / report.mjs).
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { STATS, STATS_LOG, STATS_SALT } from './config.mjs';

// Pseudonymize the client IP: a salted hash, truncated. Lets us count distinct
// visitors / spot abuse without storing raw IPs.
export function hashIp(ip) {
  if (!ip) return null;
  return createHash('sha256').update(STATS_SALT + '|' + ip).digest('hex').slice(0, 16);
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

export function logStat(rec) {
  if (!STATS) return;
  try {
    // Existing text fields live ONLY here. Owner retention decision pending:
    // drop this text object later without changing request/pipeline logging.
    const { q, a, ...fields } = rec;
    const text = { ...(typeof q === 'string' ? { q } : {}),
      ...(typeof a === 'string' ? { a: a.slice(0, 4000) } : {}) };
    appendFileSync(STATS_LOG, JSON.stringify({ ...fields,
      ts: new Date().toISOString(), ep: rec.ep, tool: rec.tool ?? null,
      client: rec.client ?? 'http', ms: rec.ms ?? null,
      path: rec.path ?? null, fallbackReason: rec.fallbackReason ?? null,
      rounds: rec.rounds ?? 0, haikuCalls: rec.haikuCalls ?? 0,
      haiku: { in: tokenCount(rec.haiku?.in), out: tokenCount(rec.haiku?.out), thinking: tokenCount(rec.haiku?.thinking) },
      jevTokens: tokenCount(rec.jevTokens), qLen: typeof q === 'string' ? q.length : rec.qLen ?? null,
      qLang: typeof q === 'string' ? queryLanguage(q) : rec.qLang ?? null, ip: rec.ip ?? null,
      errorReason: rec.errorReason ?? null, errorClass: rec.errorClass ?? null,
      ...text }) + '\n');
  }
  catch (e) { /* swallow — never let logging affect the request */ }
}

// Explicit fields keep upstream response objects and credentials out of stats.
export function pipelineStat(result = {}) {
  const { path, reason, rounds = 0, queries = [], exists, jevMs = 0, haikuMs = 0, haikuCalls = 0, jevEstimatedTokens = 0, retrievals, traces = [], errorClass, idOnlyCards = [], idOnlyCardsTotal = 0, estInputTokens = [] } = result;
  const jevUsage = retrievals?.length ? retrievals.map(r => r.jevTokens ?? r.jevEstimatedTokens) : [result.jevTokens ?? result.jevEstimatedTokens];
  const jevTokens = jevUsage.every(n => tokenCount(n) !== null) ? jevUsage.reduce((a, b) => a + b, 0) : null;
  return { idOnlyCards, idOnlyCardsTotal, estInputTokens, path, fallbackReason: reason, rounds, queries, exists, jevMs, haikuMs, haikuCalls, jevEstimatedTokens,
    haiku: { in: tokenCount(result.inputTokens), out: tokenCount(result.outputTokens), thinking: haikuCalls ? tokenCount(result.thinkingTokens) : null }, jevTokens,
    ...(errorClass ? { errorClass } : {}), ...(retrievals ? { retrievals: retrievals.map((info, i) => ({ ...info,
      hintShown: traces[i]?.hintShown === true,
      hintFollowed: traces[i]?.hintShown === true && typeof traces[i]?.hintFollowed === 'boolean' ? traces[i].hintFollowed : null,
    })) } : {}) };
}
