import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, expect, it, vi } from "vitest";

function exchange(method: string, signature?: string) {
  const req: NextApiRequest = Object.assign(new IncomingMessage(new Socket()), {
    method,
    url: "/api/synthetic",
    headers: { "stripe-signature": signature },
    query: {},
    cookies: {},
    body: undefined,
    env: {},
  });
  req.push("{}");
  req.push(null);
  const json = vi.fn<(body: unknown) => void>();
  const res: NextApiResponse = Object.assign(new ServerResponse(req), {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json,
    send: vi.fn(),
    redirect: () => res,
    setDraftMode: () => res,
    setPreviewData: () => res,
    clearPreviewData: () => res,
    revalidate: vi.fn<() => Promise<void>>(),
  });
  return { req, res, json };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("keeps unrelated URL validation out of previously raw-reading API imports", async () => {
  vi.stubEnv("CI", undefined);
  vi.stubEnv("npm_lifecycle_event", "test");
  vi.stubEnv("SUBSCRIBER_API_URL", "");
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "synthetic-auth-secret-at-least-32-characters",
  );
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://kan.example.test");
  // A lazy PostgreSQL pool prevents PGLite startup migrations; no query is made.
  vi.stubEnv(
    "POSTGRES_URL",
    "postgres://synthetic:synthetic@127.0.0.1:9/synthetic",
  );
  vi.stubEnv("REDIS_URL", undefined);
  vi.stubEnv("NEXT_PUBLIC_KAN_ENV", undefined);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_synthetic");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET_LEGACY", undefined);

  // The actual global validator still rejects this configuration without CI.
  await expect(import("../../env")).rejects.toThrow(
    "Invalid environment variables",
  );

  const { default: webhook } = await import("./stripe/webhook");
  const legacy = exchange("POST", "invalid");
  await webhook(legacy.req, legacy.res);
  expect(legacy.res.statusCode).toBe(400);
  expect(legacy.json).toHaveBeenCalledExactlyOnceWith({
    message: "Webhook handler failed",
  });

  const { default: callback } = await import("./partner/callback");
  const partner = exchange("GET");
  await callback(partner.req, partner.res);
  expect(partner.res.statusCode).toBe(200);
  expect(partner.json).toHaveBeenCalledExactlyOnceWith({ message: "OK" });

  const { default: partnerWebhook } = await import("./partner/webhook");
  const partnerGet = exchange("GET");
  await partnerWebhook(partnerGet.req, partnerGet.res);
  expect(partnerGet.res.statusCode).toBe(405);
  expect(partnerGet.json).toHaveBeenCalledExactlyOnceWith({
    message: "Method not allowed",
  });

  const { default: checkout } = await import(
    "./stripe/create_checkout_session"
  );
  const checkoutGet = exchange("GET");
  await checkout(checkoutGet.req, checkoutGet.res);
  expect(checkoutGet.res.statusCode).toBe(405);
  expect(checkoutGet.json).toHaveBeenCalledExactlyOnceWith({
    error: "Method not allowed",
  });
}, 15_000);
