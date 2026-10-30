#!/usr/bin/env python3
"""Authenticate GitHub deliveries and wake the existing, independently authorized sync."""

import hashlib
import hmac
import json
import os
import pathlib
import re
import socketserver
import stat
import threading
from http.server import BaseHTTPRequestHandler

STATE = pathlib.Path.home() / '.local/share/formwork/kan-github-sync'
SECRET = pathlib.Path.home() / '.config/formwork/kan/github-webhook-secret'
SOCKET = pathlib.Path('/run/user') / str(os.getuid()) / 'formwork-kan-github-webhook/http.sock'
PATH = '/hooks/github/issues'
MAX_BODY = 1024 * 1024
ISSUE_ACTIONS = {'opened', 'edited', 'closed', 'reopened', 'labeled', 'unlabeled'}
LABEL_ACTIONS = {'created', 'edited', 'deleted'}


def load_secret(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Webhook secret must be an owner-only regular file')
    secret = path.read_bytes().strip()
    if len(secret) < 32:
        raise ValueError('Webhook secret must contain at least 32 bytes')
    return secret


def verify_signature(secret, body, signature):
    if not signature or not re.fullmatch(r'sha256=[0-9a-f]{64}', signature):
        return False
    expected = 'sha256=' + hmac.new(secret, body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def should_wake(event, payload):
    if not isinstance(payload, dict):
        return False
    action = payload.get('action')
    if not isinstance(action, str):
        return False
    repository = payload.get('repository')
    if not isinstance(repository, dict):
        return False
    name = repository.get('full_name')
    if not isinstance(name, str) or not re.fullmatch(r'ClockworkDigital/[A-Za-z0-9_.-]+', name, re.I):
        return False
    if event == 'issues':
        issue = payload.get('issue')
        return (action in ISSUE_ACTIONS and isinstance(issue, dict)
                and 'pull_request' not in issue and type(issue.get('number')) is int
                and issue['number'] > 0)
    return event == 'label' and action in LABEL_ACTIONS


def enqueue(state):
    # One durable marker coalesces bursts. Never store payloads or use them as writes.
    with (state / 'webhook.pending').open('wb') as pending:
        pending.flush()
        os.fsync(pending.fileno())
    directory = os.open(state, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


class WebhookServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, path, secret, state):
        self.secret = secret
        self.state = state
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(str(path), WebhookHandler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Avoid logging request bodies, headers or credentials on handler failures.
        pass


class WebhookHandler(BaseHTTPRequestHandler):
    server_version = 'GitHubWebhook'
    sys_version = ''

    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, format, *args):
        pass

    def reply(self, status):
        self.send_response(status)
        self.send_header('Content-Length', '0')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def do_POST(self):
        if self.path != PATH:
            self.reply(404)
            return
        length = self.headers.get('Content-Length', '')
        if (self.headers.get('Transfer-Encoding') is not None
                or len(self.headers.get_all('Content-Length', [])) != 1
                or not re.fullmatch(r'[0-9]{1,10}', length)):
            self.reply(400)
            return
        if int(length) > MAX_BODY:
            self.reply(413)
            return
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            self.reply(415)
            return
        body = self.rfile.read(int(length))
        if len(body) != int(length):
            self.reply(400)
            return
        signatures = self.headers.get_all('X-Hub-Signature-256', [])
        if len(signatures) != 1 or not verify_signature(self.server.secret, body, signatures[0]):
            self.reply(401)
            return
        try:
            payload = json.loads(body)
        except (ValueError, RecursionError):
            self.reply(400)
            return
        events = self.headers.get_all('X-GitHub-Event', [])
        if len(events) != 1 or not isinstance(payload, dict):
            self.reply(400)
            return
        if not should_wake(events[0], payload):
            self.reply(204)
            return
        try:
            enqueue(self.server.state)
        except OSError:
            self.reply(503)
            return
        self.reply(202)


def main():
    os.umask(0o077)
    secret = load_secret(SECRET)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    SOCKET.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if SOCKET.exists():
        if not stat.S_ISSOCK(SOCKET.stat().st_mode):
            raise ValueError('Webhook socket path is not a socket')
        SOCKET.unlink()
    with WebhookServer(SOCKET, secret, STATE) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
