import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Execute the actual callbacks without initializing React or the analytics SDK.
function callback<T>(path: string, name: string, scope: object): T {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) {
      matches.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1);
  const expression = matches[0];
  assert(expression && ts.isArrowFunction(expression));
  return runInNewContext(`(${expression.getText(source)})`, scope) as T;
}

const fetch = vi.fn(() => {
  throw new Error("Unexpected external request");
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("CI", undefined);
  vi.stubEnv("npm_lifecycle_event", "test");
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "synthetic-auth-secret-at-least-32-characters",
  );
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["test", "development", "production", undefined])(
  "preserves both callback-time mode reads after initialization with %j",
  async (initialMode) => {
    vi.stubEnv("NODE_ENV", initialMode);
    const environment = await import("./env");
    const scope = { ...environment, validatedEnv: environment.env, Error };
    const enabled = callback<
      (opts: { direction: "up" | "down"; result?: unknown }) => boolean
    >("./utils/api.ts", "enabled", scope);
    const loaded = callback<(posthog: { debug: () => void }) => void>(
      "./pages/_app.tsx",
      "loaded",
      scope,
    );

    for (const mode of [
      "development",
      "production",
      "test",
      undefined,
      "",
      "development",
      "production",
    ]) {
      vi.stubEnv("NODE_ENV", mode);
      const development = mode === "development";
      expect(enabled({ direction: "up" })).toBe(development);
      expect(enabled({ direction: "up", result: new Error("synthetic") })).toBe(
        development,
      );
      expect(enabled({ direction: "down", result: {} })).toBe(development);
      expect(
        enabled({ direction: "down", result: new Error("synthetic") }),
      ).toBe(true);
      const debug = vi.fn();
      loaded({ debug });
      expect(debug).toHaveBeenCalledTimes(development ? 1 : 0);
      expect(environment.env.NODE_ENV).toBe(initialMode ?? "development");
    }
  },
);
