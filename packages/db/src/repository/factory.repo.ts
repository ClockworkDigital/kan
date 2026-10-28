import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { factoryJobs } from "@kan/db/schema";
import { generateUID } from "@kan/shared";

const summaryColumns = {
  publicId: factoryJobs.publicId,
  repository: factoryJobs.repository,
  runKey: factoryJobs.runKey,
  revision: factoryJobs.revision,
  snapshot: factoryJobs.snapshot,
  updatedAt: factoryJobs.updatedAt,
};

export async function publish(
  db: dbClient,
  input: Pick<
    typeof factoryJobs.$inferInsert,
    | "workspaceId"
    | "repository"
    | "runKey"
    | "revision"
    | "snapshot"
    | "artifacts"
  > & { createdBy: string },
) {
  const [job] = await db
    .insert(factoryJobs)
    .values({ ...input, publicId: generateUID() })
    .onConflictDoUpdate({
      target: [
        factoryJobs.workspaceId,
        factoryJobs.repository,
        factoryJobs.runKey,
      ],
      set: {
        revision: input.revision,
        snapshot: input.snapshot,
        artifacts: input.artifacts,
        updatedAt: sql`CASE WHEN ${factoryJobs.revision} < ${input.revision} THEN now() ELSE ${factoryJobs.updatedAt} END`,
      },
      // Retries are idempotent; stale revisions and other publishers cannot overwrite a run.
      setWhere: and(
        isNull(factoryJobs.deletedAt),
        eq(factoryJobs.createdBy, input.createdBy),
        or(
          lt(factoryJobs.revision, input.revision),
          and(
            eq(factoryJobs.revision, input.revision),
            eq(factoryJobs.snapshot, input.snapshot),
            eq(factoryJobs.artifacts, input.artifacts),
          ),
        ),
      ),
    })
    .returning({
      publicId: factoryJobs.publicId,
      revision: factoryJobs.revision,
    });
  return job;
}

export const list = (db: dbClient, workspaceId: number, page: number) =>
  db
    .select(summaryColumns)
    .from(factoryJobs)
    .where(
      and(
        eq(factoryJobs.workspaceId, workspaceId),
        isNull(factoryJobs.deletedAt),
      ),
    )
    .orderBy(desc(factoryJobs.updatedAt), desc(factoryJobs.publicId))
    .limit(21)
    .offset(page * 20);

export async function get(db: dbClient, workspaceId: number, publicId: string) {
  const [job] = await db
    .select({ ...summaryColumns, artifacts: factoryJobs.artifacts })
    .from(factoryJobs)
    .where(
      and(
        eq(factoryJobs.workspaceId, workspaceId),
        eq(factoryJobs.publicId, publicId),
        isNull(factoryJobs.deletedAt),
      ),
    );
  return job;
}
