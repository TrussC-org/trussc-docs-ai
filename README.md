# trussc-docs-ai (v0)

Minimal RAG loop for the trussc.org documentation assistant. Node + Ollama only —
no Python, no vector DB (brute-force cosine; the corpus is small). Same code runs
on the Linux/A1000 box later: it only talks to Ollama over HTTP.

See the design note: `Obsidian/TrussC/trussc.org ドキュメントチャットアシスタント構想.md`.

## Setup

Ollama must be running. Generation model `qwen3:8b` is assumed already installed.
Pull the embedding model once:

```bash
ollama pull bge-m3        # multilingual (ja/ko/en) embeddings
```

## Pipeline

```bash
node build-chunks.mjs    # 3 sources → chunks.jsonl  (concept + symbol + example)
node embed.mjs           # chunks.jsonl → chunks.embedded.json (vectors via Ollama, ~80s)
# or: npm run build      # does both

node ask.mjs "how do I draw a curve?"      # CLI Q&A (answer→stdout, retrieval→stderr)
node eval.mjs            # retrieval-quality snapshot over a representative question set
node server.mjs          # http://localhost:8788 → open it, press F1 for the chat widget
```

### Sources chunked
- **concept** — hand-written half of `FOR_AI_ASSISTANT.md` (before `## API Index`), by heading.
- **symbol** — every documented entry in `reference-data.json` (multilingual card + signatures + oF equiv).
- **example** — each example in `examples.json`, enriched with the APIs it calls + a `src/tcApp.cpp` excerpt.

### Web demo
`server.mjs` serves `demo.html`: a bottom-right chat bubble revealed by **F1** (hidden easter-egg
trigger, per the design note), gated on `/health`, streaming answers over SSE with a `sources`
disclosure. Self-contained — the live trussc.org site is NOT touched.

## Config

Everything is env-overridable (`config.mjs`): `OLLAMA_URL`, `GEN_MODEL`,
`EMBED_MODEL`, `TOP_K`. To point at the home server later:

```bash
OLLAMA_URL=https://your-server node ask.mjs "..."
```

## Status / next

- v0 source: only the hand-written concept half of `FOR_AI_ASSISTANT.md`.
- Next sources to add (each = a collector returning `{id,source,lang,title,text}`):
  symbol chunks from `api-definition.yaml`, examples from `examples.json`,
  addons (dynamic — needs refresh cadence), oF→TrussC from `of-mapping.json`.
- Later: per-chunk metadata weighting (recency/trust/lang), then the web widget.
