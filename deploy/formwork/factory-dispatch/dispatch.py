#!/usr/bin/env python3
"""Dispatch the enabled Kan sync repositories to their operator-installed factory."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse
import urllib.request

REPOSITORY = re.compile(r'ClockworkDigital/[A-Za-z0-9_.-]+', re.I)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class Kan:
    def __init__(self, config, profile):
        self.config = json.loads(config.read_text())
        if profile.stat().st_mode & 0o077 or profile.stat().st_uid != os.getuid():
            raise ValueError('Credential must be private and owned by the operator')
        self.profile = json.loads(profile.read_text())
        origin = urllib.parse.urlsplit(self.profile['baseUrl'])
        if (self.profile['baseUrl'] != self.config['baseUrl'] or origin.scheme != 'https'
                or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment
                or origin.path not in ('', '/')):
            raise ValueError('Invalid deployment origin')
        expiry = self.profile.get('expiresAt')
        if expiry and datetime.datetime.fromisoformat(expiry.replace('Z', '+00:00')) <= datetime.datetime.now(datetime.timezone.utc):
            raise ValueError('Credential expired')
        if not re.fullmatch(r'[A-Za-z0-9]{12}', self.config['workspacePublicId']):
            raise ValueError('Invalid workspace')

    def request(self, path, body=None):
        request = urllib.request.Request(self.profile['baseUrl'].rstrip('/') + '/api/v1' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + self.profile['apiToken'], 'Content-Type': 'application/json'})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            return json.load(response)

    def selected(self):
        settings = self.request('/integrations/github/sync/settings?workspacePublicId=' + self.config['workspacePublicId'])
        if settings.get('enabled') is not True:
            return []
        if self.request('/users/me')['id'] != self.config['userId']:
            raise ValueError('Sync owner changed')
        repos = settings['repositories']
        if not isinstance(repos, list) or not all(isinstance(r, str) and REPOSITORY.fullmatch(r) and r.split('/')[1] not in ('.', '..') for r in repos):
            raise ValueError('Invalid selected repositories')
        return sorted(set(repos), key=str.lower)

    def queued(self, repository):
        # This request rechecks enabled selection, native permissions and current gateway policy.
        for page in range(1, 1001):
            issues = self.request('/integrations/github/sync', {
                'workspacePublicId': self.config['workspacePublicId'],
                'path': f'repos/{repository}/issues?state=open&per_page=100', 'page': page})
            if not isinstance(issues, list):
                raise ValueError('Invalid issue response')
            if any('pull_request' not in issue and issue.get('state') == 'open'
                   and any(label.get('name') == 'factory' for label in issue.get('labels', [])) for issue in issues):
                return True
            if len(issues) < 100:
                return False
        raise ValueError('Issue pagination limit exceeded')


def command(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=30).strip()


def remote_repository(url):
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+?)(?:\.git)?', url)
    return match[1].lower() if match and REPOSITORY.fullmatch(match[1]) else None


def projects(registry):
    """First registered primary checkout wins; extra lanes must not duplicate a queue."""
    result = {}
    registered = json.loads(registry.read_text())
    if not isinstance(registered, list) or not all(isinstance(p, str) for p in registered):
        raise ValueError('Invalid operator registry')
    for path in registered:
        try:
            rows = command(['git', '-C', path, 'worktree', 'list', '--porcelain']).splitlines()
            root = Path(next(row[9:] for row in rows if row.startswith('worktree '))).resolve()
            config_path = root / 'factory/config.json'
            config = json.loads(config_path.read_text()) if config_path.is_file() else {}
            remote = config.get('remote', 'origin')
            if not isinstance(remote, str) or remote.startswith('-'):
                continue
            name = remote_repository(command(['git', '-C', str(root), 'remote', 'get-url', '--push', remote]))
            if name:
                ready = (config.get('queue_label') == 'factory' and isinstance(config.get('checks'), list)
                         and bool(config['checks']))
                result.setdefault(name, (root, ready))
        except (OSError, ValueError, StopIteration, subprocess.SubprocessError):
            continue
    return result


def origin(path):
    # Require the path's own .git so a parent repository's remote never counts as a match.
    if not (path / '.git').exists():
        return None
    try:
        return remote_repository(command(['git', '-C', str(path), 'remote', 'get-url', '--push', 'origin']))
    except (OSError, subprocess.SubprocessError):
        return None


def existing_clone(args, repository):
    """First registered path or ~/clockwork subfolder whose origin is this repository, whatever its folder name."""
    registered = json.loads(args.registry.read_text())
    folders = sorted(p for p in args.checkouts.iterdir() if p.is_dir()) if args.checkouts.is_dir() else []
    return next((path for path in [*map(Path, registered), *folders] if origin(path) == repository.lower()), None)


def set_up(args, repository):
    """Reuse or clone and register a selected repository; return a failure reason, or None once registered."""
    root = existing_clone(args, repository) or args.checkouts / repository.split('/')[1]
    if root.exists() and (not root.is_dir() or any(root.iterdir())):
        if origin(root) != repository.lower():
            return 'checkout path ' + str(root) + ' exists and is not a clone of this repository'
    else:
        try:
            subprocess.run(['git', 'clone', '--quiet', '--', 'https://github.com/' + repository + '.git', str(root)],
                           check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'}, timeout=600)
        except (OSError, subprocess.SubprocessError):
            return 'clone failed'
    # The launcher only registers installed checkouts, and the runner needs reviewed checks committed to the base.
    if not (root / 'factory/config.json').is_file():
        return 'no committed factory/config.json; merge reviewed factory setup into the repository'
    try:
        subprocess.run([sys.executable, str(args.launcher), '--repo', str(root), 'register'], check=True,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return 'factory register failed'
    return None


def unit(repository):
    return 'agent-factory-sync-' + hashlib.sha256(repository.lower().encode()).hexdigest()[:16] + '.service'


def active(repository):
    state = subprocess.run(['systemctl', '--user', 'show', '--property=ActiveState', '--value', unit(repository)],
                           capture_output=True, text=True, timeout=30)
    if state.returncode:
        raise RuntimeError('Cannot inspect factory service')
    return state.stdout.strip() in ('active', 'activating', 'deactivating', 'reloading')


def arguments():
    home = Path.home()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=home / '.config/formwork/kan/github-sync.json')
    parser.add_argument('--profile', type=Path, default=home / '.config/formwork/kan/github-sync-credential.json')
    parser.add_argument('--registry', type=Path, default=home / '.agent-factory/projects.json')
    parser.add_argument('--launcher', type=Path, default=home / 'src/agent-factory/scripts/factory.py')
    parser.add_argument('--checkouts', type=Path, default=home / 'clockwork')
    parser.add_argument('--status', type=Path, default=home / '.local/share/formwork/kan-factory-dispatch/status.json')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--launch', metavar='REPOSITORY', help=argparse.SUPPRESS)
    return parser.parse_args()


def launch(args, repository):
    forwarded = [item for key in ('config', 'profile', 'registry', 'launcher', 'checkouts', 'status')
                 for item in ('--' + key, str(getattr(args, key)))]
    subprocess.run(['systemd-run', '--user', '--quiet', '--collect', '--unit=' + unit(repository),
                    '--property=Type=exec', '--property=SuccessExitStatus=75',
                    '--setenv=PATH=' + os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
                    sys.executable, str(Path(__file__).resolve()), *forwarded, '--launch', repository],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


def dispatch(args, client):
    selected, installed = client.selected(), projects(args.registry)
    if args.launch:
        if args.launch not in selected:
            raise ValueError('Repository no longer selected')
        root, ready = installed.get(args.launch.lower(), (None, False))
        if not ready or not client.queued(args.launch):
            raise ValueError('Repository not ready or queue empty')
        # The runner repeats label/actor checks, holds its own lock and enforces the remote baseline.
        return subprocess.call([sys.executable, str(args.launcher), '--repo', str(root), 'run', '--publish'], cwd=root)
    results = []
    for repository in selected:
        root, ready = installed.get(repository.lower(), (None, False))
        row = {'repository': repository}
        try:
            if root is None and not args.dry_run and client.queued(repository):
                failure = set_up(args, repository)
                if failure:
                    row.update(status='setup failed', reason=failure)
                    results.append(row)
                    continue
                root, ready = projects(args.registry).get(repository.lower(), (None, False))
            if root is None:
                row['status'] = 'missing registered checkout'
            elif not ready:
                row['status'] = 'missing factory setup'
            elif active(repository):
                row['status'] = 'running'
            elif not client.queued(repository):
                row['status'] = 'queue empty'
            elif args.dry_run:
                row['status'] = 'ready'
            else:
                launch(args, repository)
                row['status'] = 'dispatched'
        except Exception as error:
            # Never log request URLs, bearer tokens, response bodies or subprocess output.
            row.update(status='error', error=type(error).__name__)
        results.append(row)
    report = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'repositories': results}
    if not args.dry_run:
        temporary = args.status.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(args.status)
    print(json.dumps(report, indent=2))
    return 0


def main():
    os.umask(0o077)
    args = arguments()
    client = Kan(args.config, args.profile)
    if args.launch or args.dry_run:
        return dispatch(args, client)
    args.status.parent.mkdir(parents=True, exist_ok=True)
    with args.status.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return dispatch(args, client)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('Factory dispatch stopped: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
