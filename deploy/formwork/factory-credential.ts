import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { assertUserInWorkspace } from "../../packages/api/src/utils/auth";
import { assertPermission } from "../../packages/api/src/utils/permissions";
import {
  formworkFactoryGrant,
  initFormworkSyncAuth,
} from "../../packages/auth/src/formwork-sync";
import { createDrizzleClient } from "../../packages/db/src/client";
import { getByPublicId } from "../../packages/db/src/repository/workspace.repo";

// Operator-only issuance for an explicitly approved background delegation.
const [input, destination] = process.argv.slice(2);
assert(
  input &&
    destination &&
    process.env.POSTGRES_URL &&
    process.env.BETTER_AUTH_SECRET,
);
const grant = formworkFactoryGrant.parse(
  JSON.parse(readFileSync(input, "utf8")),
);
const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
assert(baseUrl && grant.targetHost === new URL(baseUrl).host);
assert(grant.tenantId === process.env.FORMWORK_TENANT_ID);
const db = createDrizzleClient();
try {
  const workspace = await getByPublicId(db, grant.workspacePublicId);
  assert(workspace && !workspace.deletedAt);
  await assertUserInWorkspace(db, grant.userId, workspace.id);
  await assertPermission(db, grant.userId, workspace.id, "workspace:manage");
  const auth = initFormworkSyncAuth(db);
  const result = await auth.api.createApiKey({
    body: {
      userId: grant.userId,
      name: "Formwork factory",
      prefix: "kan_factory_",
      metadata: grant,
    },
  });
  assert(result.key && !result.expiresAt);
  try {
    writeFileSync(destination, result.key + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    await auth.api.updateApiKey({
      body: { userId: grant.userId, keyId: result.id, enabled: false },
    });
    throw error;
  }
  process.stdout.write("Issued workspace-scoped factory credential.\n");
} finally {
  await db.$client.end();
}
