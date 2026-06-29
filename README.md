# trussc-docs-ai

Local RAG assistant for the [trussc.org](https://trussc.org) documentation. Node +
Ollama only — no Python, no vector DB (brute-force cosine; the corpus is ~2k chunks).
Portable: it only talks to Ollama over HTTP, so the same code runs on a Mac and the
Linux/GPU box. Powers the hidden **F1** chat widget on trussc.org (backend at
`api.trussc.org`).

Design note: `Obsidian/TrussC/trussc.org ドキュメントチャットアシスタント構想.md`.

Advice-level by design ("here's the API/example, see the link") — not a code
generator. Knowledge lives in retrieval; the model is the reader.

## How it works

`retrieve` (embed the query, cosine over the corpus) → `draft` (think:false, ~1s) →
**deterministic ground-truth check** (flag any `KnownType::unknownMember`) →
corrective pass **only** when a fabrication is found. History (last turns) enables
follow-ups. Answers stream token-by-token; on the rare correction the whole bubble
is replaced. See `rag.mjs`.

## Setup

Ollama running, with the two models:

```bash
ollama pull qwen3.5:4b    # generation (fits 8GB w/ headroom)
ollama pull bge-m3        # multilingual (ja/ko/en) embeddings
```

## Commands

```bash
node build-chunks.mjs     # 3 sources → chunks.jsonl
node embed.mjs            # chunks.jsonl → chunks.embedded.json (bge-m3, ~couple min)
npm run build             # = build-chunks + embed

./update-corpus.sh [host] # rebuild corpus AND deploy (scp + restart) — see below
node server.mjs           # http://localhost:8788  (demo.html; press F1)
node ask.mjs "..."        # one-shot CLI Q&A (answer→stdout, sources→stderr)
node report.mjs [days]    # usage stats summary from stats.jsonl
node eval.mjs             # retrieval-quality snapshot over a question set
```

### Sources chunked (`build-chunks.mjs`)
- **concept** — hand-written half of `TrussC/docs/FOR_AI_ASSISTANT.md` (before `## API Index`), by heading. *This is the place to add high-level knowledge by hand.*
- **symbol** — every entry in `trussc.org/generated/trussc-api.js` (the same data the reference page renders: signatures, enum values, properties, multilingual prose) joined with `of-mapping.json` (openFrameworks → TrussC).
- **example** — each example in `examples.json` + the APIs it calls + a `src/tcApp.cpp` excerpt.

Source paths default to the sibling-checkout layout (`../TrussC`, `../trussc.org`)
and are env-overridable (`TRUSSC_REPO`, `SITE_REPO`, …). The running server needs
none of them — it serves the committed `chunks.embedded.json`.

## Server (`server.mjs`)

| endpoint | use |
|---|---|
| `GET /health` | `{ok,chunks}` — the widget's appearance gate |
| `POST /chat` | SSE stream (`sources`/`links`/`token`/`replace`/`done`) — the widget |
| `POST /ask` | one-shot JSON `{answer,links,sources,corrected}` — CLI / agents |
| `POST /search` | raw retrieval `{results}` — agents (no generation) |

Per-IP rate limit, CORS restricted to `ALLOW_ORIGIN`. Body: `{question, history?, convId?, k?}`.

## Widget

The production widget is `trussc.org/chat-widget.js` (a site asset). One line per
page: `<script defer src="/chat-widget.js" data-api="https://api.trussc.org">`. It
injects its own UI, is **health-gated** (invisible until the backend answers), F1
reveals it, copy/clear buttons, 24h-persisted history (localStorage), and i18n
(en/ja/ko via `<html lang>`). `demo.html` is the dev harness using the same file.

## Config (`config.mjs`, all env-overridable)

`OLLAMA_URL`, `GEN_MODEL` (qwen3.5:4b), `EMBED_MODEL` (bge-m3), `TOP_K`, `NUM_CTX`,
`KEEP_ALIVE` (model VRAM residency; `-1`=forever), `THINK`, `REF_BASE`,
`STATS`/`STATS_LOG`/`STATS_SALT` (usage logging), `EMBED_ON_CPU`.

## Deploy

Home GPU box behind a **Cloudflare Tunnel** → `api.trussc.org`. Full runbook in
`deploy/DEPLOY.md`; systemd unit + tunnel config in `deploy/`. Corpus is shipped
as the committed `chunks.embedded.json` (clone-and-go) or rebuilt on the box.

**Updating the corpus** after a re-emit or source change:

```bash
./update-corpus.sh <ssh-host>     # build-chunks → embed → scp → systemctl restart
# host/dir/service via TRUSSC_DEPLOY_HOST / TRUSSC_DEPLOY_DIR / TRUSSC_SERVICE
```

## Stats

One JSON line per request → `stats.jsonl` (gitignored): question, hashed IP, latency,
`corrected`, suggested APIs + category, conversation id. `node report.mjs` aggregates
(volume, distinct visitors, p50/p95, top questions/APIs/categories, by day).
