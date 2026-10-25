import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNextApiContext } from "@kan/api/trpc-context";
import * as subscriptionRepo from "@kan/db/repository/subscription.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { createStripeClient } from "@kan/stripe";

import handler from "./webhook";

const state = vi.hoisted(() => {
  const configuration: { secret: string | undefined; reads: number } = {
    secret: undefined,
    reads: 0,
  };
  return {
    ...configuration,
    error: vi.fn<(fields: Record<string, unknown>, message: string) => void>(),
    info: vi.fn(),
    warn: vi.fn(),
  };
});

vi.mock("next-runtime-env", () => ({
  env: (key: string) => {
    if (key === "STRIPE_WEBHOOK_SECRET_LEGACY") {
      state.reads++;
      return state.secret;
    }
    return undefined;
  },
}));
vi.mock("@kan/logger", () => ({
  createLogger: () => ({
    error: state.error,
    info: state.info,
    warn: state.warn,
  }),
}));
vi.mock("@kan/stripe", () => ({ createStripeClient: vi.fn() }));
vi.mock("@kan/api/trpc-context", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { Pool } = await import("pg");
  const schema = await import("@kan/db/schema");
  // This typed client is never queried; no database connection is opened.
  return {
    createNextApiContext: vi.fn(() =>
      Promise.resolve({
        db: drizzle(new Pool(), { schema }),
      }),
    ),
  };
});
vi.mock("@kan/db/repository/workspace.repo", () => ({
  create: vi.fn(),
  update: vi.fn(),
  getByPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/subscription.repo", () => ({
  create: vi.fn(),
  getByStripeSubscriptionId: vi.fn(),
}));

const client = new Stripe("sk_test_synthetic", {
  apiVersion: "2025-08-27.basil",
});
const payload = JSON.stringify({
  id: "evt_synthetic",
  type: "synthetic.unhandled",
});
const importSecretReads = state.reads;

function exchange(
  method = "POST",
  signature: string | string[] | undefined = "invalid",
  body = payload,
) {
  const req: NextApiRequest = Object.assign(new IncomingMessage(new Socket()), {
    method,
    url: "/api/stripe/webhook?synthetic=1",
    headers: { "stripe-signature": signature },
    query: {},
    cookies: {},
    body: undefined,
    env: {},
  });
  req.push(body);
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

function expectNoDatabaseEffects() {
  expect(createNextApiContext).not.toHaveBeenCalled();
  expect(workspaceRepo.create).not.toHaveBeenCalled();
  expect(workspaceRepo.update).not.toHaveBeenCalled();
  expect(workspaceRepo.getByPublicId).not.toHaveBeenCalled();
  expect(subscriptionRepo.create).not.toHaveBeenCalled();
  expect(subscriptionRepo.getByStripeSubscriptionId).not.toHaveBeenCalled();
}

function expectFailure(
  res: NextApiResponse,
  json: ReturnType<typeof exchange>["json"],
) {
  expect(res.statusCode).toBe(400);
  expect(json).toHaveBeenCalledExactlyOnceWith({
    message: "Webhook handler failed",
  });
  expect(state.error).toHaveBeenCalledOnce();
  const entry = state.error.mock.calls[0];
  assert.ok(entry);
  expect(entry[1]).toBe("API error");
  expect(Object.keys(entry[0]).sort()).toEqual([
    "duration",
    "err",
    "procedure",
    "requestId",
    "status",
    "transport",
  ]);
  const anyNumber: unknown = expect.any(Number);
  const anyString: unknown = expect.any(String);
  const anyError: unknown = expect.any(Error);
  expect(entry[0]).toMatchObject({
    procedure: "/api/stripe/webhook",
    transport: "rest",
    status: 400,
    duration: anyNumber,
    requestId: anyString,
    err: anyError,
  });
  expect(state.info).not.toHaveBeenCalled();
  expectNoDatabaseEffects();
}

describe("legacy Stripe webhook request narrowing", () => {
  it("does not read the webhook secret when importing the handler", () => {
    expect(importSecretReads).toBe(0);
  });

  beforeEach(() => {
    state.secret = undefined;
    state.reads = 0;
    vi.clearAllMocks();
    vi.mocked(createStripeClient).mockReturnValue(client);
  });
  afterEach(() => vi.restoreAllMocks());

  for (const secret of [undefined, "", "whsec_synthetic"]) {
    it(`preserves method and missing-signature checks for ${JSON.stringify(secret)}`, async () => {
      state.secret = secret;
      const verify = vi.spyOn(client.webhooks, "constructEvent");
      const get = exchange("GET");
      await handler(get.req, get.res);
      expect(get.res.statusCode).toBe(405);
      expect(get.json).toHaveBeenCalledExactlyOnceWith({
        message: "Method not allowed",
      });
      const post = exchange();
      delete post.req.headers["stripe-signature"];
      await handler(post.req, post.res);
      expect(post.res.statusCode).toBe(400);
      expect(post.json).toHaveBeenCalledExactlyOnceWith({
        message: "No signature found",
      });
      expect(state.reads).toBe(0);
      expect(state.error).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expectNoDatabaseEffects();
    });

    it(`keeps body read failures ahead of secret access for ${JSON.stringify(secret)}`, async () => {
      state.secret = secret;
      const { req, res, json } = exchange();
      const failure = new Error("synthetic body read failure");
      req.destroy(failure);
      await handler(req, res);
      expect(state.reads).toBe(0);
      expectFailure(res, json);
      expect(state.error.mock.calls[0]?.[0].err).toBe(failure);
    });

    for (const signature of ["invalid", ["invalid"], "signed"] as const) {
      for (const body of ["", payload]) {
        it(`preserves verification for ${JSON.stringify(secret)}, ${JSON.stringify(signature)}, ${JSON.stringify(body)}`, async () => {
          state.secret = secret;
          const header =
            signature === "signed"
              ? client.webhooks.generateTestHeaderString({
                  payload: body,
                  secret: secret ?? "synthetic-signing-key",
                })
              : typeof signature === "string"
                ? signature
                : [...signature];
          const verify = vi.spyOn(client.webhooks, "constructEvent");
          const { req, res, json } = exchange("POST", header, body);
          await handler(req, res);
          expect(state.reads).toBe(1);
          if (
            secret !== undefined &&
            signature === "signed" &&
            body === payload
          ) {
            expect(res.statusCode).toBe(200);
            expect(json).toHaveBeenCalledExactlyOnceWith({ received: true });
            expect(createNextApiContext).toHaveBeenCalledExactlyOnceWith(req);
            expect(state.error).not.toHaveBeenCalled();
            expect(state.warn).toHaveBeenCalledExactlyOnceWith(
              { eventType: "synthetic.unhandled" },
              "Unhandled Stripe event type",
            );
            expect(state.info).toHaveBeenCalledWith(
              expect.objectContaining({
                status: 200,
                transport: "rest",
                input: {
                  eventType: "synthetic.unhandled",
                  eventId: "evt_synthetic",
                },
              }),
              "API OK",
            );
            expect(workspaceRepo.update).not.toHaveBeenCalled();
            expect(subscriptionRepo.create).not.toHaveBeenCalled();
          } else {
            expectFailure(res, json);
          }
          if (secret === undefined) {
            expect(verify).not.toHaveBeenCalled();
            expect(state.error.mock.calls[0]?.[0].err).toEqual(
              new Error("STRIPE_WEBHOOK_SECRET_LEGACY is not set"),
            );
          } else {
            expect(verify).toHaveBeenCalledExactlyOnceWith(
              body,
              header,
              secret,
            );
            if (res.statusCode === 400) {
              let originalError: unknown;
              try {
                client.webhooks.constructEvent(body, header, secret);
              } catch (err) {
                originalError = err;
              }
              expect(state.error.mock.calls[0]?.[0].err).toEqual(originalError);
            }
          }
        });
      }
    }
  }
});
