# Factory dashboard

Open **Factory** in the workspace navigation (or press G, F). Jobs show their
latest stage, GitHub issue and PR, review/check results by round, reported risk,
builder, estimated USD cost and elapsed seconds. Inspect artifacts to read the
published spec, build notes, checks and reviews as plain text. Costs are reported
estimates, not billing totals. Missing telemetry is omitted.

The page polls every five seconds while visible and recovers on reconnect or
reload from PostgreSQL. It shows an error instead of stale results after a failed
read. Open artifacts refresh when their job revision changes; failed loads retry
after a successful list refresh. Twenty jobs are shown per page, newest report first. Reports can move jobs
between pages while the factory is running.

Cards linked by the GitHub sync's leading issue link also show a stage badge in
their detail view. The badge polls every five seconds while the card is open and
matches repository and issue number within the card's workspace. The newest
created run wins, even if an older run publishes again. Failed and human-review
stages remain visible until a newer run replaces them. No matching job means no
badge; failed reads hide the badge until polling succeeds.

## Publish from a running factory

After saving progress, send a complete snapshot to Kan's existing public API:

`PUT /api/v1/workspaces/{workspacePublicId}/factory/jobs`

Use `Authorization: Bearer <credential>` over HTTPS. The caller must have active
workspace membership and `workspace:manage`; readers need membership and
`workspace:view`. There is no anonymous/public dashboard. A run is identified by
workspace, GitHub `repository` and the producer's stable `runKey`. Kan returns its
12-character `publicId` and accepted `revision`. Do not send internal Kan IDs.

```json
{
  "repository": "ClockworkDigital/kan",
  "runKey": "20261028-example",
  "revision": 1,
  "snapshot": {
    "title": "Example factory run",
    "stage": "building",
    "issueNumber": 1,
    "prNumber": null,
    "risk": "high",
    "builderModel": "example-builder",
    "estimatedCostUsd": null,
    "elapsedSeconds": 30,
    "rounds": [{ "round": 1, "gate": "pending", "reviews": [] }]
  },
  "artifacts": [{ "name": "spec.md", "content": "The approved specification." }]
}
```

Persist an increasing integer revision with each changed snapshot. Retry an
identical request after a lost response. A lower revision, changed payload at the
same revision, or a different publisher returns HTTP 409 and leaves saved data
unchanged. Resolve that conflict in the producer; do not blindly increment and
overwrite it. Include previous rounds and artifacts in each snapshot to retain
them. GET the same collection to list jobs (`page=0`, then `page=1`, etc.); GET
`/api/v1/workspaces/{workspacePublicId}/factory/jobs/{jobPublicId}` for artifacts.

Stages: `queued`, `intake`, `spec`, `building`, `checks`, `rework`, `review`,
`publishing`, `babysitting`, `judging`, `waiting`,
`needs_info`, `needs_human`, `failed`, `completed`. Gate/reviewer results:
`pending`, `pass`, `fail`, `skipped`. Use `null` for unavailable issue/PR numbers,
risk, model, cost and elapsed time. Reports are limited to 512 KiB, 50 rounds,
10 reviewers per round and 50 artifacts of at most 65,536 characters each.
Round numbers and artifact names must be unique; reviewer names must be unique
within each round. Artifact names are display
labels, never server paths. Kan neither reads the producer's files nor fetches
artifact URLs. Publish only artifacts appropriate for workspace members; remove
credentials and private machine details before sending. Report bodies are
excluded from request logs.

## Formwork and rollout

Use an explicitly issued, owner-bound Formwork native API credential through the
gateway. Its existing tenant, department, block and eight-hour identity expiry
checks still apply; Kan also checks native permissions on every operation. Stop
publishing on 401/403 and have the operator inspect or reissue the grant. There is
no automatic renewal. The GitHub sync delegation cannot access factory routes.
Keep the verification callback private and do not publish the app port.

Apply the generated `AddFactoryJobs` and `AllowDeletedFactoryPublisher`
migrations to Kan's independent database before rollout. Grant its existing runtime role SELECT, INSERT and UPDATE on
`factory_jobs` and usage on `factory_jobs_id_seq`, using the same RLS setup as
the existing Kan tables. No live deployment or credential issuance is performed
by this change. The producer integration is HTTP-based and does not alter the
global factory runner, its saved job files or GitHub issue sync state.

## Verification

The API integration test runs the migrations against disposable PostgreSQL
(PGlite) and rolls back fixtures. It covers a sample lifecycle, stale/conflicting
reports, idempotency, permissions, cross-workspace reads, publisher ownership,
deletions, pagination and payload limits. The browser regression test uses a
temporary native API key to publish building → failed checks → rework → review
→ completion, observes automatic updates, opens an artifact safely, reloads,
interrupts polling and verifies recovery. Existing Formwork authentication tests
cover tenant and identity snapshot rejection separately.

```sh
pnpm --filter @kan/api exec vitest run integration-tests/factory.integration.test.ts src/utils/sync-scope.test.ts
pnpm --filter @kan/auth test
pnpm --filter @kan/e2e exec playwright test tests/self-hosted/factory-dashboard.spec.ts
```

## Send an issue to the factory

Set `FACTORY_SENDER_EMAILS` in the private Kan environment to a comma-separated
list of owner Kan account emails. Whitespace and case are ignored; unset or empty
denies everyone. This grants permission to spend the owner's model tokens.
The card menu shows **Send to factory** only for permitted accounts with card edit
access and a linked, currently open GitHub issue. The mutation repeats these checks.
It uses the Formwork Kan App installation token and requires **Issues: write**
(documented in github-oauth.md; verify the installed grant before rollout).
The existing `factory` label must exist; Kan does not create it.
A success toast confirms queueing; the normal GitHub sync brings the label to Kan.
Sending an already labelled issue makes no further write. No factory run is
started directly and no credential is renewed.
