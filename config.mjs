// Central config for the TrussC docs-ai RAG pipeline (Ollama-backed; portable).
// Everything talks to Ollama over HTTP, so the same code runs on Mac and the
// Linux/A1000 box — just point OLLAMA_URL at it.
//
// No machine-specific paths are baked in: corpus-source locations default to the
// standard sibling-checkout layout and are all env-overridable (see below). A
// deployed server needs none of them — it reads the committed chunks.embedded.json.
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));

export const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';

export const GEN_MODEL = process.env.GEN_MODEL || 'qwen3.5:4b';  // chosen: fits 8GB w/ headroom + long ctx; accuracy via the verify pass
export const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3'; // multilingual ja/ko/en
export const TOP_K = Number(process.env.TOP_K || 8);           // chunks fed to the model per question

// Generation context window. Bigger = more room for history + rich chunks, but more
// KV-cache VRAM. ~24k is generous for several turns; tune once we measure how many
// turns actually fit (target ~10). Cap it rather than letting Ollama default to 32k.
export const NUM_CTX = Number(process.env.NUM_CTX || 24000);
export const EMBED_ON_CPU = process.env.EMBED_ON_CPU === '1'; // keep bge-m3 off the GPU to save VRAM
// Thinking mode OFF by default: it's accurate but ~40–80s/answer (verbose at every
// level) — too slow for chat. We get accuracy instead from the deterministic
// fabrication check in rag.mjs (draft is ~1s). Set THINK=1 to force it on.
export const THINK = process.env.THINK === '1';

// Base URL for "see also" reference links. '' = site-relative (once embedded in
// trussc.org). Default to the live site so the standalone demo's links are clickable.
export const REF_BASE = process.env.REF_BASE ?? 'https://trussc.org';

// --- Corpus sources (only needed to (re)build the corpus, not to serve) ------
// Default to the standard sibling-checkout layout — the TrussC core and trussc.org
// site repos cloned next to this one:
//     …/TrussC          (core repo: docs, examples)
//     …/trussc.org      (site repo: generated/, examples/, chat-widget.js)
//     …/trussc-docs-ai  (this repo)
// Point TRUSSC_REPO / SITE_REPO elsewhere (or override each path below) for other
// layouts. None of these are read by the running server.
const TRUSSC_REPO = process.env.TRUSSC_REPO || resolve(HERE, '../TrussC');
const SITE_REPO   = process.env.SITE_REPO   || resolve(HERE, '../trussc.org');

// concept: the hand-written half of FOR_AI_ASSISTANT.md (task/how-to/idioms).
export const FOR_AI = process.env.FOR_AI || join(TRUSSC_REPO, 'docs/FOR_AI_ASSISTANT.md');
// symbols: the SAME merged data the website renders (emit-web output) — names match
// the reference page exactly (deep-links resolve), and it carries enum values,
// operators, properties, related, curated multilingual prose.
export const TRUSSC_API = process.env.TRUSSC_API || join(SITE_REPO, 'generated/trussc-api.js');
// openFrameworks → TrussC mapping (trussc-api.js doesn't carry `of`; join it in).
export const OF_MAPPING = process.env.OF_MAPPING || join(SITE_REPO, 'generated/of-mapping.json');
// examples: site manifest + on-disk sources (src/tcApp.cpp).
export const EXAMPLES_JSON = process.env.EXAMPLES_JSON || join(SITE_REPO, 'examples/examples.json');
export const EXAMPLES_SRC = process.env.EXAMPLES_SRC || join(TRUSSC_REPO, 'examples');

// The chat widget is a trussc.org site asset (served same-origin by GitHub Pages
// in prod). The dev server serves this same file so there's one source of truth;
// it's optional (guarded) since the deployed API box may not have the site repo.
export const WIDGET_FILE = process.env.WIDGET_FILE || join(SITE_REPO, 'chat-widget.js');

export const CHUNKS = new URL('./chunks.jsonl', import.meta.url).pathname;
export const EMBEDDED = new URL('./chunks.embedded.json', import.meta.url).pathname;

// --- Usage stats ------------------------------------------------------------
// One JSON line per request appended to STATS_LOG (no DB, no deps). Analyze with
// jq later. STATS_SALT keys the per-IP hash — set a real secret in prod so IPs
// can't be reversed/correlated. Set STATS=0 to disable logging entirely.
export const STATS = process.env.STATS !== '0';
export const STATS_LOG = process.env.STATS_LOG || new URL('./stats.jsonl', import.meta.url).pathname;
export const STATS_SALT = process.env.STATS_SALT || 'trussc-docs-ai-dev';
