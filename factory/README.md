# Temporary factory bootstrap

The user approved this published feature branch as a temporary factory base on 25 October 2026. It contains the trusted Clockwork global factory template from `ClockworkDigital/clockwork-skills` commit `e45c93a57faa3fc781f4fb9fe0a1cde83982b677`.

Parent application commit: `fecf4e5e7c88d925067872e4218e2751f8570844`. Configured base: `codex/factory-bootstrap-20261025`. Fix PRs target this branch and remain drafts. No setup merge, deployment or live-data change is authorized.

One job per repository, unchanged repository lock, three build rounds, protected paths, passing baseline, exact-commit checks and independent reviews remain mandatory. Read config.json for the complete dependency installation and checks. Tests without disposable database/container settings may report integration skips; report them explicitly.

Use the globally installed `$factory` skill. The trusted runner is unchanged. Worker invocations use a process-local fast-mode override; no account default is changed.
