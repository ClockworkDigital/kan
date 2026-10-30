import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { boards, cards, factoryJobs, lists } from "@kan/db/schema";
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
    .select({
      ...summaryColumns,
      // Board of the card the GitHub sync linked to this job's issue.
      boardPublicId: sql<string | null>`(${db
        .select({ publicId: boards.publicId })
        .from(cards)
        .innerJoin(lists, eq(lists.id, cards.listId))
        .innerJoin(boards, eq(boards.id, lists.boardId))
        .where(
          and(
            eq(boards.workspaceId, factoryJobs.workspaceId),
            eq(boards.type, "regular"),
            isNull(cards.deletedAt),
            isNull(lists.deletedAt),
            isNull(boards.deletedAt),
            sql`${cards.githubRepository} = lower(${factoryJobs.repository})`,
            sql`${cards.githubIssueNumber} = (${factoryJobs.snapshot}->>'issueNumber')::integer`,
          ),
        )
        .orderBy(desc(cards.id))
        .limit(1)})`,
    })
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

export async function cardIssueContext(db: dbClient, publicId: string) {
  const [card] = await db
    .select({
      githubRepository: cards.githubRepository,
      githubIssueNumber: cards.githubIssueNumber,
      workspaceId: boards.workspaceId,
    })
    .from(cards)
    .innerJoin(lists, eq(cards.listId, lists.id))
    .innerJoin(boards, eq(lists.boardId, boards.id))
    .where(
      and(
        eq(cards.publicId, publicId),
        isNull(cards.deletedAt),
        isNull(lists.deletedAt),
        isNull(boards.deletedAt),
      ),
    );
  return card;
}

export async function byIssue(
  db: dbClient,
  workspaceId: number,
  repository: string,
  issueNumber: number,
) {
  const [job] = await db
    .select(summaryColumns)
    .from(factoryJobs)
    .where(
      and(
        eq(factoryJobs.workspaceId, workspaceId),
        sql`lower(${factoryJobs.repository}) = ${repository.toLowerCase()}`,
        sql`${factoryJobs.snapshot}->>'issueNumber' = ${String(issueNumber)}`,
        isNull(factoryJobs.deletedAt),
      ),
    )
    .orderBy(desc(factoryJobs.id))
    .limit(1);
  return job ?? null;
}
