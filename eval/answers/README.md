# Answer evaluations

## Answer-level evaluation

`answer.mjs <questions.json> <out.json> [--jobs 3] [--limit N] [--ids a,b,c] [--resume]`
runs the real `answerStream(question)` without history or option overrides. It
requires `GEN_BACKEND=anthropic` and `ANTHROPIC_API_KEY` in the environment,
forces `STATS=0` before loading configuration, and inherits the production corpus,
retrieval and model settings. It never loads key files. Jev retrieval needs
`TYPESAFE_API_KEY`; the usual service fallback remains available and is recorded.

Each result has `id`, `text` (the final event's resolved answer), `usedIds`,
`rounds`, `queries` (count including the initial query), `haikuCalls`,
`inputTokens`, `outputTokens` (reported Haiku totals including correction/recovery),
`jevEstimatedTokens`, `path` (`jev` / `fallback`, from the final event), and `ms`
(whole-question elapsed time). Unknown metrics/path are `null`; unavailable counts
on a failure default to zero. Failed rows have empty `text`/`usedIds` and fixed
`error: "answer failed"`, and retain any available Haiku usage from the exception.
`path` describes the final retrieval round, as in the final event.

Rows retain question-file order even with concurrent completion. Every completion
atomically replaces the output with all finished rows. Resume keeps old rows in
their existing order and appends new rows in question-file order; existing failed
ids are skipped too. `--ids` filters before `--limit`, then resume skips ids already
saved. Resume validates every saved row against the same field whitelist and types
as new rows; unknown fields, missing fields or invalid values fail with
`answer: invalid resume results` before writing or generating answers.
Without resume, the output is replaced. Question ids must be unique non-empty
strings; numbers and blank strings are rejected by the runner, judge and comparison
with the fixed error `ids must be non-empty strings` (prefixed by the tool name).
Invalid arguments, file errors and generation failures return nonzero.
Errors use fixed messages;
`ANSWER_EVAL_DEBUG=1` also prints exception details, which may quote questions.

`judge_jev.py <questions.json> <answers.json> <out.json> [--jobs 8]` uses the fair
judge's Jev endpoint, model (`jev-latest`), key-file handling, redirect refusal,
bounded response and retries. It grades the supplied answer subset in question-file
order, sending the full question, reference and chat answer. It asks `correct`
(all required reference facts answered) and `wrong` (contradicts the reference).
For correctness probability p, certainty is rounded `|p−0.5|×2`: below the default
0.4 threshold scores 1; otherwise p≥0.5 scores 2, else 0. Wrong means p≥0.5.
Optional `--model` and `--threshold` match the retrieval judge's controls.
Rows contain `id`, `score`, `wrong`, `failed`, and for graded answers `correct_p`,
`wrong_p`, `certainty`. Generation errors bypass HTTP and score 0 with
`failed=true`, `wrong=false` (no final claim to judge). Judge errors have null
score/wrong, `failed=false` and a sanitized `error`; these cause a nonzero exit.
One summary line goes to stderr (graded, score/max, full, unsure, wrong, failed).

`compare.py <questions.json> <judgeA.json> <judgeB.json> [<answersA> <answersB>]`
prints JSON aggregates for paired ids: A/B totals and B−A score delta, better/worse/
tied score counts, and ids whose score, wrong or failed flag changed. Both judge
files must contain exactly the same fully graded ids, all in the question file;
subsets are allowed. Each `lang` and `type` group has the same aggregates (missing
metadata forms a null group). Optional answer files add means for Haiku input,
output and combined tokens, estimated Jev tokens, rounds and milliseconds, both
overall and per group. Each mean includes its observed sample count; null usage
does not count as zero. Failed answers' reported metrics remain included.
No question, reference or answer text is printed by the judge or comparison.

Only run live evaluations in the docs-ai key-holding shell. Tune on the improvement
set; use the held-out set once with Jev only. `text` is the model's answer verbatim
as provided by the final event (with resolved links), and can quote the question.
Answer files are private eval data and must stay outside this repository, like
the question files. See the [commands](../../README.md#answer-eval).

## Offline Haiku variants

Run from the checkout with `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY` already set
in the environment. The runner never loads credential files or prints credentials.
It calls retrieval and `answer()` in process, using Jev selection, Anthropic
Haiku, and the existing production configuration defaults (including corpus,
embedding endpoint, search rounds and response/input limits). Existing config
overrides still apply; no HTTP server is started. Stats are forced off.

```sh
node eval/answers/run-variants.mjs questions.json base.json --variant base
node eval/answers/run-variants.mjs questions.json filler.json --variant filler --filler 300
node eval/answers/run-variants.mjs questions.json thinking.json --variant thinking --thinking 1024 --ids ids.txt --model claude-haiku-4-5-20251001
node eval/answers/run-variants.mjs questions.json haiku55.json --variant base --model claude-haiku-5-5
node eval/answers/run-variants.mjs questions.json haiku55-high.json --variant base --model claude-haiku-5-5 --effort high
node eval/answers/run-variants.mjs questions.json haiku55-off.json --variant base --model claude-haiku-5-5 --thinking-off
node eval/answers/run-variants.mjs questions.json haiku45-ttft.json --variant base --model claude-haiku-4-5-20251001 --thinking-off
```

Questions are a JSON array of `{ "id": "q1", "question": "How do I draw a circle?" }`.
IDs must be unique nonempty strings or finite numbers (preserved in output). An optional IDs file selects questions using
one ID per line, preserving question-file order. Input, output and subset paths
come from arguments. Output is a JSON array, atomically replaced after each
question and at completion; a crash leaves completed rows available. A fresh run
replaces earlier results rather than resuming them.

`--model` overrides `ANTHROPIC_MODEL` in process; without it the environment or
the Haiku 5.5 default applies. `--effort` overrides `HAIKU_EFFORT` and
accepts low, medium, high, xhigh or max. With neither set, the `HAIKU_EFFORT`
default (`low`) applies; set `HAIKU_EFFORT=` (empty) to omit effort and use the
model default (medium for Haiku 5.5). Explicit `--effort` requires
an effort-capable model. `--variant thinking` requires a manual-thinking model
and fails before retrieval on Haiku 5.5, including with `--thinking 0`.

`--thinking-off` (no argument) or `HAIKU_THINKING=off` disables adaptive thinking
with `thinking: {"type":"disabled"}`. It accepts the model default effort, low,
medium or high; xhigh/max fail before any retrieval or generation request. It
cannot be combined with a manual thinking budget; the CLI also rejects combining
the flag with `--variant thinking` or `--thinking`, even `--thinking 0`.
On Haiku 4.5, off is already the default, so the field is omitted and the payload
bytes are unchanged. Unknown models also omit the field.

Each row has `id`, `variant`, `model`, `effort`, `answer`, `rounds`, `haikuCalls`, `inputTokensPerCall`, `inputTokens`,
`outputTokens`, `thinkingTokens`, `calls`, `ttftMs`, `totalMs`, and `ms`, plus `error` on failure. Input/output
counts sum reported Haiku usage across all search, recovery and correction calls;
unreported usage is `null`. `inputTokensPerCall` lists reported input counts in call
order, with `null` for unreported calls. Failed rows retain accumulated usage,
including when retrieval or correction packing fails after generation.
Output tokens retain the API's count, including
thinking. `effort` records the effective configured level or `"default"` when
omitted or unsupported. `thinkingTokens` sums separately reported thinking counts,
or is `"included in outputTokens"` when thinking is expected/observed and the API
does not report them separately; otherwise it is zero. This includes adaptive
thinking in base/filler runs. Thinking text and signatures are never written to results.
When thinking is explicitly off, unreported thinking usage defaults to zero in
the row summary (observed or separately reported thinking is still accounted for).

`calls` contains one entry per attempted Haiku call, in request order across
search, recovery and correction rounds:
`{ttftMs, totalMs, inputTokens, outputTokens, thinkingTokens}`. Per-call `ttftMs`
measures from the start of that call to its first nonempty streamed **text** delta;
thinking, signature and empty text deltas do not qualify. It is `null` if no
answer text arrives, including tool-only rounds and text discarded by a tool
decision. For a buffered answer, it retains the original text arrival time.
`totalMs` covers the entire call,
including connect and stream consumption, up to completion or failure. Per-call
token fields are the API's reported counts, or `null` if unreported; they do not
infer a separate thinking count from output tokens.

Row `ttftMs` measures from entry into the question's `answerStream()` request,
before retrieval, to the first visible answer `delta` it emits. It includes
retrieval, earlier tool calls, tool-decision buffering and answer-marker
buffering. Thinking deltas and research status messages do not qualify; text
discarded in a tool-use round does not qualify either. It is `null` if no answer
text is emitted. Thus row TTFT can exceed the first answer call's TTFT.
Row `totalMs` is the sum of all per-call `totalMs` values, excluding retrieval;
the existing `ms` is elapsed time for the whole question, including retrieval and
verification. Failed rows retain all accumulated call metrics. These measurements
are internal runner output and do not expand the HTTP debug or stats schemas.
A missing key, invalid arguments, or a failed question yields a nonzero exit status.
Question failures use a generic error string so upstream exceptions cannot leak keys.

Internal `answer()` / `answerStream()` options default to
`{ fillerTokens: 0, thinkingBudget: 0, model: ANTHROPIC_MODEL, effort: HAIKU_EFFORT, thinking: HAIKU_THINKING }`.
The in-process `thinking` option accepts `'off'` or unset. Filler accepts 0..4096 periods; thinking
accepts 0 (off) or 1024..16384 tokens. Filler is appended as the last line of each
Haiku user turn, including tool results and correction turns. Thinking raises
`max_tokens` by its budget and preserves signed/redacted blocks across tool rounds.
Haiku 5.5 gets no `thinking` field by default and never a manual budget: adaptive
thinking is already on unless disabled as above. It uses `HAIKU_ADAPTIVE_MAX_TOKENS` (8192 by default,
including thinking) for output headroom; Haiku 4.5 retains 1536 plus any manual
budget. Unknown models receive neither thinking nor effort fields. Signed and
redacted blocks are replayed before tool use even without an explicit thinking
request. A `max_tokens` stop fails through the generation error path, including
when only thinking was returned. Stream byte/frame caps remain unchanged.
The same serialized payload is used for packing, input-limit enforcement and token
estimates. The runner defaults to 300 periods or a 1024-token thinking budget for
the selected variant; other variants' knobs have no effect.

These internal options have no HTTP interface. The only new service environment
variables are optional `HAIKU_EFFORT`, `HAIKU_THINKING` and `HAIKU_ADAPTIVE_MAX_TOKENS` (see the
[configuration table](../../README.md)). `/ask` and
`/chat` ignore model, effort, thinking and variant fields in bodies, nested options, history metadata, headers
and query parameters. The public debug schema's existing `haiku.inputTokens` is
now an array aligned with `estInputTokens`; `inputTokensTotal` retains the round
sum. No variant configuration, thinking content or thinking-specific counts enter
the public debug allowlist.

## Related-list coverage

The [related-list eval](../related/README.md) records the real MCP search path
from the docs-ai key-holding shell, then compares ranked/related/neighbour list
mixes offline with ids-only output. Tune on the improvement set and use the
held-out set only once. This evaluates MCP suggestions; chat has no such list yet.
