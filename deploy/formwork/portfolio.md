# Portfolio page

`/portfolio` lists the workspace boards that have project details: status,
details, client names, whether the project was shown to a client, internal or
client work, and next steps. It replaces the separate Build Tracker app for the
CEO's overview. Progress counts the cards in each board's last list as done.

- Anyone who can view boards in the workspace, including guests, can read it.
- Users with `board:edit`, or the board's creator while still an active member,
  can add, edit or remove a board's project details from the board menu
  (⋯ → Project details) or from the Portfolio row.
- The GitHub sync delegation cannot call `portfolio.*` routes.

## Rollout

Apply the `AddBoardProjects` migration to Kan's database before rollout. Grant
the existing runtime role SELECT, INSERT, UPDATE and DELETE on `board_project`,
with the same RLS setup as the other Kan tables. The table has no sequence.

Build Tracker data is not imported by this change.

## Verification

```sh
pnpm --filter @kan/api exec vitest run integration-tests/portfolio.integration.test.ts src/utils/sync-scope.test.ts
pnpm --filter @kan/e2e exec playwright test tests/self-hosted/portfolio.spec.ts
```
