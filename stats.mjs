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

export function logStat(rec) {
  if (!STATS) return;
  try { appendFileSync(STATS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); }
  catch (e) { /* swallow — never let logging affect the request */ }
}
