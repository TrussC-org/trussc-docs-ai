#!/usr/bin/env python3
"""Paired answer evaluation. Output contains ids, group labels and aggregates only."""
import argparse
import json
import math
import sys
from judge_jev import InvalidId, load_rows


def totals(rows):
    return {'score': sum(r['score'] for r in rows), 'max': 2 * len(rows),
            'full': sum(r['score'] == 2 for r in rows), 'unsure': sum(r['score'] == 1 for r in rows),
            'wrong': sum(r['wrong'] for r in rows), 'failed': sum(r['failed'] for r in rows)}


def paired(ids, a, b):
    ta, tb = totals([a[i] for i in ids]), totals([b[i] for i in ids])
    return {'n': len(ids), 'A': ta, 'B': tb, 'delta': tb['score'] - ta['score'],
            'better': sum(b[i]['score'] > a[i]['score'] for i in ids),
            'worse': sum(b[i]['score'] < a[i]['score'] for i in ids),
            'tied': sum(b[i]['score'] == a[i]['score'] for i in ids),
            'changedIds': [i for i in ids if any(a[i][f] != b[i][f] for f in ('score', 'wrong', 'failed'))]}


def metrics(ids, answers):
    def number(value):
        return type(value) in (int, float) and math.isfinite(value) and value >= 0

    values = {field: [] for field in ('inputTokens', 'outputTokens', 'haikuTokens', 'jevEstimatedTokens', 'rounds', 'ms')}
    for i in ids:
        row = answers[i]
        for field in values:
            value = row.get(field)
            if field == 'haikuTokens':
                inp, out = row.get('inputTokens'), row.get('outputTokens')
                value = inp + out if number(inp) and number(out) else None
            if number(value):
                values[field].append(value)
    # Unreported usage stays unknown rather than becoming free traffic.
    return {field: {'mean': sum(v) / len(v) if v else None, 'n': len(v)} for field, v in values.items()}


def compare(questions, a, b, answers_a=None, answers_b=None):
    if a.keys() != b.keys() or a.keys() - questions.keys():
        raise ValueError('judge files must contain the same ids, all present in questions')
    for row in [*a.values(), *b.values()]:
        if type(row.get('score')) is not int or row['score'] not in (0, 1, 2) or any(type(row.get(f)) is not bool for f in ('wrong', 'failed')):
            raise ValueError('judge files must be fully graded with score, wrong and failed')
    ids = [i for i in questions if i in a]
    if answers_a is not None and (a.keys() - answers_a.keys() or a.keys() - answers_b.keys()):
        raise ValueError('answers must contain every paired id')

    def report(group):
        result = paired(group, a, b)
        if answers_a is not None:
            result['means'] = {'A': metrics(group, answers_a), 'B': metrics(group, answers_b)}
        return result

    result = report(ids)
    for field in ('lang', 'type'):
        groups = {}
        for i in ids:
            label = questions[i].get(field)
            if label is not None and not isinstance(label, str):
                raise ValueError('lang/type must be strings or null')
            groups.setdefault(label, []).append(i)
        result[field] = [{'value': label, **report(group)} for label, group in groups.items()]
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('questions')
    ap.add_argument('judgeA')
    ap.add_argument('judgeB')
    ap.add_argument('answers', nargs='*', metavar='answersA answersB')
    a = ap.parse_args(argv)
    if len(a.answers) not in (0, 2):
        ap.error('provide both answersA and answersB, or neither')
    answers = [load_rows(path) for path in a.answers]
    result = compare(load_rows(a.questions), load_rows(a.judgeA), load_rows(a.judgeB), *answers)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except InvalidId:
        sys.exit('compare: ids must be non-empty strings')
    except (ValueError, OSError, KeyError):
        sys.exit('compare: invalid or incomplete inputs (paired ids and fully graded scores are required)')
