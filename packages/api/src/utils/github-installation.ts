import { createSign } from "node:crypto";
import { z } from "zod";

let cached: { token: string; expiresAt: number } | undefined;

export const githubInstallationConfigured = () =>
  Boolean(
    process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_PRIVATE_KEY,
  );

const base64url = (value: string) => Buffer.from(value).toString("base64url");

// GitHub accepts the client ID as the app JWT issuer; the key is a base64-encoded PEM.
function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 540,
      iss: process.env.GITHUB_APP_CLIENT_ID,
    }),
  )}`;
  const key = Buffer.from(
    process.env.GITHUB_APP_PRIVATE_KEY ?? "",
    "base64",
  ).toString();
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key, "base64url")}`;
}

async function asApp(path: string, method: "GET" | "POST" = "GET") {
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${appJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub App HTTP ${response.status}`);
  return response.json();
}

// Installation tokens last an hour; reuse one until five minutes before expiry.
export async function githubInstallationToken() {
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const { id } = z
    .object({ id: z.number().int() })
    .parse(await asApp("orgs/ClockworkDigital/installation"));
  const { token, expires_at } = z
    .object({ token: z.string().min(1), expires_at: z.string().datetime() })
    .parse(await asApp(`app/installations/${id}/access_tokens`, "POST"));
  cached = { token, expiresAt: Date.parse(expires_at) };
  return token;
}

let descriptions: { at: number; byRepo: Map<string, string> } | undefined;

// Repository descriptions for board tiles, keyed by lower-case full name. Cached for ten minutes.
export async function githubRepositoryDescriptions() {
  if (!githubInstallationConfigured()) return new Map<string, string>();
  if (descriptions && Date.now() - descriptions.at < 10 * 60_000)
    return descriptions.byRepo;
  const token = await githubInstallationToken();
  const byRepo = new Map<string, string>();
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      `https://api.github.com/orgs/ClockworkDigital/repos?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const repos = z
      .array(
        z.object({ full_name: z.string(), description: z.string().nullable() }),
      )
      .parse(await response.json());
    for (const repo of repos)
      if (repo.description?.trim())
        byRepo.set(repo.full_name.toLowerCase(), repo.description.trim());
    if (repos.length < 100) break;
  }
  descriptions = { at: Date.now(), byRepo };
  return byRepo;
}
