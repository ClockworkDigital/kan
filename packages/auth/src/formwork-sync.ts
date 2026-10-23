import { betterAuth } from "better-auth";
import { apiKey } from "better-auth/plugins";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";

import { initAuth } from "./auth";
import { formworkApiGrant } from "./formwork-api";

// Explicit background delegation, separate from the eight-hour browser/MCP grant.
export const formworkSyncGrant = formworkApiGrant
  .omit({ purpose: true, issuedAt: true })
  .extend({
    purpose: z.literal("formwork-kan-github-sync"),
    workspacePublicId: z.string().length(12),
  });
export function initFormworkSyncAuth(db: dbClient) {
  return betterAuth({
    ...initAuth(db).options,
    hooks: {},
    plugins: [
      apiKey({
        enableMetadata: true,
        rateLimit: { enabled: true, timeWindow: 60000, maxRequests: 600 },
      }),
    ],
  });
}
export function readFormworkSyncGrant(
  key: { userId: string; metadata: unknown; expiresAt: Date | null },
  tenantId: string,
  targetHost: string,
) {
  const grant = formworkSyncGrant.parse(key.metadata);
  if (
    grant.userId !== key.userId ||
    grant.tenantId !== tenantId ||
    grant.targetHost !== targetHost ||
    (key.expiresAt && key.expiresAt.getTime() <= Date.now())
  )
    throw new Error("Invalid sync delegation");
  return grant;
}
