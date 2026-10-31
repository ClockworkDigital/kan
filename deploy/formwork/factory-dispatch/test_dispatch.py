import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
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
            status=self.root/'status.json', dry_run=False, launch=None)
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
        with patch.object(dispatch, 'set_up') as set_up:
            code, launch, _ = self.run_dispatch(client, {'clockworkdigital/a':(self.root,True), 'clockworkdigital/c':(self.root,False), 'clockworkdigital/unselected':(self.root,True)})
        self.assertEqual(code, 0)
        launch.assert_called_once_with(self.args, 'ClockworkDigital/a')
        self.assertEqual([r['status'] for r in json.loads(self.args.status.read_text())['repositories']], ['dispatched','missing registered checkout','missing factory setup'])
        self.assertEqual([c.args[0] for c in client.queued.call_args_list], ['ClockworkDigital/a','ClockworkDigital/b'])
        set_up.assert_not_called()  # idle repositories are never cloned

    def auto_setup(self, run, installed=({},)):
        client = Mock(); client.selected.return_value = ['ClockworkDigital/a']; client.queued.return_value = True
        with patch.object(dispatch, 'projects', side_effect=list(installed)), patch.object(dispatch, 'active', return_value=False), \
                patch.object(dispatch, 'launch') as launch, patch.object(dispatch.subprocess, 'run', side_effect=run) as subprocess_run, \
                contextlib.redirect_stdout(io.StringIO()) as output:
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
        row, launch, _ = self.auto_setup(lambda command, **_: (self.args.checkouts/'a').mkdir(parents=True))
        self.assertIn('no committed factory/config.json', row['reason'])
        launch.assert_not_called()

    def test_conflicting_checkout_path_is_left_untouched(self):
        conflict = self.args.checkouts/'a'; conflict.mkdir(parents=True); (conflict/'keep').write_text('mine')
        with patch.object(dispatch, 'command', return_value='https://github.com/ClockworkDigital/other.git'):
            row, launch, run = self.auto_setup(None)
        self.assertEqual(row['status'], 'setup failed'); self.assertIn('is not a clone', row['reason'])
        run.assert_not_called(); launch.assert_not_called()
        self.assertEqual([p.name for p in conflict.iterdir()], ['keep']); self.assertEqual((conflict/'keep').read_text(), 'mine')

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
