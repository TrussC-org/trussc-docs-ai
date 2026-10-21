# Usage stats

The API appends one JSON object per tracked POST request to the existing
`stats.jsonl` via `logStat` in `stats.mjs`. `/chat`, `/ask`, `/search`, `/get`, and
`/mcp` share these fields, on success and failure. The timer and report run as
operator tools outside the API sandbox. No archive is read or written by the API.

| Field | Meaning / unavailable value |
| --- | --- |
| `ts` | UTC ISO timestamp when the row is appended. |
| `ep` | `chat`, `ask`, `search`, `get`, or `mcp`. |
| `tool` | `trussc_search` or `trussc_get` for MCP tool calls; otherwise `null`. |
| `client` | `widget`, `http`, or a normalized MCP User-Agent product; missing/empty UA is `unknown`, invalid product is `other`. |
| `ms` | Request latency in milliseconds, including body reading. |
| `path`, `fallbackReason` | Pipeline selection path and reason, unchanged from `pipelineStat`; `null` when unavailable. |
| `rounds`, `haikuCalls` | Pipeline rounds and Haiku attempts; `0` when none are reported/applicable. |
| `haiku` | Always `{ "in": number\|null, "out": number\|null, "thinking": number\|null }`; reported aggregate token usage. Output includes thinking. Thinking is `null` when not separately reported (including "included in outputTokens"), or when no Haiku call applies. Never log reasoning text. |
| `jevTokens` | Sum of retrieval token counts, using each retrieval's existing estimate if measured usage is unavailable; `null` when unavailable. No new accounting call. |
| `qLen` | Query length in UTF-16 code units, using the same trimmed query as the pipeline; `null` for requests without a query. |
| `qLang` | Cheap script guess: kana → `ja`, else Hangul → `ko`, else Han → `zh`, else ASCII letters → `en`, else `other`. `null` without a query. Han-only Japanese and mixed languages can be misclassified. |
| `ip` | Existing salted, truncated `hashIp` result; `null` when unavailable. No raw IP. |
| `errorReason`, `errorClass` | Existing pipeline error fields, with coarse request/validation defaults; `null` when absent. A successful fallback can still carry the existing pipeline `errorClass`. |
| `q` | **Existing text field, retained pending owner decision.** The full query as previously logged (existing whitespace trimming remains). Omitted on non-query requests and early validation failures, as before. |
| `a` | **Existing text field, retained pending owner decision.** Answer's first 4000 UTF-16 code units, only on successful `/ask` and `/chat`, as before. |

Rejected question/history-length requests retain query length/language metadata
when a question is available, while omitting query text as before.

The existing `q` and `a` retention policy is centralized in the `text` object in
`logStat`; a later owner decision can drop those fields there. Existing optional
pipeline/detail fields remain: `queries`, `exists`, `jevMs`, `haikuMs`,
`jevEstimatedTokens`, `retrievals`, `idOnlyCards`, `idOnlyCardsTotal`,
`estInputTokens`, plus `cid`, `turns`, `debug`, `corrected`, `n`, `top`, `links`,
`sym`, and `error` where already applicable. These are optional detail fields,
not substitutes for the common fields. Raw `ua` and `ref` headers are removed.

`/ask` and `/chat` identify the widget from its existing nonempty `page` hint or
canonical site Origin (`https://trussc.org`, including `www`). Debug alone is not
sufficient: the CLI sends it too. Other HTTP requests use `http`. These are usage
hints supplied by clients, not authenticated identities.

HTTP MCP is stateless. Initialize rows add `method: "initialize"` and
`clientInfo: {name, version}` (strings as supplied, missing values `null`). Later
rows do not inherit this information. HTTP MCP rows also carry `method`, including
`tools/call`; their `client` comes only from their own User-Agent. Normalization
lowercases the first product, strips `/version` or a trailing `-1.2`/`_v1.2`,
and aliases `claude-code`, `claude-desktop`, `claude-cli` → `claude`,
`visual-studio-code` → `vscode`, `mcp-inspector` → `inspector`. A product outside
1–32 ASCII `[a-z0-9._-]` characters becomes `other`, never a truncated token.
No raw headers are logged.

The stdio proxy continues to call `/search` and `/get`, with the product
`trussc-mcp-stdio/0.1.0`; the API records those as `ep: "mcp"` with the matching
tool and `client: "trussc-mcp-stdio"`. Its local initialize does not contact the
API or write a local stats file. HTTP initialize is logged on `/mcp`. MCP
notifications and other protocol POSTs receive a common row too. Health checks,
static assets, preflight requests and unrecognized routes are outside this log.

## Example lines

Illustrative common fields (optional pipeline detail fields are omitted here):

`/chat`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"chat","tool":null,"client":"widget","ms":800,"path":"jev","fallbackReason":null,"rounds":1,"haikuCalls":1,"haiku":{"in":1000,"out":70,"thinking":null},"jevTokens":500,"qLen":11,"qLang":"en","ip":"0123456789abcdef","errorReason":null,"errorClass":null,"q":"draw circle","a":"Use drawCircle."}
```

`/ask`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"ask","tool":null,"client":"widget","ms":800,"path":"jev","fallbackReason":null,"rounds":1,"haikuCalls":1,"haiku":{"in":1000,"out":70,"thinking":null},"jevTokens":500,"qLen":11,"qLang":"en","ip":"0123456789abcdef","errorReason":null,"errorClass":null,"q":"draw circle","a":"Use drawCircle."}
```

`/search`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"search","tool":null,"client":"http","ms":2,"path":"jev","fallbackReason":null,"rounds":1,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":500,"qLen":11,"qLang":"en","ip":"0123456789abcdef","errorReason":null,"errorClass":null,"q":"draw circle"}
```

`/get`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"get","tool":null,"client":"http","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":null,"qLang":null,"ip":"0123456789abcdef","errorReason":null,"errorClass":null}
```

HTTP MCP initialize:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"mcp","tool":null,"client":"cursor","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":null,"qLang":null,"ip":"0123456789abcdef","errorReason":null,"errorClass":null,"method":"initialize","clientInfo":{"name":"Cursor","version":"1.0"}}
```

HTTP MCP `trussc_search`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"mcp","tool":"trussc_search","client":"claude","ms":2,"path":"jev","fallbackReason":null,"rounds":1,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":500,"qLen":11,"qLang":"en","ip":"0123456789abcdef","errorReason":null,"errorClass":null,"method":"tools/call","q":"draw circle"}
```

HTTP MCP `trussc_get`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"mcp","tool":"trussc_get","client":"claude","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":null,"qLang":null,"ip":"0123456789abcdef","errorReason":null,"errorClass":null,"method":"tools/call"}
```

Stdio proxy `/get`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"mcp","tool":"trussc_get","client":"trussc-mcp-stdio","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":null,"qLang":null,"ip":"0123456789abcdef","errorReason":null,"errorClass":null}
```

Failure on `/ask`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"ask","tool":null,"client":"http","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":6,"qLang":"en","ip":"0123456789abcdef","errorReason":"transport","errorClass":"TypeError","q":"circle"}
```

## Rotation and reporting

`deploy/rotate-stats.sh [stats.jsonl [archive-dir]]` defaults to the
worktree's `stats.jsonl` and `~/TrussC-dev/docs-ai-stats`. The live filename must
be `stats.jsonl`. Each rotation appends its snapshot to **the previous UTC day's month's**
`YYYY-MM.jsonl`, irrespective of each row's `ts`. Thus late/historical rows can
be in a later archive file. A manual rotation on the 1st of a month files that
day's rows under the previous month. Reporting groups by each row's own `ts` date.

The operator script sets `umask 077`, enforces mode `0700` on the archive
directory and `0600` on monthly archives and the persistent lock, and reapplies
these modes to existing monthly archives even when the live file is missing or
empty. It leaves the live file mode unchanged.

The operator script takes a nonblocking `flock` on the archive's persistent
`.rotate.lock`. A concurrent invocation exits 1 without copying or truncating.
Missing/empty live files succeed. After a successful copy it truncates the same
live inode, preserving the API's append target and permissions. Copytruncate can
lose a few concurrent appends at the boundary; that loss is accepted. A partial
boundary line is possible, and the report skips malformed JSON. An interrupted
rotation after copying but before truncation can duplicate rows on retry; this
is a small usage summary, not an audit ledger. The script writes only the live
stats file and archive directory. See [installation](deploy/DEPLOY.md#external-stats-rotation-user-timer).

```bash
node report.mjs
node report.mjs 7 --include-debug
node report.mjs --live /path/to/stats.jsonl --archive-dir /path/to/archive
```

The report streams monthly JSONL archives plus the live file line by line,
tolerates either being absent, and summarizes by endpoint, tool, client and row
timestamp day. A positive day count sets an inclusive lower timestamp cutoff;
`0` (the default) means all time. Before opening archives, it skips filenames
more than one month before the cutoff month (one extra month covers a manual
rotation on the 1st). Later months are still read because delayed rotation can
put older rows there. This assumes records are archived no earlier than the
month before their timestamp month; future-dated or manually moved rows
in an earlier archive are outside that selection rule. Each admitted row is
filtered by timestamp, debug flag and excluded IP before any aggregate changes.

The reader uses 16 KiB chunks and skips/counts lines longer than 256 KiB in bytes
(excluding LF, including CR), including an unterminated tail. Malformed lines
are also skipped/counted. Only counters are retained. Each aggregate dimension
keeps the first 256 distinct keys encountered, each at most 1024 UTF-16 code
units; oversized keys and additional distinct keys fold into `other`. Counts
for admitted keys continue to accumulate. Overflow diagnostics count folded
observations, not distinct dropped keys. Archive traversal order determines
which keys are admitted. Summaries are exact until a limit is reached; after
visitor overflow, distinct visitors are a lower bound; conversation statistics
cover tracked conversations only. Latency percentiles use weighted counts and
are exact until their distinct-value limit is reached, then display
`unavailable`; maximum latency and total request counts remain exact.
Run it outside the API sandbox, preferably between rotations; concurrent
rotation can produce a transient duplicate/missing snapshot. Old rows without
`client` report as `unknown`. Existing debug filtering (excluded by default),
`EXCLUDE_IP`, latency, visitor, question/API/category summaries remain available.
The archive flag is for the report process only; it adds no service environment
variable or file permission.
