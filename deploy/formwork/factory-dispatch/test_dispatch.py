import contextlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

import dispatch


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.args = SimpleNamespace(config=self.root/'config', profile=self.root/'profile',
            registry=self.root/'projects.json', launcher=self.root/'factory.py', checkouts=self.root/'clockwork',
            status=self.root/'status.json', dry_run=False, launch=None, configure=None, issue=None)
        self.args.config.write_text(json.dumps({'baseUrl':'https://kan.example', 'userId':'owner', 'workspacePublicId':'workspace123'}))
        self.args.profile.write_text(json.dumps({'baseUrl':'https://kan.example', 'apiToken':'do-not-log-secret', 'expiresAt':None}))
        self.args.profile.chmod(0o600)
        self.args.registry.write_text('[]')

    def run_dispatch(self, client, installed):
        with patch.object(dispatch, 'projects', return_value=installed), patch.object(dispatch, 'active', return_value=False), patch.object(dispatch, 'launch') as launch, contextlib.redirect_stdout(io.StringIO()) as output:
            code = dispatch.dispatch(self.args, client)
        return code, launch, output.getvalue()

    def test_selection_is_the_allowlist_and_every_missing_repo_is_reported(self):
        client = Mock()
        client.selected.return_value = ['ClockworkDigital/a', 'ClockworkDigital/b', 'ClockworkDigital/c']
        client.queued.side_effect = lambda repository: repository != 'ClockworkDigital/b'
        client.sent.return_value = None  # b has no issue sent by an allowed actor
        with patch.object(dispatch, 'set_up') as set_up:
            code, launch, _ = self.run_dispatch(client, {'clockworkdigital/a':(self.root,True), 'clockworkdigital/c':(self.root,False), 'clockworkdigital/unselected':(self.root,True)})
        self.assertEqual(code, 0)
        launch.assert_called_once_with(self.args, 'ClockworkDigital/a')
        self.assertEqual([r['status'] for r in json.loads(self.args.status.read_text())['repositories']], ['dispatched','missing registered checkout','missing factory setup'])
        self.assertEqual([c.args[0] for c in client.queued.call_args_list], ['ClockworkDigital/a'])
        client.sent.assert_called_once_with('ClockworkDigital/b', set())
        set_up.assert_not_called()  # idle repositories are never cloned or configured

    def auto_setup(self, run, installed=({},), active=False, fast_forward=None):
        client = Mock(); client.selected.return_value = ['ClockworkDigital/a']; client.queued.return_value = True; client.sent.return_value = 7
        with patch.object(dispatch, 'projects', side_effect=list(installed)), patch.object(dispatch, 'active', return_value=active), \
                patch.object(dispatch, 'launch') as launch, patch.object(dispatch.subprocess, 'run', side_effect=run) as subprocess_run, \
                patch.object(dispatch, 'fast_forward', return_value=fast_forward), contextlib.redirect_stdout(io.StringIO()) as output:
            dispatch.dispatch(self.args, client)
        return json.loads(output.getvalue())['repositories'][0], launch, subprocess_run

    def test_queued_repository_is_cloned_registered_and_dispatched(self):
        checkout = self.args.checkouts/'a'
        def run(command, **_):
            if command[:2] == ['git', 'clone']:
                (checkout/'factory').mkdir(parents=True); (checkout/'factory/config.json').write_text('{}')
        row, launch, run_mock = self.auto_setup(run, ({}, {'clockworkdigital/a':(checkout,True)}))
        self.assertEqual(row['status'], 'dispatched')
        launch.assert_called_once_with(self.args, 'ClockworkDigital/a')
        clone, register = [c.args[0] for c in run_mock.call_args_list]
        self.assertEqual(clone[-2:], ['https://github.com/ClockworkDigital/a.git', str(checkout)])
        self.assertEqual(register[-3:], ['--repo', str(checkout), 'register'])

    def test_setup_failure_reports_reason_and_launches_nothing(self):
        row, launch, _ = self.auto_setup(dispatch.subprocess.CalledProcessError(128, 'git'))
        self.assertEqual((row['status'], row['reason']), ('setup failed', 'clone failed'))
        launch.assert_not_called()

    def test_unconfigured_repository_with_sent_issue_starts_configure_unit(self):
        checkout = self.args.checkouts/'a'
        row, launch, run = self.auto_setup(lambda command, **_: checkout.mkdir(parents=True))
        self.assertEqual(row, {'repository': 'ClockworkDigital/a', 'status': 'configuring'})
        launch.assert_called_once_with(self.args, 'ClockworkDigital/a', ['--configure', 'ClockworkDigital/a', '--issue', '7'])
        self.assertEqual(len(run.call_args_list), 1)  # only the clone; configure runs in the unit

    def test_configuring_repository_is_not_relaunched_while_its_unit_is_active(self):
        row, launch, run = self.auto_setup(None, active=True)
        self.assertEqual(row['status'], 'configuring')
        launch.assert_not_called(); run.assert_not_called()

    def test_dirty_clone_is_reported_and_not_configured(self):
        row, launch, _ = self.auto_setup(lambda *_, **__: None, fast_forward='checkout x has local changes; not updated')
        self.assertEqual((row['status'], row['reason']), ('setup failed', 'checkout x has local changes; not updated'))
        launch.assert_not_called()

    def configure_child(self, returncode, stderr):
        self.args.configure, self.args.issue = 'ClockworkDigital/a', 7
        checkout = self.args.checkouts/'a'; (checkout/'.git').mkdir(parents=True)
        client = Mock(); client.selected.return_value = ['ClockworkDigital/a']; client.sent.return_value = 7; client.queued.return_value = True
        with patch.object(dispatch, 'command', return_value='https://github.com/ClockworkDigital/a.git'), \
                patch.object(dispatch, 'projects', return_value={'clockworkdigital/a': (checkout, True)}), \
                patch.object(dispatch.subprocess, 'run', return_value=SimpleNamespace(returncode=returncode, stderr=stderr)) as run, \
                patch.object(dispatch.subprocess, 'call', return_value=0) as call:
            code = dispatch.dispatch(self.args, client)
        self.assertEqual(run.call_args.args[0][-5:], ['--repo', str(checkout), 'configure', '--issue', '7'])
        return code, call, checkout

    def test_configure_success_runs_the_sent_issue_in_the_same_unit(self):
        code, call, checkout = self.configure_child(0, '')
        self.assertEqual(code, 0)
        self.assertEqual(call.call_args.args[0][-4:], ['--repo', str(checkout), 'run', '--publish'])

    def test_configure_failure_reason_is_shown_and_not_retried(self):
        code, call, _ = self.configure_child(1, 'agent output do-not-log-secret\nconfigure failed: no passing checks found\n')
        self.assertEqual(code, 1); call.assert_not_called()
        self.args.configure = self.args.issue = None
        row, launch, run = self.auto_setup(None)
        self.assertEqual((row['status'], row['reason']), ('setup failed', 'no passing checks found'))
        launch.assert_not_called(); run.assert_not_called()
        self.assertNotIn('do-not-log-secret', self.args.status.read_text())
        self.args.status.with_name(dispatch.unit('ClockworkDigital/a').replace('.service', '.configure.json')).write_text('{"issue": 6}')
        with patch.object(dispatch, 'command', return_value='https://github.com/ClockworkDigital/a.git'):
            row, launch, _ = self.auto_setup(None)
        self.assertEqual(row['status'], 'configuring')  # a newly sent issue tries again in the existing clone
        self.assertEqual(launch.call_args.args[2][-1], '7')

    def test_fast_forward_updates_a_clean_clone_and_skips_a_dirty_one(self):
        env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@x', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@x'}
        sh = lambda *c, cwd=self.root: subprocess.run(c, cwd=cwd, env=env, check=True, capture_output=True)
        sh('git', 'init', '--quiet', '-b', 'main', 'upstream'); upstream = self.root/'upstream'
        sh('git', 'commit', '--quiet', '--allow-empty', '-m', 'one', cwd=upstream)
        sh('git', 'clone', '--quiet', str(upstream), 'clone'); clone = self.root/'clone'
        sh('git', 'commit', '--quiet', '--allow-empty', '-m', 'two', cwd=upstream)
        (clone/'scratch').write_text('mine')
        self.assertIn('has local changes', dispatch.fast_forward(clone))
        self.assertEqual(dispatch.git(clone, 'log', '-1', '--format=%s'), 'one')
        (clone/'scratch').unlink(); sh('git', 'checkout', '--quiet', '-b', 'topic', cwd=clone)
        self.assertIn('is not on main', dispatch.fast_forward(clone))
        sh('git', 'checkout', '--quiet', 'main', cwd=clone)
        self.assertIsNone(dispatch.fast_forward(clone))
        self.assertEqual(dispatch.git(clone, 'log', '-1', '--format=%s'), 'two')

    def test_sent_issue_requires_an_allowed_actor_on_the_latest_factory_label(self):
        client = dispatch.Kan(self.args.config, self.args.profile)
        label = lambda login, at: {'event': 'labeled', 'label': {'name': 'factory'}, 'actor': {'login': login}, 'created_at': at}
        issues = [{'number': 2, 'state': 'open', 'created_at': '2026-02', 'labels': [{'name': 'factory'}]},
                  {'number': 1, 'state': 'open', 'created_at': '2026-01', 'labels': [{'name': 'factory'}]}]
        def request(_, body):
            return issues if body['path'].endswith('/issues?state=open&per_page=100') else {
                'repos/ClockworkDigital/a/issues/1/events?per_page=100': [label('Owner', '1'), label('stranger', '2')],
                'repos/ClockworkDigital/a/issues/2/events?per_page=100': [label('owner', '1')]}[body['path']]
        with patch.object(client, 'request', side_effect=request):
            self.assertEqual(client.sent('ClockworkDigital/a', {'owner'}), 2)
            self.assertIsNone(client.sent('ClockworkDigital/a', set()))
        (self.args.registry.parent/'providers.json').write_text(json.dumps({'factory_label_actors': ['Owner', 3]}))
        self.assertEqual(dispatch.actors(self.args), {'owner'})

    def test_conflicting_checkout_path_is_left_untouched(self):
        conflict = self.args.checkouts/'a'; conflict.mkdir(parents=True); (conflict/'keep').write_text('mine')
        with patch.object(dispatch, 'command', return_value='https://github.com/ClockworkDigital/other.git'):
            row, launch, run = self.auto_setup(None)
        self.assertEqual(row['status'], 'setup failed'); self.assertIn('is not a clone', row['reason'])
        run.assert_not_called(); launch.assert_not_called()
        self.assertEqual([p.name for p in conflict.iterdir()], ['keep']); self.assertEqual((conflict/'keep').read_text(), 'mine')

    def clone_at(self, name, url):
        path = self.args.checkouts/name; (path/'.git').mkdir(parents=True)
        (path/'factory').mkdir(); (path/'factory/config.json').write_text('{}')
        return path, url

    def test_existing_clone_under_another_folder_name_is_reused(self):
        clones = dict([self.clone_at('pulse check', 'git@github.com:clockworkdigital/A'),
                       self.clone_at('unrelated', 'https://github.com/ClockworkDigital/a-other.git')])
        with patch.object(dispatch, 'command', side_effect=lambda c: clones[Path(c[2])]):
            row, launch, run = self.auto_setup(lambda *_, **__: None, ({}, {'clockworkdigital/a':(self.args.checkouts/'pulse check',True)}))
        self.assertEqual(row['status'], 'dispatched')
        [register] = [c.args[0] for c in run.call_args_list]  # no git clone
        self.assertEqual(register[-3:], ['--repo', str(self.args.checkouts/'pulse check'), 'register'])

    def test_registered_path_is_reused_and_remote_forms_match(self):
        path, url = self.clone_at('Build Tracker', 'ssh://git@github.com/ClockworkDigital/Build-Tracker.git')
        self.args.registry.write_text(json.dumps([str(path)]))
        with patch.object(dispatch, 'command', return_value=url):
            self.assertEqual(dispatch.existing_clone(self.args, 'ClockworkDigital/build-tracker'), path)
        forms = ['https://github.com/ClockworkDigital/Build-Tracker', 'https://github.com/clockworkdigital/build-tracker.git',
                 'git@github.com:ClockworkDigital/Build-Tracker.git', url]
        self.assertEqual({dispatch.remote_repository(f) for f in forms}, {'clockworkdigital/build-tracker'})

    def test_folder_with_another_repository_remote_is_ignored(self):
        clones = dict([self.clone_at('a-ish', 'https://github.com/ClockworkDigital/other.git')])
        checkout = self.args.checkouts/'a'
        def run(command, **_):
            if command[:2] == ['git', 'clone']:
                (checkout/'factory').mkdir(parents=True); (checkout/'factory/config.json').write_text('{}')
        with patch.object(dispatch, 'command', side_effect=lambda c: clones[Path(c[2])]):
            row, _, run_mock = self.auto_setup(run, ({}, {'clockworkdigital/a':(checkout,True)}))
        self.assertEqual(row['status'], 'dispatched')
        self.assertEqual(run_mock.call_args_list[0].args[0][-1], str(checkout))
        self.assertEqual(sorted(p.name for p in (self.args.checkouts/'a-ish').iterdir()), ['.git', 'factory'])

    def test_pausing_sync_dispatches_nothing(self):
        client = Mock(); client.selected.return_value = []
        _, launch, _ = self.run_dispatch(client, {'clockworkdigital/a':(self.root,True)})
        launch.assert_not_called(); client.queued.assert_not_called()

    def test_error_does_not_leak_secret_or_starve_next_repository(self):
        client = Mock(); client.selected.return_value = ['ClockworkDigital/a','ClockworkDigital/b']
        client.queued.side_effect = [HTTPError('https://do-not-log-secret',403,'do-not-log-secret',{},None), True]
        _, launch, output = self.run_dispatch(client, {r.lower():(self.root,True) for r in client.selected.return_value})
        launch.assert_called_once_with(self.args, 'ClockworkDigital/b')
        self.assertNotIn('do-not-log-secret',output+self.args.status.read_text())
        self.assertEqual(json.loads(output)['repositories'][0]['error'],'HTTPError')

    def test_active_unit_is_never_started_again(self):
        client = Mock(); client.selected.return_value = ['ClockworkDigital/a']
        with patch.object(dispatch,'projects',return_value={'clockworkdigital/a':(self.root,True)}), patch.object(dispatch,'active',return_value=True), patch.object(dispatch,'launch') as launch, contextlib.redirect_stdout(io.StringIO()):
            dispatch.dispatch(self.args,client)
        launch.assert_not_called(); client.queued.assert_not_called()

    def test_child_rechecks_selection_after_scheduler_launch(self):
        self.args.launch = 'ClockworkDigital/a'
        client = Mock(); client.selected.return_value = []
        with patch.object(dispatch,'projects',return_value={'clockworkdigital/a':(self.root,True)}), patch.object(dispatch.subprocess,'call') as run:
            with self.assertRaises(ValueError): dispatch.dispatch(self.args,client)
        run.assert_not_called()

    def test_child_checks_queue_and_uses_existing_runner_without_rework(self):
        self.args.launch = 'ClockworkDigital/a'
        client = Mock(); client.selected.return_value = [self.args.launch]; client.queued.return_value = True
        with patch.object(dispatch,'projects',return_value={'clockworkdigital/a':(self.root,True)}), patch.object(dispatch.subprocess,'call',return_value=75) as run:
            self.assertEqual(dispatch.dispatch(self.args,client),75)
        self.assertEqual(run.call_args.args[0][-4:], ['--repo',str(self.root),'run','--publish'])
        client.queued.assert_called_once_with(self.args.launch)

    def test_dry_run_neither_launches_nor_writes_status(self):
        self.args.dry_run = True
        client = Mock(); client.selected.return_value = ['ClockworkDigital/a']; client.queued.return_value = True
        _, launch, output = self.run_dispatch(client, {'clockworkdigital/a':(self.root,True)})
        launch.assert_not_called(); self.assertFalse(self.args.status.exists())
        self.assertEqual(json.loads(output)['repositories'][0]['status'],'ready')

    def test_registered_primary_precedes_duplicate_lanes(self):
        self.args.registry.write_text(json.dumps(['/main-worktree','/lane']))
        def git(args):
            if args[3] == 'worktree':
                return 'worktree /primary\n' if args[2] == '/main-worktree' else 'worktree /lane\n'
            return 'git@github.com:ClockworkDigital/process-tool.git'
        with patch.object(dispatch,'command',side_effect=git):
            installed = dispatch.projects(self.args.registry)
        self.assertEqual(installed, {'clockworkdigital/process-tool':(Path('/primary'),False)})

    def test_empty_queue_does_not_launch(self):
        client=Mock(); client.selected.return_value=['ClockworkDigital/a']; client.queued.return_value=False
        _,launch,_=self.run_dispatch(client,{'clockworkdigital/a':(self.root,True)})
        launch.assert_not_called()

    def test_selected_rejects_owner_change_and_invalid_repository(self):
        client=dispatch.Kan(self.args.config,self.args.profile)
        with patch.object(client,'request',side_effect=[{'enabled':True,'repositories':['ClockworkDigital/a']},{'id':'other'}]):
            with self.assertRaises(ValueError):client.selected()
        with patch.object(client,'request',side_effect=[{'enabled':True,'repositories':['ClockworkDigital/..']},{'id':'owner'}]):
            with self.assertRaises(ValueError):client.selected()

    def test_expired_or_public_credentials_are_rejected(self):
        self.args.profile.chmod(0o644)
        with self.assertRaises(ValueError):dispatch.Kan(self.args.config,self.args.profile)
        self.args.profile.chmod(0o600)
        profile=json.loads(self.args.profile.read_text());profile['expiresAt']='2020-01-01T00:00:00Z'
        self.args.profile.write_text(json.dumps(profile))
        with self.assertRaises(ValueError):dispatch.Kan(self.args.config,self.args.profile)

    def test_queue_uses_allowed_paginated_path_and_excludes_pull_requests(self):
        client=dispatch.Kan(self.args.config,self.args.profile)
        pull={'state':'open','pull_request':{},'labels':[{'name':'factory'}]}
        issue={'state':'open','labels':[{'name':'factory'}]}
        with patch.object(client,'request',side_effect=[[pull]*100,[issue]]) as request:
            self.assertTrue(client.queued('ClockworkDigital/a'))
        self.assertEqual([c.args[1]['page'] for c in request.call_args_list],[1,2])
        self.assertEqual(request.call_args.args[1]['path'],'repos/ClockworkDigital/a/issues?state=open&per_page=100')

    def test_child_refuses_queue_read_after_selection_revoked(self):
        self.args.launch='ClockworkDigital/a'
        client=Mock(); client.selected.return_value=[self.args.launch]
        client.queued.side_effect=HTTPError('https://secret',403,'secret',{},None)
        with patch.object(dispatch,'projects',return_value={'clockworkdigital/a':(self.root,True)}), patch.object(dispatch.subprocess,'call') as run:
            with self.assertRaises(HTTPError):dispatch.dispatch(self.args,client)
        run.assert_not_called()

    def test_unavailable_settings_cannot_start_any_service(self):
        client=Mock();client.selected.side_effect=OSError('offline')
        with patch.object(dispatch,'launch') as launch:
            with self.assertRaises(OSError):dispatch.dispatch(self.args,client)
        launch.assert_not_called()

    def test_http_redirect_is_never_followed(self):
        self.assertIsNone(dispatch.NoRedirect().redirect_request(None,None,302,'',{},'https://other.example'))

    def test_unit_is_stable_and_spawn_rechecks_via_dispatcher(self):
        self.assertEqual(dispatch.unit('ClockworkDigital/A'),dispatch.unit('clockworkdigital/a'))
        with patch.object(dispatch.subprocess,'run') as run:
            dispatch.launch(self.args,'ClockworkDigital/a')
        command=run.call_args.args[0]
        self.assertIn('--collect',command)
        self.assertEqual(command[-2:],['--launch','ClockworkDigital/a'])
        self.assertNotIn('do-not-log-secret',str(command))


if __name__ == '__main__':
    unittest.main()
