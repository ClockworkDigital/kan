# Temporary heading factory base

The user approved temporary published bootstrap bases and continuation of Kan #2 after baseline repair. This isolated base applies the explicit 24-path UI dependency from fecf4e5e7c88d925067872e4218e2751f8570844 over repaired main 06967b2d00d8aa1918a7961fd5dc50080b0af609. The dependency is not authorized for main integration as part of the heading fix.

The factory runner and tests are copied unchanged from trusted bootstrap 5b0aa6b059d3e18183472dd066f678966ebe1f05. Only configuration and this dependency documentation change. Configured base is codex/factory-heading-base-20261025. Fix PRs target it as drafts. Later focused main integration must exclude branding and factory setup.

Use the supported project command `python3 factory/runner.py start --request-file PATH` here. It shares the same Git common-directory state and repository lock as the original checkout. The original issue run 20261025-060716-be3b07e8 remains unchanged, stopped at baseline in round zero with no model attempts. This new explicit request is the repaired-base continuation; do not edit saved state or reset round caps.

All existing checks, protected paths, role reviews and three-build-round cap remain. Worker service tier is standard/default through the existing task-local wrapper, with at most three total model workers. No deployment, live data, security settings or credential changes. Model workers never merge.
