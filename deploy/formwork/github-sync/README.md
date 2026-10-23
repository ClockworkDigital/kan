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
