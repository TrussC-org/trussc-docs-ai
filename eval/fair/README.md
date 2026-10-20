# Fair retrieval eval (deploy gate)

Checks that a rebuilt corpus still lets an assistant answer real TrussC questions
before `update-corpus.sh` deploys it.

The questions and reference answers were written from the TrussC **source code and
examples only** (never from the reference prose), each with file:line evidence.
Whoever writes the API reference prose must not see them, or the test stops being
fair. So the set is **not in this repo**: it lives in a local, non-git directory.

| File | Where | What |
| --- | --- | --- |
| `retrieve.mjs` | here | step 1, no LLM: per question, exactly what `trussc_search` returns to the agent (the same `retrieve(query, 8)`, top 8, MCP text: full reference cards, examples cut to a head excerpt), with local bge-m3 + Jev selection (requires `TYPESAFE_API_KEY` in the environment; refuses fallback) |
| `judge_jev.py` | here | step 2, the default judge: TypeSafe Jev answers two yes/no questions per question. **covers**: do the cards contain the reference answer's facts? **misleading**: do they contradict it? Score 1 if the covers certainty \|p−0.5\|×2 is below 0.4 (Jev unsure), else 2 if p ≥ 0.5, else 0. The key is read from `~/.config/jev/key` (or `$JEV_KEY_FILE`) and is never printed or stored |
| `judge.py` | here | the older judge (`FAIR_EVAL_JUDGE=luna`): batched grading with Codex (`gpt-6-luna`, low effort). Same 0/1/2 + `misleading` output |
| `gate.py` | here | runs both, compares with the last accepted score, prints one line, and exits non-zero on a real drop |
| `questions.json` | `$FAIR_EVAL_DIR` | the hidden held-out set (168 questions, ja/en) |
| `runs/`, `candidate.json`, `accepted.json` | `$FAIR_EVAL_DIR` | per-run retrieval, scores and logs, and the baseline (one file: the accepted corpus's retrieval output plus its hashes). Never committed |

`FAIR_EVAL_DIR` defaults to `~/TrussC-dev/docs-eval/fair`. If `questions.json` is
missing there, the gate fails with exit 2 and says where it looked.

## Use

After embedding, `update-corpus.sh` runs two guards and stops before deploying if either fails.
- **Count guard:** the new chunk count may not be more than 5% below the live `chunks.embedded.json`. `CORPUS_MAX_SHRINK=1` allows any drop, e.g. for a deliberate cleanup. With no live corpus it stops unless `--first-deploy` is given.
- **Fair eval:** `gate.py check chunks.embedded.next.json` (the new corpus, before the swap).

After a successful deploy (for `--local`, after the health check) it runs `gate.py accept chunks.embedded.json`, the same bytes after the swap, which makes that corpus's retrieval output the new baseline. By hand:

```bash
python3 eval/fair/gate.py check chunks.embedded.json    # ~3 min; prints one line
python3 eval/fair/gate.py accept chunks.embedded.json   # baseline := that corpus's passing check (its retrieval)
FAIR_EVAL_SKIP=1 ./update-corpus.sh --local             # deploy without the gate (prints SKIPPED)
```

`accept` only takes a check that passed, for the same corpus file (by SHA-256), and only once. A failed, blocked or incomplete check leaves nothing to accept. Checks and accepts hold a lock in `$FAIR_EVAL_DIR`, and `update-corpus.sh` holds its own lock, so two rebuilds can't mix baselines.

The gate needs Ollama for bge-m3 and `TYPESAFE_API_KEY` in the environment for Jev
retrieval. The retrieval batch paces calls under its per-IP window and fails rather
than measuring fallback output. Judging separately needs the Jev key (or `codex` with `FAIR_EVAL_JUDGE=luna`) for judging. Exit codes:
- 0: ok, or no comparable baseline yet;
- 1: score dropped;
- 2: question set missing, or nothing to accept;
- 3: retrieval or judging failed, or the judge didn't grade every question exactly once with 0, 1 or 2;
- 4: another check is running.

Logs and outputs that could quote questions go only to `$FAIR_EVAL_DIR/runs/`. The printed line has scores only.

## Paired comparison

The baseline is the accepted corpus's **retrieval output**, not a stored score. Each check:
1. retrieves with the new corpus;
2. finds the questions whose set of retrieved cards changed, compared as a set: the agent gets all 8, and the rubric asks whether the answer is present, so a pure reorder counts as unchanged (an unchanged question contributes exactly 0);
3. judges the baseline and the candidate retrieval for those questions only, in the same run with the same model;
4. sums the paired difference (candidate − baseline).

Judge drift between days cancels, and noise scales with how much actually changed. When the paired drop exceeds the threshold, both sides are judged once more and the **mean** of the two paired differences decides, never the better score. If that second run fails, the gate reports a judging failure (exit 3), not a confirmed drop. `accept` stores the new retrieval output as the baseline. The printed line shows how many questions changed and the paired change.

## Threshold

The same input doesn't always get the same score, so the threshold is measured per judge.

**Current set** (since 2026-10-20): 168 held-out questions, max 336 points. It was written from source by a separate generator and kept away from everyone who writes reference prose, and questions testing the same fact as a writer-visible question were removed.

**Jev (default):**
- Grading one retrieval output 10 times gave totals from 114 to 117. All ten runs agreed on 160 of 168 questions.
- The paired difference on identical inputs, with all 168 questions treated as changed (the worst case), peaked at **3 points**.
- The gate blocks when the paired drop exceeds **max(2 × 3, a floor of 4) = 6 points**.
- A run takes about 5 seconds.
- Jev's totals run lower than luna's, because unsure answers score 1. The paired comparison judges both sides with the same judge, so that doesn't matter.

**luna** (`FAIR_EVAL_JUDGE=luna`): 4 runs gave 171, 170, 172 and 164, a worst-case paired difference of **8**, so its threshold is **16**.

Only questions whose set of top-8 cards changed are judged, so the noise of a real comparison is usually smaller than the worst case. Override the threshold with `FAIR_EVAL_MAX_DROP`.

**History:** the first 80-question set measured a paired noise of 2–3 points out of 160, so its threshold was 6. That set is retired to the improvement pool, since its questions became visible to writers.

When `questions.json` changes, its hash no longer matches the baseline. The gate then judges the candidate alone and reports it without comparing, until the next `accept`.
