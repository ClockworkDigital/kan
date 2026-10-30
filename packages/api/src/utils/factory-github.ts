import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import { getProviderForUser } from "@kan/db/repository/integration.repo";

import { decryptToken } from "./encryption";

export const discussionSchema = z.object({
  body: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
  created_at: z.string(),
});
export const pullSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  draft: z.boolean(),
  merged: z.boolean(),
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string(),
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

// Use the viewer's GitHub identity: Kan membership never grants App-wide access.
export async function factoryGitHub(
  db: dbClient,
  userId: string,
  repository: string,
) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)
  )
    throw new TRPCError({ code: "BAD_REQUEST" });
  const integration = await getProviderForUser(db, userId, "github");
  if (!integration)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Connect GitHub in settings to inspect and act on factory jobs.",
    });
  const token = decryptToken(integration.accessToken);
  return async (
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> => {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok)
      throw new TRPCError({
        code: response.status === 409 ? "CONFLICT" : "BAD_GATEWAY",
        message:
          "GitHub could not complete the request. Refresh and check your GitHub connection, permissions and branch requirements before retrying.",
      });
    return response.json();
  };
}
