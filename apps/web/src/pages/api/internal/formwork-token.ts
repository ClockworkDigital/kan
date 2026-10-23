import type { NextApiRequest, NextApiResponse } from "next";

import { initFormworkApiAuth, readFormworkApiGrant } from "@kan/auth/server";
import { createDrizzleClient } from "@kan/db/client";
import { createLogger } from "@kan/logger";

import { env } from "~/env";

const credentials = initFormworkApiAuth(createDrizzleClient());
const log = createLogger("formwork-api");

// Caddy blocks this path externally and calls it only on Kan's private network.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).end();
  const supplied = req.headers.authorization;
  const token =
    typeof supplied === "string"
      ? /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(supplied)?.[1]
      : undefined;
  if (!token || !env.FORMWORK_TENANT_ID || !env.NEXT_PUBLIC_BASE_URL) {
    return res.status(401).end();
  }
  try {
    const result = await credentials.api.verifyApiKey({ body: { key: token } });
    if (!result.valid || !result.key) {
      return res
        .status(result.error?.code === "RATE_LIMITED" ? 429 : 401)
        .end();
    }
    let grant;
    try {
      grant = readFormworkApiGrant(
        result.key,
        env.FORMWORK_TENANT_ID,
        new URL(env.NEXT_PUBLIC_BASE_URL).host,
      );
    } catch {
      return res.status(403).end();
    }
    res.setHeader("X-Formwork-Tenant", grant.tenantId);
    res.setHeader("X-Formwork-User", grant.userId);
    res.setHeader("X-Formwork-Groups", grant.groups.join(","));
    res.setHeader("X-Formwork-Account-Type", grant.accountType);
    res.setHeader("X-Formwork-Issued-At", String(grant.issuedAt));
    res.setHeader("X-Formwork-Display-Name", "Codex");
    return res.status(204).end();
  } catch {
    log.error("Credential verification unavailable");
    return res.status(503).end();
  }
}
