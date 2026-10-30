import fcntl
import hashlib
import hmac
import http.client
import io
import json
import pathlib
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import sync
import webhook


class WebhookTests(unittest.TestCase):
    secret = b'0123456789abcdef0123456789abcdef'
    payload = {'action': 'edited', 'repository': {'full_name': 'ClockworkDigital/test'},
               'issue': {'number': 1}}

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = pathlib.Path(self.folder.name)
        self.socket = self.root / 'http.sock'
        self.state = self.root / 'state'
        self.state.mkdir()
        self.server = webhook.WebhookServer(self.socket, self.secret, self.state)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01})
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, payload=None, event='issues', body=None, signature=None, headers=None,
                path=webhook.PATH):
        if body is None:
            body = json.dumps(self.payload if payload is None else payload).encode()
        signed = signature if signature is not None else 'sha256=' + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        connection = http.client.HTTPConnection('localhost', timeout=2)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(2)
        connection.sock.connect(str(self.socket))
        try:
            connection.request('POST', path, body, {'Content-Type': 'application/json',
                'X-Hub-Signature-256': signed, 'X-GitHub-Event': event, **(headers or {})})
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            connection.close()

    def test_real_http_signature_and_raw_bytes(self):
        body = json.dumps(self.payload, indent=2).encode()
        self.assertEqual(self.request(body=body), 202)
        pending = self.state / 'webhook.pending'
        self.assertEqual(pending.read_bytes(), b'')
        pending.unlink()
        signature = 'sha256=' + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        for invalid in ['', 'sha1=' + '0' * 40, 'sha256=' + 'g' * 64, 'sha256=' + '0' * 64]:
            self.assertEqual(self.request(body=body, signature=invalid), 401)
        self.assertEqual(self.request(body=body + b' ', signature=signature), 401)
        self.assertFalse(pending.exists())

    def test_event_filtering(self):
        for action in webhook.ISSUE_ACTIONS:
            self.assertEqual(self.request(payload={**self.payload, 'action': action}), 202)
        for action in webhook.LABEL_ACTIONS:
            self.assertEqual(self.request(payload={**self.payload, 'action': action}, event='label'), 202)
        pending = self.state / 'webhook.pending'
        pending.unlink()
        for event, payload in [
            ('ping', {}), ('pull_request', self.payload), ('issue_comment', self.payload),
            ('issues', {**self.payload, 'action': 'deleted'}),
            ('issues', {**self.payload, 'action': []}),
            ('issues', {**self.payload, 'issue': {'number': 1, 'pull_request': {}}}),
            ('issues', {**self.payload, 'issue': {'number': True}}),
            ('issues', {**self.payload, 'issue': None}),
            ('issues', {**self.payload, 'repository': {'full_name': 'Other/test'}}),
            ('issues', {**self.payload, 'repository': {'full_name': 'ClockworkDigital/test/extra'}}),
        ]:
            self.assertEqual(self.request(payload=payload, event=event), 204)
        self.assertFalse(pending.exists())

    def test_bad_requests_and_failed_enqueue(self):
        self.assertEqual(self.request(path='/api/internal/formwork-token'), 404)
        self.assertEqual(self.request(body=b'{'), 400)
        self.assertEqual(self.request(payload=[]), 400)
        self.assertEqual(self.request(headers={'Content-Type': 'text/plain'}), 415)
        self.assertEqual(self.request(headers={'Content-Length': str(webhook.MAX_BODY + 1)}), 413)
        self.assertEqual(self.request(headers={'Transfer-Encoding': 'chunked'}), 400)
        self.assertFalse((self.state / 'webhook.pending').exists())
        with patch.object(webhook, 'enqueue', side_effect=OSError('do not leak me')):
            self.assertEqual(self.request(), 503)

    def test_duplicate_headers_are_rejected(self):
        body = json.dumps(self.payload).encode()
        signature = 'sha256=' + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        base = [('Content-Type', 'application/json'), ('Content-Length', str(len(body))),
                ('X-Hub-Signature-256', signature), ('X-GitHub-Event', 'issues')]
        for duplicate, status in [(base[1], 400), (base[2], 401), (base[3], 400)]:
            request = ('POST ' + webhook.PATH + ' HTTP/1.0\r\n' +
                       ''.join(key + ': ' + value + '\r\n' for key, value in base + [duplicate]) +
                       '\r\n').encode() + body
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(2)
                connection.connect(str(self.socket))
                connection.sendall(request)
                response = http.client.HTTPResponse(connection)
                response.begin()
                self.assertEqual(response.status, status)
                response.read()
        self.assertFalse((self.state / 'webhook.pending').exists())

    def test_secret_fails_closed(self):
        secret = self.root / 'secret'
        with self.assertRaises(FileNotFoundError):
            webhook.load_secret(secret)
        secret.write_bytes(self.secret)
        secret.chmod(0o644)
        with self.assertRaises(ValueError):
            webhook.load_secret(secret)
        secret.chmod(0o600)
        self.assertEqual(webhook.load_secret(secret), self.secret)
        secret.write_bytes(b'')
        with self.assertRaises(ValueError):
            webhook.load_secret(secret)

    def test_burst_and_delivery_during_run_preserve_state(self):
        mapping = self.state / 'state.json'
        mapping.write_text('{"issues":{"stable-id":{"base":{"title":"keep"}}}}')
        before = mapping.read_bytes()
        for _ in range(10):
            self.assertEqual(self.request(), 202)
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ['state.json', 'webhook.pending'])
        (self.state / 'webhook.pending').unlink()  # Worker consumes after acquiring its lock.
        self.assertEqual(self.request(), 202)  # A delivery during the scan must cause a follow-up.
        self.assertTrue((self.state / 'webhook.pending').exists())
        self.assertEqual(mapping.read_bytes(), before)

    def test_worker_still_rejects_expired_credentials_before_api(self):
        profile = self.root / 'profile'
        profile.write_text(json.dumps({'expiresAt': '2000-01-01T00:00:00Z'}))
        profile.chmod(0o600)
        config = self.root / 'config'
        config.write_text(json.dumps({'workspacePublicId': 'workspace123'}))
        self.assertEqual(self.request(), 202)
        with (self.state / 'lock').open('w') as lock, patch('sync.open', return_value=lock, create=True), \
             patch.object(sync, 'CONFIG', config), patch.object(sync, 'STATE', self.state), \
             patch.object(sync, 'PROFILE', profile), patch.object(sync.urllib.request, 'build_opener') as api:
            with self.assertRaisesRegex(AssertionError, 'expired'):
                sync.main()
            api.assert_not_called()
        self.assertFalse((self.state / 'webhook.pending').exists())

    def test_busy_worker_leaves_pending_for_next_run(self):
        config = self.root / 'config'
        config.write_text(json.dumps({'workspacePublicId': 'workspace123'}))
        self.assertEqual(self.request(), 202)
        with (self.state / 'lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with (self.state / 'lock').open('w') as contender, \
                 patch('sync.open', return_value=contender, create=True), \
                 patch.object(sync, 'CONFIG', config), patch.object(sync, 'STATE', self.state), \
                 patch.object(sync.urllib.request, 'build_opener') as api:
                with self.assertRaises(BlockingIOError):
                    sync.main()
                api.assert_not_called()
        self.assertTrue((self.state / 'webhook.pending').exists())

    def test_paused_worker_reads_only_settings_through_credential(self):
        profile = self.root / 'profile'
        profile.write_text(json.dumps({'apiToken': 'owner-bound-token', 'baseUrl': 'https://kan.example'}))
        profile.chmod(0o600)
        config = self.root / 'config'
        config.write_text(json.dumps({'workspacePublicId': 'workspace123', 'baseUrl': 'https://kan.example'}))
        self.assertEqual(self.request(), 202)
        with patch.object(sync, 'CONFIG', config), patch.object(sync, 'STATE', self.state), \
             patch.object(sync, 'PROFILE', profile), patch.object(sync.urllib.request, 'build_opener') as api, \
             patch('sys.stdout', new=io.StringIO()):
            api.return_value.open.return_value = io.BytesIO(b'{"enabled":false}')
            sync.main()
            request = api.return_value.open.call_args.args[0]
            self.assertEqual(request.get_header('Authorization'), 'Bearer owner-bound-token')
            self.assertEqual(request.full_url, 'https://kan.example/api/v1/integrations/github/sync/settings?workspacePublicId=workspace123')
            self.assertEqual(api.return_value.open.call_count, 1)
        self.assertFalse((self.state / 'webhook.pending').exists())


if __name__ == '__main__':
    unittest.main()
