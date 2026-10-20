// Fair eval, step 1 (no LLM): retrieve top-8 for every question from one corpus.
// Usage: EMBEDDED=<chunks.embedded.json> RERANK=1 STATS=0 node retrieve.mjs <questions.json> <out.json>
// The output carries question ids and retrieved chunks only, never the question text.
// Errors print a fixed line; FAIR_EVAL_DEBUG=1 (set by gate.py, which logs privately)
// adds the details, which can quote the hidden questions.
import { readFileSync, writeFileSync } from 'fs';
try {
  const { retrieve } = await import(process.env.DOCS_AI_RAG || new URL('../../rag.mjs', import.meta.url).href);
  const [qf, out] = process.argv.slice(2);
  const qs = JSON.parse(readFileSync(qf, 'utf8'));
  const res = [];
  for (const q of qs) {
    // Bound (cache): eight chunks per question, as the docs assistant answers with. Overflow is not retrieved and is not reported.
    const r = await retrieve(q.question, 8);
    const syms = (q.symbols || []).map((s) => s.replace(/\(.*$/, '').replace(/^(tc|trussc)::/, ''));
    const hit = r.findIndex((c) => syms.some((s) => c.id === 'symbol:' + s || c.title === s)) + 1;   // first chunk that is one of the expected symbols
    res.push({ id: q.id, symbolRank: hit, top: r.map((c) => ({ id: c.id, title: c.title, text: c.text })) });
  }
  writeFileSync(out, JSON.stringify(res));
  console.error(`retrieved ${res.length} questions → ${out}`);
} catch (e) {
  console.error('retrieve: failed' + (process.env.FAIR_EVAL_DEBUG === '1' ? `\n${e && e.stack || e}` : ' (set FAIR_EVAL_DEBUG=1 for details; they may quote questions)'));
  process.exit(1);
}
