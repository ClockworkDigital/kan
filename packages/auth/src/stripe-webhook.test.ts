import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { BetterAuthPlugin } from "better-auth";
import { stripe } from "@better-auth/stripe";
import { betterAuth, createLogger, logger } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@kan/db/schema";
import { createStripeClient } from "@kan/stripe";

import { createPlugins } from "./plugins";

vi.mock("@kan/stripe", () => ({ createStripeClient: vi.fn() }));

const client = new Stripe("sk_test_synthetic", {
  apiVersion: "2025-08-27.basil",
});
// Construct a typed, unused client; these tests never execute database queries.
const db = drizzle(new Pool(), { schema });
const payload = JSON.stringify({
  id: "evt_synthetic",
  type: "synthetic.unhandled",
});
const url = "https://kan.example.test/api/auth/stripe/webhook";

function authWith(plugin: BetterAuthPlugin) {
  return betterAuth({
    secret: "synthetic-auth-secret-at-least-32-characters",
    baseURL: "https://kan.example.test",
    plugins: [plugin],
  });
}

function guardedAuth() {
  const plugin = createPlugins(db).find((plugin) => plugin.id === "stripe");
  assert.ok(
    plugin && "endpoints" in plugin && "stripeWebhook" in plugin.endpoints,
  );
  return authWith(plugin);
}

function baselineAuth(secret: string | undefined) {
  const options = {
    stripeClient: client,
    get stripeWebhookSecret(): string {
      throw new Error(
        "The baseline descriptor must be replaced before construction",
      );
    },
  };
  // Model the original erased non-null assertion without a test type escape.
  Object.defineProperty(options, "stripeWebhookSecret", { value: secret });
  return authWith(stripe(options));
}

function request(body: string | null, signature: string | null) {
  return new Request(url, {
    method: "POST",
    ...(body === null ? {} : { body }),
    headers: signature === null ? {} : { "stripe-signature": signature },
  });
}

describe("Stripe webhook secret snapshot", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_KAN_ENV", "cloud");
    vi.mocked(createStripeClient).mockReturnValue(client);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("uses the same default error formatting and channel as the SDK context", () => {
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    logger.error("Stripe webhook secret not found");
    const exportedOutput = output.mock.calls.slice();
    output.mockClear();
    createLogger().error("Stripe webhook secret not found");
    expect(output.mock.calls).toEqual(exportedOutput);
    expect(output).toHaveBeenCalledOnce();
    const message: unknown = output.mock.calls[0]?.[0];
    assert.ok(typeof message === "string");
    expect(stripVTControlCharacters(message)).toContain(
      "[Better Auth]: Stripe webhook secret not found",
    );
  });

  for (const secret of [undefined, "", "whsec_synthetic", " "]) {
    for (const signatureKind of ["absent", "invalid", "valid"] as const) {
      for (const body of [null, "", payload]) {
        it(`matches the installed SDK for secret ${JSON.stringify(secret)}, signature ${signatureKind}, body ${JSON.stringify(body)}`, async () => {
          vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
          const output = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
          const verify = vi.spyOn(client.webhooks, "constructEventAsync");
          const signature =
            signatureKind === "absent"
              ? null
              : signatureKind === "invalid"
                ? "invalid"
                : client.webhooks.generateTestHeaderString({
                    payload: body ?? "",
                    secret: secret ?? "synthetic-signing-key",
                  });

          const baseline = baselineAuth(secret);
          const current = guardedAuth();
          // Missing/empty snapshots must neither validate nor log at construction/init.
          await current.$context;
          await baseline.$context;
          expect(output).not.toHaveBeenCalled();
          expect(verify).not.toHaveBeenCalled();

          const before = await baseline.handler(request(body, signature));
          const beforeText = await before.text();
          const beforeBody: unknown = beforeText
            ? JSON.parse(beforeText)
            : null;
          const beforeLogs = output.mock.calls.slice();
          const beforeVerification = verify.mock.calls.slice();
          output.mockClear();
          verify.mockClear();
          const after = await current.handler(request(body, signature));
          expect(after.status).toBe(before.status);
          expect(await after.text()).toBe(beforeText);
          expect(output.mock.calls).toEqual(beforeLogs);
          expect(verify.mock.calls).toEqual(beforeVerification);

          if (body === null) {
            expect(after.status).toBe(500);
            expect(beforeText).toBe("");
            expect(verify).not.toHaveBeenCalled();
          }
          if (body !== null && (!secret || signatureKind === "absent")) {
            expect(after.status).toBe(400);
            expect(beforeBody).toEqual({
              code: "WEBHOOK_ERROR_STRIPE_WEBHOOK_SECRET_NOT_FOUND",
              message: "Webhook Error: Stripe webhook secret not found",
            });
            expect(output).toHaveBeenCalledOnce();
            expect(output.mock.calls[0]?.[0]).toContain("ERROR");
          }
          if (body === payload && secret && signatureKind === "valid") {
            expect(after.status).toBe(200);
            expect(beforeBody).toEqual({ success: true });
            expect(verify).toHaveBeenCalledWith(payload, signature, secret);
          }
        });
      }
    }
  }

  it("keeps request text failures ahead of the secret guard", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", undefined);
    const baseline = baselineAuth(undefined);
    const current = guardedAuth();
    const failure = new Error("synthetic request text failure");
    vi.spyOn(Request.prototype, "text").mockRejectedValue(failure);
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const guardLog = vi.spyOn(logger, "error");
    const verify = vi.spyOn(client.webhooks, "constructEventAsync");
    const before = await baseline.handler(request(payload, "invalid"));
    const beforeLogs = output.mock.calls.slice();
    output.mockClear();
    const after = await current.handler(request(payload, "invalid"));
    expect(after.status).toBe(500);
    expect(after.status).toBe(before.status);
    expect(await after.text()).toBe(await before.text());
    expect(output.mock.calls).toEqual(beforeLogs);
    expect(guardLog).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])(
    "keeps an unavailable snapshot %s after configuration changes",
    async (secret) => {
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
      const auth = guardedAuth();
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_replacement_synthetic");
      const output = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const response = await auth.handler(request(payload, "invalid"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: "WEBHOOK_ERROR_STRIPE_WEBHOOK_SECRET_NOT_FOUND",
        message: "Webhook Error: Stripe webhook secret not found",
      });
      expect(output).toHaveBeenCalledOnce();
    },
  );

  it("keeps the construction snapshot when the environment later changes", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_captured_synthetic");
    const auth = guardedAuth();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_replacement_synthetic");
    const signature = client.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_captured_synthetic",
    });
    const response = await auth.handler(request(payload, signature));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });
});
