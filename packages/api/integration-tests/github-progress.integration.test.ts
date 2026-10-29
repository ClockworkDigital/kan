import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import {
  boards,
  githubSyncSettings,
  integrations,
  users,
  workspaceMembers,
} from "@kan/db/schema";

import { portfolioRouter } from "../src/routers/portfolio";
import { encryptToken } from "../src/utils/encryption";
import { createTestDb, seedTestData } from "./test-db";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterEach(() => vi.unstubAllGlobals());

it("uses viewer credentials and historical issue totals; respects permissions, paused links, failures and unlinking", async () => {
  const rollback = new Error("rollback");
  await expect(
    db.transaction(async (tx) => {
      const client = tx as unknown as typeof db;
      const seed = await seedTestData(client);
      const [board] = await client
        .insert(boards)
        .values({
          publicId: "progress1234",
          name: "GitHub: ClockworkDigital/Kan",
          slug: "progress",
          workspaceId: seed.workspace.id,
          createdBy: seed.user.id,
        })
        .returning();
      assert.ok(board);
      await client.insert(githubSyncSettings).values({
        workspaceId: seed.workspace.id,
        userId: seed.user.id,
        repositories: ["ClockworkDigital/Kan"],
        enabled: false,
      });
      await client.insert(integrations).values({
        userId: seed.user.id,
        provider: "github",
        accessToken: encryptToken("owner-token"),
        expiresAt: new Date("2099-01-01"),
      });
      const [viewer] = await client
        .insert(users)
        .values({
          id: crypto.randomUUID(),
          name: "Viewer",
          email: "viewer@example.com",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      assert.ok(viewer);
      await client.insert(workspaceMembers).values({
        publicId: "viewer123456",
        workspaceId: seed.workspace.id,
        userId: viewer.id,
        role: "member",
        status: "active",
        email: viewer.email,
        createdBy: seed.user.id,
      });
      const caller = (user: typeof viewer | null) =>
        portfolioRouter.createCaller({
          db: client,
          user,
          headers: new Headers(),
        } as never);
      const input = { workspacePublicId: seed.workspace.publicId };
      const fetcher = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              r0: { open: { totalCount: 4 }, closed: { totalCount: 96 } },
            },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      expect(await caller(viewer).progress(input)).toEqual([
        {
          boardPublicId: board.publicId,
          repository: "ClockworkDigital/Kan",
          done: null,
          total: null,
        },
      ]);
      expect(fetcher).not.toHaveBeenCalled();
      await client.insert(integrations).values({
        userId: viewer.id,
        provider: "github",
        accessToken: encryptToken("viewer-token"),
        expiresAt: new Date("2099-01-01"),
      });
      expect(await caller(viewer).progress(input)).toEqual([
        {
          boardPublicId: board.publicId,
          repository: "ClockworkDigital/Kan",
          done: 96,
          total: 100,
        },
      ]);
      const options = fetcher.mock.calls[0]?.[1] as RequestInit;
      expect(options.headers).toMatchObject({
        Authorization: "Bearer viewer-token",
      });
      expect(options.body).toContain("issues(states: CLOSED)");
      expect(options.body).not.toContain("pullRequests");
      fetcher.mockRejectedValue(new Error("offline"));
      expect((await caller(viewer).progress(input))[0]?.done).toBeNull();
      await expect(caller(null).progress(input)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await client
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.userId, viewer.id));
      await expect(caller(viewer).progress(input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await client
        .update(githubSyncSettings)
        .set({ repositories: [] })
        .where(eq(githubSyncSettings.workspaceId, seed.workspace.id));
      expect((await caller(seed.user).progress(input))[0]).toMatchObject({
        repository: null,
        done: 0,
        total: 0,
      });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});
