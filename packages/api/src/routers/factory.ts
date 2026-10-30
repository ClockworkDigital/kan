import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as factoryRepo from "@kan/db/repository/factory.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { factoryResults, factoryStages } from "@kan/db/schema";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { assertUserInWorkspace } from "../utils/auth";
import {
  discussionSchema,
  factoryGitHub,
  pullSchema,
} from "../utils/factory-github";
import { assertPermission } from "../utils/permissions";

const workspaceInput = z.object({ workspacePublicId: z.string().length(12) });
const number = z.number().int().positive().max(2147483647);
const snapshot = z.object({
  title: z.string().trim().min(1).max(256),
  stage: z.enum(factoryStages),
  issueNumber: number.nullable(),
  prNumber: number.nullable(),
  risk: z.enum(["low", "medium", "high"]).nullable(),
  builderModel: z.string().min(1).max(128).nullable(),
  estimatedCostUsd: z.number().finite().nonnegative().max(1e9).nullable(),
  elapsedSeconds: z.number().int().nonnegative().max(2147483647).nullable(),
  rounds: z
    .array(
      z.object({
        round: number,
        gate: z.enum(factoryResults),
        reviews: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(64),
              result: z.enum(factoryResults),
              summary: z.string().max(2000),
            }),
          )
          .max(10)
          .refine(
            (reviews) =>
              new Set(reviews.map((review) => review.name)).size ===
              reviews.length,
            "Reviewer names must be unique within each round.",
          ),
      }),
    )
    .max(50)
    .refine(
      (rounds) =>
        new Set(rounds.map((round) => round.round)).size === rounds.length,
      "Round numbers must be unique.",
    ),
});
const artifacts = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(128),
      content: z.string().max(65536),
    }),
  )
  .max(50)
  .refine(
    (items) => new Set(items.map((item) => item.name)).size === items.length,
    "Artifact names must be unique.",
  );
const job = z.object({
  publicId: z.string().length(12),
  repository: z.string(),
  runKey: z.string(),
  revision: number,
  snapshot,
  updatedAt: z.date(),
});

const githubDetailsSchema = z.object({
  issue: z
    .object({
      title: z.string(),
      body: z.string().nullable(),
      state: z.string(),
    })
    .nullable(),
  comments: z.array(discussionSchema),
  pull: pullSchema.nullable(),
  reviews: z.array(
    z.object({
      body: z.string().nullable(),
      state: z.string(),
      user: z.object({ login: z.string() }).nullable(),
    }),
  ),
  reviewComments: z.array(
    discussionSchema.extend({
      path: z.string(),
      line: z.number().nullable(),
      original_line: z.number().nullable(),
    }),
  ),
  files: z.array(
    z.object({
      filename: z.string(),
      status: z.string(),
      patch: z.string().optional(),
    }),
  ),
});

async function access(
  db: dbClient,
  userId: string,
  publicId: string,
  publish = false,
) {
  const workspace = await workspaceRepo.getByPublicId(db, publicId);
  if (!workspace || workspace.deletedAt)
    throw new TRPCError({ code: "NOT_FOUND" });
  await assertUserInWorkspace(db, userId, workspace.id);
  await assertPermission(
    db,
    userId,
    workspace.id,
    publish ? "workspace:manage" : "workspace:view",
  );
  return workspace.id;
}

export const factoryRouter = createTRPCRouter({
  github: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workspaces/{workspacePublicId}/factory/jobs/{jobPublicId}/github",
        protect: true,
        tags: ["Factory"],
      },
    })
    .input(workspaceInput.extend({ jobPublicId: z.string().length(12) }))
    .output(githubDetailsSchema)
    .query(async ({ ctx, input }) => {
      const workspaceId = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
      );
      const job = await factoryRepo.get(ctx.db, workspaceId, input.jobPublicId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      const request = await factoryGitHub(ctx.db, ctx.user.id, job.repository);
      const { issueNumber, prNumber } = job.snapshot;
      const [issue, comments, pull, reviews, files, reviewComments] =
        await Promise.all([
          issueNumber ? request(`issues/${issueNumber}`) : null,
          issueNumber
            ? request(
                `issues/${issueNumber}/comments?per_page=100&sort=created&direction=desc`,
              )
            : [],
          prNumber ? request(`pulls/${prNumber}`) : null,
          prNumber ? request(`pulls/${prNumber}/reviews?per_page=100`) : [],
          prNumber ? request(`pulls/${prNumber}/files?per_page=100`) : [],
          prNumber ? request(`pulls/${prNumber}/comments?per_page=100`) : [],
        ]);
      return githubDetailsSchema.parse({
        issue,
        comments,
        pull,
        reviews,
        reviewComments,
        files,
      });
    }),
  reply: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workspaces/{workspacePublicId}/factory/jobs/{jobPublicId}/reply",
        protect: true,
        tags: ["Factory"],
      },
    })
    .input(
      workspaceInput.extend({
        jobPublicId: z.string().length(12),
        body: z.string().trim().min(1).max(60000),
      }),
    )
    .output(z.boolean())
    .mutation(async ({ ctx, input }) => {
      const workspaceId = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
        true,
      );
      const job = await factoryRepo.get(ctx.db, workspaceId, input.jobPublicId);
      if (!job?.snapshot.issueNumber)
        throw new TRPCError({ code: "NOT_FOUND" });
      const request = await factoryGitHub(ctx.db, ctx.user.id, job.repository);
      await request(`issues/${job.snapshot.issueNumber}/comments`, "POST", {
        body: input.body,
      });
      return true;
    }),
  merge: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workspaces/{workspacePublicId}/factory/jobs/{jobPublicId}/merge",
        protect: true,
        tags: ["Factory"],
      },
    })
    .input(
      workspaceInput.extend({
        jobPublicId: z.string().length(12),
        headSha: z.string().regex(/^[a-f0-9]{40}$/),
        method: z.enum(["merge", "squash", "rebase"]),
      }),
    )
    .output(z.boolean())
    .mutation(async ({ ctx, input }) => {
      const workspaceId = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
        true,
      );
      const job = await factoryRepo.get(ctx.db, workspaceId, input.jobPublicId);
      if (!job?.snapshot.prNumber) throw new TRPCError({ code: "NOT_FOUND" });
      const request = await factoryGitHub(ctx.db, ctx.user.id, job.repository);
      const path = `pulls/${job.snapshot.prNumber}`;
      const pull = pullSchema.parse(await request(path));
      if (
        pull.head.sha !== input.headSha ||
        pull.state !== "open" ||
        pull.draft ||
        pull.mergeable !== true ||
        pull.mergeable_state !== "clean"
      )
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "The PR changed or is not ready to merge. Refresh and review its latest state.",
        });
      const result = z.object({ merged: z.boolean() }).parse(
        await request(`${path}/merge`, "PUT", {
          sha: input.headSha,
          merge_method: input.method,
        }),
      );
      if (!result.merged)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "GitHub did not merge the PR. Refresh its status before retrying.",
        });
      return true;
    }),
  byIssue: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/cards/{cardPublicId}/factory",
        protect: true,
        tags: ["Factory"],
      },
    })
    .input(z.object({ cardPublicId: z.string().length(12) }))
    .output(job.nullable())
    .query(async ({ ctx, input }) => {
      const card = await factoryRepo.cardIssueContext(
        ctx.db,
        input.cardPublicId,
      );
      if (!card) throw new TRPCError({ code: "NOT_FOUND" });
      await assertUserInWorkspace(ctx.db, ctx.user.id, card.workspaceId);
      await assertPermission(
        ctx.db,
        ctx.user.id,
        card.workspaceId,
        "workspace:view",
      );
      const workspace = await ctx.db.query.workspaces.findFirst({
        where: (table, { eq, isNull, and }) =>
          and(eq(table.id, card.workspaceId), isNull(table.deletedAt)),
      });
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND" });
      if (!card.githubRepository || !card.githubIssueNumber) return null;
      return factoryRepo.byIssue(
        ctx.db,
        card.workspaceId,
        card.githubRepository,
        card.githubIssueNumber,
      );
    }),
  publish: protectedProcedure
    .meta({
      openapi: {
        method: "PUT",
        path: "/workspaces/{workspacePublicId}/factory/jobs",
        protect: true,
        tags: ["Factory"],
        summary: "Publish a complete, versioned factory job snapshot",
      },
    })
    .input(
      workspaceInput
        .extend({
          repository: z
            .string()
            .max(200)
            .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
          runKey: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
          revision: number,
          snapshot,
          artifacts,
        })
        .refine(
          (input) => Buffer.byteLength(JSON.stringify(input), "utf8") <= 524288,
          "Job snapshot exceeds 512 KiB.",
        ),
    )
    .output(z.object({ publicId: z.string().length(12), revision: number }))
    .mutation(async ({ ctx, input }) => {
      const workspaceId = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
        true,
      );
      const { workspacePublicId: _workspacePublicId, ...report } = input;
      const result = await factoryRepo.publish(ctx.db, {
        ...report,
        workspaceId,
        createdBy: ctx.user.id,
      });
      if (!result)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "A newer or different snapshot exists, or this run belongs to another publisher.",
        });
      return result;
    }),
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workspaces/{workspacePublicId}/factory/jobs",
        protect: true,
        tags: ["Factory"],
      },
    })
    .input(
      workspaceInput.extend({
        page: z.number().int().min(0).max(100000).default(0),
        includeClosed: z.boolean().default(false),
      }),
    )
    .output(
      z.object({
        jobs: z.array(
          job.extend({
            boardPublicId: z.string().nullable(),
            cardPublicId: z.string().nullable(),
          }),
        ),
        hasMore: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const workspaceId = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
      );
      const jobs = await factoryRepo.list(
        ctx.db,
        workspaceId,
        input.page,
        input.includeClosed,
      );
      return { jobs: jobs.slice(0, 20), hasMore: jobs.length > 20 };
    }),
  byId: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workspaces/{workspacePublicId}/factory/jobs/{jobPublicId}",
        protect: true,
        tags: ["Factory"],
      },
    })
    .input(workspaceInput.extend({ jobPublicId: z.string().length(12) }))
    .output(job.extend({ artifacts }))
    .query(async ({ ctx, input }) => {
      const workspaceId = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
      );
      const result = await factoryRepo.get(
        ctx.db,
        workspaceId,
        input.jobPublicId,
      );
      if (!result) throw new TRPCError({ code: "NOT_FOUND" });
      return result;
    }),
});
