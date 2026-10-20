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
node embed.mjs            # chunks.jsonl → chunks.embedded.next.json (bge-m3, ~couple min)
npm run build             # = build-chunks + embed

./update-corpus.sh         # rebuild + check only (→ chunks.embedded.next.json)
./update-corpus.sh --local # rebuild, check and deploy on this server — see Deploy
node server.mjs           # http://localhost:8788  (demo.html; press F1)
node ask.mjs "..."        # one-shot CLI Q&A (answer→stdout, sources→stderr)
node report.mjs [days]    # usage stats summary from stats.jsonl
node eval.mjs             # retrieval-quality snapshot over a question set
bash test-update-corpus.sh # update-corpus.sh flow with restart/health/gate stubbed
```

### Sources chunked (`build-chunks.mjs`)

API cards are English only (the agent reading them translates; the website keeps every language). They share a 10,000-character notes budget across details, related symbols, examples, keywords, snippets and platform notes. Nested member notes share their containing card's budget. The budget counts formatted notes and separators and is enforced while consuming list items and snippet characters; card headers, signatures and descriptions are separate. Longer notes keep their start (with complete snippet fences) and append `(details truncated; see the full reference)` outside the budget. The build summary counts cards with truncated notes.

- **concept** — hand-written half of `TrussC/docs/FOR_AI_ASSISTANT.md` (before `## API Index`), by heading. *This is the place to add high-level knowledge by hand.*
- **symbol** — every entry in `trussc.org/generated/trussc-api.js` (the same data the reference page renders: signatures, enum values, properties, English prose) joined with `of-mapping.json` (openFrameworks → TrussC).
- **example** — each example in `examples.json` + the APIs it calls + a `src/tcApp.cpp` excerpt.
- **issue** — the open `bug` issues of TrussC-org/TrussC, one chunk each (title + `## Summary` + `## Workaround`), cached in `issues.json` by `node fetch-issues.mjs` (`update-corpus.sh` runs it). A closed issue drops out on the next rebuild. Retrieval admits an issue only when it ranks among the top k and clears a rerank floor; the model links it as `[[#123]]`.

Source paths default to the sibling-checkout layout (`../TrussC`, `../trussc.org`)
and are env-overridable (`TRUSSC_REPO`, `SITE_REPO`, …). The running server needs
none of them — it serves `chunks.embedded.json`, which `update-corpus.sh` generates
at deploy time (the corpus is not in git).

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
`STATS`/`STATS_LOG`/`STATS_SALT` (usage logging), `EMBED_ON_CPU`,
`EMBED_TOKEN_BUDGET` (default 1900: `embed.mjs` cuts each input to about this many bge-m3 tokens, under the model's 2,048-token context, and lists the cut inputs; if Ollama still rejects one, only that input is shortened and retried. Changing it re-embeds the inputs it affects).

## Deploy

Home GPU box behind a **Cloudflare Tunnel** → `api.trussc.org`. Full runbook in
`deploy/DEPLOY.md`; systemd unit + tunnel config in `deploy/`.

The corpus (`chunks.embedded.json`) is **generated at deploy time, not kept in git**:
it is built from the TrussC and trussc.org checkouts on the server. The GitHub caches
`releases.json` and `issues.json` are not in git either; each rebuild fetches them.

**Updating the corpus** after a re-emit or source change, on the server itself:

```bash
./update-corpus.sh --local    # fetch → build-chunks → embed → guards → swap → restart → health → accept
```

1. `embed.mjs` writes the new corpus to `chunks.embedded.next.json`; the live file is untouched.
2. Guards: it stops if the chunk count is more than 5% below the **live** corpus, or if
   `eval/fair/gate.py` sees a real score drop on a hidden question set kept outside this
   repo (see `eval/fair/README.md`). With no live corpus it stops unless you pass
   `--first-deploy`.
3. Swap: the live corpus is kept as `chunks.embedded.prev.json` and the new one is renamed
   into place.
4. `sudo systemctl restart trussc-docs-ai`, then `/health` must report `ok` and the new
   chunk count within about 30 s. If not — or if the run is interrupted after the swap —
   it restores `.prev` (on a first deploy: removes the new corpus), restarts again and
   exits non-zero without accepting the new baseline.
5. `gate.py accept` makes the deployed corpus the gate's baseline.

Roll back by hand to the corpus before the last swap:

```bash
mv chunks.embedded.prev.json chunks.embedded.json && sudo systemctl restart trussc-docs-ai
```

Without `--local`, `./update-corpus.sh` only rebuilds and checks (the result stays in
`chunks.embedded.next.json`). Deploying to another host is not supported: the guards
compare against the live corpus and the swap must happen where the service reads it,
so run `--local` on the server itself (`TRUSSC_SERVICE` names the systemd service).

**Migrating a checkout that has the committed corpus.** Older checkouts track
`chunks.embedded.json`, `releases.json` and `issues.json`. Production rebuilds have
modified them in place, so `git pull` refuses to merge or, once the local edits are
gone, deletes them. Keep a verified copy of the corpus first; each step runs only if
the one before it succeeded:

```bash
cp -p chunks.embedded.json ../chunks.embedded.keep.json &&
  cmp chunks.embedded.json ../chunks.embedded.keep.json &&
  git checkout -- chunks.embedded.json releases.json issues.json &&
  git pull &&
  cp -p ../chunks.embedded.keep.json chunks.embedded.json   # the live corpus again, now untracked
```

If any step fails, the copy in `../chunks.embedded.keep.json` is still there; copy it back
to `chunks.embedded.json` before restarting the service. Delete it once the next
`--local` run has passed.

The running server keeps the corpus in memory once loaded (any `/health` or query
loads it), so it serves normally throughout. The
next `./update-corpus.sh --local` compares against the restored file.

## Stats

One JSON line per request → `stats.jsonl` (gitignored): question, hashed IP, latency,
`corrected`, suggested APIs + category, conversation id. `node report.mjs` aggregates
(volume, distinct visitors, p50/p95, top questions/APIs/categories, by day).
