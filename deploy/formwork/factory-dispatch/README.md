# Factory queue dispatch

The existing `agent-factory-kan.timer` runs this dispatcher every minute. It reads
current GitHub sync settings through the protected Kan API, using the existing
sync profile. A paused sync launches no new work; only selected repositories are
considered. It checks open issues for the `factory` label using existing allowed
GitHub reads. No credentials are issued, renewed, or printed.

Each selected repository needs an operator-registered checkout in
`~/.agent-factory/projects.json` and reviewed `factory/config.json` with actual
project checks and `queue_label: "factory"`. Git worktrees resolve to their primary
checkout. When separate registered clones share a remote, the first registered
primary checkout wins; put the intended main checkout before extra lanes. The
configured push remote must match the selected GitHub repository. Missing setup
is reported explicitly, without cloning repositories or guessing checks.

Repositories run independently in stable `agent-factory-sync-<hash>.service` user
units. An active unit cannot be started twice. Immediately before running, the
child rereads settings, resolves the checkout again, and rechecks the queue through
Kan. The existing factory launcher enforces its label-actor allowlist, per-repo
lock, remote baseline checks, and manual PR merge policy. Already processed
issues are not automatically restarted. The runner's existing first-100-labelled-
issues queue limit still applies. In-flight work is not killed when sync settings
change; the change prevents subsequent launches.

The factory's existing machine-level Kan publisher remains separate from the
sync profile: the dispatcher uses the latter only for settings and GitHub reads.
It does not publish reports itself or modify sync mappings, jobs, or baselines.

## Inspect and install

Run the inventory without starting models or writing status:

```sh
python3 deploy/formwork/factory-dispatch/dispatch.py --dry-run
python3 -m unittest discover -s deploy/formwork/factory-dispatch -p 'test_*.py'
```

The JSON report lists every selected repository as ready, running, queue empty,
missing registered checkout, missing factory setup, or error. Ordinary timer runs
save it privately to `~/.local/share/formwork/kan-factory-dispatch/status.json`.
If settings or owner authorization cannot be read, the dispatcher exits without
launching anything. Check its journal as well as the status timestamp: a failed
settings read cannot produce a fresh inventory. Per-repository errors contain
only exception types, never URLs, bodies, credentials, or subprocess output.

For an approved rollout on this host, first retain the previous unit files. Stop
`agent-factory-kan.timer` and wait for any old `agent-factory-kan.service` run to
finish; do not interrupt an active model run. Install the service and timer files
from this directory into `~/.config/systemd/user/`, run
`systemctl --user daemon-reload`, then enable/start the timer. The files use this
host's existing Kan and launcher paths; adjust them for another host.

```sh
systemctl --user enable --now agent-factory-kan.timer
journalctl --user -u agent-factory-kan.service
systemctl --user list-units 'agent-factory-sync-*'
```

Rollback stops the dispatcher timer and restores the retained service/timer files,
then reloads systemd and enables the old timer. It need not terminate existing
per-repository runs, delete jobs, or change the database.
