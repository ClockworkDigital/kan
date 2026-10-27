# Agent factory

Only this configuration lives here: the global `agent-factory` skill runs its bundled runner
against this repository (`factory.py --repo . status`). To pin a runner version instead,
vendor it as `factory/runner.py`; a repository runner always takes precedence.
Providers (Codex, Claude) are chosen per step from machine-level accounts by headroom.
Review config.json, commit and merge setup to the remote base before starting a job.
One job per repository; three build rounds; human merging; no deployment.
