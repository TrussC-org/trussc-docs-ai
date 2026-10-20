#!/usr/bin/env python3
"""Fair eval judge on TypeSafe Jev (the deploy gate's default judge; owner rule, 2026-10-20).

For each question, Jev gets the question, the source-verified reference answer and the
retrieved cards (exactly what the agent receives), and answers two yes/no questions:
  covers     - do the cards contain the reference answer's facts?
  misleading - do the cards contradict the reference answer?
Score: if the certainty |p - 0.5| * 2 of `covers` is below 0.4, score 1 (Jev is unsure);
otherwise 2 if p >= 0.5, else 0. misleading = p(misleading) >= 0.5. No fallback questions
and no second-stage judge.

Same output contract as judge.py: [{"id", "score", "misleading", ...}].
Usage: judge_jev.py <questions.json> <retrieval.json> <out.json> [--model jev-latest] [--jobs 8]
The API key is read from ~/.config/jev/key (or $JEV_KEY_FILE). It is never printed, logged
or written anywhere.
"""
import argparse, concurrent.futures as cf, json, os, sys, time, urllib.error, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('questions'); ap.add_argument('retrieval'); ap.add_argument('out')
ap.add_argument('--model', default='jev-latest')
# Bound (realtime): eight requests in flight keep a 168-question run under a minute without flooding the API. Overflow just queues and is not reported.
ap.add_argument('--jobs', type=int, default=8)
# Bound (cache): the judge sees what the agent sees; this only guards against a runaway card, far above the ~10k-character card cap. Overflow truncates the card text and is not reported.
ap.add_argument('--chars', type=int, default=20000, help='max characters kept per retrieved card')
ap.add_argument('--threshold', type=float, default=0.4, help='covers certainty below this scores 1')
a = ap.parse_args()

KEY_FILE = os.path.expanduser(os.environ.get('JEV_KEY_FILE', '~/.config/jev/key'))
try:
    KEY = open(KEY_FILE).read().strip()
except OSError:
    sys.exit(f'judge_jev: no Jev API key at {KEY_FILE} (set JEV_KEY_FILE)')
if not KEY:
    sys.exit(f'judge_jev: the Jev API key file {KEY_FILE} is empty')

Q = {q['id']: q for q in json.load(open(a.questions))}
R = {r['id']: r for r in json.load(open(a.retrieval))}
ids = [i for i in Q if i in R]

QUESTIONS = {
    'covers': {'type': 'noul',
               'instructions': 'Do the search results in state.context contain the facts of state.reference_answer, '
                               'so that the user question can be answered correctly from them alone?',
               'criteria': {'true': 'Yes: the search results state the reference answer clearly enough',
                            'false': 'No: the information is missing, only partly there, or must be guessed'}},
    'misleading': {'type': 'noul',
                   'instructions': 'Do the search results state something that contradicts the reference answer?',
                   'criteria': {'true': 'At least one search result contradicts the reference answer',
                                'false': 'Nothing in the search results contradicts the reference answer'}},
}


def score_of(p):
    certainty = abs(p - 0.5) * 2
    if certainty < a.threshold:
        return 1, certainty
    return (2 if p >= 0.5 else 0), certainty


def prob(d, name):
    p = d['answers'][name]['noul']
    if type(p) not in (int, float) or not 0 <= p <= 1:
        raise ValueError(f'bad {name} probability')
    return float(p)


def call(i):
    q, r = Q[i], R[i]
    state = {'question': q['question'], 'reference_answer': q['answer'],
             'context': [{'title': c['title'], 'text': c['text'][:a.chars]} for c in r['top']]}
    body = json.dumps({'model': a.model, 'state': state, 'questions': QUESTIONS}).encode()
    err = ''
    # Bound (realtime): six attempts with exponential back-off for rate limits and network errors. Overflow leaves the question ungraded, which the gate reports as incomplete judging.
    for t in range(6):
        req = urllib.request.Request('https://api.typesafe.ai/v1/systemone', data=body, method='POST',
                                     headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
        try:
            # Bound (realtime): one request may take at most 120 s; Bound (cache): read at most 1 MiB of response. Overflow fails that attempt and is retried.
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read(1 << 20 | 1)
            if len(raw) > 1 << 20:
                raise ValueError('response too large')
            d = json.loads(raw)
            p, m = prob(d, 'covers'), prob(d, 'misleading')
            s, c = score_of(p)
            return {'id': i, 'score': s, 'misleading': m >= 0.5, 'covers_p': p, 'certainty': round(c, 3), 'misleading_p': m}
        except urllib.error.HTTPError as e:
            err = f'HTTP {e.code}'
            if e.code in (429, 500, 502, 503, 529):
                time.sleep(2 ** t); continue
            return {'id': i, 'score': None, 'misleading': None, 'error': err}
        except Exception as e:  # network hiccup or malformed answer: retry
            err = type(e).__name__; time.sleep(2 ** t)
    return {'id': i, 'score': None, 'misleading': None, 'error': f'retries exhausted ({err})'}


t0 = time.time()
with cf.ThreadPoolExecutor(a.jobs) as ex:
    res = list(ex.map(call, ids))
json.dump(res, open(a.out, 'w'), indent=1)
ok = [x for x in res if isinstance(x.get('score'), int)]
print(f"{a.retrieval}: graded {len(ok)}/{len(ids)} in {time.time() - t0:.0f}s  score {sum(x['score'] for x in ok)}/{2 * len(ok)}  "
      f"full {sum(x['score'] == 2 for x in ok)}  unsure {sum(x['score'] == 1 for x in ok)}  misleading {sum(x['misleading'] for x in ok)}")
