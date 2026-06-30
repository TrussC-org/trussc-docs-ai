# trussc_search — MCP grounding tool

`mcp.mjs` is a zero-dependency stdio MCP server that exposes the TrussC docs corpus
as a single tool, **`trussc_search`**. It is a thin proxy over the `/search` endpoint:

```
query → bge-m3 embedding → cosine over the corpus → the most relevant chunks
```

**No generation** happens here — `/search` does retrieval only. The calling agent
(Claude Code, Claude Desktop, Cursor, …) reads the returned chunks and writes the
answer/code with its own model. So sharing this widely costs only the box's bge
compute, never hosted-generation tokens.

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

## Tuning

- `k` (tool arg, default 8): number of chunks returned (server clamps 1–20). Chunks
  are returned in full (example chunks are whole multi-file sources) — lower `k` for a
  leaner result. Note: per-source quota still applies (≤3 examples, ≤3 addons, rest
  reference/doc), so a large `k` mostly adds reference/doc chunks.
