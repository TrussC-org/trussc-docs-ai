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
last round has no tool; the default `MAX_SEARCH_ROUNDS=4` allows three re-searches.
When accumulated cards fill `HAIKU_MAX_INPUT_TOKENS`, searching stops earlier and the
next call answers without the tool.
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
./update-corpus.sh --no-pull # use local source commits for an offline/dev rebuild
node fetch-addons.mjs      # refresh registry and sparse external addon cache
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
- **addon** — registry metadata cards plus available addon READMEs, split by heading. Bundled content in `ADDONS_DIR` takes priority; external addons (`bundled:false`) fall back to the operator's sparse Git cache. `ADDON_EXAMPLES=all` also ingests their immediate `example-*/src/*.{cpp,h,glsl}` files, excluding `main.cpp` (the update script enables this by default).
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
| `exists` | Jev coverage estimate (can every part of the question be answered from the cards), or `null` on fallback |
| `hintShown` | `true` when this round's Haiku prompt recommended `search_more` (estimate below `JEV_SEARCH_HINT_BELOW` and `search_more` offered) |
| `hintFollowed` | `true` if Haiku called `search_more` after the recommendation, `false` if it answered instead, `null` when no recommendation was shown |
| `path` | `"jev"` or `"fallback"` |
| `idOnlyCards` | Number of newly picked cards sent by id only because of the whole-request input budget (excludes already-shown references) |
| `haiku` | `{ms,inputTokens,inputTokensTotal,outputTokens,estInputTokens}`: elapsed milliseconds; reported input tokens per call (array aligned with `estInputTokens`, `null` when unreported); round input total; round output total (includes thinking if enabled internally); and estimated input tokens per call (including recovery/correction) |
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
| `JEV_SEARCH_HINT_BELOW` | `0.7` | Haiku always sees the Jev coverage estimate as a percentage; below this value, in rounds that offer `search_more`, its prompt also asks it to search for the missing parts instead of answering now (Haiku still decides). Clamped to 0–1 |
| `JEV_RATE_MAX` | `20` | Jev calls per IP per sliding window |
| `JEV_RATE_WIN_MS` | `60000` | Sliding window duration |
| `JEV_DAILY_TOKENS` | `20000000` | Per-process daily token budget, resetting at local midnight |
| `MAX_SEARCH_ROUNDS` | `4` | Search rounds, clamped to 1–10; total Haiku calls at most this value + 1 |
| `GEN_BACKEND` | `ollama` | `anthropic` enables native search rounds |
| `ANTHROPIC_API_KEY` | unset | Haiku credential, environment only |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Answer model. Set `claude-haiku-4-5-20251001` for the Haiku 4.5 path (no effort, 1536 max tokens, unchanged prompt). |
| `HAIKU_EFFORT` | `low` | `low`, `medium`, `high`, `xhigh`, or `max`; sent as `output_config.effort` only for supported models (currently Haiku 5.5). An empty value omits it so the model default applies (medium for Haiku 5.5). Invalid values warn and use `low`. |
| `HAIKU_THINKING` | unset (model default) | Optional `off` sends `thinking: {"type":"disabled"}` for adaptive models only. Requires effort high or below (Haiku 5.5's default medium is allowed); xhigh/max and manual thinking budgets are rejected before retrieval or requests. Invalid values warn and use the model default. Haiku 4.5 already defaults to thinking off, so its payload stays unchanged. |
| `HAIKU_ADAPTIVE_MAX_TOKENS` | `8192` | Total output token allowance for adaptive models, including thinking; integer clamped to 1536..32768. Haiku 4.5 and unknown models retain 1536 (plus any internal manual thinking budget). |
| `HAIKU_TIMEOUT_MS` | `60000` | Overall generation deadline, covering connect and the entire streamed response |
| `HAIKU_MAX_RESPONSE_BYTES` | `1048576` | Incremental streamed-body byte cap; individual SSE lines/events also capped at min(this value, 64 KiB) |
| `HAIKU_CARD_CHARS` | `8000` | Generation text cap per card, including truncation marker; separate from Jev's text cap |
| `HAIKU_MAX_INPUT_TOKENS` | `24000` | Whole serialized generation request estimate, using `JEV_TOKENS_PER_CHAR` (×1.25 for Haiku 5.5, whose tokenizer counts more tokens for the same text) |

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
node test-addons.mjs
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
`releases.json`, `issues.json` and `addon-registry.json` are generated caches too;
each rebuild refreshes them. See the migration notes below for older tracked files.

**Updating the corpus** after a re-emit or source change, on the server itself:

```bash
./update-corpus.sh --local    # pull sources → fetch caches → build → embed → guards → swap → restart → health → accept
```

Before any fetcher or build runs, both source checkouts must be on branches with
upstreams and have no tracked local changes (untracked files are allowed). The
script runs `git fetch` and `git merge --ff-only @{u}` in each. A dirty or detached
checkout, missing upstream, fetch failure or divergence stops the rebuild with the
live corpus untouched. It never resets, stashes or checks out these source repos.
`TRUSSC_REPO` and `SITE_REPO` default to `../TrussC` and `../trussc.org`, relative to
this repository, with operator-shell environment overrides. Both built commit SHAs
are printed and passed as `CORPUS_SOURCES` to the gate's check/accept result lines.
Rebuilds do not write usage events to `stats.jsonl`.

`--no-pull` skips source fetch and merge for offline/development builds, and still
prints/records each local HEAD commit. The branch/upstream/clean checks still apply.
Cache refreshes are still attempted
and remain non-fatal. For a fully offline chunk-only build, run
`ADDON_EXAMPLES=all node build-chunks.mjs` directly against existing caches.

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

**Addon registry and external sources.** `fetch-addons.mjs` fetches
[`registry.json`](https://raw.githubusercontent.com/TrussC-org/trussc-addons/gh-pages/registry.json)
from the same endpoint as trusscli. The response is read incrementally with a
2 MiB limit, a 30 s overall timeout and no redirects. It requires an object with an
`addons` array and drops entries without string `name`/`url` and boolean `bundled`,
with a warning. Loading considers the first 256 entries and keeps the first valid
entry for each case-insensitive addon name or cache URL, warning for each later
duplicate and once for overflow. A successful fetch replaces `addon-registry.json`
by atomic rename; failure preserves the previous file and tries its registry for
external sources.

External sources live outside the worktree, in
`~/.cache/trussc-docs-ai/addons` by default. Set `ADDON_CACHE_DIR` in the operator
shell to move the cache; use the same setting for fetches and chunk builds. Cache
subdirectories are keyed by the canonical repository URL. Only plain
`https://github.com/<owner>/<repo>` URLs (optional `.git`) are accepted; credentials,
extra paths, queries, fragments and other hosts/protocols are skipped with a warning.
Each refresh clones into a fresh temporary directory inside the cache, using depth
1, `--filter=blob:none`, no initial checkout and no submodules. It then explicitly
fetches `refs/tags/<latest_tag>` when present, otherwise remote `HEAD`, and checks
out the fetched commit detached. Non-cone sparse patterns materialize only
`README.md` and the example source files the builder reads. The completed clone
is published by renaming the old entry to a backup, renaming the completed clone
into place, then deleting the backup. A failed refresh preserves the old published
entry; existing Git metadata is never reused. Hooks, credential helpers and
inherited Git config are disabled. The cache root must be a real directory owned by the current user. Size walks use
`lstat` and discard entries containing symlinks, including inside `.git`.

Refreshes, including direct fetcher runs in separate worktrees, and chunk builds
share an atomic cache lock held through registry refresh or all cached content
reads. The lock records PID, start time and hostname. Waiters retry for up to ten
minutes, then fail with a clear message. A dead owner on the same host permits
safe takeover; locks from other hosts are retained. Each Git command's process
group ID, `ps` start identity and staging path are recorded before Git starts.
Takeover kills any surviving recorded group only when its identity matches, then
waits up to two seconds for the entire group to exit before removing staging.
An identity mismatch (including PID reuse), unavailable identity, failed kill or
group that does not exit stops takeover with a clear error and retains the lock
and staging for operator inspection; the mismatched process is left running.
Interrupted publication backups
are recovered before readers enter. At refresh start, abandoned `.addon-*` staging
directories are removed under the lock before calculating remaining budget.

Security bounds are fixed at 64 distinct external entries per run and 120 s for
all Git steps per addon. Every Git process inherits a hard 64 MiB per-file limit, covering
packs, objects and working files. While Git runs, the temporary directory's total
logical size, including `.git`, is polled by Node against a 64 MiB per-addon limit.
A POSIX shell supervisor independently checks owner liveness and the remaining
deadline every 0.2 s, even if Node dies or stops. A separate background job uses
`du -sk` to measure allocated staging bytes, including `.git`, and a bounded
`find` count rejects more than 20,000 staging entries independently of filenames.
Scans use any numeric `du` total despite a nonzero exit; five consecutive scans
without a total fail the refresh. Owner/deadline enforcement
occurs within one 0.2 s tick; size overshoot can span one scan cycle of writes.
Node retains its logical-byte checks, including a final check before publication.
These polling bounds are not a filesystem quota. Before starting an addon, at
least 64 MiB must remain in the 512 MiB whole-cache budget, including existing entries and Git objects. Timeouts
and live size overflow kill the entire Git process group; failed temporary clones
are removed with a `Warning`. Insufficient remaining cache budget skips further
downloads. The builder checks the size/count bounds again before reading a cache.
External README expansion stops at 200 sections per addon, omits the remainder and
prints one warning naming the addon. The admitted content's origin determines this
cap; bundled content keeps its existing behavior. Heading IDs use per-document
suffix counters; bundled README output is preserved. Registry metadata cards remain available when
source content is skipped. Prune unused cache directories from the operator shell
if the total cache limit is reached. Run manual cache maintenance only when no
fetcher or chunk builder is active.

`ADDON_REGISTRY_URL` overrides the registry endpoint for operator-shell tests.
`ADDON_URL_REWRITES` is an optional JSON map from validated GitHub repository URLs
to local `file://` remotes for offline tests; validation always runs on the original
registry URL. These settings and the cache are used only by build scripts. The
service's runtime config, filesystem access and stats behavior are unchanged.

**Migrating a checkout that tracks the addon registry.** Keep a verified copy
before pulling the change that removes it from Git, then restore it as a cache:

```bash
cp -p addon-registry.json ../addon-registry.keep.json &&
  cmp addon-registry.json ../addon-registry.keep.json &&
  git checkout -- addon-registry.json &&
  git pull &&
  cp -p ../addon-registry.keep.json addon-registry.json
```

If a step fails, keep the copy and restore it before rebuilding. Remove the backup
after a successful rebuild. This follows the corpus migration above; combine the
backups before pulling if both migrations apply.

## Stats

One JSON line per request → `stats.jsonl` (gitignored). See [STATS.md](STATS.md)
for the common endpoint/client/token schema, retained text fields, examples,
external monthly rotation and live-plus-archive reporting. Existing details: question, hashed IP, latency,
`corrected`, suggested APIs + category, conversation id. Pipeline fields include
`idOnlyCards` (per-round counts), `idOnlyCardsTotal`, `estInputTokens` (one number per Haiku call),
`path`, `fallbackReason`, `rounds`, `haikuCalls`, `queries`, Jev `exists`, `jevMs`, `haikuMs`,
`jevEstimatedTokens`, and per-round `retrievals` (so an earlier fallback stays visible; each carries that round's `exists`, `hintShown` and `hintFollowed`, as in the debug rounds above).
Debug request rows carry `debug:true`; `node report.mjs [days]` excludes them by
default. Pass `--include-debug` to include them. The report aggregates
(volume by endpoint/tool/client/day, distinct visitors, p50/p95, top questions/APIs/categories).

Offline model/effort, thinking-off and base/filler/extended-thinking comparisons: see [the variant runner](eval/answers/README.md), including per-call usage and latency measurements. These internal options are unavailable over HTTP. The production model default is Haiku 5.5 at effort low; it uses adaptive thinking by default and rejects manual thinking budgets. Haiku 5.5 also gets one extra system-prompt rule allowing clearly implied facts when the answer names the evidence (it otherwise declines to state what the cards only imply); Haiku 4.5's prompt is unchanged.
