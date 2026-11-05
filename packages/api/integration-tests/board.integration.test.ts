import assert from "node:assert/strict";
import { beforeAll, describe, expect, it } from "vitest";

import { boards, users, workspaceMembers, workspaces } from "@kan/db/schema";

import type { TestDbClient } from "./test-db";
import { boardRouter } from "../src/routers/board";
import { createTestDb, seedTestData } from "./test-db";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

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

const caller = (tx: TestDbClient, user: Seed["user"]) =>
  boardRouter.createCaller({ db: tx, user, headers: new Headers() } as never);

let uid = 0;
const publicId = () => `bo${String(++uid).padStart(10, "0")}`;

async function addBoard(tx: TestDbClient, workspaceId: number, name: string) {
  const id = publicId();
  const [board] = await tx
    .insert(boards)
    .values({ publicId: id, name, slug: id, workspaceId })
    .returning();
  assert.ok(board);
  return board;
}

describe("board priority order", () => {
  it("lists ranked boards first, in the saved order", async () =>
    fixture(async (tx, seed) => {
      const api = caller(tx, seed.user);
      const workspacePublicId = seed.workspace.publicId;
      const a = await addBoard(tx, seed.workspace.id, "Alpha");
      await addBoard(tx, seed.workspace.id, "Bravo");
      const c = await addBoard(tx, seed.workspace.id, "Charlie");
      const names = async () =>
        (await api.all({ workspacePublicId })).map((board) => board.name);

      expect(await names()).toEqual(["Alpha", "Bravo", "Charlie"]);

      // Another workspace's board in the list must not be touched.
      const [other] = await tx
        .insert(workspaces)
        .values({
          publicId: publicId(),
          name: "Other",
          slug: publicId(),
          createdBy: seed.user.id,
        })
        .returning();
      assert.ok(other);
      const foreign = await addBoard(tx, other.id, "Foreign");
      await api.reorder({
        workspacePublicId,
        boardPublicIds: [c.publicId, foreign.publicId, a.publicId],
      });
      expect(await names()).toEqual(["Charlie", "Alpha", "Bravo"]);
      expect(
        (
          await tx.query.boards.findFirst({
            where: (board, { eq }) => eq(board.id, foreign.id),
          })
        )?.index,
      ).toBeNull();
    }));

  it("forbids reordering without board:edit", async () =>
    fixture(async (tx, seed) => {
      const [guest] = await tx
        .insert(users)
        .values({
          ...seed.user,
          id: crypto.randomUUID(),
          email: `${publicId()}@example.test`,
        })
        .returning();
      assert.ok(guest);
      await tx.insert(workspaceMembers).values({
        publicId: publicId(),
        workspaceId: seed.workspace.id,
        userId: guest.id,
        email: guest.email,
        createdBy: seed.user.id,
        role: "guest",
        status: "active",
      });
      await expect(
        caller(tx, guest).reorder({
          workspacePublicId: seed.workspace.publicId,
          boardPublicIds: [],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));
});
