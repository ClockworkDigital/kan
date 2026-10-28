import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as factoryRepo from "@kan/db/repository/factory.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { factoryResults, factoryStages } from "@kan/db/schema";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { assertUserInWorkspace } from "../utils/auth";
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
      }),
    )
    .output(z.object({ jobs: z.array(job), hasMore: z.boolean() }))
    .query(async ({ ctx, input }) => {
      const workspaceId = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
      );
      const jobs = await factoryRepo.list(ctx.db, workspaceId, input.page);
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
