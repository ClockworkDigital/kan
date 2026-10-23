import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import {
  formworkSyncGrant,
  initFormworkSyncAuth,
} from "../../packages/auth/src/formwork-sync";
import { createDrizzleClient } from "../../packages/db/src/client";
import { get } from "../../packages/db/src/repository/github-sync.repo";
import { getByPublicId } from "../../packages/db/src/repository/workspace.repo";

// Operator-only issuance for an explicitly approved background delegation.
const [input, destination] = process.argv.slice(2);
assert(
  input &&
    destination &&
    process.env.POSTGRES_URL &&
    process.env.BETTER_AUTH_SECRET,
);
const grant = formworkSyncGrant.parse(JSON.parse(readFileSync(input, "utf8")));
const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
assert(baseUrl && grant.targetHost === new URL(baseUrl).host);
assert(grant.tenantId === process.env.FORMWORK_TENANT_ID);
const db = createDrizzleClient();
try {
  const workspace = await getByPublicId(db, grant.workspacePublicId);
  assert(workspace);
  const settings = await get(db, workspace.id);
  assert(settings?.userId === grant.userId);
  const auth = initFormworkSyncAuth(db);
  const result = await auth.api.createApiKey({
    body: {
      userId: grant.userId,
      name: "Formwork GitHub sync",
      prefix: "kan_sync_",
      metadata: grant,
    },
  });
  assert(result.key && !result.expiresAt);
  try {
    writeFileSync(
      destination,
      JSON.stringify({
        baseUrl,
        apiToken: result.key,
        expiresAt: null,
        keyId: result.id,
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    await auth.api.updateApiKey({
      body: { userId: grant.userId, keyId: result.id, enabled: false },
    });
    throw error;
  }
  process.stdout.write("Issued workspace-scoped background sync credential.\n");
} finally {
  await db.$client.end();
}
