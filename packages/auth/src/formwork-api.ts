import { betterAuth } from "better-auth";
import { apiKey } from "better-auth/plugins";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";

import { initAuth } from "./auth";

export const formworkApiGrant = z.object({
  purpose: z.literal("formwork-kan-mcp"),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  groups: z.array(z.string().uuid()).min(1).max(200),
  accountType: z.literal("0"),
  issuedAt: z.number().int().positive(),
  targetHost: z.string().min(1).max(253),
});

// Server-side credential operations only. This handler is never mounted publicly.
export function initFormworkApiAuth(db: dbClient) {
  return betterAuth({
    ...initAuth(db).options,
    hooks: {},
    plugins: [
      apiKey({
        enableMetadata: true,
        keyExpiration: { minExpiresIn: 0, maxExpiresIn: 1 / 3 },
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
      }),
    ],
  });
}

export function readFormworkApiGrant(
  key: { userId: string; metadata: unknown; expiresAt: Date | null },
  tenantId: string,
  targetHost: string,
) {
  const grant = formworkApiGrant.parse(key.metadata);
  const age = Date.now() / 1000 - grant.issuedAt;
  if (
    grant.tenantId !== tenantId ||
    grant.userId !== key.userId ||
    grant.targetHost !== targetHost ||
    age < -60 ||
    age >= 8 * 60 * 60 ||
    !key.expiresAt ||
    key.expiresAt.getTime() <= Date.now() ||
    key.expiresAt.getTime() > (grant.issuedAt + 8 * 60 * 60 + 1) * 1000
  )
    throw new Error("Invalid Formwork API grant");
  return grant;
}
