import type { NextApiRequest, NextApiResponse } from "next";
import { expect, it, vi } from "vitest";

import handler from "../pages/api/internal/formwork-token";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@kan/auth/server", async () => {
  const sync = await import("../../../../packages/auth/src/formwork-sync");
  const api = await import("../../../../packages/auth/src/formwork-api");
  return {
    ...sync,
    ...api,
    initFormworkApiAuth: () => ({ api: { verifyApiKey: verify } }),
  };
});
vi.mock("@kan/db/client", () => ({ createDrizzleClient: vi.fn() }));
vi.mock("~/env", () => ({
  env: {
    FORMWORK_TENANT_ID: "10000000-0000-4000-8000-000000000002",
    NEXT_PUBLIC_BASE_URL: "https://kan.test",
  },
}));

const tenantId = "10000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000001";
async function call() {
  const res = { setHeader: vi.fn(), status: vi.fn(), end: vi.fn() };
  res.status.mockReturnValue(res);
  await handler(
    {
      method: "GET",
      headers: { authorization: `Bearer ${"a".repeat(40)}` },
    } as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}
it.each([
  "formwork-kan-factory",
  "formwork-kan-github-sync",
  "formwork-kan-mcp",
])("sets scope only for persistent purpose %s", async (purpose) => {
  const issuedAt = Math.floor(Date.now() / 1000);
  verify.mockResolvedValue({
    valid: true,
    key: {
      userId,
      expiresAt:
        purpose === "formwork-kan-mcp"
          ? new Date((issuedAt + 3600) * 1000)
          : null,
      metadata: {
        purpose,
        tenantId,
        userId,
        targetHost: "kan.test",
        groups: [tenantId],
        accountType: "0",
        workspacePublicId: "workspace123",
        issuedAt: purpose === "formwork-kan-mcp" ? issuedAt : issuedAt - 86400,
      },
    },
  });
  const res = await call();
  expect(res.status).toHaveBeenCalledWith(204);
  if (purpose === "formwork-kan-mcp")
    expect(
      res.setHeader.mock.calls.some(
        ([name]) => name === "X-Formwork-Sync-Workspace",
      ),
    ).toBe(false);
  else
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-Formwork-Sync-Workspace",
      purpose === "formwork-kan-factory"
        ? "factory:workspace123"
        : "workspace123",
    );
});
it("rejects disabled credentials before emitting identity", async () => {
  verify.mockResolvedValue({
    valid: false,
    key: null,
    error: { code: "KEY_DISABLED" },
  });
  const res = await call();
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.setHeader).toHaveBeenCalledTimes(1);
});
