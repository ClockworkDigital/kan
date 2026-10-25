import assert from "node:assert/strict";
import type * as TRPCClient from "@trpc/client";
import type * as RuntimeEnv from "next-runtime-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("~/env", () => import("../env"));
vi.mock("@trpc/next", () => ({ createTRPCNext: vi.fn() }));
vi.mock("@trpc/client", async (importOriginal) => {
  const actual = await importOriginal<typeof TRPCClient>();
  return { ...actual, httpBatchLink: vi.fn(actual.httpBatchLink) };
});
vi.mock("next-runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeEnv>();
  return { ...actual, env: vi.fn(actual.env) };
});

const fetch = vi.fn(() => {
  throw new Error("Unexpected external request");
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("CI", undefined);
  vi.stubEnv("npm_lifecycle_event", "test");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "synthetic-auth-secret-at-least-32-characters",
  );
  vi.stubEnv("PORT", "3100");
  vi.stubEnv("VERCEL_URL", "initial.example.test");
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function loadConfiguration() {
  await import("./api");
  const { createTRPCNext } = await import("@trpc/next");
  const { httpBatchLink } = await import("@trpc/client");
  const options = vi.mocked(createTRPCNext).mock.calls[0]?.[0];
  assert(options);
  expect(options.ssr).toBe(false);
  return () => {
    options.config({});
    return vi.mocked(httpBatchLink).mock.lastCall?.[0].url;
  };
}

it.each([
  [undefined, undefined, "http://localhost:3000/api/trpc"],
  [undefined, "", "http://localhost:/api/trpc"],
  [undefined, "3200", "http://localhost:3200/api/trpc"],
  ["", undefined, "http://localhost:3000/api/trpc"],
  ["", "", "http://localhost:/api/trpc"],
  ["", "3200", "http://localhost:3200/api/trpc"],
  ["current.example.test", undefined, "https://current.example.test/api/trpc"],
  ["current.example.test", "", "https://current.example.test/api/trpc"],
  ["current.example.test", "3200", "https://current.example.test/api/trpc"],
])(
  "reads current VERCEL_URL=%j and PORT=%j when tRPC config runs",
  async (vercelUrl, port, expected) => {
    const configure = await loadConfiguration();
    const { env } = await import("../env");
    expect(env.PORT).toBe("3100");
    expect(env.VERCEL_URL).toBe("initial.example.test");

    vi.stubEnv("VERCEL_URL", vercelUrl);
    vi.stubEnv("PORT", port);
    expect(configure()).toBe(expected);
  },
);

it("rereads changes on successive tRPC configurations after initialization", async () => {
  vi.stubEnv("VERCEL_URL", undefined);
  const configure = await loadConfiguration();
  expect(configure()).toBe("http://localhost:3100/api/trpc");
  vi.stubEnv("PORT", "3200");
  expect(configure()).toBe("http://localhost:3200/api/trpc");
  vi.stubEnv("VERCEL_URL", "later.example.test");
  expect(configure()).toBe("https://later.example.test/api/trpc");
});

it.each([false, true])(
  "keeps the browser URL relative without runtime reads, browser at import=%j",
  async (browserAtImport) => {
    if (browserAtImport) vi.stubGlobal("window", {});
    const configure = await loadConfiguration();
    vi.stubGlobal("window", {});
    vi.stubEnv("PORT", "3200");
    vi.stubEnv("VERCEL_URL", "later.example.test");
    const { env } = await import("next-runtime-env");

    expect(configure()).toBe("/api/trpc");
    expect(env).not.toHaveBeenCalled();
  },
);
