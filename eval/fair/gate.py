#!/usr/bin/env python3
"""Fair retrieval gate: grade a new corpus against hidden, source-verified questions
and stop the deploy when it answers them worse than the accepted corpus.

  eval/fair/gate.py check  <chunks.embedded.json>   retrieve + paired judging (exit 0 = ok)
  eval/fair/gate.py accept <chunks.embedded.json>   make that corpus's passing check the baseline

Paired comparison: the baseline is the accepted corpus's retrieval output, not a stored
score. Each check judges the baseline and the candidate retrieval in the same run, with
the same model, only for the questions whose retrieved context changed (an unchanged
question contributes exactly 0), and compares the summed difference. Judge drift
between days cancels, and the noise scales with how much actually changed.

The question set and reference answers are NOT in this repo (whoever writes the
reference prose must not see them). They live in a local, non-git directory:
  FAIR_EVAL_DIR        default ~/TrussC-dev/docs-eval/fair  (needs questions.json)
Runs, scores, logs and the accepted baseline are written there too, never into the repo.
  FAIR_EVAL_MAX_DROP   allowed paired drop in score points (default 6 with Jev, 16 with luna; README.md "Threshold")
  FAIR_EVAL_JUDGE      jev (default, TypeSafe Jev; key in ~/.config/jev/key or $JEV_KEY_FILE) or luna (Codex)
  FAIR_EVAL_SKIP=1     skip the gate for one run (prints a warning)

Exit codes: 0 ok, 1 score dropped, 2 question set missing / nothing to accept,
3 retrieval or judging failed or incomplete, 4 another check holds the lock.
Printed lines carry scores only; anything that could quote a question goes to the run log.
"""
import fcntl, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.environ.get('FAIR_EVAL_DIR') or os.path.expanduser('~/TrussC-dev/docs-eval/fair')
QUESTIONS = os.path.join(DIR, 'questions.json')
CANDIDATE = os.path.join(DIR, 'candidate.json')
# The baseline is ONE file (metadata + retrieval rows), replaced atomically, so it can
# never pair one corpus's metadata with another corpus's retrieval.
ACCEPTED = os.path.join(DIR, 'accepted.json')
# The judge: TypeSafe Jev by default (owner decision, 2026-10-20); FAIR_EVAL_JUDGE=luna
# selects the older Codex judge (gpt-6-luna). Each judge has its own measured threshold
# (README.md "Threshold"); FAIR_EVAL_MAX_DROP overrides it.
_judge = os.environ.get('FAIR_EVAL_JUDGE', 'jev')
JUDGE = {'jev': 'judge_jev.py', 'luna': 'judge.py'}.get(_judge)
MAX_DROP = int(os.environ.get('FAIR_EVAL_MAX_DROP', {'jev': '6', 'luna': '16'}.get(_judge, '16')))
# Bound (realtime): a retrieval that hangs on Ollama or the reranker is killed after this. Overflow fails the check with exit 3.
RETRIEVE_TIMEOUT = int(os.environ.get('FAIR_EVAL_RETRIEVE_TIMEOUT', '1200'))


def say(msg, code):
    print(f'fair eval: {msg}')
    sys.exit(code)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, data):
    # Atomic replace, so a reader never sees a truncated file.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix='.tmp')
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def lock():
    # One check/accept at a time: they share the candidate and the baseline.
    os.makedirs(DIR, exist_ok=True)
    fd = os.open(os.path.join(DIR, '.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        say('FAILED: another fair eval check is running', 4)
    return fd


def grade(path, expected):
    """Per-id scores, or None unless the judge graded every expected id exactly once with 0/1/2."""
    try:
        rows = json.load(open(path))
    except (OSError, ValueError):
        return None
    if not isinstance(rows, list):
        return None
    out = {}
    for r in rows:
        s = r.get('score') if isinstance(r, dict) else None
        if type(s) is not int or s not in (0, 1, 2) or r.get('id') not in expected or r['id'] in out:
            return None
        out[r['id']] = s
    return out if set(out) == expected else None


def judge(run, rows, name, log, expected):
    """Judge a retrieval subset; return {id: score} or None on any failure."""
    ret = os.path.join(run, name + '-retrieval.json')
    out = os.path.join(run, name + '.json')
    write_json(ret, rows)
    with open(log, 'a') as lf:
        rc = subprocess.run([sys.executable, os.path.join(HERE, JUDGE), QUESTIONS, ret, out],
                            stdout=lf, stderr=lf).returncode
    return grade(out, expected) if rc == 0 else None


def context(row):
    # Everything the judge sees for a chunk (judge.py prints title and text), as a
    # set: the agent receives all 8 cards and the rubric asks whether the answer is
    # present, so reordering the same cards doesn't change the judged outcome.
    return sorted((str(c.get('id')), str(c.get('title')), str(c.get('text'))) for c in row.get('top', []))


def drop_candidate():
    try:
        os.unlink(CANDIDATE)           # a failed, skipped or blocked check leaves nothing to accept
    except FileNotFoundError:
        pass


def rows_by_id(rows, ids):
    """{id: row} if rows cover exactly ids once each, else None."""
    if not isinstance(rows, list):
        return None
    out = {}
    for r in rows:
        if not isinstance(r, dict) or r.get('id') not in ids or r['id'] in out or not isinstance(r.get('top'), list):
            return None
        out[r['id']] = r
    return out if set(out) == ids else None


def check(emb):
    keep = lock()
    drop_candidate()
    if os.environ.get('FAIR_EVAL_SKIP') == '1':
        say('SKIPPED (FAIR_EVAL_SKIP=1)', 0)
    if JUDGE is None:
        say('FAILED: FAIR_EVAL_JUDGE must be jev or luna', 2)
    if not os.path.isfile(QUESTIONS) or os.path.getsize(QUESTIONS) == 0:
        say(f'FAILED: question set not found at {QUESTIONS} '
            '(set FAIR_EVAL_DIR, or FAIR_EVAL_SKIP=1 to deploy without the gate)', 2)
    os.makedirs(os.path.join(DIR, 'runs'), exist_ok=True)
    run = tempfile.mkdtemp(prefix=time.strftime('%Y%m%d-%H%M%S-'), dir=os.path.join(DIR, 'runs'))
    log = os.path.join(run, 'gate.log')
    qhash = sha256(QUESTIONS)[:16]
    ids = {q['id'] for q in json.load(open(QUESTIONS))}
    # Retrieve from a private snapshot, so the hash accept checks is the corpus retrieved.
    snap = os.path.join(run, 'corpus.json')
    shutil.copyfile(emb, snap)
    ret = os.path.join(run, 'retrieval.json')
    env = dict(os.environ, EMBEDDED=snap, RERANK='1', STATS='0', FAIR_EVAL_DEBUG='1')
    with open(log, 'a') as lf:
        try:
            rc = subprocess.run(['node', os.path.join(HERE, 'retrieve.mjs'), QUESTIONS, ret],
                                env=env, stdout=lf, stderr=lf, timeout=RETRIEVE_TIMEOUT).returncode
        except subprocess.TimeoutExpired:
            rc = -1
    corpus = sha256(snap)
    os.unlink(snap)
    if rc != 0:
        say(f'FAILED: retrieval failed or timed out (rerank server or Ollama down?), see {log}', 3)
    try:
        cand_rows = rows_by_id(json.load(open(ret)), ids)
    except (OSError, ValueError):
        cand_rows = None
    if cand_rows is None:
        say(f'FAILED: retrieval output does not cover the question set, see {log}', 3)
    cand = {'questions': qhash, 'corpus': corpus, 'retrieval': ret,
            'checked': time.strftime('%Y-%m-%dT%H:%M:%S')}

    # Only a missing baseline or a changed question set re-baselines; a damaged
    # baseline fails closed instead of silently turning the comparison off.
    base, base_rows = None, None
    if os.path.exists(ACCEPTED):
        try:
            base = json.load(open(ACCEPTED))
        except (OSError, ValueError):
            say(f'FAILED: baseline {ACCEPTED} is unreadable; restore it, or remove it to re-baseline', 3)
        if not isinstance(base, dict) or not re.fullmatch(r'[0-9a-f]{16}', str(base.get('questions', ''))):
            say(f'FAILED: baseline {ACCEPTED} is malformed; restore it, or remove it to re-baseline', 3)
        if base.get('questions') == qhash:
            base_rows = rows_by_id(base.get('rows'), ids)
            if base_rows is None:
                say(f'FAILED: baseline {ACCEPTED} does not cover the question set; restore it, or remove it to re-baseline', 3)
    if base_rows is None:
        # Nothing to pair with: judge the candidate alone once, so a broken corpus
        # still fails here, and offer it as the first baseline.
        scores = judge(run, list(cand_rows.values()), 'score', log, ids)
        if scores is None:
            say(f'FAILED: judging failed or did not grade all {len(ids)} questions; rerun (see {log})', 3)
        why = 'no baseline yet' if not base else 'question set changed'
        cand['score'] = sum(scores.values())
        write_json(CANDIDATE, cand)
        say(f'{cand["score"]}/{2*len(ids)}; {why}, not compared; accept makes it the baseline', 0)

    changed = {i for i in ids if context(cand_rows[i]) != context(base_rows[i])}
    if not changed:
        write_json(CANDIDATE, cand)
        os.close(keep)
        say(f'retrieval unchanged for all {len(ids)} questions -> ok', 0)

    def paired(tag):
        b = judge(run, [base_rows[i] for i in sorted(changed)], f'base-{tag}', log, changed)
        c = judge(run, [cand_rows[i] for i in sorted(changed)], f'cand-{tag}', log, changed)
        if b is None or c is None:
            say(f'FAILED: judging failed or incomplete on the {len(changed)} changed questions; rerun (see {log})', 3)
        return sum(c.values()) - sum(b.values())

    diffs = [paired(1)]
    if diffs[0] < -MAX_DROP:
        # One judging run is noisy: grade both sides again and use the mean of the
        # paired differences, so only a drop the two runs agree on blocks.
        diffs.append(paired(2))
    change = sum(diffs) / len(diffs)
    line = (f'{len(changed)}/{len(ids)} questions retrieved differently, paired change '
            f'{change:+.1f}' + (f' (mean of {diffs[0]:+d}, {diffs[1]:+d})' if len(diffs) > 1 else '') +
            f', allowed drop {MAX_DROP}')
    if change < -MAX_DROP:
        say(line + ' -> BLOCKED', 1)
    write_json(CANDIDATE, cand)
    os.close(keep)
    say(line + ' -> ok', 0)


def accept(emb):
    keep = lock()
    try:
        cand = json.load(open(CANDIDATE))
    except (OSError, ValueError):
        say('nothing to accept: no passing check (run check first)', 2)
    if cand.get('corpus') != sha256(emb):
        say('nothing to accept: the passing check was for a different corpus file', 2)
    if not os.path.isfile(QUESTIONS) or cand.get('questions') != sha256(QUESTIONS)[:16]:
        say('nothing to accept: the question set changed since the passing check', 2)
    # The baseline is the retrieval output itself, so later checks re-judge it fresh.
    rows = json.load(open(cand['retrieval']))
    write_json(ACCEPTED, dict({k: v for k, v in cand.items() if k != 'retrieval'}, rows=rows))
    os.unlink(CANDIDATE)               # each passing check is accepted at most once
    os.close(keep)
    say('baseline is now the retrieval of this corpus', 0)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('check', 'accept'):
        print('usage: gate.py check|accept <chunks.embedded.json>', file=sys.stderr)
        sys.exit(2)
    if not os.path.isfile(sys.argv[2]):
        if sys.argv[1] == 'check':
            lock(); drop_candidate()
        say(f'FAILED: corpus not found: {sys.argv[2]}', 2)
    (check if sys.argv[1] == 'check' else accept)(sys.argv[2])
