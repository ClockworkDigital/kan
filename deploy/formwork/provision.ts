import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { dbClient } from "../../packages/db/src/client";
import { createDrizzleClient } from "../../packages/db/src/client";
import * as memberRepo from "../../packages/db/src/repository/member.repo";
import * as permissionRepo from "../../packages/db/src/repository/permission.repo";
import * as workspaceRepo from "../../packages/db/src/repository/workspace.repo";
import {
  users,
  workspaceMembers,
  workspaces,
} from "../../packages/db/src/schema";

// Privileged, explicit provisioning. Never infer membership from an email match.
const filename = process.argv[2];
assert(filename, "Supply a protected JSON file containing the approved users");
assert(process.env.POSTGRES_URL, "Set the operator POSTGRES_URL");
const approved = z
  .array(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(255),
      email: z.string().email().max(255),
      emailVerified: z.boolean().default(false),
    }),
  )
  .min(1)
  .parse(JSON.parse(readFileSync(filename, "utf8")));
assert.equal(new Set(approved.map((user) => user.id)).size, approved.length);
const owner = approved[0];
assert(owner);
const db = createDrizzleClient();
try {
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values(approved)
      .onConflictDoNothing({ target: users.id });
    const client = tx as unknown as dbClient;
    let workspace = await tx.query.workspaces.findFirst({
      where: eq(workspaces.slug, "tech-innovation"),
    });
    if (!workspace) {
      await workspaceRepo.create(client, {
        name: "Tech and Innovation",
        slug: "tech-innovation",
        createdBy: owner.id,
        createdByEmail: owner.email,
      });
      workspace = await tx.query.workspaces.findFirst({
        where: eq(workspaces.slug, "tech-innovation"),
      });
    }
    assert(
      workspace && !workspace.deletedAt,
      "Expected an active department workspace",
    );
    const role = await permissionRepo.getRoleByWorkspaceIdAndName(
      client,
      workspace.id,
      "admin",
    );
    assert(role, "Expected the native workspace administrator role");
    for (const user of approved) {
      const existing = await tx.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, user.id),
        ),
      });
      if (!existing)
        await memberRepo.create(client, {
          workspaceId: workspace.id,
          userId: user.id,
          email: user.email,
          createdBy: owner.id,
          role: "admin",
          roleId: role.id,
          status: "active",
        });
      else
        assert(
          existing.roleId === role.id &&
            existing.status === "active" &&
            !existing.deletedAt,
          "Existing membership differs; review it before changing permissions",
        );
    }
  });
  console.info(`Provisioned ${approved.length} department administrators.`);
} finally {
  await db.$client.end();
}
