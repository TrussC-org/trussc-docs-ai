# TrussC MCP grounding tools

`mcp.mjs` is a zero-dependency stdio MCP server that exposes the TrussC docs corpus
through **`trussc_search`** and **`trussc_get`**, also used by the chat. It is a thin proxy over the `/search` and `/get` endpoints:

```
query → dense + BM25 → RRF pool → Jev probabilities → selected cards
```

**No generation** happens here — `/search` does retrieval only. The calling agent
(Claude Code, Claude Desktop, Cursor, …) reads the returned chunks and writes the
answer/code with its own model. Search uses local embedding compute and one hosted Jev selection request, with no
Haiku answer call. All HTTP search endpoints share the per-IP Jev call window and
daily token budget. Missing credentials, upstream failure, or usage bounds use the
existing reranker/quota fallback; `RETRIEVAL=rerank` selects fallback directly.

There are two ways to connect: **remote** (just a URL, nothing to install — the
recommended way to share) or **stdio** (run `mcp.mjs` locally).

## A) Remote — api.trussc.org as the gateway (no local file)

The box serves the MCP protocol directly at `POST /mcp` (Streamable HTTP). Anyone
can connect by URL; nothing to clone or run:

```bash
claude mcp add --transport http --scope user trussc-docs https://api.trussc.org/mcp
```

- Works from any machine, any project (`--scope user` = available everywhere).
- Other MCP clients: point them at `https://api.trussc.org/mcp` (Streamable HTTP).
- Non-MCP callers (e.g. Gemini function-calling): just `POST /search` directly.

## B) Stdio — run mcp.mjs locally

For offline/localhost use, or clients that prefer stdio. Retrieval still goes over
HTTP to `/search`, so it needs network unless you run the box locally.

```bash
claude mcp add trussc-docs -- node /Users/toru/Nextcloud/Make/TrussC/trussc-docs-ai/mcp.mjs
```

- Point at a different API with env `TRUSSC_DOCS_API` (default `https://api.trussc.org`):
  ```bash
  claude mcp add trussc-docs -e TRUSSC_DOCS_API=http://localhost:8788 -- node /ABS/PATH/mcp.mjs
  ```
- Verify: `claude mcp list` → `trussc-docs` should be listed; in a session the tool
  appears as `trussc_search`.

Works in any MCP client (Claude Desktop / Cursor config: command `node`, args the
absolute path to `mcp.mjs`). For non-MCP callers (e.g. Gemini function-calling),
just POST `/search` directly — same data.

## Make Claude actually use it (the strong trigger)

A good tool description gets it called sometimes; an explicit instruction in
`CLAUDE.md` gets it called reliably. Paste this into the TrussC project's
`CLAUDE.md` (or your global `~/.claude/CLAUDE.md`):

```markdown
## TrussC grounding (MCP)
TrussC is niche; model priors about its API are unreliable. BEFORE writing or
reviewing TrussC C++ code, call the `trussc_search` MCP tool to confirm the real
API names, signatures, conventions (TAU not PI, colors 0–1, `using namespace tc`),
and a working example. Prefer APIs that appear in its results; do not invent ones.
```

`POST /search` accepts exactly one of `question` (the legacy single-query field)
or `queries`, plus optional `message`, with the same validation (HTTP 400 on
invalid input). Its existing 8,000-character question limit still applies.
The stdio proxy sends `question` for `query`, preserving single-query compatibility
with old servers; it forwards `queries` for the new form. Old proxies keep working
with the new server. Multi-query calls need a server that supports `queries`.

The chat offers these exact tool definitions. It uses the original question plus
one pool per search query, fixes language from the page (`sketch` uses Lua), and
ignores model-supplied `k` and `full`. Each tool-bearing turn, including
`trussc_get`, consumes a round. Call one tool per turn; put multiple searches in
`queries`. Cards and the related list count inside the chat input budget; cards
that do not fit are shown as `[#id]` for `trussc_get`, and previously shown cards
are referenced rather than repeated. MCP without that budget keeps its existing
output. Get retains string ids only, keeps the first 20, and strips one leading
`#` during lookup, matching the existing MCP rules.

## Tools & behaviour

- **`trussc_search({query?, queries?, message?, k?, full?, lang?})`** — ranked by hybrid retrieval (BM25 over
  names + bge-m3 semantic, RRF-fused), then selected by Jev probabilities. Quotas apply only on fallback. Example chunks come back **trimmed** by default
  (header + start of source) to keep the result light; pass `full: true` for whole text.
  Supply exactly one of `query` or `queries`. `queries` is an array of 1–3
  nonempty strings, each at most 200 UTF-16 code units (checked before trimming).
  Both fields are optional in the schema for client compatibility; the server
  rejects both/neither, invalid arrays/items, or whitespace-only queries as an
  error tool result (`isError`). Legacy `query` handling has no new length limit.
  Optional `message` is one short line in the user's language, at most 300 code
  units; non-strings or longer values are rejected. MCP validates and otherwise
  ignores it, including in logs. For example:
  `{"queries":["draw a circle", "serve a web page"],"message":"Looking for examples."}`.
  Multiple queries get equal shares of the existing candidate-token budget,
  deduplicate into one result list and make one Jev request with the queries
  joined by spaces as its question. Only embedding calls grow per query; fallback
  reranks one merged top-30 list. A one-item `queries` uses exactly the `query` path.
  `k` is the **max total results** (default 8, clamped 1–20). Each card shows its `[#id]` and, on the Jev path, a relevance probability.
  A leading type or function name absent from the loaded documentation gets a
  top-line warning ("No TrussC symbol named `X` appears in the documentation.")
  and up to three near names. Matching ignores case and a leading `tc::`/`tcx::`.
  For every judged name, strip one leading `tc::`/`tcx::`, then check only
  the leading `A` in `A::b::c` (a bare name is its own leading name).
  Known names come from `symbol:`, `lua:` and `example:` ids and their components.
  Otherwise, any case-insensitive whole-word mention in any loaded card's title
  or text, or a matching `addon:` id/component, suppresses the warning. This includes
  symbol, Lua, doc, concept and example cards as well as addons. This rule applies
  equally to `tc::`, `tcx::` and bare names, including addon compatibility aliases
  such as `tc::OscMessage` and `tc::PhysicsWorld`. Prose, headings, comments
  and strings all count as reasons to abstain: for example, any card mentioning
  "circle" suppresses a warning for `tc::circle`. This favors avoiding false
  absence claims; a missing warning does not establish that an API exists.
  Inline fields, members and nested types need no standalone card id: a word such
  as `onMouseDrag`, `sampleRate` or `MatrixScope` in its owner's text suffices.
  Whitespace around separators has the same meaning: `tc :: CudaGraph :: begin`
  checks only `CudaGraph`. Dot/colon spellings (`a.b()`, `A.b`, `a:b()`,
  `a . b`, `a : b()`) and operator syntax are skipped. Before splitting names,
  any whitespace-delimited chunk containing `/` or `\`, a hyphen joining
  identifier characters, or a trailing file extension is skipped entirely.
  Ordinary English, acronyms, short bare words and a small list
  of product names are ignored, as are the non-TrussC names `std`, `chrono`,
  `filesystem`, `this_thread` and `ranges`, including as qualified leading names.
  Member existence is never checked: for example,
  `Fbo::drawCircle` emits no name warning when `Fbo` is known. A missing warning
  therefore does not verify that a member exists. If initialization fails or the
  overall index bounds are exceeded, name checking abstains. All card words are
  collected in one linear scan, with at most 1 Gi code units of total title/text
  and 1,000,000 distinct words/id components across core and addon cards. Words
  are maximal ASCII letter/digit/underscore spans. Vectors are never scanned.
  Words longer than 96 code units skip only themselves; later words remain
  checkable. Canonical suggestion spellings retain only the first 2,048 ids;
  this does not limit exact membership.
  Below 0.3 coverage, the output says "These results probably don't answer the
  query." Missing names or low coverage label the cards as closest matches.
  Fallback has no coverage warning. Selection still keeps its minimum four cards
  when available (the caller's `k` may show fewer).
  After the cards, **Other possibly related** lists up to 16 distinct suggestions,
  excluding shown cards and Lua cards. It first takes up to 10 ranked leftovers
  (Jev relevance on that path, RRF on fallback), then visits shown cards in order,
  interleaving their related targets and stored primary-vector neighbours. Related
  and neighbour sources each accept up to 6 unique cards; only the first 5 stored
  neighbours per shown card are considered. Duplicates and unresolved targets do
  not consume source quotas. Each line is `- title — brief [#id]`, or
  `- title [#id]` when no brief exists. Titles are capped at 192 UTF-8 bytes,
  briefs at 160 bytes and ids at 256 bytes (oversized ids are omitted).
  The whole search text is capped at 256 KiB; oversized card output is truncated
  with a `trussc_get` hint. `/search` carries the same bounded candidate metadata
  in final list order: `candidates[]` entries have `id`, `title` and an optional
  `brief`, alongside coverage and missing names for the stdio MCP proxy.
  - `lang` — API flavor. `"cpp"` (default) is the C++ framework; `"lua"` targets
    **TrussSketch** (the in-browser Lua playground) — it prefers the Lua twin of each
    symbol (colon-call methods, `Type.new(...)`, reserved-word renames like `fbo:end_fbo()`)
    and drops the C++ twin, while C++ examples/docs (no Lua twin) still come through.
- **`trussc_get(ids)`** — fetch the FULL text of specific chunks (e.g. expand a trimmed
  example). Ids are exactly as shown in results / the `[#id]` tags: `symbol:drawCircle`,
  `symbol:Fbo::begin`, `example:shaderExample`, `addon:tcxOsc`, `issue:257`, `doc:...`, `concept:...`.
  One leading `#` is accepted (for example `#symbol:drawCircle`); exactly one is
  removed before lookup. All other characters, including surrounding whitespace,
  are preserved. The same rule applies to `/get` and older stdio proxies.

The intended agent move: `trussc_search` to find the right chunks cheaply, then
`trussc_get` (or `full:true`) for the one or two you actually need in full.

This file is developer documentation. The MCP tool description explains only
visible output: documentation-absence lines, near names, closest matches and
other possibly related titles/ids. It does not describe retrieval or name-check
implementation rules.

## Offline name regression

Run `node test-no-match-sweep.mjs` to build real reference cards with
`build-chunks.mjs` in a temporary directory, without embeddings. Input paths use
the builder's existing config/overrides (`SITE_REPO`, `TRUSSC_API`,
`SKETCH_LUA_REF`, `OF_MAPPING`, `EXAMPLES_JSON`); nested worktrees can discover an
ancestor's sibling site checkout. The sweep queries every available reference
TOML heading and each distinct bare component, or every name in the real builder
API input when TOML is unavailable. It asserts that documented words never get
absence lines and checks five true absences. Missing source data prints an
explicit `SKIP`. The restricted sweep also explicitly skips core docs/example
sources and addon trees; it never reads them or creates embeddings. Counts and
remaining reported names are printed for review.

`node test-symbol-checker.mjs` measures initialization on a ~65 MiB,
5,002-card synthetic corpus and verifies whole-word/span and distinct-word bounds.
The existing pipeline suite covers HTTP search, both MCP transports and chat.
