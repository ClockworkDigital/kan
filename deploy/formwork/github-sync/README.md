# ClockworkDigital issue sync

The user service `formwork-kan-github-sync` polls every five minutes. It imports
open repository issues into private repository boards in Tech and Innovation,
then synchronises linked titles, descriptions and open/closed status both ways.
Moving a linked card to Closed closes its GitHub issue. Moving it to another list
on the same board reopens it. In progress remains an open GitHub issue.

Descriptions contain the source link and an editable Markdown code block. Keep
the issue description in that block to preserve its Markdown during round trips.
Labels, assignees, comments, attachments, pull requests and GitHub Projects are
not synchronised. New standalone Kan cards do not create GitHub issues. Deleted
cards or inaccessible issues are reported; deletion is never propagated.
Archived repositories are skipped. New accessible organisation repositories are
discovered automatically and receive boards when they have open issues.

Stable GitHub issue IDs map to Kan public IDs in the protected state file under
`~/.local/share/formwork/kan-github-sync/`. The source link recovers card creation
if a run stops before the mapping is saved. A process lock prevents overlapping
runs. Each field has a saved baseline: conflicting edits stay on both services
and appear in `status.json`. Resolve a conflict by making that field agree on
both sides. Back up state.json with Kan's database; never delete it to reset sync.
Requests are rechecked immediately before writes, but the APIs do not provide a
shared transaction. A concurrent edit during the final write window remains a
limitation of polling.

The worker calls the fork's authenticated `/integrations/github/sync` API using
the protected Kan MCP profile. Kan decrypts the current user's saved GitHub PAT
server-side for each request; the PAT never leaves Kan. Replacing or disconnecting
the GitHub integration therefore applies on the next request. Formwork checks current
access and blocks, and the worker checks native workspace permissions before
GitHub writes. Credential expiry stops the worker; it does not renew credentials
or bypass Formwork. The credential expiry is recorded in the private profile.
After authorised renewal, the next scheduled run reads the new profile.

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
