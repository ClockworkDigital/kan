---
name: babysit-pr
description: Watch the current PR until it is ready to merge — resolve bot review comments, fix failing CI checks, and loop until all checks are green and no unanswered bot comments remain.
license: MIT
compatibility: Requires git, gh (GitHub CLI), and Node.js installed.
allowed-tools: Bash(gh pr *) Bash(gh run *) Bash(gh api *) Bash(npx agent-reviews *) Bash(pnpm dlx agent-reviews *) Bash(yarn dlx agent-reviews *) Bash(bunx agent-reviews *) Bash(git config *) Bash(git add *) Bash(git commit *) Bash(git push *) Bash(git status *) Bash(git diff *) Bash(git log *)
---

Babysit the current PR until it is merge-ready. Alternate between two signals and fix whatever is broken after each round:

1. **CI checks** — all required checks must pass (`gh pr checks`).
2. **Bot review comments** — no unanswered bot comments (`npx agent-reviews --watch --bots-only`).

Terminate only when both signals are clean at the same time.

## Prerequisites

The current branch must have an associated PR. The `agent-reviews` CLI authenticates via `gh` or env vars; on cloud environments verify `git config --global --get user.email` is set to a real address so CI can attribute commits.

Substitute the user's package manager runner (`pnpm dlx`, `yarn dlx`, `bunx`) for `npx` where appropriate.

## Phase 1: Initial sweep

### Step 0: Ensure the PR is mergeable

Before touching CI or comments, confirm the PR is not conflicting with its base branch. A stale base can cause CI to pass on obsolete code or block merge even after every check is green.

Run `gh pr view --json mergeable,mergeStateStatus,baseRefName`.

- **`mergeable: MERGEABLE`** → go to Step 1.
- **`mergeable: UNKNOWN`** → GitHub has not computed mergeability yet. Wait ~5s and re-check (retry up to 3 times before escalating).
- **`mergeable: CONFLICTING`** or **`mergeStateStatus: DIRTY`** → rebase:
  1. `git fetch origin <baseRefName>`
  2. `git rebase origin/<baseRefName>`
  3. If conflicts arise during the rebase:
     - Trivial / mechanical conflicts (lockfile regeneration, import re-ordering, adjacent edits to separate symbols): resolve and `git rebase --continue`.
     - Non-trivial conflicts (overlapping logic changes, schema/API changes, anything requiring product judgement): run `git rebase --abort` and ask the user.
  4. After a clean rebase, push with `git push --force-with-lease` — never plain `--force`.
  5. Re-run `gh pr view --json mergeable` to confirm the PR is now clean before proceeding.

### Step 1: Resolve existing bot comments

If there are any unanswered bot comments, resolve them by invoking the `resolve-agent-reviews` skill (or following its workflow: fetch with `--bots-only --unanswered --expanded`, evaluate each finding, fix true positives, commit, push, reply with `--resolve`).

Skip to Step 2 if there are no unanswered comments.

### Step 2: Check CI status

Run `gh pr checks` to read the current status.

- **All passing** → Phase 2.
- **Any pending / in-progress** → Step 3.
- **Any failed** → Step 4.

### Step 3: Wait for in-flight checks

Run `gh pr checks --watch` to block until every check finishes. When it returns, re-run Step 2 to re-evaluate.

### Step 4: Fix failing checks

For each failed check:

1. Identify the failing run: `gh pr checks --json name,link,state,workflow` (or `gh pr view --json statusCheckRollup`).
2. Fetch the failing logs: `gh run view <run-id> --log-failed`. For very long logs, grep for the first error.
3. Analyze the root cause. Read the relevant code — do not guess from the log alone.
4. Fix the code minimally. Do not refactor unrelated code.
5. Reproduce the check locally where feasible (lint, type-check, unit tests).
6. Commit with a message describing the fix (e.g., `fix(ci): resolve type error in FooBar`) and push.
7. Return to Step 2.

If the failure is genuinely unclear, or the fix would require architectural changes, stop and ask the user.

## Phase 2: Watch loop

All checks are green and all known bot comments are resolved. Now wait to see whether anything new appears.

### Step 5: Watch for new bot comments

Run `npx agent-reviews --watch --bots-only` as a background task and wait for it to exit (default 10 min; override with `--timeout`).

- **`EXITING WITH NEW COMMENTS`** → handle them as in Step 1, then go back to **Step 2** (new commits may have retriggered CI).
- **`WATCH COMPLETE`** → Step 6.

### Step 6: Final CI sanity check

Run `gh pr checks` once more. Intermediate commits may have kicked off a new run. Also re-check `gh pr view --json mergeable` — the base may have moved during the watch window.

- **All green and mergeable** → Summary report. Done.
- **Check failing or pending** → back to Step 2.
- **Conflicting with base** → back to Step 0.

## Summary report

```
## Babysit PR Summary
- Iterations: N
- Bot comments addressed: X (fixed Y, won't-fix Z, skipped W)
- CI failures fixed: M
- Final status: All checks green, no unanswered bot comments
```

## Stopping rules

Bail out and ask the user when:

- The same check fails 3 times in a row after your fixes — your diagnosis is probably wrong.
- The same bot keeps re-raising a comment on the same lines after you replied — it is not accepting your fix or dismissal.
- A failure requires judgement outside the scope of the PR (architectural change, unrelated broken infra, flaky test needing a retry rather than a fix).
- The user has not authorized pushing to this branch, or the branch is protected.

Do not use destructive git operations to work around a failure. `git push --force-with-lease` is acceptable after a legitimate rebase in Step 0; plain `git push --force`, `git reset --hard`, and history rewrites intended to hide a failing check are not.
