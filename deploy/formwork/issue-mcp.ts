import assert from "node:assert/strict";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

import {
  formworkApiGrant,
  initFormworkApiAuth,
} from "../../packages/auth/src/formwork-api";
import { createDrizzleClient } from "../../packages/db/src/client";

// Privileged operator delegation. The input is an explicitly approved identity snapshot.
const input = process.argv[2];
const destination = process.argv[3];
assert(
  input && destination,
  "Supply protected grant and output JSON filenames",
);
assert(process.env.POSTGRES_URL && process.env.BETTER_AUTH_SECRET);
const snapshot = formworkApiGrant.parse(
  JSON.parse(readFileSync(input, "utf8")),
);
assert.equal(snapshot.tenantId, process.env.FORMWORK_TENANT_ID);
const baseUrl = z.string().url().parse(process.env.NEXT_PUBLIC_BASE_URL);
assert.equal(snapshot.targetHost, new URL(baseUrl).host);
const remaining = snapshot.issuedAt + 28_800 - Math.ceil(Date.now() / 1000);
assert(
  remaining > 0 && remaining <= 28_800,
  "Snapshot must be fresh and bounded to eight hours",
);
const db = createDrizzleClient();
try {
  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.id, snapshot.userId),
  });
  assert(user, "Provision this stable user UUID before issuing a credential");
  const credentials = initFormworkApiAuth(db);
  const result = await credentials.api.createApiKey({
    body: {
      userId: snapshot.userId,
      name: "Codex through Formwork",
      prefix: "kan_mcp_",
      expiresIn: remaining,
      metadata: snapshot,
    },
  });
  assert(result.key && result.expiresAt);
  const temporary = `${destination}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({
        baseUrl,
        apiToken: result.key,
        expiresAt: result.expiresAt,
        keyId: result.id,
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } catch (error) {
    await credentials.api.updateApiKey({
      body: {
        userId: snapshot.userId,
        keyId: result.id,
        enabled: false,
      },
    });
    throw error;
  }
  process.stdout.write(
    JSON.stringify({
      keyId: result.id,
      userId: result.userId,
      expiresAt: result.expiresAt,
    }) + "\n",
  );
} finally {
  await db.$client.end();
}
