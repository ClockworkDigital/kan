import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { boards, cards, lists, users, workspaceMembers } from "@kan/db/schema";

import type { TestDbClient } from "./test-db";
import { portfolioRouter } from "../src/routers/portfolio";
import { createTestDb, seedTestData } from "./test-db";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

const project = {
  status: "busy" as const,
  details: "Rider payments pilot",
  clients: "Transit partner",
  shownToClient: true,
  internal: false,
  nextSteps: "Pilot sign-off",
};

let db: TestDbClient;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);

async function fixture(run: (tx: TestDbClient, seed: Seed) => Promise<void>) {
  const rollback = new Error("Rollback fixture");
  await expect(
    db.transaction(async (tx) => {
      const client = tx as unknown as TestDbClient;
      await run(client, await seedTestData(client));
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

const caller = (tx: TestDbClient, user: Seed["user"] | null) =>
  portfolioRouter.createCaller({
    db: tx,
    user,
    headers: new Headers(),
  } as never);

let uid = 0;
const publicId = () => `pf${String(++uid).padStart(10, "0")}`;

async function addBoard(
  tx: TestDbClient,
  seed: Seed,
  extra: Partial<typeof boards.$inferInsert> = {},
) {
  const id = publicId();
  const [board] = await tx
    .insert(boards)
    .values({
      publicId: id,
      name: `Board ${id}`,
      slug: id,
      workspaceId: seed.workspace.id,
      createdBy: seed.user.id,
      ...extra,
    })
    .returning();
  assert.ok(board);
  return board;
}

async function addList(
  tx: TestDbClient,
  boardId: number,
  index: number,
  cardCount: number,
  deletedCards = 0,
  deletedAt: Date | null = null,
) {
  const [list] = await tx
    .insert(lists)
    .values({
      publicId: publicId(),
      name: `List ${index}`,
      index,
      boardId,
      deletedAt,
    })
    .returning();
  assert.ok(list);
  for (let i = 0; i < cardCount + deletedCards; i++)
    await tx.insert(cards).values({
      publicId: publicId(),
      title: `Card ${i}`,
      index: i,
      listId: list.id,
      deletedAt: i < cardCount ? null : new Date(),
    });
}

async function addUser(
  tx: TestDbClient,
  seed: Seed,
  role?: "member" | "guest",
) {
  const [user] = await tx
    .insert(users)
    .values({
      ...seed.user,
      id: crypto.randomUUID(),
      email: `${publicId()}@example.test`,
      name: "Other",
    })
    .returning();
  assert.ok(user);
  if (role)
    await tx.insert(workspaceMembers).values({
      publicId: publicId(),
      workspaceId: seed.workspace.id,
      userId: user.id,
      email: user.email,
      createdBy: seed.user.id,
      role,
      status: "active",
    });
  return user;
}

describe("portfolio", () => {
  it("lists only project boards with live card progress from the last list", async () =>
    fixture(async (tx, seed) => {
      const api = caller(tx, seed.user);
      const board = await addBoard(tx, seed, { name: "PayShap City Hop" });
      await addList(tx, board.id, 0, 3, 1);
      await addList(tx, board.id, 1, 2);
      await addList(tx, board.id, 2, 4, 2);
      // A deleted list after "done" must not become the last list or count.
      await addList(tx, board.id, 3, 5, 0, new Date());
      await addBoard(tx, seed, { name: "Not a project" });
      const template = await addBoard(tx, seed, { type: "template" });
      const deleted = await addBoard(tx, seed);
      await api.update({ boardPublicId: board.publicId, ...project });
      await api.update({ boardPublicId: deleted.publicId, ...project });
      await tx
        .update(boards)
        .set({ deletedAt: new Date() })
        .where(eq(boards.id, deleted.id));
      await expect(
        api.update({ boardPublicId: template.publicId, ...project }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const listed = await api.list({
        workspacePublicId: seed.workspace.publicId,
      });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        boardPublicId: board.publicId,
        name: "PayShap City Hop",
        ...project,
        totalCards: 9,
        doneCards: 4,
        updatedByName: "Test User",
        canEdit: true,
      });
      expect(listed[0]).not.toHaveProperty("boardId");
      expect(listed[0]).not.toHaveProperty("createdBy");

      await api.update({
        boardPublicId: board.publicId,
        ...project,
        status: "done",
        nextSteps: "  Hand over  ",
      });
      expect(await api.byBoardId({ boardPublicId: board.publicId })).toEqual({
        project: { ...project, status: "done", nextSteps: "Hand over" },
        canEdit: true,
      });
      await api.remove({ boardPublicId: board.publicId });
      expect(
        await api.list({ workspacePublicId: seed.workspace.publicId }),
      ).toEqual([]);
      expect(await api.byBoardId({ boardPublicId: board.publicId })).toEqual({
        project: null,
        canEdit: true,
      });
    }));

  it("reports last-list progress for every live board, with or without project details", async () =>
    fixture(async (tx, seed) => {
      const sync = await addBoard(tx, seed, { name: "GitHub: acme/app" });
      await addList(tx, sync.id, 0, 2); // Open
      await addList(tx, sync.id, 1, 1); // In progress
      await addList(tx, sync.id, 2, 3, 1); // Closed
      const empty = await addBoard(tx, seed);
      await addBoard(tx, seed, { type: "template" });
      await addBoard(tx, seed, { deletedAt: new Date() });

      const input = { workspacePublicId: seed.workspace.publicId };
      const guest = await addUser(tx, seed, "guest");
      const progress = await caller(tx, guest).progress(input);
      expect(progress).toHaveLength(2);
      expect(progress).toEqual(
        expect.arrayContaining([
          {
            boardPublicId: sync.publicId,
            totalCards: 6,
            doneCards: 3,
            lastActivityAt: expect.any(Date) as Date,
            description: null,
          },
          {
            boardPublicId: empty.publicId,
            totalCards: 0,
            doneCards: 0,
            lastActivityAt: null,
            description: null,
          },
        ]),
      );
      await expect(
        caller(tx, await addUser(tx, seed)).progress(input),
      ).rejects.toThrow();
    }));

  it("lets guests read, and only board editors or the board's creator write", async () =>
    fixture(async (tx, seed) => {
      const board = await addBoard(tx, seed);
      await caller(tx, seed.user).update({
        boardPublicId: board.publicId,
        ...project,
      });
      const ws = { workspacePublicId: seed.workspace.publicId };
      const write = { boardPublicId: board.publicId, ...project };

      await expect(caller(tx, null).list(ws)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      const outsider = caller(tx, await addUser(tx, seed));
      await expect(outsider.list(ws)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        outsider.byBoardId({ boardPublicId: board.publicId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(outsider.update(write)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      const guest = caller(tx, await addUser(tx, seed, "guest"));
      expect(await guest.list(ws)).toMatchObject([{ canEdit: false }]);
      expect(await guest.byBoardId({ boardPublicId: board.publicId })).toEqual({
        project,
        canEdit: false,
      });
      await expect(guest.update(write)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        guest.remove({ boardPublicId: board.publicId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // Members lack board:edit by default, but may edit boards they created.
      const memberUser = await addUser(tx, seed, "member");
      const member = caller(tx, memberUser);
      await expect(member.update(write)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      const own = await addBoard(tx, seed, { createdBy: memberUser.id });
      await member.update({ ...write, boardPublicId: own.publicId });
      // The UI's edit controls follow the same rule as the server.
      expect(
        (await member.list(ws)).map((p) => [p.boardPublicId, p.canEdit]),
      ).toEqual(
        expect.arrayContaining([
          [board.publicId, false],
          [own.publicId, true],
        ]),
      );
      await tx
        .update(workspaceMembers)
        .set({ status: "removed" })
        .where(eq(workspaceMembers.userId, memberUser.id));
      await expect(
        member.update({ ...write, boardPublicId: own.publicId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  it("rejects oversized text and unknown statuses", async () =>
    fixture(async (tx, seed) => {
      const api = caller(tx, seed.user);
      const board = await addBoard(tx, seed);
      for (const bad of [
        { details: "x".repeat(601) },
        { clients: "x".repeat(2001) },
        { nextSteps: "x".repeat(2001) },
        { status: "late" },
      ])
        await expect(
          api.update({
            boardPublicId: board.publicId,
            ...project,
            ...bad,
          } as never),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await api.update({
        boardPublicId: board.publicId,
        ...project,
        details: "x".repeat(600),
      });
    }));
});
