# Offline Haiku variants

Run from the checkout with `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY` already set
in the environment. The runner never loads credential files or prints credentials.
It calls retrieval and `answer()` in process, using Jev selection, Anthropic
Haiku, and the existing production configuration defaults (including corpus,
embedding endpoint, search rounds and response/input limits). Existing config
overrides still apply; no HTTP server is started. Stats are forced off.

```sh
node eval/answers/run-variants.mjs questions.json base.json --variant base
node eval/answers/run-variants.mjs questions.json filler.json --variant filler --filler 300
node eval/answers/run-variants.mjs questions.json thinking.json --variant thinking --thinking 1024 --ids ids.txt
```

Questions are a JSON array of `{ "id": "q1", "question": "How do I draw a circle?" }`.
IDs must be unique nonempty strings or finite numbers (preserved in output). An optional IDs file selects questions using
one ID per line, preserving question-file order. Input, output and subset paths
come from arguments. Output is a JSON array, atomically replaced after each
question and at completion; a crash leaves completed rows available. A fresh run
replaces earlier results rather than resuming them.

Each row has `id`, `variant`, `answer`, `rounds`, `haikuCalls`, `inputTokens`,
`outputTokens`, `thinkingTokens`, and `ms`, plus `error` on failure. Input/output
counts sum reported Haiku usage across all search, recovery and correction calls;
unreported usage is `null`. Output tokens retain the API's count, including
thinking. `thinkingTokens` is zero for base/filler; for thinking it sums separately
reported thinking counts, or is `"included in outputTokens"` when the API does not
report them separately. Thinking text and signatures are never written to results.
A missing key, invalid arguments, or a failed question yields a nonzero exit status.
Question failures use a generic error string so upstream exceptions cannot leak keys.

Internal `answer()` / `answerStream()` options default to
`{ fillerTokens: 0, thinkingBudget: 0 }`. Filler accepts 0..4096 periods; thinking
accepts 0 (off) or 1024..16384 tokens. Filler is appended as the last line of each
Haiku user turn, including tool results and correction turns. Thinking raises
`max_tokens` by its budget and preserves signed/redacted blocks across tool rounds.
The same serialized payload is used for packing, input-limit enforcement and token
estimates. The runner defaults to 300 periods or a 1024-token thinking budget for
the selected variant; other variants' knobs have no effect.

These options have no HTTP interface or service environment variables. `/ask` and
`/chat` ignore variant fields in bodies, nested options, history metadata, headers
and query parameters. The public debug schema's existing `haiku.inputTokens` is
now an array aligned with `estInputTokens`; `inputTokensTotal` retains the round
sum. No variant configuration, thinking content or thinking-specific counts enter
the public debug allowlist.
