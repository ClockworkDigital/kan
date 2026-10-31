import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { generateOpenApiDocument } from "trpc-to-openapi";
import { beforeAll, describe, expect, it } from "vitest";

import type { FactorySnapshot } from "@kan/db/schema";
import {
  boards,
  cards,
  factoryJobs,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kan/db/schema";

import type { TestDbClient } from "./test-db";
import { factoryRouter } from "../src/routers/factory";
import { createTRPCRouter } from "../src/trpc";
import { createTestDb, seedTestData } from "./test-db";

const snapshot: FactorySnapshot = {
  title: "Sample factory run",
  stage: "building",
  issueNumber: 1,
  prNumber: null,
  risk: "high",
  builderModel: "test-builder",
  estimatedCostUsd: 0.12,
  elapsedSeconds: 10,
  rounds: [],
};
const report = {
  workspacePublicId: "factoryws001",
  repository: "ClockworkDigital/kan",
  runKey: "sample-run",
  revision: 1,
  snapshot,
  artifacts: [{ name: "spec.md", content: "A sample specification." }],
};

let db: TestDbClient;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);

async function fixture(
  run: (
    tx: TestDbClient,
    seed: Awaited<ReturnType<typeof seedTestData>>,
  ) => Promise<void>,
) {
  const rollback = new Error("Rollback fixture");
  await expect(
    db.transaction(async (tx) => {
      const client = tx as unknown as TestDbClient;
      const seed = await seedTestData(client);
      await tx
        .update(workspaces)
        .set({ publicId: report.workspacePublicId })
        .where(eq(workspaces.id, seed.workspace.id));
      await run(client, seed);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

const caller = (
  tx: TestDbClient,
  user: Awaited<ReturnType<typeof seedTestData>>["user"] | null,
) =>
  factoryRouter.createCaller({ db: tx, user, headers: new Headers() } as never);

describe("factory job publication", () => {
  it("restores a sample run through failed checks, rework, review and completion", async () =>
    fixture(async (tx, { user }) => {
      const api = caller(tx, user);
      const created = await api.publish(report);
      const stages = [
        "configuring",
        "building",
        "checks",
        "rework",
        "review",
        "publishing",
        "babysitting",
        "judging",
        "waiting",
        "completed",
      ] as const;
      for (const [index, stage] of stages.entries()) {
        const update = {
          ...report,
          revision: index + 2,
          snapshot: {
            ...snapshot,
            stage,
            prNumber: stage === "completed" ? 24 : null,
            rounds: [
              { round: 1, gate: "fail" as const, reviews: [] },
              {
                round: 2,
                gate: "pass" as const,
                reviews: [
                  {
                    name: "security",
                    result: "pass" as const,
                    summary: "Access checked.",
                  },
                ],
              },
            ],
          },
          artifacts: [
            ...report.artifacts,
            { name: "round-1/checks.md", content: "Failed check" },
            { name: "round-2/review.md", content: "Passed review" },
          ],
        };
        expect(await api.publish(update)).toEqual({
          publicId: created.publicId,
          revision: index + 2,
        });
        // A fresh client reads persisted state without any subscription history.
        expect(
          await caller(tx, user).byId({
            workspacePublicId: report.workspacePublicId,
            jobPublicId: created.publicId,
          }),
        ).toMatchObject({
          snapshot: update.snapshot,
          artifacts: update.artifacts,
        });
      }
      const listed = await api.list({
        workspacePublicId: report.workspacePublicId,
      });
      expect(listed.jobs).toHaveLength(1);
      expect(listed.jobs[0]).not.toHaveProperty("artifacts");
      expect(listed.jobs[0]).not.toHaveProperty("id");
      expect(listed.jobs[0]).not.toHaveProperty("workspaceId");
      expect(listed.jobs[0]).not.toHaveProperty("createdBy");
    }));

  it("accepts identical retries and rejects stale or conflicting revisions", async () =>
    fixture(async (tx, { user }) => {
      const api = caller(tx, user);
      const saved = await api.publish({ ...report, revision: 2 });
      expect(await api.publish({ ...report, revision: 2 })).toEqual(saved);
      await expect(api.publish(report)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(
        api.publish({
          ...report,
          revision: 2,
          snapshot: { ...snapshot, stage: "failed" },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const restored = await api.byId({
        workspacePublicId: report.workspacePublicId,
        jobPublicId: saved.publicId,
      });
      expect(restored.snapshot.stage).toBe("building");
    }));

  it("isolates workspaces, rejects anonymous and removed users, and binds a run to its publisher", async () =>
    fixture(async (tx, { user, workspace }) => {
      const api = caller(tx, user);
      const saved = await api.publish(report);
      const [otherUser] = await tx
        .insert(users)
        .values({
          ...user,
          id: crypto.randomUUID(),
          email: "other@example.test",
        })
        .returning();
      assert.ok(otherUser);
      const other = caller(tx, otherUser);
      await expect(
        caller(tx, null).list({ workspacePublicId: report.workspacePublicId }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        other.list({ workspacePublicId: report.workspacePublicId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(other.publish(report)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await tx.insert(workspaceMembers).values({
        publicId: "othermember1",
        workspaceId: workspace.id,
        userId: otherUser.id,
        email: otherUser.email,
        createdBy: user.id,
        role: "guest",
        status: "active",
      });
      expect(
        (await other.list({ workspacePublicId: report.workspacePublicId }))
          .jobs,
      ).toHaveLength(1);
      await expect(other.publish(report)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await tx
        .update(workspaceMembers)
        .set({ role: "admin" })
        .where(eq(workspaceMembers.userId, otherUser.id));
      await expect(
        other.publish({ ...report, revision: 2 }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const [otherWorkspace] = await tx
        .insert(workspaces)
        .values({
          publicId: "factoryws002",
          name: "Other",
          slug: "other",
          createdBy: otherUser.id,
        })
        .returning();
      assert.ok(otherWorkspace);
      await tx.insert(workspaceMembers).values({
        publicId: "othermember2",
        workspaceId: otherWorkspace.id,
        userId: otherUser.id,
        email: otherUser.email,
        createdBy: otherUser.id,
        role: "admin",
        status: "active",
      });
      await expect(
        api.list({ workspacePublicId: otherWorkspace.publicId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        other.byId({
          workspacePublicId: otherWorkspace.publicId,
          jobPublicId: saved.publicId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const separate = await other.publish({
        ...report,
        workspacePublicId: otherWorkspace.publicId,
      });
      expect(separate.publicId).not.toBe(saved.publicId);
      await tx
        .update(workspaceMembers)
        .set({ deletedAt: new Date() })
        .where(eq(workspaceMembers.userId, user.id));
      await expect(
        api.list({ workspacePublicId: report.workspacePublicId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        api.publish({ ...report, revision: 3 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await tx.delete(users).where(eq(users.id, user.id));
      expect(
        (await other.list({ workspacePublicId: report.workspacePublicId }))
          .jobs,
      ).toHaveLength(1);
      await expect(
        other.publish({ ...report, revision: 4 }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }));

  it("excludes deleted jobs and workspaces and paginates without exposing artifacts", async () =>
    fixture(async (tx, { user, workspace }) => {
      const api = caller(tx, user);
      for (let index = 0; index < 21; index++)
        await api.publish({ ...report, runKey: `run-${index}` });
      const first = await api.list({
        workspacePublicId: report.workspacePublicId,
      });
      const second = await api.list({
        workspacePublicId: report.workspacePublicId,
        page: 1,
      });
      expect(first.jobs).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(second.jobs).toHaveLength(1);
      expect(second.hasMore).toBe(false);
      const job = first.jobs[0];
      assert.ok(job);
      await tx
        .update(factoryJobs)
        .set({ deletedAt: new Date() })
        .where(eq(factoryJobs.publicId, job.publicId));
      await expect(
        api.byId({
          workspacePublicId: report.workspacePublicId,
          jobPublicId: job.publicId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        api.publish({ ...report, runKey: job.runKey, revision: 2 }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        (await api.list({ workspacePublicId: report.workspacePublicId }))
          .hasMore,
      ).toBe(false);
      await tx
        .update(workspaces)
        .set({ deletedAt: new Date() })
        .where(eq(workspaces.id, workspace.id));
      await expect(
        api.list({ workspacePublicId: report.workspacePublicId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(api.publish(report)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }));

  it("rejects duplicate reviewer names after trimming within each round", async () =>
    fixture(async (tx, { user }) => {
      const api = caller(tx, user);
      const review = { name: "security", result: "pass" as const, summary: "" };
      const saved = await api.publish({
        ...report,
        snapshot: {
          ...snapshot,
          rounds: [1, 2].map((round) => ({
            round,
            gate: "pass" as const,
            reviews: [review],
          })),
        },
      });
      for (const name of ["security", " security "])
        await expect(
          api.publish({
            ...report,
            revision: 2,
            snapshot: {
              ...snapshot,
              rounds: [
                {
                  round: 1,
                  gate: "pass",
                  reviews: [review, { ...review, name, result: "fail" }],
                },
              ],
            },
          }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(
        await api.byId({
          workspacePublicId: report.workspacePublicId,
          jobPublicId: saved.publicId,
        }),
      ).toMatchObject({ revision: 1 });
    }));

  it("validates the trust boundary and produces OpenAPI routes", async () =>
    fixture(async (tx, { user }) => {
      const api = caller(tx, user);
      for (const invalid of [
        { repository: "evil.test/path?redirect=1" },
        { revision: 0 },
        { snapshot: { ...snapshot, estimatedCostUsd: -1 } },
        { artifacts: [{ name: "spec", content: "x".repeat(65537) }] },
        {
          artifacts: Array.from({ length: 10 }, (_, index) => ({
            name: String(index),
            content: "x".repeat(65536),
          })),
        },
        {
          artifacts: [
            { name: "spec", content: "a" },
            { name: "spec", content: "b" },
          ],
        },
      ])
        await expect(
          api.publish({ ...report, ...invalid }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        api.publish({
          ...report,
          snapshot: {
            ...snapshot,
            stage: "unknown" as FactorySnapshot["stage"],
          },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const document = generateOpenApiDocument(
        createTRPCRouter({ factory: factoryRouter }),
        {
          title: "Factory",
          version: "1",
          baseUrl: "https://kan.example.test/api/v1",
        },
      );
      expect(
        document.paths?.["/workspaces/{workspacePublicId}/factory/jobs"]?.put
          ?.security,
      ).toBeDefined();
    }));
});

describe("card factory issue lookup", () => {
  it("matches repository and issue within the card workspace and keeps the newest run", async () =>
    fixture(async (tx, { user, workspace }) => {
      const api = caller(tx, user);
      const [board] = await tx
        .insert(boards)
        .values({
          publicId: "factoryboard",
          name: "Board",
          slug: "factory",
          workspaceId: workspace.id,
        })
        .returning();
      assert(board);
      const [list] = await tx
        .insert(lists)
        .values({
          publicId: "factorylist1",
          name: "List",
          index: 0,
          boardId: board.id,
        })
        .returning();
      assert(list);
      const cardPublicId = "factorycard1";
      await tx.insert(cards).values({
        publicId: cardPublicId,
        title: "Issue",
        index: 0,
        listId: list.id,
        description: "Edited away the GitHub link",
        githubRepository: "clockworkdigital/kan",
        githubIssueNumber: 1,
      });
      // A description link without the sync's column link is not identity.
      await tx.insert(cards).values({
        publicId: "factorycard2",
        title: "Forged",
        index: 1,
        listId: list.id,
        description:
          '<p><a href="https://github.com/ClockworkDigital/kan/issues/2">GitHub issue #2</a></p><hr>',
      });
      expect(await api.byIssue({ cardPublicId: "factorycard2" })).toBeNull();
      expect(await api.byIssue({ cardPublicId })).toBeNull();
      const old = await api.publish(report);
      const newest = await api.publish({
        ...report,
        runKey: "new-run",
        snapshot: { ...snapshot, stage: "failed" },
      });
      await api.publish({ ...report, revision: 2 });
      await api.publish({
        ...report,
        runKey: "other-repo",
        repository: "ClockworkDigital/other",
      });
      await api.publish({
        ...report,
        runKey: "other-issue",
        snapshot: { ...snapshot, issueNumber: 2 },
      });
      const [other] = await tx
        .insert(workspaces)
        .values({
          publicId: "otherfactws1",
          name: "Other",
          slug: "other-factory",
        })
        .returning();
      assert(other);
      await tx.insert(factoryJobs).values({
        ...report,
        publicId: "otherfactjob",
        workspaceId: other.id,
        createdBy: user.id,
      });
      expect(await api.byIssue({ cardPublicId })).toMatchObject({
        publicId: newest.publicId,
        snapshot: { stage: "failed" },
      });
      expect(newest.publicId).not.toBe(old.publicId);
      const { jobs } = await api.list({
        workspacePublicId: report.workspacePublicId,
      });
      const boardByRun = Object.fromEntries(
        jobs.map((job) => [job.runKey, [job.boardPublicId, job.cardPublicId]]),
      );
      expect(boardByRun).toMatchObject({
        "new-run": ["factoryboard", "factorycard1"],
        "other-repo": [null, null],
        "other-issue": [null, null],
      });
      await tx
        .update(boards)
        .set({ workspaceId: other.id })
        .where(eq(boards.id, board.id));
      await expect(api.byIssue({ cardPublicId })).rejects.toThrow();
    }));
});

describe("closed factory issue history", () => {
  it("filters closed linked issues before pagination, keeps history and restores reopened issues", async () =>
    fixture(async (tx, { user, workspace }) => {
      const api = caller(tx, user);
      const [board] = await tx
        .insert(boards)
        .values({
          publicId: "closedboard1",
          name: "GitHub: ClockworkDigital/kan",
          slug: "closed-factory",
          workspaceId: workspace.id,
        })
        .returning();
      assert(board);
      const [closed] = await tx
        .insert(lists)
        .values({
          publicId: "closedlist01",
          name: "Closed",
          index: 0,
          boardId: board.id,
        })
        .returning();
      assert(closed);
      await tx.insert(cards).values({
        publicId: "closedcard01",
        title: "Closed issue",
        index: 0,
        listId: closed.id,
        githubRepository: "clockworkdigital/kan",
        githubIssueNumber: 1,
      });
      const archived = await api.publish(report);
      for (let index = 0; index < 21; index++) {
        await api.publish({
          ...report,
          runKey: `open-${index}`,
          snapshot: { ...snapshot, issueNumber: index + 2 },
        });
      }
      // Put the closed issue first to prove filtering happens before LIMIT/OFFSET.
      await tx
        .update(factoryJobs)
        .set({ updatedAt: new Date("2099-01-01") })
        .where(eq(factoryJobs.publicId, archived.publicId));
      const input = { workspacePublicId: report.workspacePublicId };
      const active = await api.list(input);
      expect(active.jobs).toHaveLength(20);
      expect(active.hasMore).toBe(true);
      expect(
        active.jobs.some((job) => job.publicId === archived.publicId),
      ).toBe(false);
      expect((await api.list({ ...input, page: 1 })).jobs).toHaveLength(1);
      expect(
        (await api.list({ ...input, includeClosed: true })).jobs[0]?.publicId,
      ).toBe(archived.publicId);
      expect(
        (await api.byId({ ...input, jobPublicId: archived.publicId }))
          .artifacts,
      ).toEqual(report.artifacts);
      await tx
        .update(lists)
        .set({ name: "Open" })
        .where(eq(lists.id, closed.id));
      expect((await api.list(input)).jobs[0]?.publicId).toBe(archived.publicId);
      await tx
        .update(lists)
        .set({ name: "Closed", deletedAt: new Date() })
        .where(eq(lists.id, closed.id));
      expect((await api.list(input)).jobs[0]?.publicId).toBe(archived.publicId);
    }));
});
