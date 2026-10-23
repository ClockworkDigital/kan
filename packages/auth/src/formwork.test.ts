import { betterAuth } from "better-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";

import { formworkHook } from "./formwork";

const tenant = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
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
    "x-formwork-issued-at": String(Math.floor(Date.now() / 1000)),
  });

describe("Formwork gateway identity", () => {
  beforeEach(() => {
    findFirst.mockReset().mockResolvedValue(user);
  });

  it("returns the provisioned user through both server and HTTP session APIs without issuing cookies", async () => {
    const session = await auth.api.getSession({ headers: headers() });
    expect(session?.user.id).toBe(userId);
    expect(session?.session.token).toBe("");
    const response = await auth.handler(
      new Request("https://kan.example.test/api/auth/get-session", {
        headers: headers(),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ user: { id: userId } });
  });

  it.each([
    ["x-formwork-tenant", "10000000-0000-4000-8000-000000000099"],
    ["x-formwork-user", ""],
    ["x-formwork-user", `${userId},${userId}`],
    ["x-formwork-issued-at", ""],
    ["x-formwork-issued-at", String(Math.floor(Date.now() / 1000) - 28800)],
    ["x-formwork-issued-at", String(Math.floor(Date.now() / 1000) + 120)],
  ])(
    "denies malformed, foreign or expired identity %s=%s",
    async (key, value) => {
      const h = headers();
      h.set(key, value);
      await expect(auth.api.getSession({ headers: h })).rejects.toMatchObject({
        status: "UNAUTHORIZED",
      });
      expect(findFirst).not.toHaveBeenCalled();
    },
  );

  it("does not accept a Kan cookie or API key in place of Formwork identity", async () => {
    await expect(
      auth.api.getSession({
        headers: new Headers({
          cookie: "kan.session_token=anything",
          "x-api-key": "anything",
        }),
      }),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  });

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
