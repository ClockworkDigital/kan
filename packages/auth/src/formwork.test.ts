import { betterAuth } from "better-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";

import { FORMWORK_IDENTITY_MISSING, formworkHook } from "./formwork";

const tenant = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const now = 1793095200;
const user = {
  id: userId,
  name: "Colleague",
  email: "colleague@example.test",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const findFirst = vi.fn();
const db = { query: { users: { findFirst } } } as unknown as dbClient;
const auth = betterAuth({
  baseURL: "https://kan.example.test",
  secret: "test-secret-that-is-at-least-32-characters",
  hooks: { before: formworkHook(db, tenant) },
});
const headers = () =>
  new Headers({
    "x-formwork-tenant": tenant,
    "x-formwork-user": userId,
    "x-formwork-issued-at": String(now),
  });

describe("Formwork gateway identity", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    findFirst.mockReset().mockResolvedValue(user);
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns the provisioned user through both server and HTTP session APIs without issuing cookies", async () => {
    const session = await auth.api.getSession({ headers: headers() });
    expect(session?.user.id).toBe(userId);
    expect(session?.session.token).toBe("");
    expect(session?.session.expiresAt).toEqual(new Date((now + 28800) * 1000));
    const response = await auth.handler(
      new Request("https://kan.example.test/api/auth/get-session", {
        headers: headers(),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ user: { id: userId } });
  });

  it("allows sign-out through the gateway", async () => {
    await expect(auth.api.signOut({ headers: headers() })).resolves.toEqual({
      success: true,
    });
  });

  it.each([
    ["x-formwork-tenant", "10000000-0000-4000-8000-000000000099"],
    ["x-formwork-user", ""],
    ["x-formwork-user", `${userId},${userId}`],
    ["x-formwork-issued-at", ""],
    ["x-formwork-issued-at", "invalid"],
    ["x-formwork-issued-at", String(now - 28800)],
    ["x-formwork-issued-at", String(now - 28801)],
    ["x-formwork-issued-at", String(now + 61)],
  ])(
    "denies malformed, foreign or expired identity %s=%s",
    async (key, value) => {
      const h = headers();
      h.set(key, value);
      const error = await auth.api
        .getSession({ headers: h })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        status: "UNAUTHORIZED",
      });
      expect(error).not.toHaveProperty("body.code");
      expect(findFirst).not.toHaveBeenCalled();
    },
  );

  it("rejects partial Formwork identity without tagging it as missing", async () => {
    const error = await auth.api
      .getSession({ headers: new Headers({ "X-Formwork-Groups": tenant }) })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ status: "UNAUTHORIZED" });
    expect(error).not.toHaveProperty("body.code");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: "no headers", headers: undefined },
    { scenario: "empty headers", headers: new Headers() },
    {
      scenario: "a Kan cookie and API key",
      headers: new Headers({
        cookie: "kan.session_token=anything",
        "x-api-key": "anything",
      }),
    },
  ])(
    "rejects missing Formwork identity with $scenario",
    async ({ headers }) => {
      await expect(auth.api.getSession({ headers })).rejects.toMatchObject({
        status: "UNAUTHORIZED",
        body: { code: FORMWORK_IDENTITY_MISSING },
      });
      expect(findFirst).not.toHaveBeenCalled();
    },
  );

  it("denies users who were not explicitly provisioned", async () => {
    findFirst.mockResolvedValue(undefined);
    await expect(
      auth.api.getSession({ headers: headers() }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("disables alternate account authentication and keeps database failures closed", async () => {
    await expect(
      auth.api.signUpEmail({
        headers: headers(),
        body: {
          email: user.email,
          name: user.name,
          password: "long-enough-password",
        },
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    findFirst.mockRejectedValue(new Error("database unavailable"));
    await expect(auth.api.getSession({ headers: headers() })).rejects.toThrow(
      "database unavailable",
    );
  });
});
