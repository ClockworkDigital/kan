import { randomBytes } from "node:crypto";
import type { NextApiRequest, NextApiResponse } from "next";

import { createNextApiContext } from "@kan/api/trpc-context";
import {
  beginGitHubOAuth,
  completeGitHubOAuth,
  githubOAuthOrigin,
  oauthHash,
} from "@kan/api/utils/github-oauth";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const callback = req.query.action === "callback";
  if (
    (!callback && (req.query.action !== "start" || req.method !== "POST")) ||
    (callback && req.method !== "GET")
  )
    return res.status(405).end();
  try {
    const origin = githubOAuthOrigin();
    if (!callback && req.headers.origin !== origin)
      return res.status(403).end();
    // Machine credentials cannot authorize interactive connections, even through the gateway.
    if (
      req.headers.authorization ||
      req.headers["x-api-key"] ||
      req.headers["x-formwork-sync-workspace"]
    )
      return res.status(403).end();
    const ctx = await createNextApiContext(req);
    const session = await ctx.auth.api.getSession();
    if (!ctx.user || !session) {
      if (callback)
        return res.redirect(
          303,
          `${origin}/settings/integrations?github=error`,
        );
      return res.status(401).end();
    }
    const cookieName = origin.startsWith("https:")
      ? "__Host-kan-github-oauth"
      : "kan-github-oauth";
    const cookie = callback
      ? req.cookies[cookieName]
      : randomBytes(32).toString("base64url");
    if (!cookie) throw new Error("Missing browser binding");
    const binding = oauthHash(
      JSON.stringify([
        cookie,
        ctx.user.id,
        session.session.id,
        session.session.createdAt,
        req.headers["x-formwork-tenant"] ?? "native",
      ]),
    );
    if (!callback) {
      const url = await beginGitHubOAuth(ctx.db, ctx.user.id, binding);
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${origin.startsWith("https:") ? "; Secure" : ""}`,
      );
      return res.redirect(303, url);
    }
    const { state, code, error } = req.query;
    if (typeof state !== "string" || state.length > 100)
      throw new Error("Invalid state");
    await completeGitHubOAuth(
      ctx.db,
      ctx.user.id,
      binding,
      state,
      !error && typeof code === "string" && code.length < 1024
        ? code
        : undefined,
    );
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`,
    );
    return res.redirect(303, `${origin}/settings/integrations`);
  } catch {
    // Never expose upstream bodies, codes, tokens or diagnostic URLs.
    return res.redirect(303, "/settings/integrations?github=error");
  }
}
