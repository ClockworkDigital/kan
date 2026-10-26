# Codex factory

Use the global `$factory` skill or `python3 factory/runner.py --help`.
Review config.json, commit and merge setup to the remote base before starting a job.
One job per repository; three build rounds; human merging; no deployment.
Run `python3 -m unittest discover -s factory/tests -v` to verify the runner.

This fork must target `ClockworkDigital/kan`, not the upstream GitHub CLI default.
Run jobs with `GH_REPO=ClockworkDigital/kan python3 /home/trmos/.codex/skills/factory/scripts/factory.py --repo /home/trmos/clockwork/Kan issue 6`.
The checks require pnpm 9.14.2 on PATH. Live sync and deployment are excluded.
