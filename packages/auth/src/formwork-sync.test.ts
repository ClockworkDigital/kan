import { describe, expect, it } from "vitest";

import { readFormworkApiGrant } from "./formwork-api";
import { readFormworkSyncGrant } from "./formwork-sync";

const userId = "10000000-0000-4000-8000-000000000001";
const tenantId = "10000000-0000-4000-8000-000000000002";
const key = {
  userId,
  expiresAt: null,
  metadata: {
    purpose: "formwork-kan-github-sync",
    userId,
    tenantId,
    targetHost: "kan.test",
    workspacePublicId: "workspace123",
    groups: [tenantId],
    accountType: "0",
  },
};
describe("background delegation", () => {
  it("accepts explicit persistent delegation without extending MCP", () => {
    expect(
      readFormworkSyncGrant(key, tenantId, "kan.test").workspacePublicId,
    ).toBe("workspace123");
    expect(() => readFormworkApiGrant(key, tenantId, "kan.test")).toThrow();
  });
  it("rejects wrong identity, host, tenant, scope and expiration", () => {
    for (const bad of [
      { ...key, userId: tenantId },
      { ...key, expiresAt: new Date(0) },
      { ...key, metadata: { ...key.metadata, workspacePublicId: "" } },
      { ...key, metadata: { ...key.metadata, purpose: "formwork-kan-mcp" } },
    ])
      expect(() => readFormworkSyncGrant(bad, tenantId, "kan.test")).toThrow();
    expect(() => readFormworkSyncGrant(key, userId, "kan.test")).toThrow();
    expect(() => readFormworkSyncGrant(key, tenantId, "other.test")).toThrow();
  });
});
