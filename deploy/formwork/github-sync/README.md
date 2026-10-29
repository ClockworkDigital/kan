# ClockworkDigital issue sync

The user service `formwork-kan-github-sync` polls every five minutes. It imports
open repository issues into private repository boards in Tech and Innovation,
then synchronises linked titles and descriptions both ways. Issue state flows
only from GitHub into Kan. Closing or reopening an issue must happen in GitHub
after its required checks. A contradictory Kan state is corrected on the next
sync. In progress remains an open GitHub issue.

Descriptions contain the source link and an editable Markdown code block. Keep
the issue description in that block to preserve its Markdown during round trips.
Label names, colours and issue assignments flow only from GitHub into Kan.
Assignees, comments, attachments, pull requests and GitHub Projects are not
synchronised. New standalone Kan cards do not create GitHub issues. Deleted
cards or inaccessible issues are reported; deletion is never propagated.
Archived repositories are skipped. Choose repositories in Settings → Integrations
→ GitHub issue sync. New repositories are listed for selection, not automatically
enabled. Save and enable starts polling within five minutes. Pause or uncheck a
repository to stop its sync without deleting cards or mappings. Keep linked board
names unchanged, because the delegation uses those names to restrict access.
Only the connecting account can manage this workspace's sync settings.

Stable GitHub issue IDs map to Kan public IDs in the protected state file under
`~/.local/share/formwork/kan-github-sync/`. The source link recovers card creation
if a run stops before the mapping is saved. A process lock prevents overlapping
runs. Each field has a saved baseline: conflicting edits stay on both services
and appear in `status.json`. Resolve a conflict by making that field agree on
both sides. Back up state.json with Kan's database; never delete it to reset sync.
Requests are rechecked immediately before writes, but the APIs do not provide a
shared transaction. A concurrent edit during the final write window remains a
limitation of polling.

The worker calls Kan through Formwork using its own protected profile at
`~/.config/formwork/kan/github-sync-credential.json`. It does not use or renew the
Codex MCP credential. Kan decrypts the owner's current saved GitHub PAT for each
GitHub request; the PAT never leaves Kan. Disconnecting GitHub denies subsequent
background data operations, and replacing the PAT applies to the next request.

The operator issues an explicit persistent `formwork-kan-github-sync` delegation
with `issue-sync.ts`, using an approved tenant, stable user UUID, delegated groups,
hostname and workspace public ID. It is independent of browser sign-in. This grant
has no automatic expiry, and retains its approved groups until the operator
revokes/reissues it; it does not poll the identity provider. Current Formwork tool
rules, tool enablement and emergency user blocks still apply on every request.
Native Kan permissions, owner, pause state and selected repositories are checked
on every API operation. Disable the API key to revoke the worker credential.
Never reuse this purpose for interactive access or silently extend an MCP grant.

The gateway copies `X-Formwork-Sync-Workspace` only from Kan's private verification
callback after stripping caller identity headers. Kan restricts the delegated API
to settings/status polling, repository discovery, selected issue requests and
board/card operations within the chosen workspace. It cannot alter credentials,
sync settings or workspace permissions. The app remains unpublished.

Apply the database migration before deploying. Grant the scoped runtime database
role SELECT, INSERT and UPDATE on `github_sync_settings`. Seed selections from the
previous deployment to preserve existing sync; retain the original state file.
The scheduler remains a separately managed user service. Status appears in Kan;
no check-in for fifteen minutes is shown as stale. The detailed per-issue report
remains in the protected `status.json`. A policy outage may prevent writing a
fresh status, so staleness is also a failure signal.

```sh
python3 -m unittest discover -s deploy/formwork/github-sync
systemctl --user start formwork-kan-github-sync.service
systemctl --user status formwork-kan-github-sync.timer
journalctl --user -u formwork-kan-github-sync.service
cat ~/.local/share/formwork/kan-github-sync/status.json
# Stop synchronisation while retaining imported tasks and state:
systemctl --user disable --now formwork-kan-github-sync.timer
```

The service files select this host's checkout and Python. The worker requires only Python and access to Kan through Formwork. It no longer
uses GitHub CLI authentication. Update paths when relocating.
Unit and simulated API tests cover import idempotence, both update directions,
closing an issue and conflicts. Label sync has not been validated against live
data; these tests do not edit real GitHub issues.

The protected `~/.config/formwork/kan/github-sync.json` selects `baseUrl`,
`workspacePublicId`, and the expected stable `userId`. These values must match the
selected Formwork deployment and the owner of the Kan API credential.

Synced repository boards use the GitHub submission form in New card. Bugs require
summary, reproduction steps, expected result, actual result and environment.
Features require summary and desired outcome. The server validates these fields,
checks native card-create permission and submits using the caller's own saved
GitHub token. The regular worker imports the resulting card within five minutes.
The background worker cannot call the submission endpoint. Submission does not
retry automatically; check GitHub after a timeout before submitting again.

`packages/shared/src/issue-forms.ts` defines the shared fields. Run
`node node_modules/vite-node/vite-node.mjs deploy/formwork/generate-issue-templates.ts`
to regenerate GitHub forms in `deploy/formwork/issue-templates`. Publish those to
ClockworkDigital/.github under `.github/ISSUE_TEMPLATE/` when changing requirements.
GitHub inherits these organisation defaults unless a repository defines its own
forms. Custom repository forms are not dynamically interpreted by this version.

The repository picker displays GitHub topics and filters by topic or repository
name. Topic edits replace the complete set on GitHub, using the signed-in owner's
saved PAT; Administration write permission and repository admin access are
required. Existing topics are prefilled. Stale selections are rejected before
writing, although GitHub offers no shared transaction with Kan and a concurrent
edit in the final write window is still possible. The worker cannot edit topics.
Topic names are public even when the repository is private. Use lowercase
letters, digits and hyphens, at most 50 characters each and 20 topics per repo.

## GitHub label ownership

The worker reads every page of the selected repository's label definitions,
including labels that are not assigned to an open issue. Labels are scoped to the
mapped private board. `state.json` now has an additive `labels` mapping keyed by
repository ID and GitHub label ID. Existing issue mappings and conflict baselines
are retained. Renaming or recolouring a label updates its existing Kan public ID.
Kan edits to imported names, colours or assignments are corrected on the next
poll. These changes never generate GitHub label writes.
Conflicting board ownership or duplicate ownership of any current or retired Kan
label public ID stops the worker before board or repository reads. Repair the protected
mapping after inspecting the affected boards; never resolve ownership by name.

Only mapped labels are managed. A Kan-only label with the same name or colour is
not adopted, renamed, detached or deleted. It can coexist with an imported label
of the same name. Removing an issue label removes that imported assignment from
the linked card. Closed tracked issues are included. Deleting a label in GitHub
retires its mapping and removes its assignments from linked cards, but retains
the Kan board definition and any assignments on standalone Kan cards. The worker
never deletes labels. Recreating a GitHub label produces a new source identity,
so an old retired definition can coexist with its replacement. Manually deleting
an active imported Kan label recreates it on the next poll.

A pending label-create intent is saved before POST. If a request times out, or the
process stops before saving the returned public ID, later polls stop label sync
for that repository instead of creating a duplicate or guessing ownership by
name. This also applies if the pending source label has disappeared from GitHub.
The protected report identifies this condition. An operator must inspect
the board and pending entry, then record the confirmed new label public ID or
clear that pending entry only after proving no label was created. Preserve the
entry's `retiredPublicIds` when repairing a mapping. Never remove the state file.
Definitively rejected HTTP 4xx requests other than HTTP 408 and 499 clear their
pending intent and can retry normally. Timeouts, client disconnects and server
failures retain the intent. Repository errors skip that repository;
other selected repositories continue.

The membership API toggles labels, so the worker re-reads each card immediately
before each toggle and checks the returned membership. The existing polling
limitation still applies to concurrent edits during the final request window.
Full GitHub names of up to 50 characters are accepted by the label API without
truncation. Incomplete pagination and malformed label snapshots stop reconciliation
without retiring definitions or removing assignments. No database migration is needed.

### Delegation boundaries

The background allowlists permit label-list reads only for selected repositories.
Label create/update is limited to active private repository boards in the
specified workspace and requires `board:edit`. Card-label assignment is limited
to active labels on the card's own authorized board, including assignments when
creating cards. Label deletion and all GitHub label writes remain forbidden.
Current owner, pause, provider and native permission checks still apply on every
request. This change does not alter credentials or deployed gateway policy.

Deployment and live label validation are still outstanding. A later approved
rollout must update the app and separately scheduled worker together. Older app
versions reject label-list reads and Kan label operations from this delegation.

Before resuming the scheduler, back up the protected state and record both the
running app image revision and the worker checkout revision. Check the running
image, not just the primary checkout's source. Stage the app's selected-repository
label allowlist before enabling the label-aware worker. Run the offline worker
and delegated API tests against that release. Any later live verification needs
separate approval and disposable data. Verify a selected repository label read
through the existing delegation, then verify one import and an unchanged repeat
poll before resuming regular polling. Confirm unselected reads and label writes
remain denied. Do not reset mappings or conflict baselines during rollout.

The protected report includes numeric `httpStatus` for HTTP failures, alongside
the repository and operation. It never includes HTTP error URLs, headers, reasons
or response bodies. HTTP 403 during `labels` means the request was rejected;
it does not establish whether the rejection came from the gateway or Kan.
Check the app's private request logs for the corresponding procedure and denial.
On 2026-10-26, operator diagnosis found five repository label failures and a
403 with `Outside background sync delegation.` at `githubSync.request`.
Current source permits selected-repository label reads, so an app/worker version
mismatch is the leading explanation, not a verified deployment diagnosis.
Compare running revisions first, then check the existing owner, workspace,
selection, pause, provider and native permissions. Do not broaden delegation,
renew credentials, edit live mappings or retry live sync to diagnose this error.

### Offline build verification, 2026-10-26

These results are from this build, independently of the earlier draft's counts.
Full command logs are in `/tmp/kan-issue6-validation/` on the build host.

| Check                                                         | Result                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `python3 -m unittest discover -s deploy/formwork/github-sync` | 20 passed                                                                                                                           |
| Targeted API tests                                            | 69 passed across github-sync, sync-scope, label, card-labels, card-description, card-members and label repository integration tests |
| `pnpm lint`                                                   | Passed, 19 tasks, eight existing web warnings                                                                                       |
| `pnpm typecheck`                                              | Passed, 22 tasks                                                                                                                    |
| Direct API/DB typechecks and targeted ESLint/Prettier         | Passed                                                                                                                              |
| Label UI check                                                | Three colour tests passed; shared badge render preserved a 50-character name and custom SVG fill                                    |
| `pnpm test`                                                   | Failed at MCP; its local HTTP server cannot bind, `listen EPERM 127.0.0.1`                                                          |
| Continued unit run                                            | Shared 18/18, auth 80/80, web 98/98; MCP 12 passed/1 failed; API 211 passed/3 failed                                                |
| `pnpm test:e2e`                                               | Stopped before tests, `mailpit: not found`; cloud mode was not reached                                                              |
| Docker app build                                              | Could not start, permission denied on `/var/run/docker.sock`                                                                        |

The continued run used
`pnpm --filter='!@kan/e2e' -r --no-bail --workspace-concurrency=1 --if-present test`.
API failures were the unchanged `github-policy.test.ts:64` assertion and two
5-second timeouts in `integration.repo.integration.test.ts`. The initial parallel
API run had 210 passed/4 failed, including an additional webhook fixture timeout;
that webhook test passed in the continued run. A separate serial recheck still
failed the policy assertion and one integration timeout. The affected policy,
integration, webhook and MCP fixtures and implementations match base
`ed59609b41a58d7f2cc0f68a3f30c69e5c467858`; no unrelated fixture repairs were made.
These failures remain recorded rather than treating the broader gates as passed.
No live sync or deployment was performed.

## Production and Experiment policy

Classify through Kan's topic editor with exactly one of `production` or
`experiment`. Production adds acceptance criteria, a test plan and impact/risk
fields to bugs and features. PRs also need Summary and a Related issue reference.
Experiment retains the base bug/feature forms and a summary-only PR template.
Kan reads GitHub topics again at submission time and validates Production answers
server-side. The UI policy lookup also uses the user's own GitHub token.

A classification change installs namespaced issue forms, the PR template and a
metadata-only `pull_request_target` workflow in one non-force Git commit. It
never checks out or runs PR code. Production adds an independent active ruleset
requiring `Production submission requirements` on the default branch, without
replacing other rulesets. GitHub repository Administration, Contents and Workflows
write permissions and a plan supporting rulesets are needed. Classification is
saved only after setup succeeds. A later API failure may leave stricter policy
files installed; inspect the GitHub commit before retrying. Protected branches
may require an operator to apply the policy through a PR instead of a direct
commit. Existing custom templates cause setup to stop for an explicit migration.

Changing classification directly on GitHub does not install these files. Apply
classification through Kan. It does not remove pre-existing branch protection;
changing Production to Experiment may require a reviewed policy update on a
protected branch. The automatic check validates required information, not its
correctness or engineering quality. GitHub admins retain their normal ability
to change policies. Issue-form requirements apply to GitHub's web forms; GitHub's
API itself cannot be forced to reject incomplete issues by these templates.
No repositories are classified automatically.
Existing PRs may need a description edit or another eligible PR event after policy
installation to produce the newly required check. No existing PR is auto-approved.

GitHub App connections are also supported; see [setup and expiry](../github-oauth.md). They require explicit reconnect on expiry; the worker never refreshes credentials.
