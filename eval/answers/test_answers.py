"""Offline answer-judge and paired-comparison regressions; all inputs are synthetic."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import compare
import judge_jev as judge


class AnswersTest(unittest.TestCase):
    def test_ids(self):
        self.assertEqual(list(judge.index_rows([{'id': 'q1'}, {'id': '1'}])), ['q1', '1'])
        for value in [1, 1.5, '', '  ', None, True, [], {}]:
            with self.subTest(id=value), self.assertRaisesRegex(judge.InvalidId, '^ids must be non-empty strings$'):
                judge.index_rows([{'id': value}])
        with self.assertRaisesRegex(judge.InvalidId, '^ids must be non-empty strings$'):
            judge.index_rows([{}])
        with tempfile.TemporaryDirectory(prefix='answer-eval-ids-') as directory:
            root = Path(directory)
            invalid = root / 'invalid.json'
            invalid.write_text('[{"id": 1}]', encoding='utf-8')
            valid = root / 'valid.json'
            valid.write_text('[{"id": "q"}]', encoding='utf-8')
            key = root / 'key'
            key.write_text('synthetic-key', encoding='utf-8')
            for script, inputs in [
                ('judge_jev.py', [invalid, valid, root / 'out.json']),
                ('judge_jev.py', [valid, invalid, root / 'out.json']),
                ('compare.py', [invalid, valid, valid]),
                ('compare.py', [valid, invalid, valid]),
                ('compare.py', [valid, valid, invalid]),
                ('compare.py', [valid, valid, valid, invalid, valid]),
                ('compare.py', [valid, valid, valid, valid, invalid]),
            ]:
                with self.subTest(script=script, inputs=inputs):
                    result = subprocess.run([sys.executable, str(Path(__file__).with_name(script)), *map(str, inputs)],
                                            env={**os.environ, 'JEV_KEY_FILE': str(key)}, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout, '')
                    self.assertEqual(result.stderr, f'{Path(script).stem}: ids must be non-empty strings\n')

    def test_threshold(self):
        for p, expected in [(0, 0), (.3, 0), (.300001, 1), (.5, 1), (.699999, 1), (.7, 2), (1, 2)]:
            self.assertEqual(judge.score_of(p)[0], expected)
        self.assertEqual(judge.score_of(.65, .2)[0], 2)
        for p in [True, None, '0.9', -1, 2, float('nan')]:
            with self.assertRaises(ValueError):
                judge.prob({'answers': {'correct': {'noul': p}}}, 'correct')

    def test_http_and_failure_rows(self):
        question = {'id': 'q', 'question': 'SYNTHETIC QUESTION', 'answer': 'SYNTHETIC REFERENCE'}
        answer = {'id': 'q', 'text': 'SYNTHETIC CHAT'}
        raw = json.dumps({'answers': {'correct': {'noul': .7}, 'wrong': {'noul': .5}}}).encode()
        with patch.object(judge.OPENER, 'open', return_value=io.BytesIO(raw)) as http:
            result = judge.judge(question, answer, 'synthetic-key')
        self.assertEqual((result['score'], result['wrong'], result['failed']), (2, True, False))
        req = http.call_args.args[0]
        self.assertEqual(req.full_url, 'https://api.typesafe.ai/v1/systemone')
        self.assertEqual(req.get_header('Authorization'), 'Bearer synthetic-key')
        payload = json.loads(req.data)
        self.assertEqual(payload['state'], {'question': question['question'], 'reference_answer': question['answer'], 'chat_answer': answer['text']})
        self.assertEqual(set(payload['questions']), {'correct', 'wrong'})
        with patch.object(judge.OPENER, 'open') as http:
            self.assertEqual(judge.judge(question, {'error': 'answer failed'}, 'synthetic-key'),
                             {'id': 'q', 'score': 0, 'wrong': False, 'failed': True})
            http.assert_not_called()
        with patch.object(judge.OPENER, 'open', side_effect=urllib.error.HTTPError(req.full_url, 401, 'PRIVATE DETAIL', {}, None)):
            result = judge.judge(question, answer, 'synthetic-key')
        self.assertIsNone(result['score'])
        self.assertFalse(result['failed'])
        self.assertEqual(result['error'], 'judge failed (HTTP 401)')
        with patch.object(judge.OPENER, 'open', side_effect=ValueError('PRIVATE DETAIL')) as http, patch.object(judge.time, 'sleep'):
            result = judge.judge(question, answer, 'synthetic-key')
        self.assertEqual(http.call_count, 6)
        self.assertNotIn('PRIVATE DETAIL', json.dumps(result))
        self.assertIsNone(judge.NoRedirect().redirect_request(req, None, 302, '', {}, 'https://elsewhere.invalid'))

    def test_response_bound(self):
        with self.assertRaises(ValueError):
            judge.read_bounded(io.BytesIO(b'x' * (judge.MAX_RESPONSE + 1)), float('inf'))
        with self.assertRaises(TimeoutError):
            judge.read_bounded(io.BytesIO(b'{}'), 0)

    def test_synthetic_files(self):
        with tempfile.TemporaryDirectory(prefix='answer-eval-') as directory:
            root = Path(directory)

            def save(name, data):
                path = root / name
                path.write_text(json.dumps(data), encoding='utf-8')
                return str(path)

            questions = [{'id': 'a', 'question': 'PRIVATE SYNTHETIC A', 'answer': 'REF A', 'lang': 'ja', 'type': 'api'},
                         {'id': 'b', 'question': 'PRIVATE SYNTHETIC B', 'answer': 'REF B', 'lang': 'en', 'type': 'api'},
                         {'id': 'c', 'question': 'PRIVATE SYNTHETIC C', 'answer': 'REF C', 'lang': 'en', 'type': 'example'}]
            qf = save('questions.json', questions)
            answers = [{'id': 'a', 'text': 'CHAT A', 'inputTokens': 100, 'outputTokens': 20, 'jevEstimatedTokens': 200, 'rounds': 1, 'ms': 50},
                       {'id': 'b', 'text': 'CHAT B', 'inputTokens': 300, 'outputTokens': 40, 'jevEstimatedTokens': 400, 'rounds': 3, 'ms': 150},
                       {'id': 'c', 'text': '', 'error': 'answer failed', 'inputTokens': None, 'outputTokens': None, 'jevEstimatedTokens': None, 'rounds': 0, 'ms': 10}]
            af = save('answers.json', list(reversed(answers)))
            key = root / 'key'
            key.write_text('synthetic-key')
            jf = str(root / 'judge.json')
            probabilities = iter([(.7, .1), (.5, .9)])

            def response(*args, **kwargs):
                p, w = next(probabilities)
                return io.BytesIO(json.dumps({'answers': {'correct': {'noul': p}, 'wrong': {'noul': w}}}).encode())

            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.dict(os.environ, {'JEV_KEY_FILE': str(key)}), patch.object(judge.OPENER, 'open', side_effect=response), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(judge.main([qf, af, jf, '--jobs', '1']), 0)
            self.assertEqual(stdout.getvalue(), '')
            self.assertEqual(len(stderr.getvalue().splitlines()), 1)
            self.assertIn('score 3/6  full 1  unsure 1  wrong 1  failed 1', stderr.getvalue())
            rows = json.loads(Path(jf).read_text())
            self.assertEqual([r['id'] for r in rows], ['a', 'b', 'c'])
            self.assertTrue(rows[2]['failed'])
            changed = [{'id': 'c', 'score': 0, 'wrong': False, 'failed': False},
                       {'id': 'b', 'score': 2, 'wrong': False, 'failed': False},
                       {'id': 'a', 'score': 0, 'wrong': False, 'failed': False}]
            bf = save('judgeB.json', changed)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertEqual(compare.main([qf, jf, bf, af, af]), 0)
            report = json.loads(stdout.getvalue())
            self.assertEqual((report['A']['score'], report['B']['score'], report['delta']), (3, 2, -1))
            self.assertEqual((report['better'], report['worse'], report['tied']), (1, 1, 1))
            self.assertEqual(report['changedIds'], ['a', 'b', 'c'])
            self.assertEqual({r['value']: r['delta'] for r in report['lang']}, {'ja': -2, 'en': 1})
            self.assertEqual({r['value']: r['n'] for r in report['type']}, {'api': 2, 'example': 1})
            means = report['means']['A']
            self.assertEqual(means['haikuTokens'], {'mean': 230, 'n': 2})
            self.assertEqual(means['jevEstimatedTokens'], {'mean': 300, 'n': 2})
            self.assertEqual(means['rounds']['mean'], 4 / 3)
            self.assertEqual(means['ms']['mean'], 70)
            for text in ['PRIVATE SYNTHETIC', 'REF A', 'CHAT A', 'synthetic-key']:
                self.assertNotIn(text, Path(jf).read_text() + stdout.getvalue() + stderr.getvalue())
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(compare.main([qf, jf, bf]), 0)
            with self.assertRaises(ValueError):
                compare.compare(judge.index_rows(questions), judge.index_rows(rows), judge.index_rows(changed[:1]))
            rows[0]['score'] = None
            with self.assertRaises(ValueError):
                compare.compare(judge.index_rows(questions), judge.index_rows(rows), judge.index_rows(changed))
            with self.assertRaises(ValueError):
                judge.index_rows([{'id': 'duplicate'}, {'id': 'duplicate'}])


if __name__ == '__main__':
    unittest.main()
