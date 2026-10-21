# Usage stats

The API appends one JSON object per tracked POST request to
`STATS_DIR/YYYY-MM.jsonl` via `logStat` in `stats.mjs`. `/chat`, `/ask`, `/search`,
`/get`, and `/mcp` share these fields, on success and failure. The month is the UTC
month of the row's `ts`. The report runs outside the API sandbox.

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
| `net` | Network grouping hash on every row, including MCP initialize and errors: SHA-256 with the existing `STATS_SALT` and `salt + '|' + key` construction, truncated to 16 lowercase hex characters. IPv4 uses the full address; IPv6 uses its normalized first /64; IPv4-mapped IPv6 uses the full IPv4 address. Missing/unparseable input is `null`. No raw address or prefix is logged. |
| `errorReason`, `errorClass` | Existing pipeline error fields, with coarse request/validation defaults; `null` when absent. A successful fallback can still carry the existing pipeline `errorClass`. |
| `q` | **Existing text field, retained by owner decision.** The full query as previously logged (existing whitespace trimming remains). Omitted on non-query requests and early validation failures, as before. |
| `a` | **Existing text field, retained by owner decision.** Answer's first 4000 UTF-16 code units, only on successful `/ask` and `/chat`, as before. |

Rejected question/history-length requests retain query length/language metadata
when a question is available, while omitting query text as before.

The existing `q` and `a` retention policy is centralized in the `text` object in
`logStat`; the owner has chosen to keep those fields. Existing optional
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
`clientInfo: {name, version}`. Each supplied value must be 1–64 ASCII characters
from `[A-Za-z0-9._ -]`; valid values (including dashboard self-marker nonces) are
preserved exactly. Empty, oversized, non-string or disallowed-character values
become `other`, without truncation or sanitization. Missing/null values are `null`.
Later rows do not inherit this information. HTTP MCP rows also carry `method`, including
`tools/call`; their `client` comes only from their own User-Agent. Normalization
lowercases the first product, strips `/version` or a trailing `-1.2`/`_v1.2`,
and aliases `claude-code`, `claude-desktop`, `claude-cli` → `claude`,
`visual-studio-code` → `vscode`, `mcp-inspector` → `inspector`. A product outside
1–32 ASCII `[a-z0-9._-]` characters becomes `other`, never a truncated token.
No raw headers are logged.

`net` uses the same header/socket address source as `ip`, while leaving the
existing `ip` hashes unchanged. Parsing accepts at most 128 UTF-16 code units
including any zone id; longer input returns `null`. Valid IPv6 compression,
letter case, leading zeroes, dotted IPv4 tails and zone ids normalize before
hashing. Zone ids do not affect the key. IPv6 keys use four lowercase,
zero-padded hexadecimal words followed by `::/64`; mapped addresses (including
hexadecimal spellings) instead use dotted IPv4. Two IPv6 addresses in one /64
therefore share `net`, allowing the dashboard to mark home/office traffic as
self without retaining addresses or prefixes. Hashes are pseudonyms, not
authenticated identities. Old rows have no `net`; no history is rewritten.

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
{"ts":"2026-10-21T12:00:00.000Z","ep":"chat","tool":null,"client":"widget","ms":800,"path":"jev","fallbackReason":null,"rounds":1,"haikuCalls":1,"haiku":{"in":1000,"out":70,"thinking":null},"jevTokens":500,"qLen":11,"qLang":"en","ip":"0123456789abcdef","net":"fedcba9876543210","errorReason":null,"errorClass":null,"q":"draw circle","a":"Use drawCircle."}
```

`/ask`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"ask","tool":null,"client":"widget","ms":800,"path":"jev","fallbackReason":null,"rounds":1,"haikuCalls":1,"haiku":{"in":1000,"out":70,"thinking":null},"jevTokens":500,"qLen":11,"qLang":"en","ip":"0123456789abcdef","net":"fedcba9876543210","errorReason":null,"errorClass":null,"q":"draw circle","a":"Use drawCircle."}
```

`/search`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"search","tool":null,"client":"http","ms":2,"path":"jev","fallbackReason":null,"rounds":1,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":500,"qLen":11,"qLang":"en","ip":"0123456789abcdef","net":"fedcba9876543210","errorReason":null,"errorClass":null,"q":"draw circle"}
```

`/get`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"get","tool":null,"client":"http","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":null,"qLang":null,"ip":"0123456789abcdef","net":"fedcba9876543210","errorReason":null,"errorClass":null}
```

HTTP MCP initialize:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"mcp","tool":null,"client":"cursor","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":null,"qLang":null,"ip":"0123456789abcdef","net":"fedcba9876543210","errorReason":null,"errorClass":null,"method":"initialize","clientInfo":{"name":"Cursor","version":"1.0"}}
```

HTTP MCP `trussc_search`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"mcp","tool":"trussc_search","client":"claude","ms":2,"path":"jev","fallbackReason":null,"rounds":1,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":500,"qLen":11,"qLang":"en","ip":"0123456789abcdef","net":"fedcba9876543210","errorReason":null,"errorClass":null,"method":"tools/call","q":"draw circle"}
```

HTTP MCP `trussc_get`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"mcp","tool":"trussc_get","client":"claude","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":null,"qLang":null,"ip":"0123456789abcdef","net":"fedcba9876543210","errorReason":null,"errorClass":null,"method":"tools/call"}
```

Stdio proxy `/get`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"mcp","tool":"trussc_get","client":"trussc-mcp-stdio","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":null,"qLang":null,"ip":"0123456789abcdef","net":"fedcba9876543210","errorReason":null,"errorClass":null}
```

Failure on `/ask`:

```json
{"ts":"2026-10-21T12:00:00.000Z","ep":"ask","tool":null,"client":"http","ms":2,"path":null,"fallbackReason":null,"rounds":0,"haikuCalls":0,"haiku":{"in":null,"out":null,"thinking":null},"jevTokens":null,"qLen":6,"qLang":"en","ip":"0123456789abcdef","net":"fedcba9876543210","errorReason":"transport","errorClass":"TypeError","q":"circle"}
```

## Monthly files and reporting

`STATS_DIR` is defined in `config.mjs` and defaults to the sibling directory
`new URL('../docs-ai-stats/', import.meta.url)`. In the deployed checkout this is
`/home/toru/TrussC-dev/docs-ai-stats`. `STATS_LOG` is removed. The operator creates
the directory before deployment; the API never creates directories. It holds
stats only, and nothing in it is executed or sourced.

Each row uses one timestamp for both `ts` and its UTC `YYYY-MM.jsonl` filename.
Only names matching `^\d{4}-\d{2}\.jsonl$` can be created. The writer opens with
`O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW`, mode `0600`, makes a single append
write for the complete JSON line and closes the file. Symlinks at the monthly
filename are refused. Missing directories and open/write failures drop the line,
warn once per process, and never fail request handling. Existing files retain
their modes; the operator ensures migrated files use `0600`.
There is no external rotation script, lock file or timer.

```bash
node report.mjs
node report.mjs 7 --include-debug
STATS_DIR=/path/to/monthly node report.mjs
node report.mjs --stats-dir /path/to/monthly --live /path/to/stats.jsonl
```

The report streams monthly files in `STATS_DIR` plus the optional legacy
worktree `stats.jsonl`, and tolerates either being absent. `--archive-dir` remains
an alias for `--stats-dir`; `--live` selects a legacy input. After migration
renames the legacy file to `stats.jsonl.migrated`, it is no longer read, so the
monthly copies are counted once. See [deployment](deploy/DEPLOY.md#monthly-stats-deployment)
for the coordinated switch and one-time migration.

Summaries group by endpoint, tool, client and row timestamp day. A positive day
count sets an inclusive lower timestamp cutoff; `0` (the default) means all time.
Before opening files, the report skips filenames more than one month before the
cutoff month. The extra month preserves compatibility with files from the former
external rotation; later months are still read for its delayed historical rows.
This compatibility rule assumes records are filed no earlier than the month
before their timestamp month. Direct writes always use their timestamp month.
Each admitted row is filtered by timestamp, debug flag and excluded IP before
any aggregate changes.

The reader uses 16 KiB chunks and skips/counts lines longer than 256 KiB in bytes
(excluding LF, including CR), including an unterminated tail. Malformed lines
are also skipped/counted. Only counters are retained. Each aggregate dimension
keeps the first 256 distinct keys encountered, each at most 1024 UTF-16 code
units; oversized keys and additional distinct keys fold into `other`. Counts
for admitted keys continue to accumulate. Overflow diagnostics count folded
observations, not distinct dropped keys. Directory traversal order determines
which keys are admitted. Summaries are exact until a limit is reached; after
visitor overflow, distinct visitors are a lower bound; conversation statistics
cover tracked conversations only. Latency percentiles use weighted counts and
are exact until their distinct-value limit is reached, then display
`unavailable`; maximum latency and total request counts remain exact.
Run the report outside the API sandbox. Concurrent appends may not yet be
included in the snapshot. Old rows without `client` report as `unknown`.
Existing debug filtering (excluded by default), `EXCLUDE_IP`, latency, visitor,
question/API/category summaries remain available.
