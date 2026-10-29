import assert from "node:assert/strict";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as repo from "@kan/db/repository/integration.repo";

import { integrationRouter } from "../src/routers/integration";
import { decryptToken, encryptToken } from "../src/utils/encryption";
import {
  beginGitHubOAuth,
  completeGitHubOAuth,
  oauthHash,
} from "../src/utils/github-oauth";
import { createTestDb, seedTestData } from "./test-db";

describe("GitHub account authorization", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let userId: string;
  let state: string;
  const fetchMock = vi.fn();
  beforeAll(async () => {
    db = await createTestDb();
    userId = (await seedTestData(db)).user.id;
  }, 30000);
  beforeEach(async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "test-client");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "test-secret");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://kan.example");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    await repo.deleteProviderForUser(db, userId, "github");
    const url = new URL(
      await beginGitHubOAuth(db, userId, "session-and-browser"),
    );
    state = url.searchParams.get("state") ?? "";
    const pending = await repo.getProviderForUser(
      db,
      userId,
      "github-oauth-state",
    );
    const value = JSON.parse(decryptToken(pending?.accessToken ?? "")) as {
      verifier: string;
    };
    expect(url.searchParams.get("code_challenge")).toBe(
      oauthHash(value.verifier),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ghu_test",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "discard-me",
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: 123, login: "octocat" }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("stores encrypted credentials, verified numeric identity and real lifetime, hides state", async () => {
    expect(await repo.getProvidersForUser(db, userId)).toEqual([]);
    const start = Date.now();
    await completeGitHubOAuth(db, userId, "session-and-browser", state, "code");
    const saved = await repo.getProviderForUser(db, userId, "github");
    assert(saved);
    expect(saved.accessToken).not.toContain("ghu_test");
    expect(decryptToken(saved.accessToken)).toBe("ghu_test");
    expect(JSON.parse(decryptToken(saved.refreshToken ?? ""))).toEqual({
      id: 123,
      login: "octocat",
    });
    expect(saved.expiresAt.getTime()).toBeGreaterThanOrEqual(start + 3600000);
    expect(saved.expiresAt.getTime()).toBeLessThan(Date.now() + 3600001);
    await expect(
      completeGitHubOAuth(db, userId, "session-and-browser", state, "code"),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("allows only one concurrent callback to exchange the code", async () => {
    const results = await Promise.allSettled([
      completeGitHubOAuth(db, userId, "session-and-browser", state, "code"),
      completeGitHubOAuth(db, userId, "session-and-browser", state, "code"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("rejects CSRF, another browser/session and user switching without exchanging", async () => {
    for (const [user, binding, supplied] of [
      [userId, "session-and-browser", "bad"],
      [userId, "other", state],
      ["00000000-0000-4000-8000-000000000000", "session-and-browser", state],
    ]) {
      await expect(
        completeGitHubOAuth(
          db,
          user ?? "",
          binding ?? "",
          supplied ?? "",
          "code",
        ),
      ).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("consumes denied authorization", async () => {
    await expect(
      completeGitHubOAuth(db, userId, "session-and-browser", state),
    ).rejects.toThrow();
    await expect(
      completeGitHubOAuth(db, userId, "session-and-browser", state, "code"),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects expired state", async () => {
    const pending = await repo.getProviderForUser(
      db,
      userId,
      "github-oauth-state",
    );
    await repo.createOrUpdateProvider(db, {
      userId,
      provider: "github-oauth-state",
      accessToken: pending?.accessToken ?? "",
      expiresAt: new Date(0),
    });
    await expect(
      completeGitHubOAuth(db, userId, "session-and-browser", state, "code"),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["disconnect", "replace"])(
    "cannot resurrect credentials after %s during exchange",
    async (action) => {
      fetchMock
        .mockReset()
        .mockImplementationOnce(async () => {
          if (action === "disconnect")
            await repo.deleteProviderForUser(db, userId, "github");
          else
            await repo.createOrUpdateProvider(db, {
              userId,
              provider: "github",
              accessToken: "pat",
              expiresAt: new Date(Date.now() + 60000),
            });
          return Response.json({
            access_token: "ghu_test",
            token_type: "bearer",
            expires_in: 3600,
          });
        })
        .mockResolvedValueOnce(Response.json({ id: 123, login: "octocat" }));
      await expect(
        completeGitHubOAuth(db, userId, "session-and-browser", state, "code"),
      ).rejects.toThrow();
      expect(
        (await repo.getProviderForUser(db, userId, "github"))?.accessToken,
      ).toBe(action === "replace" ? "pat" : undefined);
    },
  );
  it.each([
    { error: "access_denied" },
    { access_token: "ghu_test", token_type: "bearer" },
  ])("rejects exchange errors and non-expiring tokens: %j", async (payload) => {
    fetchMock.mockReset().mockResolvedValue(Response.json(payload));
    await expect(
      completeGitHubOAuth(db, userId, "session-and-browser", state, "code"),
    ).rejects.toThrow();
    expect(await repo.getProviderForUser(db, userId, "github")).toBeUndefined();
  });
  it("distinguishes absent, PAT, active App and expired App connections without making expired tokens usable", async () => {
    const caller = integrationRouter.createCaller({
      db,
      user: { id: userId },
      headers: new Headers(),
    } as never);
    expect(await caller.getGitHubStatus()).toMatchObject({
      connected: false,
      expired: false,
      appConnection: false,
      login: null,
    });
    await repo.createOrUpdateProvider(db, {
      userId,
      provider: "github",
      accessToken: encryptToken("pat"),
      expiresAt: new Date(Date.now() + 60000),
    });
    expect(await caller.getGitHubStatus()).toMatchObject({
      connected: true,
      expired: false,
      appConnection: false,
      login: null,
    });
    for (const expired of [false, true]) {
      await repo.createOrUpdateProvider(db, {
        userId,
        provider: "github",
        accessToken: encryptToken("app"),
        refreshToken: encryptToken(
          JSON.stringify({ id: 123, login: "octocat" }),
        ),
        expiresAt: new Date(Date.now() + (expired ? -60000 : 60000)),
      });
      expect(await caller.getGitHubStatus()).toMatchObject({
        connected: !expired,
        expired,
        appConnection: true,
        login: "octocat",
      });
    }
    expect(await repo.getProviderForUser(db, userId, "github")).toBeUndefined();
    await caller.disconnectGitHub();
    expect(await caller.getGitHubStatus()).toMatchObject({
      connected: false,
      expired: false,
      appConnection: false,
      login: null,
    });
  });
});
