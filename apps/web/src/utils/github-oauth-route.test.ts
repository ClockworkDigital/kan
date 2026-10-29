import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, expect, it, vi } from "vitest";

import { createNextApiContext } from "@kan/api/trpc-context";
import {
  beginGitHubOAuth,
  completeGitHubOAuth,
} from "@kan/api/utils/github-oauth";

import handler from "../pages/api/integrations/github/[action]";

vi.mock("@kan/api/trpc-context", () => ({ createNextApiContext: vi.fn() }));
vi.mock("@kan/api/utils/github-oauth", () => ({
  beginGitHubOAuth: vi
    .fn()
    .mockResolvedValue("https://github.com/login/oauth/authorize"),
  completeGitHubOAuth: vi.fn(),
  githubOAuthOrigin: () => "https://kan.example",
  oauthHash: (value: string) => value,
}));
beforeEach(() => vi.clearAllMocks());
function response() {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    end: vi.fn(),
    redirect: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}
it.each(["authorization", "x-api-key", "x-formwork-sync-workspace"])(
  "blocks machine %s before authentication",
  async (header) => {
    for (const action of ["start", "callback"]) {
      const res = response();
      await handler(
        {
          method: action === "start" ? "POST" : "GET",
          query: { action },
          headers: { origin: "https://kan.example", [header]: "machine" },
        } as unknown as NextApiRequest,
        res as unknown as NextApiResponse,
      );
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(createNextApiContext).not.toHaveBeenCalled();
  },
);
it("rejects cross-origin initiation", async () => {
  const res = response();
  await handler(
    {
      method: "POST",
      query: { action: "start" },
      headers: { origin: "https://evil.example" },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  expect(res.status).toHaveBeenCalledWith(403);
  expect(beginGitHubOAuth).not.toHaveBeenCalled();
});
it("requires normal authentication on callback", async () => {
  vi.mocked(createNextApiContext).mockResolvedValue({
    user: null,
    auth: { api: { getSession: () => Promise.resolve(null) } },
  } as unknown as Awaited<ReturnType<typeof createNextApiContext>>);
  const res = response();
  await handler(
    {
      method: "GET",
      query: { action: "callback", state: "state", code: "secret-code" },
      headers: {},
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  expect(res.redirect).toHaveBeenCalledWith(
    303,
    "https://kan.example/settings/integrations?github=error",
  );
  expect(completeGitHubOAuth).not.toHaveBeenCalled();
  expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
});

function authenticatedContext() {
  vi.mocked(createNextApiContext).mockResolvedValue({
    db: {},
    user: { id: "user-1" },
    auth: {
      api: {
        getSession: () =>
          Promise.resolve({
            session: { id: "session-1", createdAt: "2026-01-01" },
          }),
      },
    },
  } as unknown as Awaited<ReturnType<typeof createNextApiContext>>);
}
it("starts authorization with a secure browser cookie and 303 redirect", async () => {
  authenticatedContext();
  const res = response();
  await handler(
    {
      method: "POST",
      query: { action: "start" },
      headers: { origin: "https://kan.example" },
      cookies: {},
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  expect(beginGitHubOAuth).toHaveBeenCalledWith(
    {},
    "user-1",
    expect.any(String),
  );
  expect(res.setHeader).toHaveBeenCalledWith(
    "Set-Cookie",
    expect.stringMatching(
      /^__Host-kan-github-oauth=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/,
    ),
  );
  expect(res.redirect).toHaveBeenCalledWith(
    303,
    "https://github.com/login/oauth/authorize",
  );
});
it("rejects a callback missing its binding cookie before exchanging the code", async () => {
  authenticatedContext();
  const res = response();
  await handler(
    {
      method: "GET",
      query: { action: "callback", state: "state", code: "code" },
      headers: {},
      cookies: {},
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  expect(completeGitHubOAuth).not.toHaveBeenCalled();
  expect(res.redirect).toHaveBeenCalledWith(
    303,
    "/settings/integrations?github=error",
  );
});
it("passes a denied callback through state consumption without exchanging a code", async () => {
  authenticatedContext();
  vi.mocked(completeGitHubOAuth).mockRejectedValueOnce(
    new Error("Authorization denied"),
  );
  const res = response();
  await handler(
    {
      method: "GET",
      query: { action: "callback", state: "state", error: "access_denied" },
      headers: {},
      cookies: { "__Host-kan-github-oauth": "binding" },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  expect(completeGitHubOAuth).toHaveBeenCalledWith(
    {},
    "user-1",
    expect.any(String),
    "state",
    undefined,
  );
  expect(res.redirect).toHaveBeenCalledWith(
    303,
    "/settings/integrations?github=error",
  );
});
