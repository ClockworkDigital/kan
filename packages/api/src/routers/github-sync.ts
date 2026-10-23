import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as syncSettings from "@kan/db/repository/github-sync.repo";
import * as integrations from "@kan/db/repository/integration.repo";
import * as workspaces from "@kan/db/repository/workspace.repo";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { decryptToken } from "../utils/encryption";
import { assertPermission } from "../utils/permissions";

// Restrict the worker to repository discovery and issue operations, never arbitrary URLs.
export const githubSyncInput = z.object({
  workspacePublicId: z.string().min(12),
  path: z
    .string()
    .regex(
      /^(?:orgs\/ClockworkDigital\/repos\?per_page=100|repos\/ClockworkDigital\/[A-Za-z0-9_][A-Za-z0-9_.-]*\/issues(?:\?state=open&per_page=100|\/[1-9][0-9]*))$/,
    ),
  page: z.number().int().min(1).max(1000).default(1),
  changes: z
    .object({
      title: z.string().min(1).max(2000).optional(),
      body: z.string().max(65536).optional(),
      state: z.enum(["open", "closed"]).optional(),
    })
    .strict()
    .optional(),
});

async function githubRequest(
  db: dbClient,
  userId: string,
  input: z.infer<typeof githubSyncInput>,
): Promise<unknown> {
  if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });
  const workspace = await workspaces.getByPublicId(db, input.workspacePublicId);
  if (!workspace) throw new TRPCError({ code: "NOT_FOUND" });
  for (const permission of [
    "board:create",
    "card:create",
    "card:edit",
  ] as const)
    await assertPermission(db, userId, workspace.id, permission);
  if (
    input.changes &&
    (!/\/issues\/[1-9][0-9]*$/.test(input.path) || input.page !== 1)
  )
    throw new TRPCError({ code: "BAD_REQUEST" });
  const integration = await integrations.getProviderForUser(
    db,
    userId,
    "github",
  );
  if (!integration)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Connect GitHub in Kan settings before syncing.",
    });
  let token: string;
  try {
    token = decryptToken(integration.accessToken);
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Reconnect GitHub in Kan settings.",
    });
  }
  const url = new URL(input.path, "https://api.github.com/");
  if (url.search) url.searchParams.set("page", String(input.page));
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.changes ? "PATCH" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: input.changes ? JSON.stringify(input.changes) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "GitHub is unavailable.",
    });
  }
  if (!response.ok)
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `GitHub returned HTTP ${response.status}. Check the saved token's repository and issue permissions.`,
    });
  return response.json();
}

const workspaceInput = z.object({ workspacePublicId: z.string().length(12) });
const repositoryName = z
  .string()
  .regex(/^ClockworkDigital\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const reportSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }),
  created: z.number().int().nonnegative(),
  updatedGitHub: z.number().int().nonnegative(),
  updatedKan: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});
async function access(db: dbClient, userId: string, publicId: string) {
  const workspace = await workspaces.getByPublicId(db, publicId);
  if (!workspace) throw new TRPCError({ code: "NOT_FOUND" });
  for (const permission of [
    "board:create",
    "card:create",
    "card:edit",
  ] as const)
    await assertPermission(db, userId, workspace.id, permission);
  const settings = await syncSettings.get(db, workspace.id);
  if (settings && settings.userId !== userId)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Issue sync is managed by the account that connected it.",
    });
  return { workspace, settings };
}
async function repositories(
  db: dbClient,
  userId: string,
  workspacePublicId: string,
) {
  const result: { name: string; writable: boolean }[] = [];
  const schema = z.array(
    z.object({
      full_name: repositoryName,
      archived: z.boolean(),
      has_issues: z.boolean(),
      permissions: z.object({ push: z.boolean() }).optional(),
    }),
  );
  for (let page = 1; page <= 1000; page++) {
    const batch = schema.parse(
      await githubRequest(db, userId, {
        workspacePublicId,
        path: "orgs/ClockworkDigital/repos?per_page=100",
        page,
      }),
    );
    result.push(
      ...batch
        .filter((repo) => !repo.archived && repo.has_issues)
        .map((repo) => ({
          name: repo.full_name,
          writable: repo.permissions?.push === true,
        })),
    );
    if (batch.length < 100) return result;
  }
  throw new TRPCError({
    code: "BAD_GATEWAY",
    message: "GitHub repository list is too large.",
  });
}

export const githubSyncRouter = createTRPCRouter({
  settings: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/integrations/github/sync/settings",
        protect: true,
        tags: ["Integration"],
      },
    })
    .input(workspaceInput)
    .output(
      z.object({
        repositories: z.array(repositoryName),
        enabled: z.boolean(),
        status: reportSchema.nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { settings } = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
      );
      return {
        repositories: settings?.repositories ?? [],
        enabled: settings?.enabled ?? false,
        status: settings?.status ?? null,
      };
    }),
  repositories: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/integrations/github/sync/repositories",
        protect: true,
        tags: ["Integration"],
      },
    })
    .input(workspaceInput)
    .output(z.array(z.object({ name: repositoryName, writable: z.boolean() })))
    .query(async ({ ctx, input }) => {
      await access(ctx.db, ctx.user.id, input.workspacePublicId);
      return repositories(ctx.db, ctx.user.id, input.workspacePublicId);
    }),
  save: protectedProcedure
    .meta({
      openapi: {
        method: "PUT",
        path: "/integrations/github/sync/settings",
        protect: true,
        tags: ["Integration"],
      },
    })
    .input(
      workspaceInput.extend({
        repositories: z.array(repositoryName).max(1000),
        enabled: z.boolean(),
      }),
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
      );
      if (input.enabled) {
        const available = await repositories(
          ctx.db,
          ctx.user.id,
          input.workspacePublicId,
        );
        if (
          !input.repositories.length ||
          input.repositories.some(
            (name) =>
              !available.some((repo) => repo.name === name && repo.writable),
          )
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Select repositories with issue write access.",
          });
      }
      if (
        !(await syncSettings.save(
          ctx.db,
          workspace.id,
          ctx.user.id,
          [...new Set(input.repositories)],
          input.enabled,
        ))
      )
        throw new TRPCError({ code: "CONFLICT" });
      return { success: true };
    }),
  report: protectedProcedure
    .meta({
      openapi: {
        method: "PUT",
        path: "/integrations/github/sync/status",
        protect: true,
        tags: ["Integration"],
      },
    })
    .input(workspaceInput.extend({ status: reportSchema }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await access(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
      );
      await syncSettings.report(
        ctx.db,
        workspace.id,
        ctx.user.id,
        input.status,
      );
      return { success: true };
    }),
  request: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integrations/github/sync",
        summary:
          "Sync GitHub issues using the current user's saved integration",
        protect: true,
        tags: ["Integration"],
      },
    })
    .input(githubSyncInput)
    .output(z.unknown())
    .mutation(async ({ ctx, input }) => {
      return githubRequest(ctx.db, ctx.user.id, input);
    }),
});
