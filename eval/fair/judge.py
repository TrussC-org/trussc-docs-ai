#!/usr/bin/env python3
"""Fair eval, step 2: cheap batched judging with Codex (default gpt-6-luna, low effort).
Each question is scored against its source-verified reference answer, for ONE corpus at a time,
so runs are comparable over time (no pairing needed).
Usage: judge.py <questions.json> <retrieval.json> <out-scores.json> [--model M] [--effort E] [--batch N] [--jobs P]
Score: 2 = context states the answer correctly and sufficiently; 1 = partial; 0 = absent.
'misleading' = context states something that contradicts the reference answer."""
import json, sys, os, subprocess, tempfile, argparse, concurrent.futures as cf
ap = argparse.ArgumentParser()
ap.add_argument('questions'); ap.add_argument('retrieval'); ap.add_argument('out')
ap.add_argument('--model', default='gpt-6-luna'); ap.add_argument('--effort', default='low')
# Bound (realtime): five questions per call and two calls at a time keep prompts cheap and stay under shared rate limits. Overflow just takes more calls and is not reported.
ap.add_argument('--batch', type=int, default=5); ap.add_argument('--jobs', type=int, default=2)
# Bound (cache): long chunks are cut so a batch prompt stays small and cheap. Overflow truncates the chunk text and is not reported.
ap.add_argument('--chars', type=int, default=2500, help='max characters kept per retrieved chunk')
ap.add_argument('--timeout', type=int, default=300, help='seconds per Codex call')
a = ap.parse_args()
Q = {q['id']: q for q in json.load(open(a.questions))}
R = {r['id']: r for r in json.load(open(a.retrieval))}
ids = [i for i in Q if i in R]
HEAD = """You grade search results for a documentation assistant about the TrussC C++ framework.
For each question you get the question, a REFERENCE ANSWER that was verified against the source code, and the search results (CONTEXT).
Grade only what the CONTEXT says, compared with the REFERENCE ANSWER. Do not use outside knowledge.
score: 2 = the context states the reference answer clearly enough to answer correctly; 1 = partially (related, but key part missing or must be guessed); 0 = absent.
If the reference answer marks parts as "Optional detail", their absence never lowers the score. If the question asks several things, 2 needs every required part.
misleading: true if the context states something that contradicts the reference answer.
Output ONLY a JSON array: [{"id": "...", "score": 0|1|2, "misleading": true|false}] with one item per question, nothing else.
"""
def block(i):
    q, r = Q[i], R[i]
    ctx = '\n'.join(f"[{k+1}] {c['title']}\n{c['text'][:a.chars]}" for k, c in enumerate(r['top']))
    return f"\n##### {i}\nQUESTION: {q['question']}\nREFERENCE ANSWER: {q['answer']}\nCONTEXT:\n{ctx}\n"
def valid(r, batch):
    # Exactly the asked ids, once each, scored 0/1/2 (bool is not a score).
    return (isinstance(r, list) and len(r) == len(batch)
            and all(isinstance(x, dict) and type(x.get('score')) is int and x['score'] in (0, 1, 2) for x in r)
            and sorted(str(x.get('id')) for x in r) == sorted(batch))
def run(batch, tries=4):
    import time
    # Bound (realtime): a failing batch is retried a few times with back-off. Overflow leaves it ungraded and is reported by the gate as incomplete judging.
    for t in range(tries):
        r = run1(batch)
        if valid(r, batch):
            # Keep only the graded fields; anything else the model adds is dropped.
            return [{'id': str(x['id']), 'score': x['score'], 'misleading': x.get('misleading') is True} for x in r]
        time.sleep(20 * (t + 1))   # back off (429 rate limits are shared with other Codex users)
    return [{'id': i, 'score': None, 'misleading': None, 'error': 'invalid'} for i in batch]
def limit_writes():
    import resource
    # Bound (cache): the Codex child may not write any file larger than 64 MiB (its answer is a few hundred bytes). Overflow kills that call, which is retried, then reported as ungraded.
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 << 20, 64 << 20))
def run1(batch):
    prompt = HEAD + ''.join(block(i) for i in batch)
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as tf: outp = tf.name
    try:
        # Bound (realtime): a stalled Codex call is killed after --timeout seconds. Overflow fails that attempt and is retried, then reported as ungraded.
        subprocess.run(['codex', 'exec', '-s', 'read-only', '-m', a.model, '-c', f'model_reasoning_effort="{a.effort}"',
                        '--skip-git-repo-check', '--ephemeral', '-o', outp, '-'], input=prompt, text=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=tempfile.gettempdir(), timeout=a.timeout,
                       preexec_fn=limit_writes)
    except (subprocess.TimeoutExpired, OSError):
        pass
    # Bound (cache): a batch answer is a few hundred bytes; read at most 64 KiB. Overflow is treated as an unparseable answer and retried, then reported as ungraded.
    txt = ''
    if os.path.exists(outp):
        with open(outp, 'rb') as f: raw = f.read(65537)
        os.unlink(outp)
        txt = '' if len(raw) > 65536 else raw.decode('utf-8', 'replace').strip()
    txt = txt[txt.find('['): txt.rfind(']') + 1]
    try: return json.loads(txt)
    except Exception: return [{'id': i, 'score': None, 'misleading': None, 'error': 'parse'} for i in batch]
batches = [ids[k:k + a.batch] for k in range(0, len(ids), a.batch)]
res = []
with cf.ThreadPoolExecutor(a.jobs) as ex:
    for out in ex.map(run, batches): res += out
json.dump(res, open(a.out, 'w'), indent=1)
ok = [x for x in res if isinstance(x.get('score'), int)]
print(f"{a.retrieval}: graded {len(ok)}/{len(ids)}  score {sum(x['score'] for x in ok)}/{2*len(ok)}  "
      f"full {sum(1 for x in ok if x['score']==2)}  misleading {sum(1 for x in ok if x.get('misleading'))}")
