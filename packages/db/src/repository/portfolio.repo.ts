import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { boardProjects, boards, users } from "@kan/db/schema";

export type ProjectFields = Pick<
  typeof boardProjects.$inferInsert,
  "status" | "details" | "clients" | "shownToClient" | "internal" | "nextSteps"
>;

// Qualified by hand: single-table selects render bare "id", which the subqueries would capture.
const boardId = sql`${boards}."id"`;
const liveCards = sql`FROM "card" c JOIN "list" l ON c."listId" = l."id"
  WHERE l."boardId" = ${boardId} AND l."deletedAt" IS NULL AND c."deletedAt" IS NULL`;

const cardCounts = {
  totalCards: sql<number>`(SELECT count(*) ${liveCards})`.mapWith(Number),
  // Kanban convention: cards in the board's last list count as done.
  // GitHub sync boards end in "Closed", so this also counts closed issues.
  doneCards: sql<number>`(SELECT count(*) ${liveCards} AND l."id" = (
    SELECT l2."id" FROM "list" l2
    WHERE l2."boardId" = ${boardId} AND l2."deletedAt" IS NULL
    ORDER BY l2."index" DESC, l2."id" DESC LIMIT 1))`.mapWith(Number),
};

export async function listByWorkspaceId(db: dbClient, workspaceId: number) {
  return db
    .select({
      boardPublicId: boards.publicId,
      name: boards.name,
      isArchived: boards.isArchived,
      createdBy: boards.createdBy,
      status: boardProjects.status,
      details: boardProjects.details,
      clients: boardProjects.clients,
      shownToClient: boardProjects.shownToClient,
      internal: boardProjects.internal,
      nextSteps: boardProjects.nextSteps,
      updatedAt: boardProjects.updatedAt,
      updatedByName: users.name,
      ...cardCounts,
    })
    .from(boardProjects)
    .innerJoin(boards, eq(boardProjects.boardId, boards.id))
    .leftJoin(users, eq(boardProjects.updatedBy, users.id))
    .where(
      and(
        eq(boards.workspaceId, workspaceId),
        eq(boards.type, "regular"),
        isNull(boards.deletedAt),
      ),
    )
    .orderBy(asc(boards.name));
}

export async function getByBoardId(db: dbClient, boardId: number) {
  const [project] = await db
    .select()
    .from(boardProjects)
    .where(eq(boardProjects.boardId, boardId));
  return project ?? null;
}

export async function upsert(
  db: dbClient,
  boardId: number,
  fields: ProjectFields,
  userId: string,
) {
  const values = { ...fields, updatedBy: userId, updatedAt: new Date() };
  const [project] = await db
    .insert(boardProjects)
    .values({ boardId, ...values })
    .onConflictDoUpdate({ target: boardProjects.boardId, set: values })
    .returning();
  return project;
}

export async function remove(db: dbClient, boardId: number) {
  await db.delete(boardProjects).where(eq(boardProjects.boardId, boardId));
}

export async function listBoardsForProgress(db: dbClient, workspaceId: number) {
  return db
    .select({ boardPublicId: boards.publicId, ...cardCounts })
    .from(boards)
    .where(
      and(
        eq(boards.workspaceId, workspaceId),
        eq(boards.type, "regular"),
        isNull(boards.deletedAt),
      ),
    );
}
