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

function makeOpts(
  headers: NextApiRequest["headers"] = {},
): CreateNextContextOptions {
  return {
    req: { headers },
    res: {},
    info: {},
  } as unknown as CreateNextContextOptions;
}

const identity = {
  "x-formwork-tenant": "10000000-0000-4000-8000-000000000001",
  "x-formwork-user": "10000000-0000-4000-8000-000000000002",
  "x-formwork-issued-at": String(Math.floor(Date.now() / 1000)),
};
const warningMessage = "Failed to get session, treating as unauthenticated";

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
  it.each(["null session", "bare UNAUTHORIZED"])(
    "keeps a credential-free request anonymous without warnings for %s",
    async (scenario) => {
      if (scenario === "null session") getSession.mockResolvedValueOnce(null);
      else getSession.mockRejectedValueOnce(new APIError("UNAUTHORIZED"));

      const ctx = await createRESTContext(
        makeOpts({ Accept: "application/json" }),
      );

      expect(ctx.user).toBeUndefined();
      expect(ctx.transport).toBe("rest");
      expect(getSession).toHaveBeenCalledExactlyOnceWith({
        headers: ctx.headers,
      });
      expect(ctx.headers.get("accept")).toBe("application/json");
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Authorization", "Bearer synthetic-token"],
    ["Authorization", ""],
    ["Cookie", "kan.session_token=synthetic-cookie"],
    ["Cookie", ""],
    ["X-Api-Key", "synthetic-key"],
    ["X-Api-Key", ""],
    ["X-Formwork-Tenant", identity["x-formwork-tenant"]],
    ["X-Formwork-Tenant", ""],
    ["X-Formwork-User", identity["x-formwork-user"]],
    ["X-Formwork-User", ""],
    ["X-Formwork-Issued-At", identity["x-formwork-issued-at"]],
    ["X-Formwork-Issued-At", ""],
    ["X-Formwork-Sync-Workspace", "workspace123"],
    ["X-Formwork-Sync-Workspace", ""],
    ["X-Formwork-Unknown", ""],
  ])("retains the warning with header %s=%s", async (name, value) => {
    const error = new APIError("UNAUTHORIZED");
    getSession.mockRejectedValueOnce(error);

    const ctx = await createRESTContext(makeOpts({ [name]: value }));

    expect(ctx.user).toBeUndefined();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      { err: error },
      warningMessage,
    );
  });

  it.each([
    ["complete identity", identity],
    ["malformed identity", { ...identity, "x-formwork-user": "invalid" }],
    [
      "foreign tenant",
      {
        ...identity,
        "x-formwork-tenant": "10000000-0000-4000-8000-000000000099",
      },
    ],
    [
      "expired identity",
      {
        ...identity,
        "x-formwork-issued-at": String(Math.floor(Date.now() / 1000) - 28800),
      },
    ],
  ])("retains the warning for rejected %s", async (_scenario, headers) => {
    const error = new APIError("UNAUTHORIZED");
    getSession.mockRejectedValueOnce(error);

    const ctx = await createRESTContext(makeOpts(headers));

    expect(ctx.user).toBeUndefined();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      { err: error },
      warningMessage,
    );
  });

  it.each([
    new Error("database unavailable"),
    new Error("adapter failure"),
    new APIError("FORBIDDEN"),
    new APIError("UNAUTHORIZED", { message: "Invalid credentials" }),
    new APIError("UNAUTHORIZED", { code: "INVALID_TOKEN" }),
    Object.assign(new APIError("UNAUTHORIZED"), {
      cause: new Error("adapter failure"),
    }),
    { status: 401 },
    { name: "APIError", status: "UNAUTHORIZED", statusCode: 401 },
    Object.assign(new Error(""), { status: "UNAUTHORIZED", statusCode: 401 }),
    Object.assign(new Error(""), {
      name: "APIError",
      status: "UNAUTHORIZED",
      statusCode: 401,
    }),
  ])(
    "logs unexpected lookup failures with error details: %s",
    async (error) => {
      getSession.mockRejectedValueOnce(error);

      const ctx = await createRESTContext(makeOpts());

      expect(ctx.user).toBeUndefined();
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        { err: error },
        warningMessage,
      );
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it("does not add credentials or request/session objects to diagnostics", async () => {
    const headers = {
      Authorization: "Bearer synthetic-token",
      Cookie: "kan.session_token=synthetic-cookie",
      "x-api-key": "synthetic-key",
      ...identity,
    };
    const error = new Error("database unavailable");
    getSession.mockRejectedValueOnce(error);

    await createRESTContext(makeOpts(headers));

    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      { err: error },
      warningMessage,
    );
    expect(Object.keys(log.warn.mock.calls[0]?.[0] as object)).toEqual(["err"]);
    const diagnostics = JSON.stringify(log.warn.mock.calls);
    for (const value of Object.values(headers))
      expect(diagnostics).not.toContain(value);
  });

  it.each([
    [42000, " Try again in 42s."],
    [1001, " Try again in 2s."],
    [undefined, ""],
  ])(
    "propagates API-key rate limits with retry duration %s",
    async (tryAgainIn, suffix) => {
      const error = Object.assign(new APIError("UNAUTHORIZED"), {
        body: {
          code: "RATE_LIMITED",
          ...(tryAgainIn !== undefined && { details: { tryAgainIn } }),
        },
      });
      getSession.mockRejectedValueOnce(error);

      await expect(createRESTContext(makeOpts())).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: `Rate limit exceeded for this API key.${suffix}`,
      });
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    { Cookie: "kan.session_token=synthetic-cookie" },
    { "x-api-key": "synthetic-key" },
    identity,
  ])(
    "preserves valid session users and REST context fields with %s",
    async (headers) => {
      const user = { id: identity["x-formwork-user"] };
      getSession.mockResolvedValueOnce({ user });

      const ctx = await createRESTContext(makeOpts(headers));

      expect(ctx.user).toBe(user);
      expect(ctx.db).toEqual({ execute });
      expect(ctx.transport).toBe("rest");
      expect(ctx.requestId).toEqual(expect.any(String));
      expect(getSession).toHaveBeenCalledExactlyOnceWith({
        headers: ctx.headers,
      });
      getSession.mockResolvedValueOnce({ user });
      await expect(ctx.auth.api.getSession()).resolves.toEqual({ user });
      expect(getSession).toHaveBeenLastCalledWith({ headers: ctx.headers });
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it.each(["null session", "bare UNAUTHORIZED"])(
    "serves GET /api/v1/health unchanged and without warnings for %s",
    async (scenario) => {
      if (scenario === "null session") getSession.mockResolvedValueOnce(null);
      else getSession.mockRejectedValueOnce(new APIError("UNAUTHORIZED"));
      const router = createTRPCRouter({ health: healthRouter });
      const handler = createOpenApiNextHandler({
        router,
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
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          procedure: "health.health",
          transport: "rest",
          status: 200,
        }),
        "REST OK",
      );
    },
  );

  it("keeps anonymous callers out of protected procedures", async () => {
    getSession.mockRejectedValueOnce(new APIError("UNAUTHORIZED"));
    const ctx = await createRESTContext(makeOpts());
    const resolve = vi.fn(() => "private data");
    const router = createTRPCRouter({
      private: protectedProcedure.query(resolve),
    });

    await expect(router.createCaller(ctx).private()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
