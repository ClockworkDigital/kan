import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { CreateNextContextOptions } from "@trpc/server/adapters/next";
import type { NextApiRequest, NextApiResponse } from "next";
import { APIError } from "better-auth/api";
import { createOpenApiNextHandler } from "trpc-to-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const execute = vi.fn();
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock("@kan/auth/server", () => ({
  FORMWORK_IDENTITY_MISSING: "FORMWORK_IDENTITY_MISSING",
  initAuth: vi.fn(() => ({ api: { getSession } })),
}));
vi.mock("@kan/db/client", () => ({
  createDrizzleClient: vi.fn(() => ({ execute })),
}));
vi.mock("@kan/logger", () => ({
  createLogger: vi.fn(() => log),
}));

const { createRESTContext } = await import("./trpc-context.js");
const { createTRPCRouter, protectedProcedure } = await import("./trpc.js");
const { healthRouter } = await import("./routers/health.js");

function makeOpts(): CreateNextContextOptions {
  return {
    req: { headers: {} },
    res: {},
    info: {},
  } as unknown as CreateNextContextOptions;
}

const missingIdentity = () =>
  new APIError("UNAUTHORIZED", { code: "FORMWORK_IDENTITY_MISSING" });

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReset();
  execute.mockReset().mockResolvedValue([]);
  vi.stubEnv("S3_ENDPOINT", "");
  vi.stubEnv("S3_ACCESS_KEY_ID", "");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("createRESTContext", () => {
  it.each([
    [42000, " Try again in 42s."],
    [1001, " Try again in 2s."],
    [undefined, ""],
  ])(
    "propagates API-key rate limits with retry duration %s",
    async (tryAgainIn, suffix) => {
      getSession.mockRejectedValueOnce({
        name: "APIError",
        body: { code: "RATE_LIMITED", details: { tryAgainIn } },
      });

      await expect(createRESTContext(makeOpts())).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: `Rate limit exceeded for this API key.${suffix}`,
      });
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    new Error("network error"),
    new APIError("UNAUTHORIZED"),
    new APIError("FORBIDDEN"),
    Object.assign(new Error("not an APIError"), {
      body: { code: "FORMWORK_IDENTITY_MISSING" },
    }),
  ])(
    "treats a session lookup failure as unauthenticated and warns: %s",
    async (error) => {
      getSession.mockRejectedValueOnce(error);

      const ctx = await createRESTContext(makeOpts());

      expect(ctx.user).toBeUndefined();
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        { err: error },
        "Failed to get session, treating as unauthenticated",
      );
    },
  );

  it("keeps requests without Formwork identity anonymous and quiet", async () => {
    getSession.mockRejectedValueOnce(missingIdentity());

    const ctx = await createRESTContext(makeOpts());
    const resolve = vi.fn(() => "private data");
    const router = createTRPCRouter({
      private: protectedProcedure.query(resolve),
    });

    expect(ctx.user).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
    await expect(router.createCaller(ctx).private()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("serves the container healthcheck without warnings", async () => {
    getSession.mockRejectedValueOnce(missingIdentity());
    const handler = createOpenApiNextHandler({
      router: createTRPCRouter({ health: healthRouter }),
      createContext: createRESTContext,
    });
    const req = Object.assign(new IncomingMessage(new Socket()), {
      method: "GET",
      url: "/api/v1/health",
      query: { trpc: ["health"] },
    }) as unknown as NextApiRequest;
    const res = new ServerResponse(req) as unknown as NextApiResponse;
    const end = vi.spyOn(res, "end").mockReturnValue(res);

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        status: "ok",
        database: "ok",
        storage: "not_configured",
      }),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("resolves the user normally when the session is valid", async () => {
    getSession.mockResolvedValueOnce({ user: { id: "user-1" } });

    const ctx = await createRESTContext(makeOpts());

    expect(ctx.user).toEqual({ id: "user-1" });
  });
});
