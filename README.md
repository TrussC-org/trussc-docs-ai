# trussc-docs-ai

RAG assistant for the [trussc.org](https://trussc.org) documentation: Node.js,
local Ollama/bge-m3 embeddings, Jev card selection, and either Claude Haiku or
Ollama answers. No vector database is needed. Powers the F1 chat widget on
trussc.org (backend at `api.trussc.org`).

Design note: `Obsidian/TrussC/trussc.org ドキュメントチャットアシスタント構想.md`.

Advice-level by design ("here's the API/example, see the link") — not a code
generator. Knowledge lives in retrieval; the model is the reader.

## How it works

The raw question goes to dense + BM25 retrieval, fused with RRF. Inherited cards
collapse to their declaring card and the existing C++/Lua policy applies. An RRF
pool fills a 28k estimated-state-token budget with card text capped at 2,000
characters. One Jev request assigns a probability to every card and an `exists`
probability for the combined answer. Selection defaults to p >= 0.4, filled to at
least 4 and capped at 16, ordered by probability. Source quotas apply only to fallback.

With `GEN_BACKEND=anthropic`, Haiku receives the selected cards and `exists` as a
hint. It can answer or call native `search_more({message, queries})` with 1–3
queries. The server emits `research` and builds a separate dense + BM25 RRF pool
for the original question and each query, applying inherited collapse and language
policy to each. The full pool budget is divided evenly, including state overhead;
each share fills in its own RRF order. Pools merge original-first, then query order,
with duplicate ids keeping their first slot and no redistribution of unused shares.
The combined state stays within `JEV_POOL_TOKENS` and Jev's 32k per-question limit.
One Jev call selects from that round's new pool. Its state contains the original
question, the current `search_more` message and queries, and new candidate cards;
earlier-round picks are never carried into Jev. Round 1 uses the raw question and
one pool, as before.

Haiku's round-1 user turn contains the question, first cards and exists hint and
stays intact. Each subsequent turn appends the returned assistant `tool_use` and a
user `tool_result` for its id, containing that round's selected cards and exists
hint. Repeated cards use `[#id] already shown above` references instead of repeating
their text. Used-card tracking and links span all rounds' cards. The
last round has no tool; `MAX_SEARCH_ROUNDS=3` allows two re-searches.
`MAX_SEARCH_ROUNDS` bounds search rounds. Total Haiku calls per request are
hard-capped at `MAX_SEARCH_ROUNDS + 1`, including one fabrication-correction call
and any invalid-tool recovery. Stats and debug report numeric `haikuCalls`. Invalid tool
input forces a tool-free answer without another retrieval. The existing
`@@USED` trail, implicit linked-card IDs, deterministic link resolution, and fabrication correction remain.
Tool-enabled rounds buffer text until the tool decision is complete so a tool call
never exposes answer text; tool-free rounds stream text as it arrives.
`GEN_BACKEND=ollama` stays single stage and has no search tool.
`eval-answers.mjs` also now searches the raw question; query expansion is removed.

Jev failures, timeout, missing credentials, response/pool limits, and usage bounds
use the existing finalize/rerank + quota + issue-floor path. `RETRIEVAL=rerank`
selects that path directly as an operator kill switch; keep `RERANK=1` and the
reranker available for cross-encoder fallback. Without it, existing RRF fallback
behavior remains. See `rag.mjs` and `jev.mjs`.

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
node server.mjs           # http://localhost:8788  (standalone demo.html)
node ask.mjs "..."        # one-shot CLI Q&A (answer→stdout, sources→stderr)
node ask-cli.mjs "..."    # HTTP answer + public per-round debug trace
node report.mjs [days]    # usage stats summary; excludes debug requests
node eval.mjs             # retrieval-quality snapshot over a question set
bash test-update-corpus.sh # update-corpus.sh flow with restart/health/gate stubbed
```

### Sources chunked (`build-chunks.mjs`)

API cards are English only (the agent reading them translates; the website keeps every language). They share a 10,000-character notes budget across details, related symbols, examples, keywords, snippets and platform notes. Nested member notes share their containing card's budget. The budget counts formatted notes and separators and is enforced while consuming list items and snippet characters; card headers, signatures and descriptions are separate. Longer notes keep their start (with complete snippet fences) and append `(details truncated; see the full reference)` outside the budget. The build summary counts cards with truncated notes.

- **concept** — hand-written half of `TrussC/docs/FOR_AI_ASSISTANT.md` (before `## API Index`), by heading. *This is the place to add high-level knowledge by hand.*
- **symbol** — every entry in `trussc.org/generated/trussc-api.js` (the same data the reference page renders: signatures, enum values, properties, English prose) joined with `of-mapping.json` (openFrameworks → TrussC).
- **example** — each example in `examples.json` + the APIs it calls + a `src/tcApp.cpp` excerpt.
- **issue** — the open `bug` issues of TrussC-org/TrussC, one chunk each (title + `## Summary` + `## Workaround`), cached in `issues.json` by `node fetch-issues.mjs` (`update-corpus.sh` runs it). A closed issue drops out on the next rebuild. Fallback retrieval admits an issue only when it ranks among the top k and clears a rerank floor; the model links it as `[[#123]]`.

Source paths default to the sibling-checkout layout (`../TrussC`, `../trussc.org`)
and are env-overridable (`TRUSSC_REPO`, `SITE_REPO`, …). The running server needs
none of them — it serves `chunks.embedded.json`, which `update-corpus.sh` generates
at deploy time (the corpus is not in git).

## Server (`server.mjs`)

| endpoint | use |
|---|---|
| `GET /health` | `{ok,chunks}` — the widget's appearance gate |
| `POST /chat` | SSE stream (`sources`/`links`/`research`/`token`/`replace`/`done`/`error`) — the widget |
| `POST /ask` | one-shot JSON `{answer,links,sources,corrected,usedIds,rounds,queries}` — CLI / agents |
| `POST /search` | retrieval `{results,path,exists,...}` — agents (no generation) |

Per-IP rate limit, CORS restricted to `ALLOW_ORIGIN`. Body: `{question, history?, convId?, k?, debug?}`. A request `rounds` field is ignored.

POST bodies are counted incrementally before JSON parsing, including `/get` and
`/mcp`. Above `MAX_BODY_BYTES`, the reader releases retained chunks, drains the
remaining request without accumulating it and returns HTTP 413
`{"error":"request too large"}`. MCP returns a JSON-RPC error with `id:null`,
code `-32000` and message `request too large` at the same HTTP status. Only the
fixed reason `body` and endpoint are logged for this rejection, with no body or
client fields. Questions and each retained user/assistant history entry allow
at most 8,000 UTF-16 code units each; only the last six incoming entries are
considered, and invalid roles or non-string content are discarded. Excess returns HTTP
400 with `question or history too long`, recording only reason `input-fields`
and endpoint. Older history entries are discarded without overflow accounting.

## Widget

The production widget is `trussc.org/chat-widget.js` (a site asset). One line per
page: `<script defer src="/chat-widget.js" data-api="https://api.trussc.org">`. It
injects its own UI, is **health-gated** (invisible until the backend answers), F1
reveals it, copy/clear buttons, 24h-persisted history (localStorage), and i18n
(en/ja/ko via `<html lang>`). `demo.html` is a self-contained dev harness. It renders each
`research` event as filler plus a ja/en/ko search status line, with the final answer
below. Input and send stay disabled until the response finishes or errors. The site
widget update is a separate PR.

The `research` SSE payload is `{round,message,queries}`; `round` is the next search
round (the first re-search is round 2). Sources and links refresh after retrieval.
`/ask` and `done` include the number of answer rounds and the raw question followed
by additional queries in execution order.

## Public debug trace and CLI

Any peer can send `{question: "...", debug: true}` to `/ask`. Its normal answer
response gains `debug: {haikuCalls: number, idOnlyCardsTotal: number, rounds: [...]}`. `/chat` accepts the same flag and emits
one SSE `debug` event containing that object immediately before `done`.
`idOnlyCardsTotal` sums the per-round budget omissions. Dropped card text is not summarized or compacted.
`haikuCalls` counts all Haiku attempts for the request (zero with Ollama).
Only the boolean `true` enables it. Each round has exactly these fields:

| Field | Contents |
|---|---|
| `queries` | Search queries executed for that round (raw question first) |
| `poolSize` | Number of deduplicated candidates in this round's Jev pool |
| `picked` | This round's selected cards as `{id,title,p}` only; previously shown selections use id references in Haiku's tool result |
| `exists` | Jev answer-exists probability, or `null` on fallback |
| `path` | `"jev"` or `"fallback"` |
| `idOnlyCards` | Number of newly picked cards sent by id only because of the whole-request input budget (excludes already-shown references) |
| `haiku` | `{ms,inputTokens,outputTokens,estInputTokens}`: elapsed milliseconds, reported input/output tokens, and a numeric estimate array in Haiku call order (including recovery/correction) |
| `jev` | `{ms,tokens}`: selection milliseconds and reported total tokens, or the request estimate when not reported |
| `message` | The round's validated tool-call filler message, or `null` if no search tool was called |

Array order identifies rounds. Probabilities and token counts are `null` when
unavailable (including p for cards without a Jev score). Haiku fields are 0 ms
and null tokens with Ollama. Recovery/correction Haiku calls count toward the
same round's timing and token totals. Jev request estimates may also appear on
failed or skipped selections; they do not represent remaining budget.

The trace is constructed field by field from an explicit allowlist. It excludes
credentials, prompts/system text, card texts, internal filesystem paths, fallback
reasons, remaining budgets, limiter state and IPs. Fallback reasons go only to
stats. Debug requests share all normal request and Jev usage limits.

```bash
node ask-cli.mjs "How do I draw a circle?"
node ask-cli.mjs "How do I draw a circle?" --json
node ask-cli.mjs "How do I draw a circle?" --url https://api.trussc.org/ask
```

The CLI POSTs `{question,debug:true}` to `http://127.0.0.1:$PORT/ask`
(`PORT=8788` by default). It prints a readable per-round trace followed by the
answer; `--json` prints the raw JSON response. `--url` specifies the full endpoint.
There is no rounds option. Changing `MAX_SEARCH_ROUNDS` requires an environment
change and a server restart; requests cannot override it.

## Config (`config.mjs`, all env-overridable)

`OLLAMA_URL`, `GEN_MODEL` (qwen3.5:4b), `EMBED_MODEL` (bge-m3), `TOP_K`, `NUM_CTX`,
`KEEP_ALIVE` (model VRAM residency; `-1`=forever), `THINK`, `REF_BASE`,
`STATS`/`STATS_LOG`/`STATS_SALT` (usage logging), `EMBED_ON_CPU`,
`EMBED_TOKEN_BUDGET` (default 1900: `embed.mjs` cuts each input to about this many bge-m3 tokens, under the model's 2,048-token context, and lists the cut inputs; if Ollama still rejects one, only that input is shortened and retried. Changing it re-embeds the inputs it affects).

| Variable | Default | Purpose |
|---|---|---|
| `MAX_BODY_BYTES` | `262144` | Incremental POST body limit in bytes (256 KiB); overflow returns HTTP 413 |
| `TYPESAFE_API_KEY` | unset | Jev credential; environment only; missing key warns once at startup |
| `JEV_URL` | `https://api.typesafe.ai/v1/systemone` | Selection endpoint; redirects are rejected |
| `JEV_MODEL` | `jev-latest` | Selection model |
| `RETRIEVAL` | `jev` | `jev` or `rerank` kill switch |
| `JEV_POOL_TOKENS` | `28000` | Total estimated state budget, split evenly across query pools on re-search |
| `JEV_TOKENS_PER_CHAR` | `0.4` | Conservative character-to-token estimate |
| `JEV_CARD_CHARS` | `2000` | Card text cap for pool estimation and Jev requests |
| `JEV_TIMEOUT_MS` | `3000` | Connect plus whole-body deadline |
| `JEV_PICK` | `threshold` | `threshold` or `fixed` |
| `JEV_PICK_K` | `8` | Fixed selection count |
| `JEV_PICK_MIN_P` | `0.4` | Threshold probability |
| `JEV_PICK_MIN` | `4` | Threshold minimum, filled by descending p |
| `JEV_PICK_MAX` | `16` | Threshold maximum (takes precedence if below minimum) |
| `JEV_RATE_MAX` | `20` | Jev calls per IP per sliding window |
| `JEV_RATE_WIN_MS` | `60000` | Sliding window duration |
| `JEV_DAILY_TOKENS` | `20000000` | Per-process daily token budget, resetting at local midnight |
| `MAX_SEARCH_ROUNDS` | `3` | Search rounds, clamped to 1–10; total Haiku calls at most this value + 1 |
| `GEN_BACKEND` | `ollama` | `anthropic` enables native search rounds |
| `ANTHROPIC_API_KEY` | unset | Haiku credential, environment only |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Answer model |
| `HAIKU_TIMEOUT_MS` | `60000` | Overall generation deadline, covering connect and the entire streamed response |
| `HAIKU_MAX_RESPONSE_BYTES` | `1048576` | Incremental streamed-body byte cap; individual SSE lines/events also capped at min(this value, 64 KiB) |
| `HAIKU_CARD_CHARS` | `8000` | Generation text cap per card, including truncation marker; separate from Jev's text cap |
| `HAIKU_MAX_INPUT_TOKENS` | `24000` | Whole serialized generation request estimate, using `JEV_TOKENS_PER_CHAR` |

New numeric settings reject non-finite or negative values with a warning and use
the default. Counts are floored. Jev estimates per-question state plus instruction
size against the 32k limit, reads at most 1 MiB incrementally, and validates all
requested probabilities. Fixed error reasons omit upstream bodies and credentials.

Hosted generation stops reading and cancels the response at `message_stop`.
Tool blocks are capped at 8, and each tool input (including incremental partial
JSON) at 8 KiB. An exceeded transport bound fails that answer with the fixed
`generation service error` message; stats record a fixed reason and exception
class only. Keyed request construction, fetch and body exceptions are normalized
at the Anthropic/Jev boundaries; upstream exception messages are not retained.
Jev failures continue to use retrieval fallback.

Generation cuts long card text on a line boundary and appends
`(truncated; use trussc_get for the full text)` within `HAIKU_CARD_CHARS`.
Within the whole-request budget, full capped cards are allocated by descending
probability; the rest are listed by id only. System text, external history,
retained native turns, tool definitions/results and correction turns all count.
Earlier search turns stay intact. If a new native continuation cannot fit even
without card text, Haiku answers from the existing context without another
search. Oversized external history drops its oldest turns and disables further
searches for that answer. If the minimal fixed request itself cannot fit, the
answer fails with the same safe error. The estimate is a local input bound,
not the provider's tokenizer.

The per-IP Jev windows are shared across `/chat`, `/ask`, `/search`, and MCP search;
the existing `RATE_MAX` request limiter also stays in place. Expired IP entries are
pruned and at most 10,000 IPs are tracked, evicting the oldest. Daily request tokens
are reserved before sending; API-reported usage replaces the estimate when present.
A failed request keeps its reservation. Exceeding either usage bound selects the
fallback path; budget fallback warns once each local day. These counters are in
memory, reset on process restart, and are not shared across worker processes.

Offline checks (tiny synthetic corpus and injected transports; no running models):

```bash
node test-jev.mjs
node test-two-stage.mjs
node test-debug.mjs
node test-r4.mjs
node test-r6.mjs
node test-build-chunks.mjs
node test-collapse.mjs
node test-resolve-links.mjs
bash test-update-corpus.sh
```

## Deploy

Home GPU box behind a **Cloudflare Tunnel** → `api.trussc.org`. Full runbook in
`deploy/DEPLOY.md`; systemd unit + tunnel config in `deploy/`.

**Owner one-time setup**

1. Add `TYPESAFE_API_KEY` to the installed systemd unit's `Environment=` or its
   `EnvironmentFile=` (see `deploy/trussc-docs-ai.service` and `deploy/DEPLOY.md`).
   For native Haiku rounds also set `GEN_BACKEND=anthropic` and `ANTHROPIC_API_KEY`.
   Keep real credentials out of the repository. If the unit configuration changes,
   run `sudo systemctl daemon-reload` before restarting.
2. Run `git pull` in the deployed checkout.
3. Run `systemctl restart trussc-docs-ai` as the service user (polkit permits this).
4. Check `curl -fsS http://127.0.0.1:8788/health` for `ok: true`, then run
   `node ask-cli.mjs "How do I draw a circle?" --json` and confirm
   `debug.rounds[].path` is `"jev"`. Health alone does not verify selection; a
   `"fallback"` path means Jev was not active for that round.

The `update-corpus.sh` gate (`eval/fair/retrieve.mjs`) **does require
`TYPESAFE_API_KEY` exported in the shell running the script**. It reads its own
process environment; the service environment is not inherited. In Bash, enter the
key at a hidden prompt so the value is neither in shell history nor a repo file
(keep shell tracing off):

```bash
set +x
read -r -s -p 'TYPESAFE_API_KEY: ' TYPESAFE_API_KEY; printf '\n'
export TYPESAFE_API_KEY
./update-corpus.sh --local
unset TYPESAFE_API_KEY
```

The retrieval eval rejects fallback output and paces its batch under the Jev
per-IP window; missing credentials make it and the gate fail clearly. The paired
comparison is unchanged. A first check after changing retrieval may compare
different selected cards against the accepted retrieval baseline.

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
4. `systemctl restart trussc-docs-ai`, then `/health` must report `ok` and the new
   chunk count within about 30 s. If not — or if the run is interrupted after the swap —
   it restores `.prev` (on a first deploy: removes the new corpus), restarts again and
   exits non-zero without accepting the new baseline.
   The default restart command uses no sudo. On an authorization error the script
   prints a hint to rerun with `TRUSSC_RESTART_CMD='sudo systemctl restart trussc-docs-ai'`.
   It never retries with sudo automatically; rollback uses the same configured command.
5. `gate.py accept` makes the deployed corpus the gate's baseline.

Roll back by hand to the corpus before the last swap:

```bash
mv chunks.embedded.prev.json chunks.embedded.json && systemctl restart trussc-docs-ai
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
`corrected`, suggested APIs + category, conversation id. Pipeline fields include
`idOnlyCards` (per-round counts), `idOnlyCardsTotal`, `estInputTokens` (one number per Haiku call),
`path`, `fallbackReason`, `rounds`, `haikuCalls`, `queries`, Jev `exists`, `jevMs`, `haikuMs`,
`jevEstimatedTokens`, and per-round `retrievals` (so an earlier fallback stays visible).
Debug request rows carry `debug:true`; `node report.mjs [days]` excludes them by
default. Pass `--include-debug` to include them. The report aggregates
(volume, distinct visitors, p50/p95, top questions/APIs/categories, by day).
