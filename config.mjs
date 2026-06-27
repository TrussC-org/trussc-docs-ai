// Central config for the TrussC docs-chat RAG prototype (Mac + Ollama, v0).
// Everything is portable: we only ever talk to Ollama over HTTP, so the same
// code runs unchanged on the Linux/A1000 box (just point OLLAMA at it).
export const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';

export const GEN_MODEL = process.env.GEN_MODEL || 'qwen3:8b';   // read-and-explain role (already installed)
export const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3'; // multilingual ja/ko/en — run: ollama pull bge-m3
export const TOP_K = Number(process.env.TOP_K || 5);            // chunks fed to the model per question
// Generation context window. Our prompt (system+primer+~5 chunks+history) is a
// few K tokens, so cap this instead of letting Ollama default to the model's full
// 32K — the big default KV cache is what bloats VRAM on the 8GB box.
export const NUM_CTX = Number(process.env.NUM_CTX || 8192);
export const EMBED_ON_CPU = process.env.EMBED_ON_CPU === '1';   // keep bge-m3 off the GPU to save VRAM
// Base URL for "see also" reference links. '' = site-relative (ideal once the
// widget is embedded in trussc.org). Default to the live site so the standalone
// demo's links are clickable; override (e.g. http://localhost:8723) for local docs.
export const REF_BASE = process.env.REF_BASE ?? 'https://trussc.org';

// Corpus sources. v0 starts with the hand-written concept half of FOR_AI
// (the auto-generated API Index tail is skipped — better served by per-symbol
// chunks from api-definition.yaml later).
export const FOR_AI = '/Users/toru/Nextcloud/Make/TrussC/TrussC/docs/FOR_AI_ASSISTANT.md';
// Per-symbol reference data (overhauled pipeline output; replaces api-definition.yaml).
export const REFERENCE_DATA = '/Users/toru/Nextcloud/Make/TrussC/TrussC/docs/reference/reference-data.json';
// Examples: the site manifest (groups/items) + the on-disk sources (src/tcApp.cpp).
export const EXAMPLES_JSON = '/Users/toru/Nextcloud/Make/TrussC/trussc.org/examples/examples.json';
export const EXAMPLES_SRC = '/Users/toru/Nextcloud/Make/TrussC/TrussC/examples';

export const CHUNKS = new URL('./chunks.jsonl', import.meta.url).pathname;
export const EMBEDDED = new URL('./chunks.embedded.json', import.meta.url).pathname;
