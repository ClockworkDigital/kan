# Factory queue dispatch

The existing `agent-factory-kan.timer` runs this dispatcher every minute. It reads
current GitHub sync settings through the protected Kan API, using the existing
sync profile. A paused sync launches no new work; only selected repositories are
considered. It checks open issues for the `factory` label using existing allowed
GitHub reads. No credentials are issued, renewed, or printed.

Each selected repository runs from a checkout registered in
`~/.agent-factory/projects.json` with committed `factory/config.json` holding
actual project checks and `queue_label: "factory"`; both are set up automatically
when an issue is sent (below). Git worktrees resolve to their primary
checkout. When separate registered clones share a remote, the first registered
primary checkout wins; put the intended main checkout before extra lanes. The
configured push remote must match the selected GitHub repository.

When a selected repository has no registered checkout, the dispatcher sets it up
only for an issue someone sent: the oldest open `factory` issue whose latest
`factory` label came from an actor in agent-factory's `factory_label_actors`
(`~/.agent-factory/providers.json`; missing or empty allows nobody), the same
rule the runner applies. It reads the label events through Kan's sync API
(`repos/<repo>/issues/<n>/events?per_page=100`, read-only). Idle repositories,
issues labelled by anyone else, and dry runs are never cloned or configured.

It first reuses an existing clone whose `origin` is the same GitHub repository
(owner/name compared case-insensitively; https, ssh and `.git` forms match),
checking registry paths and then each folder directly under `~/clockwork`
(`--checkouts`) whatever its name, e.g. `~/clockwork/pulse check`. Only when none
matches does it clone `https://github.com/<owner>/<repo>.git` into
`~/clockwork/<repo>`. An existing path that is not a matching clone is never
modified. It then fetches `origin` and fast-forwards the clone to
`origin/<default branch>`, but only if the clone is clean and on that branch;
otherwise it changes nothing and reports why.

If the updated clone already has `factory/config.json`, it is registered with
`factory.py --repo <path> register` and dispatched in the same run. Otherwise the
dispatcher starts `factory.py --repo <path> configure --issue <n>` in the
repository's unit (below) and reports `configuring` while that unit is active.
Configure can take many minutes (agent work and CI) and other repositories keep
dispatching meanwhile. It reports the issue to Kan at the `configuring` stage
itself. On success the config is merged, the checkout updated and registered,
and the same unit goes straight on to run the sent issue. On failure only the
last stderr line (`configure failed: <reason>`) is kept, in
`agent-factory-sync-<hash>.configure.json` beside the status file, and the row
reports `setup failed` with that `reason`. A failed issue is not configured
again automatically; sending a different issue retries, or delete that file to
retry the same one. Other setup failures also report `setup failed` with a
`reason`.

Repositories run independently in stable `agent-factory-sync-<hash>.service` user
units, used for both configuring and running. An active unit cannot be started
twice. Immediately before configuring or running, the child rereads settings,
resolves the checkout again, and rechecks the sent issue or queue through Kan.
The existing factory launcher enforces its label-actor allowlist, per-repo lock,
remote baseline checks, and manual PR merge policy (only configure's own config
PR, limited to `factory/**` and `.gitignore`, is merged by agent-factory). Already processed
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

The JSON report lists every selected repository as ready, running, configuring,
queue empty, missing registered checkout, missing factory setup, setup failed
(with a reason), or error. Ordinary timer runs
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
