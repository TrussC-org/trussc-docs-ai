# Fair retrieval eval (deploy gate)

Checks that a rebuilt corpus still lets an assistant answer real TrussC questions
before `update-corpus.sh` deploys it.

The questions and reference answers were written from the TrussC **source code and
examples only** (never from the reference prose), each with file:line evidence.
Whoever writes the API reference prose must not see them, or the test stops being
fair. So the set is **not in this repo**: it lives in a local, non-git directory.

| File | Where | What |
| --- | --- | --- |
| `retrieve.mjs` | here | step 1, no LLM: per question, exactly what `trussc_search` returns to the agent (the same `retrieve(query, 8)`, top 8, MCP text: full reference cards, examples cut to a head excerpt), with local bge-m3 + reranker |
| `judge.py` | here | step 2, cheap: batched grading with Codex (`gpt-6-luna`, low effort, 5 questions per call, retries on 429). Each question scores 0/1/2 against its reference answer, plus a `misleading` flag |
| `gate.py` | here | runs both, compares with the last accepted score, prints one line, and exits non-zero on a real drop |
| `questions.json` | `$FAIR_EVAL_DIR` | the hidden held-out set (168 questions, ja/en) |
| `runs/`, `candidate.json`, `accepted.json` | `$FAIR_EVAL_DIR` | per-run retrieval, scores and logs, and the baseline (one file: the accepted corpus's retrieval output plus its hashes). Never committed |

`FAIR_EVAL_DIR` defaults to `~/TrussC-dev/docs-eval/fair`. If `questions.json` is
missing there, the gate fails with exit 2 and says where it looked.

## Use

After embedding, `update-corpus.sh` runs two guards and stops before deploying if either fails.
- **Count guard:** the new chunk count may not be more than 5% below the committed `chunks.embedded.json`. `CORPUS_MAX_SHRINK=1` allows any drop, e.g. for a deliberate cleanup.
- **Fair eval:** `gate.py check chunks.embedded.json`.

After a successful deploy it runs `gate.py accept chunks.embedded.json`, which makes that corpus's retrieval output the new baseline. By hand:

```bash
python3 eval/fair/gate.py check chunks.embedded.json    # ~3 min; prints one line
python3 eval/fair/gate.py accept chunks.embedded.json   # baseline := that corpus's passing check (its retrieval)
FAIR_EVAL_SKIP=1 ./update-corpus.sh myserver            # deploy without the gate (prints SKIPPED)
```

`accept` only takes a check that passed, for the same corpus file (by SHA-256), and only once. A failed, blocked or incomplete check leaves nothing to accept. Checks and accepts hold a lock in `$FAIR_EVAL_DIR`, and `update-corpus.sh` holds its own lock, so two rebuilds can't mix baselines.

The gate needs the local services that retrieval uses (Ollama for bge-m3 and the
rerank server) and `codex` for judging. Exit codes:
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

The judge is a cheap model, so the same input doesn't always get the same score.

**Current set** (since 2026-10-20): 168 held-out questions, max 336 points.
- The set was written from source by a separate generator and kept away from everyone who writes reference prose.
- Questions testing the same fact as a question writers can see were removed.
- Grading one retrieval output 4 times gave 171, 170, 172 and 164. The paired difference on identical inputs, with all 168 questions treated as changed (the worst case), peaked at **8 points**.
- The gate blocks when the paired drop exceeds **max(2 × 8, the old 6-point floor scaled to this set's size ≈ 13) = 16 points**.
- In practice only the questions whose retrieval changed are judged, so the noise of a real comparison is usually smaller.
- Override it with `FAIR_EVAL_MAX_DROP`.

**History:** the first 80-question set measured a paired noise of 2–3 points out of 160, so its threshold was 6. That set is retired to the improvement pool, since its questions became visible to writers.

When `questions.json` changes, its hash no longer matches the baseline. The gate then judges the candidate alone and reports it without comparing, until the next `accept`.
