import assert from "node:assert/strict";
import { expect, it } from "vitest";

import * as labelRepo from "@kan/db/repository/label.repo";
import { boards } from "@kan/db/schema";

import type { TestDbClient } from "./test-db";
import { createTestDb, seedTestData } from "./test-db";

it("returns board ownership and excludes deleted labels from assignment lookups", async () => {
  const db = await createTestDb();
  const rollback = new Error("Rollback fixture");
  await expect(
    db.transaction(async (tx) => {
      const testDb = tx as unknown as TestDbClient;
      const { user, workspace } = await seedTestData(testDb);
      const [board] = await tx
        .insert(boards)
        .values({
          publicId: "board0000001",
          name: "Labels",
          slug: "labels",
          workspaceId: workspace.id,
          createdBy: user.id,
        })
        .returning();
      assert.ok(board);
      const label = await labelRepo.create(testDb, {
        name: "x".repeat(50),
        colourCode: "#abcdef",
        boardId: board.id,
        createdBy: user.id,
      });
      assert.ok(label);
      expect(
        await labelRepo.getByPublicId(testDb, label.publicId),
      ).toMatchObject({
        boardId: board.id,
        name: "x".repeat(50),
        colourCode: "#abcdef",
      });
      expect(
        await labelRepo.getAllByPublicIds(testDb, [
          label.publicId,
          "missing00001",
        ]),
      ).toEqual([{ id: label.id, boardId: board.id }]);
      await labelRepo.softDelete(testDb, {
        labelId: label.id,
        deletedAt: new Date(),
        deletedBy: user.id,
      });
      expect(
        await labelRepo.getByPublicId(testDb, label.publicId),
      ).toBeUndefined();
      expect(
        await labelRepo.getAllByPublicIds(testDb, [label.publicId]),
      ).toEqual([]);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}, 10000);
