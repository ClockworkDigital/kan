import { TRPCError } from "@trpc/server";
import { z } from "zod";

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

export const githubSyncRouter = createTRPCRouter({
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
      const userId = ctx.user?.id;
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });
      const workspace = await workspaces.getByPublicId(
        ctx.db,
        input.workspacePublicId,
      );
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND" });
      for (const permission of [
        "board:create",
        "card:create",
        "card:edit",
      ] as const)
        await assertPermission(ctx.db, userId, workspace.id, permission);
      if (
        input.changes &&
        (!/\/issues\/[1-9][0-9]*$/.test(input.path) || input.page !== 1)
      )
        throw new TRPCError({ code: "BAD_REQUEST" });
      const integration = await integrations.getProviderForUser(
        ctx.db,
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
    }),
});
