// Fair eval, step 1 (no LLM): retrieve top-8 for every question from one corpus.
// Usage: provide TYPESAFE_API_KEY in env; EMBEDDED=<corpus> STATS=0 node retrieve.mjs <questions.json> <out.json>
// The output carries question ids and retrieved chunks only, never the question text.
// Each question keeps exactly what trussc_search returns to the agent: the top 8, with
// the same text (leanText: full reference cards, examples cut to a head excerpt).
// Errors print a fixed line; FAIR_EVAL_DEBUG=1 (set by gate.py, which logs privately)
// adds the details, which can quote the hidden questions.
import { readFileSync, writeFileSync } from 'fs';
try {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required for deployed Jev retrieval');
  if (process.env.RETRIEVAL === 'rerank') throw new Error('RETRIEVAL=rerank cannot measure deployed Jev retrieval');
  const { retrieve, leanText, refLink, retrievalInfo } = await import(process.env.DOCS_AI_RAG || new URL('../../rag.mjs', import.meta.url).href);
  const { JEV_RATE_MAX, JEV_RATE_WIN_MS } = await import('../../config.mjs');
  if (JEV_RATE_MAX < 1) throw new Error('JEV_RATE_MAX must allow calls for the retrieval eval');
  const [qf, out] = process.argv.slice(2);
  const qs = JSON.parse(readFileSync(qf, 'utf8'));
  const res = [];
  for (const q of qs) {
    // Bound (cache): eight chunks per question, as the docs assistant answers with. Overflow is not retrieved and is not counted.
    // Pace the trusted batch under the same per-IP bound; never record fallback output.
    if (res.length > 0 && res.length % JEV_RATE_MAX === 0) await new Promise((resolve) => setTimeout(resolve, JEV_RATE_WIN_MS));
    const selected = await retrieve(q.question, 8, { ip: 'fair-eval' });
    if (retrievalInfo(selected).path !== 'jev') throw new Error(`Jev retrieval fell back: ${retrievalInfo(selected).reason}`);
    const r = selected.slice(0, 8);   // mcp-core trims to k the same way
    const syms = (q.symbols || []).map((s) => s.replace(/\(.*$/, '').replace(/^(tc|trussc)::/, ''));
    const hit = r.findIndex((c) => syms.some((s) => c.id === 'symbol:' + s || c.title === s)) + 1;   // first chunk that is one of the expected symbols
    res.push({ id: q.id, symbolRank: hit, top: r.map((c) => ({ id: c.id, title: c.title, text: leanText({ ...c, link: refLink(c) }) })) });
  }
  writeFileSync(out, JSON.stringify(res));
  console.error(`retrieved ${res.length} questions → ${out}`);
} catch (e) {
  console.error(!process.env.TYPESAFE_API_KEY ? 'retrieve: TYPESAFE_API_KEY is required for deployed Jev retrieval' : 'retrieve: failed' + (process.env.FAIR_EVAL_DEBUG === '1' ? `\n${e && e.stack || e}` : ' (set FAIR_EVAL_DEBUG=1 for details; they may quote questions)'));
  process.exit(1);
}
