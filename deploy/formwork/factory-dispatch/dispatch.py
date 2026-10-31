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

    def pages(self, path, stop=lambda found: False):
        # This request rechecks enabled selection, native permissions and current gateway policy.
        found = []
        for page in range(1, 1001):
            items = self.request('/integrations/github/sync', {
                'workspacePublicId': self.config['workspacePublicId'], 'path': path, 'page': page})
            if not isinstance(items, list):
                raise ValueError('Invalid GitHub response')
            found += items
            if stop(found) or len(items) < 100:
                return found
        raise ValueError('GitHub pagination limit exceeded')

    def issues(self, repository, first=False):
        """Open factory-labelled issues (not pull requests); with first, stop at the first page that has one."""
        matching = lambda items: [i for i in items if 'pull_request' not in i and i.get('state') == 'open'
                                  and any(label.get('name') == 'factory' for label in i.get('labels', []))]
        return matching(self.pages(f'repos/{repository}/issues?state=open&per_page=100',
                                   lambda items: first and bool(matching(items))))

    def queued(self, repository):
        return bool(self.issues(repository, first=True))

    def sent(self, repository, actors):
        """Oldest open factory issue whose latest factory label came from an allowed actor, as the runner picks."""
        for issue in sorted(self.issues(repository), key=lambda i: i.get('created_at', '')):
            events = [e for e in self.pages(f'repos/{repository}/issues/{issue["number"]}/events?per_page=100')
                      if e.get('event') == 'labeled' and (e.get('label') or {}).get('name') == 'factory']
            latest = max(events, key=lambda e: (e.get('created_at', ''), e.get('id', 0))) if events else {}
            if (latest.get('actor') or {}).get('login', '').lower() in actors:
                return issue['number']
        return None


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


def actors(args):
    """The runner's factory_label_actors allowlist; missing or invalid means nobody, so nothing starts."""
    path = args.registry.parent / 'providers.json'
    allowed = json.loads(path.read_text()).get('factory_label_actors', []) if path.is_file() else []
    return {a.lower() for a in allowed if isinstance(a, str)} if isinstance(allowed, list) else set()


def git(root, *arguments, timeout=30):
    return subprocess.run(['git', '-C', str(root), *arguments], check=True, capture_output=True, text=True,
                          stdin=subprocess.DEVNULL, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
                          timeout=timeout).stdout.strip()


def fast_forward(root):
    """Update a clean clone on its default branch to origin's; return a failure reason, or None."""
    try:
        git(root, 'fetch', '--quiet', 'origin', timeout=600)
        try:
            base = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
        except subprocess.CalledProcessError:
            git(root, 'remote', 'set-head', 'origin', '--auto', timeout=120)
            base = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
        branch = base.split('/', 1)[1]
    except (OSError, subprocess.SubprocessError, IndexError):
        return 'cannot fetch the default branch from origin'
    try:
        current = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD')
    except (OSError, subprocess.SubprocessError):
        current = None
    if current != branch:
        return 'checkout ' + str(root) + ' is not on ' + branch + '; not updated'
    try:
        if git(root, 'status', '--porcelain'):
            return 'checkout ' + str(root) + ' has local changes; not updated'
        git(root, 'merge', '--ff-only', '--quiet', base)
    except (OSError, subprocess.SubprocessError):
        return 'checkout ' + str(root) + ' cannot fast-forward to ' + base
    return None


def failure_record(args, repository):
    return args.status.with_name(unit(repository).replace('.service', '.configure.json'))


def set_up(args, repository, issue):
    """Reuse or clone, update and register a selected repository, or start configuring it for the sent issue.
    Return a failure reason, 'configuring' once a configure unit started, or None once registered."""
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
    # configure and the runner both start from the current remote base.
    failure = fast_forward(root)
    if failure:
        return failure
    if not (root / 'factory/config.json').is_file():
        failure_record(args, repository).unlink(missing_ok=True)
        launch(args, repository, ['--configure', repository, '--issue', str(issue)])
        return 'configuring'
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
    parser.add_argument('--configure', metavar='REPOSITORY', help=argparse.SUPPRESS)
    parser.add_argument('--issue', type=int, help=argparse.SUPPRESS)
    return parser.parse_args()


def launch(args, repository, child=None):
    forwarded = [item for key in ('config', 'profile', 'registry', 'launcher', 'checkouts', 'status')
                 for item in ('--' + key, str(getattr(args, key)))]
    forwarded += child or ['--launch', repository]
    subprocess.run(['systemd-run', '--user', '--quiet', '--collect', '--unit=' + unit(repository),
                    '--property=Type=exec', '--property=SuccessExitStatus=75',
                    '--setenv=PATH=' + os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
                    sys.executable, str(Path(__file__).resolve()), *forwarded],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


def configure(args, client):
    """Configure-unit child: recheck the sent issue, configure, then continue as the runner child in this unit."""
    repository = args.configure
    if repository not in client.selected() or client.sent(repository, actors(args)) != args.issue:
        raise ValueError('Repository no longer selected or issue no longer sent')
    root = existing_clone(args, repository)
    if root is None:
        raise ValueError('Checkout not found')
    # configure takes many minutes (agent work and CI); only its last stderr line is kept, never logged.
    result = subprocess.run([sys.executable, str(args.launcher), '--repo', str(root), 'configure', '--issue', str(args.issue)],
                            cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        last = (result.stderr.strip().splitlines() or [''])[-1]
        reason = last[len('configure failed: '):][:300] if last.startswith('configure failed: ') else 'configure failed'
        args.status.parent.mkdir(parents=True, exist_ok=True)
        failure_record(args, repository).write_text(json.dumps({'issue': args.issue, 'reason': reason}) + '\n')
        return 1
    args.launch = repository
    return dispatch(args, client)


def dispatch(args, client):
    if args.configure and not args.launch:
        return configure(args, client)
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
            if root is None and not args.dry_run:
                # One unit per repository: configuring, then running the sent issue, never starts twice.
                if active(repository):
                    row['status'] = 'configuring'
                    results.append(row)
                    continue
                issue = client.sent(repository, actors(args))
                record = failure_record(args, repository)
                failed = json.loads(record.read_text()) if issue and record.is_file() else {}
                if issue and failed.get('issue') == issue:
                    # Like processed runner jobs, a failed issue is not retried automatically.
                    row.update(status='setup failed', reason=failed.get('reason', 'configure failed'))
                    results.append(row)
                    continue
                failure = set_up(args, repository, issue) if issue else None
                if failure == 'configuring':
                    row['status'] = 'configuring'
                elif failure:
                    row.update(status='setup failed', reason=failure)
                if failure:
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
    if args.launch or args.configure or args.dry_run:
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
