# trussc_search — MCP grounding tool

`mcp.mjs` is a zero-dependency stdio MCP server that exposes the TrussC docs corpus
as a single tool, **`trussc_search`**. It is a thin proxy over the `/search` endpoint:

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

## Tools & behaviour

- **`trussc_search(query, k?, full?, lang?)`** — ranked by hybrid retrieval (BM25 over
  names + bge-m3 semantic, RRF-fused), then selected by Jev probabilities. Quotas apply only on fallback. Example chunks come back **trimmed** by default
  (header + start of source) to keep the result light; pass `full: true` for whole text.
  `k` is the **max total results** (default 8, clamped 1–20). Each card shows its `[#id]` and, on the Jev path, a relevance probability.
  A leading type or function name absent from the loaded documentation gets a
  top-line warning ("No TrussC symbol named `X` appears in the documentation.")
  and up to three near names. Matching ignores case and a leading `tc::`/`tcx::`.
  For every judged name, strip one leading `tc::`/`tcx::`, then check only
  the leading `A` in `A::b::c` (a bare name is its own leading name).
  Known names come from `symbol:`, `lua:` and `example:` ids and their components.
  Otherwise, any case-insensitive whole-word mention in an addon card's title
  or text, or a matching `addon:` id, suppresses the warning. This rule applies
  equally to `tc::`, `tcx::` and bare names, including addon compatibility aliases
  such as `tc::OscMessage` and `tc::PhysicsWorld`. Addon prose, headings, comments
  and strings all count as reasons to abstain: for example, an addon mentioning
  "circle" suppresses a warning for `tc::circle`. This favors avoiding false
  absence claims; a missing warning does not establish that an API exists.
  Core prose and card titles alone do not establish membership.
  Whitespace around separators has the same meaning: `tc :: CudaGraph :: begin`
  checks only `CudaGraph`. Dot/colon spellings (`a.b()`, `A.b`, `a:b()`,
  `a . b`, `a : b()`) and operator syntax are skipped. Before splitting names,
  any whitespace-delimited chunk containing `/` or `\`, a hyphen joining
  identifier characters, or a trailing file extension is skipped entirely.
  Ordinary English, acronyms, short bare words and a small list
  of product names are ignored. Member existence is never checked: for example,
  `Fbo::drawCircle` emits no name warning when `Fbo` is known. A missing warning
  therefore does not verify that a member exists. If initialization fails or the
  overall index bounds are exceeded, name checking abstains. Addon words are
  collected in one linear scan, with at most 1 Gi code units of title/text and
  1,000,000 distinct words/id components. Words longer than 96 code units skip
  only themselves; later words remain checkable.
  Below 0.3 coverage, the output says "These results probably don't answer the
  query." Missing names or low coverage label the cards as closest matches.
  Fallback has no coverage warning. Selection still keeps its minimum four cards
  when available (the caller's `k` may show fewer).
  After the cards, **Other possibly related** lists up to 16 distinct titles and
  exact ids, excluding shown cards. Order is Jev relevance on that path and RRF
  on fallback, even if a fallback reranker reordered the full cards. Titles are
  capped at 192 UTF-8 bytes and ids at 256 bytes (oversized ids are omitted).
  The whole search text is capped at 256 KiB; oversized card output is truncated
  with a `trussc_get` hint. `/search` carries the same bounded title/id candidate
  metadata, coverage and missing names for the stdio MCP proxy.
  - `lang` — API flavor. `"cpp"` (default) is the C++ framework; `"lua"` targets
    **TrussSketch** (the in-browser Lua playground) — it prefers the Lua twin of each
    symbol (colon-call methods, `Type.new(...)`, reserved-word renames like `fbo:end_fbo()`)
    and drops the C++ twin, while C++ examples/docs (no Lua twin) still come through.
- **`trussc_get(ids)`** — fetch the FULL text of specific chunks (e.g. expand a trimmed
  example). Ids are exactly as shown in results / the `[#id]` tags: `symbol:drawCircle`,
  `symbol:Fbo::begin`, `example:shaderExample`, `addon:tcxOsc`, `issue:257`, `doc:...`, `concept:...`.

The intended agent move: `trussc_search` to find the right chunks cheaply, then
`trussc_get` (or `full:true`) for the one or two you actually need in full.
