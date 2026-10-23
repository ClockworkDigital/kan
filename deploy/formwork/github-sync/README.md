# ClockworkDigital issue sync

The user service `formwork-kan-github-sync` polls every five minutes. It imports
open repository issues into private repository boards in Tech and Innovation,
then synchronises linked titles and descriptions both ways. Issue state flows
only from GitHub into Kan. Closing or reopening an issue must happen in GitHub
after its required checks. A contradictory Kan state is corrected on the next
sync. In progress remains an open GitHub issue.

Descriptions contain the source link and an editable Markdown code block. Keep
the issue description in that block to preserve its Markdown during round trips.
Labels, assignees, comments, attachments, pull requests and GitHub Projects are
not synchronised. New standalone Kan cards do not create GitHub issues. Deleted
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
closing an issue and conflicts. Live initial import and repeated polling are
verified; tests do not edit real GitHub issues.

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
