import copy
import unittest
from urllib.error import HTTPError

from labels import (github_labels, issue_label_ids, sync_card_labels, sync_labels,
                    validate_label_ownership)


class LabelTests(unittest.TestCase):
    def setUp(self):
        self.board = {'publicId': 'board0000001', 'labels': []}
        self.source = github_labels([{'id': 42, 'name': 'bug', 'color': 'ABCDEF'}])
        self.saved = {}
        self.writes = []
        self.snapshots = []

    def save(self):
        self.snapshots.append(copy.deepcopy(self.saved))

    def api(self, path, body):
        self.writes.append((path, body))
        if path == '/labels':
            label = {**body, 'publicId': f'label{len(self.board["labels"]):07}'}
            self.board['labels'].append(label)
            return label
        identity = path.split('/')[-1]
        next(label for label in self.board['labels'] if label['publicId'] == identity).update(body)

    def run_sync(self):
        return sync_labels(self.api, self.board, self.source, self.saved, self.save)

    def test_repeat_rename_and_kan_edits_keep_identity(self):
        active, managed = self.run_sync()
        self.assertEqual(self.run_sync(), (active, managed))
        self.assertEqual(len(self.writes), 1)
        self.source['42'] = {'name': 'renamed', 'colourCode': '#123456'}
        self.assertEqual(self.run_sync(), (active, managed))
        self.board['labels'][0]['name'] = 'Kan edit'
        self.run_sync()
        self.assertEqual(self.board['labels'][0]['name'], 'renamed')

    def test_never_adopts_same_name_kan_label(self):
        local = {'publicId': 'local0000001', **self.source['42']}
        self.board['labels'].append(local.copy())
        active, _ = self.run_sync()
        self.assertNotEqual(active['42'], local['publicId'])
        self.assertEqual(self.board['labels'][0], local)

    def test_retired_labels_remain_managed_without_deleting_definitions(self):
        _, managed = self.run_sync()
        self.source = {}
        self.assertEqual(self.run_sync(), ({}, managed))
        self.assertEqual(len(self.writes), 1)

    def test_deleted_kan_label_recreated_once(self):
        before, _ = self.run_sync()
        self.board['labels'].clear()
        # Use a different server-generated identity on re-creation.
        def create(path, body):
            result = {**body, 'publicId': 'replacement1'}
            self.board['labels'].append(result)
            return result
        after, managed = sync_labels(create, self.board, self.source, self.saved, self.save)
        self.assertNotEqual(before, after)
        self.assertEqual(managed, set(before.values()) | set(after.values()))
        self.assertEqual(self.run_sync()[0], after)

    def test_uncertain_create_stops_without_duplicate_or_adoption(self):
        def uncertain(path, body):
            self.api(path, body)
            raise TimeoutError()
        with self.assertRaises(TimeoutError):
            sync_labels(uncertain, self.board, self.source, self.saved, self.save)
        self.assertIn('pending', self.snapshots[0]['labels']['42'])
        with self.assertRaisesRegex(RuntimeError, 'Uncertain'):
            self.run_sync()
        self.assertEqual(len(self.writes), 1)

    def test_pending_disappeared_label_stops_before_other_creates(self):
        self.saved['labels'] = {'99': {'pending': self.source['42']}}
        with self.assertRaisesRegex(RuntimeError, 'Uncertain'):
            self.run_sync()
        self.source = {}
        with self.assertRaisesRegex(RuntimeError, 'Uncertain'):
            self.run_sync()
        self.assertEqual(self.writes, [])

    def test_ambiguous_server_failures_keep_create_intent(self):
        for status in (408, 499, 500, 502, 504):
            with self.subTest(status=status):
                self.setUp()
                def uncertain(path, body):
                    raise HTTPError('https://kan.test/labels', status, 'Uncertain', {}, None)
                with self.assertRaises(HTTPError):
                    sync_labels(uncertain, self.board, self.source, self.saved, self.save)
                with self.assertRaisesRegex(RuntimeError, 'Uncertain'):
                    self.run_sync()
                self.assertEqual(self.writes, [])

    def test_interruption_before_response_saved_retains_pending_intent(self):
        def interrupted_save():
            if self.snapshots:
                raise InterruptedError()
            self.save()
        with self.assertRaises(InterruptedError):
            sync_labels(self.api, self.board, self.source, self.saved, interrupted_save)
        self.saved = self.snapshots[0]
        with self.assertRaisesRegex(RuntimeError, 'Uncertain'):
            self.run_sync()
        self.assertEqual(len(self.writes), 1)

    def test_rejected_create_does_not_leave_uncertain_state(self):
        def forbidden(path, body):
            raise HTTPError('https://kan.test/labels', 403, 'Forbidden', {}, None)
        with self.assertRaises(HTTPError):
            sync_labels(forbidden, self.board, self.source, self.saved, self.save)
        self.assertEqual(self.saved['labels'], {})
        self.run_sync()
        self.assertEqual(len(self.writes), 1)

    def test_mapping_cannot_cross_boards_or_share_identity(self):
        self.run_sync()
        self.board['publicId'] = 'anotherboard'
        with self.assertRaises(RuntimeError):
            self.run_sync()
        self.board['publicId'] = 'board0000001'
        self.saved['labels']['43'] = self.saved['labels']['42'].copy()
        with self.assertRaises(RuntimeError):
            self.run_sync()

    def test_ownership_includes_retired_ids_and_other_repositories(self):
        self.run_sync()
        mapping = copy.deepcopy(self.saved)
        validate_label_ownership({'2': self.board['publicId']}, {'2': mapping})
        with self.assertRaises(RuntimeError):
            validate_label_ownership({'2': 'otherboard01'}, {'2': mapping})
        with self.assertRaises(RuntimeError):
            validate_label_ownership({'2': self.board['publicId'], '3': self.board['publicId']}, {})
        other = {'board': 'otherboard01', 'labels': {'99': {
            'publicId': 'anotherlabel', 'retiredPublicIds': [mapping['labels']['42']['publicId']]}}}
        with self.assertRaises(RuntimeError):
            validate_label_ownership({'2': self.board['publicId'], '3': 'otherboard01'},
                                     {'2': mapping, '3': other})
        self.saved['labels']['43'] = other['labels']['99']
        with self.assertRaises(RuntimeError):
            self.run_sync()
        self.assertEqual(len(self.writes), 1)

    def test_validation_and_issue_snapshot_fail_closed(self):
        self.assertEqual(self.source['42']['colourCode'], '#abcdef')
        for label in ['bug', {}, {'id': 0, 'name': 'bug', 'color': 'ffffff'},
                      {'id': True, 'name': 'bug', 'color': 'ffffff'},
                      {'id': 1, 'name': '', 'color': 'ffffff'},
                      {'id': 1, 'name': 'x' * 51, 'color': 'ffffff'},
                      {'id': 1, 'name': 'bug', 'color': '#ffffff'}]:
            with self.assertRaises(ValueError):
                github_labels([label])
        self.assertEqual(github_labels([{'id': 1, 'name': 'x' * 50, 'color': 'ffffff'}])['1']['name'], 'x' * 50)
        for snapshot in ({}, None, 'bug'):
            with self.assertRaises(ValueError):
                github_labels(snapshot)
            with self.assertRaises(ValueError):
                issue_label_ids({'labels': snapshot}, {})
        with self.assertRaises(ValueError):
            issue_label_ids({'labels': [{'id': 99}]}, {'42': 'label0000001'})
        self.assertEqual(issue_label_ids({'labels': [{'id': 42}, {'id': 42}]},
                                         {'42': 'label0000001'}), {'label0000001'})

    def test_assignment_rechecks_toggle_and_preserves_unrelated_labels(self):
        card = {'publicId': 'card00000001', 'labels': [{'publicId': 'local0000001'},
                {'publicId': 'old000000001'}], 'list': {'board': {'publicId': 'board0000001'}}}
        calls = []
        def api(path, body=None):
            if body is None:
                return copy.deepcopy(card)
            identity = path.split('/')[-1]
            present = any(label['publicId'] == identity for label in card['labels'])
            card['labels'] = [label for label in card['labels'] if label['publicId'] != identity]
            if not present:
                card['labels'].append({'publicId': identity})
            calls.append(path)
            return {'newLabel': not present}
        desired, managed = {'new000000001'}, {'new000000001', 'old000000001'}
        self.assertTrue(sync_card_labels(api, copy.deepcopy(card), 'board0000001', desired, managed))
        self.assertFalse(sync_card_labels(api, card, 'board0000001', desired, managed))
        self.assertEqual(len(calls), 2)
        self.assertEqual({label['publicId'] for label in card['labels']}, desired | {'local0000001'})
        stale = copy.deepcopy(card)
        stale['labels'] = []
        self.assertFalse(sync_card_labels(api, stale, 'board0000001', desired, managed))
        card['list']['board']['publicId'] = 'anotherboard'
        with self.assertRaises(RuntimeError):
            sync_card_labels(api, stale, 'board0000001', desired, managed)

    def test_wrong_toggle_response_is_reported(self):
        card = {'publicId': 'card00000001', 'labels': [],
                'list': {'board': {'publicId': 'board0000001'}}}
        def api(path, body=None):
            return card if body is None else {'newLabel': False}
        with self.assertRaisesRegex(RuntimeError, 'Concurrent'):
            sync_card_labels(api, card, 'board0000001', {'label0000001'}, {'label0000001'})
