# Related-list coverage

Run the dump only from the docs-ai shell holding the retrieval keys, with the
intended corpus and embedding service available. It runs the real in-process
`trussc_search` dispatch/retrieval path with the question as query and default MCP
options (`k=8`, C++). Both HTTP MCP and the stdio proxy form the list after
applying the actual shown-card boundary. Jev needs `TYPESAFE_API_KEY`; service fallback is recorded.
It does not generate answers, load credential files, or run a server. It forces
`STATS=0` before importing configuration. Keep inputs and outputs outside the repo.

```sh
node eval/related/dump.mjs "$IMPROVEMENT_QUESTIONS" "$RUN_DIR/related.json" --jobs 3
node eval/related/dump.mjs "$IMPROVEMENT_QUESTIONS" "$RUN_DIR/related.json" --jobs 3 --resume
node eval/related/coverage.mjs "$IMPROVEMENT_QUESTIONS" "$RUN_DIR/related.json"
```

Tune on the improvement set; use the held-out set only once after choosing a mix.
Use the same corpus for dumping and coverage. Coverage runs entirely offline and
reads `EMBEDDED` (or `--corpus corpus.json`); an older corpus without `near` or
`meta.brief` works, with fewer suggestions/descriptions.

The input is an array of `{id, question, symbols}`. Question ids are unique,
nonempty strings. A dump row contains only `id`, `shown` (actual MCP card ids),
`ranked` (first 40 ranked candidate ids, including shown cards), and `path`
(`jev` or `fallback`). A failed row has empty ids, `path: null`, and the fixed
`error: "search failed"`. The runner returns nonzero on failures, never prints
exception details, and replaces upstream warnings with a fixed diagnostic.
It atomically checkpoints after every question. Concurrent completions are saved
in input order; resume retains existing rows (including failures) and appends new
ids in input order. Remove a failed row to retry it. Resume rejects unknown fields
and invalid rows before writing or searching: each row must be a success with a
non-null path and no error field, or a marked failure with empty ids and null path.
Retained failures count in the summary's `failed` total and keep the exit status
nonzero, even when no new questions run. No question, answer, title, brief,
query, credential, or upstream error text enters the dump or coverage output.

Coverage normalizes each gold symbol by trimming, removing leading `tc::` and
its argument list, then looking up the exact `symbol:` id. Per-question gold ids
are deduplicated. Unmatched symbols are counted separately from matched gold
found nowhere. For each variant it prints the effective mix, totals found in
shown/list/nowhere, first-contributing list source, unmatched count, mean and p90
(nearest-rank) list bytes, and question/card ids. Failed dump rows are counted and
excluded from coverage/bytes; missing question rows are not evaluated. Byte counts
include the heading and separators exactly as MCP renders them; empty lists use
zero bytes. The default grid prints four variants: ranked-only 16, production
10 ranked + up to 6 related and 6 neighbours (M=5, total 16), ranked 4
(M=3, total 16, related/near quotas 6 each), and ranked 8
(M=6, total 24). The 24-card variant is an offline experiment; MCP still caps at 16.

Supply a JSON array of mix overrides to change counts, interleave order, M or total:

```sh
node eval/related/coverage.mjs "$IMPROVEMENT_QUESTIONS" "$RUN_DIR/related.json" \
  --grid '[{"counts":{"ranked":10,"related":6,"near":6},"order":["ranked",["related","near"]],"nearPerShown":5,"total":16},{"counts":{"ranked":4,"related":24,"near":24},"nearPerShown":6,"total":24}]'
```

The pure `buildRelatedList({shown, ranked, corpus, mix})` export in
`mcp-core.mjs` accepts cards or ids for shown/ranked and an array or Map for the
corpus. It returns `{id, title, brief?, source}` in final order. Counts apply to
successfully added unique cards; shown cards, Lua cards, invalid ids and unknown
targets do not consume quotas. `order` is a sequence of phases: a string consumes
that source; an array visits each shown card in order and alternates the named
sources' next targets (preserving order within each source). The default takes up
to 10 ranked leftovers, then alternates each shown card's related targets and its
first 5 stored neighbour ids before moving to the next shown card, accepting up
to 6 related and 6 neighbour targets and stopping at 16 total. These defaults were
selected from improvement-set measurements. Duplicate contributions retain the first source. `meta.related`
resolves exact chunk ids or symbol names (also accepting `tc::` and arguments).

`computeNeighbours(chunks, count=12)` in `embed.mjs` is also importable without
starting embedding. It uses primary vectors only, normalizes once, computes each
pair once, and keeps small sorted top-k lists. Ties use ascending exact ids;
zero vectors have cosine zero. Before allocating the normalization workspace, it
validates all primary vectors as arrays of finite numbers with matching dimensions
from 1 to 4096 and at most 8,388,608 workspace elements (64 MiB). Invalid vectors
fail the build with a one-line error. The normal embed command persists the resulting
`near` ids after vectors are final, even on a fully cached rebuild.

Example briefs skip generated core/addon boilerplate when later descriptive prose
exists in the card; the boilerplate remains the fallback when no description exists.
