import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as repo from "@kan/db/repository/integration.repo";

import { decryptToken, encryptToken } from "./encryption";

export const githubOAuthConfigured = () =>
  Boolean(
    process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET,
  );
export const oauthHash = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
export function githubOAuthOrigin() {
  const url = new URL(process.env.NEXT_PUBLIC_BASE_URL ?? "");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "localhost"))
  )
    throw new Error("Invalid origin");
  return url.origin;
}
const pendingSchema = z.object({
  state: z.string(),
  binding: z.string(),
  verifier: z.string(),
});
export async function beginGitHubOAuth(
  db: dbClient,
  userId: string,
  binding: string,
) {
  if (!githubOAuthConfigured()) throw new Error("Not configured");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: process.env.GITHUB_APP_CLIENT_ID ?? "",
    redirect_uri: `${githubOAuthOrigin()}/api/integrations/github/callback`,
    state,
    code_challenge: oauthHash(verifier),
    code_challenge_method: "S256",
  }).toString();
  await repo.createOrUpdateProvider(db, {
    userId,
    provider: "github-oauth-state",
    accessToken: encryptToken(JSON.stringify({ state, binding, verifier })),
    expiresAt: new Date(Date.now() + 600_000),
  });
  return url.toString();
}
export async function completeGitHubOAuth(
  db: dbClient,
  userId: string,
  binding: string,
  state: string,
  code?: string,
) {
  const pending = await repo.getProviderForUser(
    db,
    userId,
    "github-oauth-state",
  );
  if (!pending) throw new Error("Expired state");
  const value = pendingSchema.parse(
    JSON.parse(decryptToken(pending.accessToken)),
  );
  if (value.state !== state || value.binding !== binding)
    throw new Error("Invalid state");
  const claimed = encryptToken(randomBytes(32).toString("base64url"));
  if (!(await repo.claimGitHubState(db, userId, pending.accessToken, claimed)))
    throw new Error("Used state");
  if (!code) throw new Error("Authorization denied");
  const started = Date.now();
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_APP_CLIENT_ID,
      client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
      code,
      code_verifier: value.verifier,
      redirect_uri: `${githubOAuthOrigin()}/api/integrations/github/callback`,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Exchange failed");
  const token = z
    .object({
      access_token: z.string().min(1),
      token_type: z.literal("bearer"),
      expires_in: z.number().int().positive().max(28800),
    })
    .parse(await response.json());
  // Explicit reconnect only: discard the refresh token, never store an unused secret.
  const identityResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/vnd.github+json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!identityResponse.ok) throw new Error("Identity verification failed");
  const identity = z
    .object({
      id: z.number().int().positive().safe(),
      login: z.string().regex(/^[a-zA-Z0-9-]{1,39}$/),
    })
    .parse(await identityResponse.json());
  if (
    !(await repo.finishGitHubState(
      db,
      userId,
      claimed,
      encryptToken(token.access_token),
      new Date(started + token.expires_in * 1000),
      encryptToken(JSON.stringify(identity)),
    ))
  )
    throw new Error("Connection replaced");
}
