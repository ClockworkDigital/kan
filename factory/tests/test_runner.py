import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('factory_runner', SOURCE / 'runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class SimulatedFactory(runner.Factory):
    def __init__(self, root):
        super().__init__(root)
        self.calls = []
        self.fail_gate = False
        self.review_changes = False
        self.protect = False

    def agent(self, job, role):
        self.calls.append(role)
        if role == 'intake':
            return dict(summary='Add behaviour', decision='accept', risk='low', surfaces=[],
                        risk_factors=[], risk_reason='Localized reversible behaviour')
        if role == 'spec':
            return dict(summary='Add behaviour', acceptance=['The feature works'])
        if role == 'build':
            (Path(job['worktree']) / ('factory/config.json' if self.protect else 'feature.txt')).write_text(str(job['round']))
            return dict(summary='Built', verdict='ready', findings=[])
        return dict(summary='Reviewed', verdict='changes' if self.review_changes else 'pass', findings=[])

    def check(self, job, baseline=False):
        evidence = super().check(job, baseline)
        if self.fail_gate and not baseline:
            evidence['passed'] = False
        return evidence


class FactoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'factory-test@example.invalid')
        self.git('config', 'user.name', 'Factory Test')
        (self.root / 'factory').mkdir()
        config = json.loads((SOURCE / 'config.json').read_text())
        config['setup'] = []
        config['checks'] = [[sys.executable, '-c', 'print("checked")']]
        (self.root / 'factory/config.json').write_text(json.dumps(config))
        (self.root / 'factory/runner.py').write_text('# fixture')
        (self.root / 'app.txt').write_text('baseline')
        self.git('add', '.')
        self.git('commit', '-m', 'baseline')
        remote = Path(self.temp.name) / 'remote.git'
        subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
        self.git('remote', 'add', 'origin', str(remote))
        self.git('push', '-u', 'origin', 'main')
        self.factory = SimulatedFactory(self.root)

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()

    def job(self):
        return self.factory.create('Add a useful feature')

    def test_full_flow_is_ready_without_publishing_or_merging(self):
        initial = self.git('rev-parse', 'HEAD')
        job = self.factory.run(self.job())
        self.assertEqual(job['stage'], 'ready')
        self.assertEqual(self.factory.calls, ['intake', 'spec', 'build', 'review'])
        self.assertEqual(job['gate']['commit'], job['reviews']['review']['commit'])
        self.assertIsNone(job['pr'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), initial)
        self.assertEqual(self.git('ls-remote', '--heads', 'origin').count('\n'), 0)
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_gate_failure_skips_review_and_stops_at_round_cap(self):
        self.factory.fail_gate = True
        job = self.factory.run(self.job())
        self.assertEqual(job['stage'], 'needs-human')
        self.assertEqual(job['round'], 3)
        self.assertNotIn('review', self.factory.calls)
        with self.assertRaises(runner.Refused):
            self.factory.rework(job, 'Try again')

    def test_review_feedback_returns_to_builder(self):
        self.factory.review_changes = True
        job = self.factory.run(self.job())
        self.assertEqual(job['stage'], 'needs-human')
        self.assertEqual(self.factory.calls.count('review'), 3)
        self.assertIn('review', job['feedback'])

    def test_protected_change_stops_before_gate(self):
        self.factory.protect = True
        job = self.job()
        with self.assertRaisesRegex(runner.Refused, 'protected'):
            self.factory.run(job)
        self.assertEqual(self.factory.load(job['id'])['stage'], 'needs-human')
        self.assertFalse((self.factory.folder(job) / 'gate-1.json').exists())

    def test_one_active_job_and_nonblocking_lock(self):
        self.job()
        with self.assertRaises(runner.Refused):
            self.job()
        with self.factory.lock():
            with self.assertRaisesRegex(runner.Refused, 'active'):
                with runner.Factory(self.root).lock():
                    self.fail('second lock acquired')

    def test_interrupted_agent_requires_explicit_rework(self):
        job = self.job()
        job['attempts'] = [dict(status='running', role='build')]
        self.factory.save(job)
        result = self.factory.run(job)
        self.assertEqual(result['stage'], 'needs-human')
        self.assertEqual(self.factory.calls, [])
        result = self.factory.rework(result, 'I inspected the interruption; retry')
        self.assertEqual(result['stage'], 'ready')

    def test_stale_head_refuses_publish_before_github(self):
        job = self.factory.run(self.job())
        self.factory.git('commit', '--allow-empty', '-m', 'later change', cwd=job['worktree'])
        with self.assertRaisesRegex(runner.Refused, 'Stale gate'):
            self.factory.publish(job)

    def test_baseline_failure_never_invokes_models(self):
        self.factory.config['checks'] = [[sys.executable, '-c', 'raise SystemExit(1)']]
        with self.assertRaisesRegex(runner.Refused, 'Baseline'):
            self.factory.run(self.job())
        self.assertEqual(self.factory.calls, [])

    def test_schema_rejects_invalid_verdict(self):
        with self.assertRaises(runner.Refused):
            runner.validate(dict(summary='x', verdict='approve', findings=[]), runner.schema('review'))
        with self.assertRaises(runner.Refused):
            runner.validate(dict(summary='x', acceptance=[]), runner.schema('spec'))

    def test_explicit_issue_accepts_unlabeled_open_issue(self):
        issue = dict(number=1, title='Small change', body='Requirements', labels=[], state='OPEN')
        with patch.object(self.factory, 'checked', return_value=json.dumps(issue)):
            self.assertEqual(json.loads(self.factory.issue_request(1, require_label=False)), issue)
            with self.assertRaisesRegex(runner.Refused, 'not labeled'):
                self.factory.issue_request(1)

    def test_closed_issue_is_rejected_even_when_explicit(self):
        issue = dict(number=1, title='Closed', body='', labels=[], state='CLOSED')
        with patch.object(self.factory, 'checked', return_value=json.dumps(issue)):
            with self.assertRaisesRegex(runner.Refused, 'closed'):
                self.factory.issue_request(1, require_label=False)

    def test_queue_queries_only_configured_label(self):
        self.factory.config['queue_label'] = 'factory-ready'
        with patch.object(self.factory, 'checked', return_value='[]') as checked:
            self.assertIsNone(self.factory.queue())
        args = checked.call_args.args[0]
        self.assertEqual(args[args.index('--label') + 1], 'factory-ready')

    def test_risk_factors_force_high_and_security_review(self):
        intake = dict(risk='low', risk_factors=['access-control'], surfaces=[])
        runner.classify_intake(intake)
        self.assertEqual(intake['risk'], 'high')
        self.assertEqual(intake['surfaces'], ['security'])
        data = runner.classify_intake(dict(risk='medium', risk_factors=['destructive-data-change'], surfaces=[]))
        self.assertEqual(data['risk'], 'high')
        self.assertEqual(data['surfaces'], [])
        gameplay = runner.classify_intake(dict(risk='low', risk_factors=['business-integrity'], surfaces=[]))
        self.assertEqual(gameplay['risk'], 'high')
        self.assertEqual(gameplay['surfaces'], ['security'])

    def test_model_routing_limits_astra_to_selected_roles(self):
        job = dict(config=self.factory.config, intake=dict(risk='low'))
        self.assertEqual(runner.role_profile(job, 'spec')['model'], 'gpt-6.1-sol')
        self.assertEqual(runner.role_profile(job, 'security')['model'], 'gpt-6-astra')
        job['intake']['risk'] = 'high'
        self.assertEqual(runner.role_profile(job, 'spec')['model'], 'gpt-6-astra')
        for role in ('intake', 'build', 'review', 'ui'):
            self.assertEqual(runner.role_profile(job, role)['model'], 'gpt-6.1-sol')

    def test_intake_contract_requires_risk_evidence(self):
        value = dict(summary='Inspect', decision='accept', risk='high', surfaces=['security'],
                     risk_factors=['access-control'], risk_reason='Group checks could grant access incorrectly')
        runner.validate(value, runner.schema('intake'))
        del value['risk_reason']
        with self.assertRaises(runner.Refused):
            runner.validate(value, runner.schema('intake'))

    def test_real_agent_adapter_with_fake_cli(self):
        job = self.factory.run(self.job())
        fake_bin = Path(self.temp.name) / 'bin'
        fake_bin.mkdir()
        fake = fake_bin / 'codex'
        fake.write_text('#!' + sys.executable + '\n' + '''import json, pathlib, sys
args = sys.argv
assert args[1] == 'exec'
assert args[args.index('-m') + 1] == 'gpt-6.1-sol'
assert args[args.index('--sandbox') + 1] == 'read-only'
assert 'task data' in sys.stdin.read()
pathlib.Path(args[args.index('-o') + 1]).write_text(json.dumps(dict(summary='Checked', verdict='pass', findings=[])))
print(json.dumps(dict(type='turn.completed', usage=dict(input_tokens=10, output_tokens=2))))
''')
        fake.chmod(0o755)
        with patch.dict(os.environ, {'PATH': str(fake_bin) + os.pathsep + os.environ['PATH']}):
            value = runner.Factory.agent(self.factory, job, 'review')
        self.assertEqual(value['verdict'], 'pass')
        self.assertEqual(job['attempts'][-1]['usage'][0]['input_tokens'], 10)

    def test_publish_reuses_pr_after_interrupted_save(self):
        job = self.factory.run(self.job())
        real_checked = self.factory.checked
        calls = []
        def checked(args, **kwargs):
            if args[0] == 'gh':
                calls.append(args)
                return json.dumps([dict(url='https://github.com/example/repo/pull/1', state='OPEN',
                                        headRefOid=self.factory.head(job), baseRefName='main')])
            return real_checked(args, **kwargs)
        with patch.object(self.factory, 'checked', side_effect=checked):
            self.factory.publish(job)
        self.assertEqual(job['stage'], 'published')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1:3], ['pr', 'list'])

    def test_resume_review_does_not_repeat_builder(self):
        job = self.factory.run(self.job())
        job['reviews'] = {}
        self.factory.save(job, 'review')
        self.factory.calls.clear()
        self.factory.run(self.factory.load(job['id']))
        self.assertEqual(self.factory.calls, ['review'])

    def test_all_surface_reviews_run_before_repair(self):
        job = self.factory.run(self.job())
        job['intake']['surfaces'] = ['security', 'ui']
        job['reviews'] = {}
        self.factory.save(job, 'review')
        self.factory.calls.clear()
        self.factory.run(job)
        self.assertEqual(self.factory.calls, ['review', 'security', 'ui'])

    def test_rework_cannot_disturb_another_active_job(self):
        first = self.factory.run(self.job())
        second = self.job()
        with self.assertRaisesRegex(runner.Refused, 'unfinished'):
            self.factory.rework(first, 'Make it better')
        self.assertEqual(self.factory.load(first['id'])['stage'], 'ready')
        self.assertEqual(self.factory.load(second['id'])['stage'], 'prepare')

    def test_publish_creates_only_a_draft_pr_and_never_merges(self):
        job = self.factory.run(self.job())
        real_checked = self.factory.checked
        calls = []
        def checked(args, **kwargs):
            if args[0] == 'gh':
                calls.append(args)
                if args[1:3] == ['pr', 'list']:
                    return '[]'
                self.assertEqual(args[1:3], ['pr', 'create'])
                self.assertIn('--draft', args)
                return 'https://github.com/example/repo/pull/1'
            return real_checked(args, **kwargs)
        with patch.object(self.factory, 'checked', side_effect=checked):
            self.factory.publish(job)
        self.assertEqual(job['stage'], 'published')
        self.assertEqual(len(calls), 2)
        self.assertIn(job['branch'], self.git('ls-remote', '--heads', 'origin'))

    def test_base_change_blocks_publication(self):
        job = self.factory.run(self.job())
        self.git('commit', '--allow-empty', '-m', 'base moved')
        self.git('push', 'origin', 'main')
        with self.assertRaisesRegex(runner.Refused, 'Base branch moved'):
            self.factory.publish(job)


if __name__ == '__main__':
    unittest.main()
