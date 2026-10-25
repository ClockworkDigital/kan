import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as syncSettings from "@kan/db/repository/github-sync.repo";
import * as integrations from "@kan/db/repository/integration.repo";
import * as workspaces from "@kan/db/repository/workspace.repo";
import { issueForms, productionFields } from "@kan/shared";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { decryptToken } from "../utils/encryption";
import { installRepositoryPolicy } from "../utils/github-policy";
import { assertPermission } from "../utils/permissions";

// Restrict requests to repository discovery, issues and read-only label lists.
export const githubSyncInput = z.object({
  workspacePublicId: z.string().min(12),
  path: z
    .string()
    .regex(
      /^(?:orgs\/ClockworkDigital\/repos\?per_page=100|repos\/ClockworkDigital\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?:issues(?:\?state=open&per_page=100|\/[1-9][0-9]*)|labels\?per_page=100))$/,
    ),
  page: z.number().int().min(1).max(1000).default(1),
  changes: z
    .object({
      title: z.string().min(1).max(2000).optional(),
      body: z.string().max(65536).optional(),
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
  .regex(/^ClockworkDigital\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/);
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
  const result: { name: string; writable: boolean; topics: string[] }[] = [];
  const schema = z.array(
    z.object({
      full_name: repositoryName,
      topics: z.array(z.string()).default([]),
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
          topics: repo.topics,
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

export const issueSubmission = z
  .object({
    boardPublicId: z.string().length(12),
    kind: z.enum(["bug", "feature"]),
    title: z.string().trim().min(1).max(256),
    answers: z.array(z.string().trim().min(1).max(2000)).max(4),
    productionAnswers: z
      .array(z.string().trim().min(1).max(2000))
      .max(3)
      .default([]),
  })
  .superRefine((input, ctx) => {
    if (input.answers.length !== issueForms[input.kind].fields.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Complete every required field.",
      });
  });

export const topicNames = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/))
  .max(20)
  .refine(
    (names) => new Set(names).size === names.length,
    "Remove duplicate topics.",
  )
  .refine(
    (names) => !(names.includes("production") && names.includes("experiment")),
    "Choose Production or Experiment, not both.",
  );

export const githubSyncRouter = createTRPCRouter({
  setTopics: protectedProcedure
    .meta({
      openapi: {
        method: "PUT",
        path: "/integrations/github/topics",
        protect: true,
        tags: ["Integration"],
      },
    })
    .input(
      workspaceInput.extend({
        repository: repositoryName,
        names: topicNames,
        expectedNames: topicNames,
      }),
    )
    .output(z.object({ names: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      await access(ctx.db, ctx.user.id, input.workspacePublicId);
      const available = await repositories(
        ctx.db,
        ctx.user.id,
        input.workspacePublicId,
      );
      const repo = available.find((item) => item.name === input.repository);
      if (!repo) throw new TRPCError({ code: "FORBIDDEN" });
      if (
        JSON.stringify([...repo.topics].sort()) !==
        JSON.stringify([...input.expectedNames].sort())
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "Topics changed on GitHub. Refresh before saving.",
        });
      const integration = await integrations.getProviderForUser(
        ctx.db,
        ctx.user.id,
        "github",
      );
      if (!integration)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Connect GitHub first.",
        });
      const classification = input.names.includes("production")
        ? "production"
        : input.names.includes("experiment")
          ? "experiment"
          : null;
      const previous = input.expectedNames.includes("production")
        ? "production"
        : input.expectedNames.includes("experiment")
          ? "experiment"
          : null;
      if (previous === "production" && !classification)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Choose Experiment explicitly to change a Production policy.",
        });
      if (classification && classification !== previous)
        await installRepositoryPolicy(
          input.repository,
          classification === "production",
          decryptToken(integration.accessToken),
        );
      const response = await fetch(
        `https://api.github.com/repos/${input.repository}/topics`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${decryptToken(integration.accessToken)}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ names: input.names }),
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok)
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `GitHub returned HTTP ${response.status}. Editing topics requires repository admin access and the token's Administration write permission.`,
        });
      return z
        .object({ names: z.array(z.string()) })
        .parse(await response.json());
    }),
  issuePolicy: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/integrations/github/issue-policy",
        protect: true,
        tags: ["Integration"],
      },
    })
    .input(z.object({ boardPublicId: z.string().length(12) }))
    .output(z.object({ production: z.boolean() }))
    .query(async ({ ctx, input }) => {
      const board = await ctx.db.query.boards.findFirst({
        where: (b, { eq, and, isNull }) =>
          and(eq(b.publicId, input.boardPublicId), isNull(b.deletedAt)),
      });
      if (!board) throw new TRPCError({ code: "NOT_FOUND" });
      await assertPermission(
        ctx.db,
        ctx.user.id,
        board.workspaceId,
        "card:create",
      );
      const workspace = await ctx.db.query.workspaces.findFirst({
        where: (w, { eq }) => eq(w.id, board.workspaceId),
      });
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND" });
      const available = await repositories(
        ctx.db,
        ctx.user.id,
        workspace.publicId,
      );
      const repo = available.find(
        (item) => board.name === `GitHub: ${item.name}`,
      );
      if (!repo) throw new TRPCError({ code: "NOT_FOUND" });
      return { production: repo.topics.includes("production") };
    }),
  submitIssue: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integrations/github/issues",
        protect: true,
        tags: ["Integration"],
      },
    })
    .input(issueSubmission)
    .output(z.object({ url: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      const board = await ctx.db.query.boards.findFirst({
        where: (b, { eq, and, isNull }) =>
          and(eq(b.publicId, input.boardPublicId), isNull(b.deletedAt)),
      });
      if (!board || board.visibility !== "private")
        throw new TRPCError({ code: "NOT_FOUND" });
      await assertPermission(
        ctx.db,
        ctx.user.id,
        board.workspaceId,
        "card:create",
      );
      const settings = await syncSettings.get(ctx.db, board.workspaceId);
      const repo = settings?.repositories.find(
        (name) => board.name === `GitHub: ${name}`,
      );
      if (!settings?.enabled || !repo)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Enable sync for this repository first.",
        });
      const integration = await integrations.getProviderForUser(
        ctx.db,
        ctx.user.id,
        "github",
      );
      if (!integration)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Connect your GitHub token in Integrations first.",
        });
      const metadataResponse = await fetch(
        `https://api.github.com/repos/${repo}`,
        {
          headers: {
            Authorization: `Bearer ${decryptToken(integration.accessToken)}`,
            Accept: "application/vnd.github+json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!metadataResponse.ok)
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: "Cannot verify repository requirements.",
        });
      const metadata = z
        .object({ topics: z.array(z.string()) })
        .parse(await metadataResponse.json());
      const production = metadata.topics.includes("production");
      if (
        production &&
        input.productionAnswers.length !== productionFields.length
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Production requires acceptance criteria, a test plan, and impact/risk details.",
        });
      const form = issueForms[input.kind];
      const body = [...form.fields, ...(production ? productionFields : [])]
        .map(
          (label, index) =>
            `### ${label}\n\n${[...input.answers, ...(production ? input.productionAnswers : [])][index]}`,
        )
        .join("\n\n");
      const response = await fetch(
        `https://api.github.com/repos/${repo}/issues`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${decryptToken(integration.accessToken)}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: `[${form.name}] ${input.title}`,
            body,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok)
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `GitHub returned HTTP ${response.status}. Check your issue write permission before retrying.`,
        });
      const result = z
        .object({ html_url: z.string().url() })
        .parse(await response.json());
      return { url: result.html_url };
    }),
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
    .output(
      z.array(
        z.object({
          name: repositoryName,
          writable: z.boolean(),
          topics: z.array(z.string()),
        }),
      ),
    )
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
