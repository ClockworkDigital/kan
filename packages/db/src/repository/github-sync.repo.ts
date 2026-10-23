import { and, eq } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { githubSyncSettings } from "@kan/db/schema";

export const get = (db: dbClient, workspaceId: number) =>
  db.query.githubSyncSettings.findFirst({
    where: eq(githubSyncSettings.workspaceId, workspaceId),
  });

export async function save(
  db: dbClient,
  workspaceId: number,
  userId: string,
  repositories: string[],
  enabled: boolean,
) {
  // A concurrent first save cannot replace another user's delegation.
  const result = await db
    .insert(githubSyncSettings)
    .values({ workspaceId, userId, repositories, enabled })
    .onConflictDoUpdate({
      target: githubSyncSettings.workspaceId,
      set: { repositories, enabled, updatedAt: new Date() },
      setWhere: eq(githubSyncSettings.userId, userId),
    })
    .returning();
  return result.length === 1;
}

export async function report(
  db: dbClient,
  workspaceId: number,
  userId: string,
  status: NonNullable<typeof githubSyncSettings.$inferSelect.status>,
) {
  await db
    .update(githubSyncSettings)
    .set({ status })
    .where(
      and(
        eq(githubSyncSettings.workspaceId, workspaceId),
        eq(githubSyncSettings.userId, userId),
      ),
    );
}
