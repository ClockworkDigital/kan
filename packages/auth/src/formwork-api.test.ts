import { describe, expect, it } from "vitest";

import { readFormworkApiGrant } from "./formwork-api";

const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const groupId = "10000000-0000-4000-8000-000000000005";
const issuedAt = Math.floor(Date.now() / 1000);
const metadata = {
  purpose: "formwork-kan-mcp",
  tenantId,
  userId,
  groups: [groupId],
  accountType: "0",
  issuedAt,
  targetHost: "kan.example.test",
};
const key = {
  userId,
  metadata,
  expiresAt: new Date((issuedAt + 28_800) * 1000),
};

describe("Formwork MCP credential binding", () => {
  it("resolves a bounded credential for the exact tenant, owner and tool", () => {
    expect(readFormworkApiGrant(key, tenantId, "kan.example.test").userId).toBe(
      userId,
    );
  });
  it.each([
    { ...key, userId: groupId },
    { ...key, expiresAt: null },
    { ...key, expiresAt: new Date(Date.now() - 1000) },
    { ...key, expiresAt: new Date((issuedAt + 28_803) * 1000) },
    { ...key, metadata: null },
    { ...key, metadata: { ...metadata, purpose: "other" } },
    { ...key, metadata: { ...metadata, accountType: "1" } },
    { ...key, metadata: { ...metadata, groups: ["everyone"] } },
    { ...key, metadata: { ...metadata, groups: [] } },
    { ...key, metadata: { ...metadata, groups: Array(201).fill(groupId) } },
    { ...key, metadata: { ...metadata, issuedAt: issuedAt - 28_800 } },
    { ...key, metadata: { ...metadata, issuedAt: issuedAt + 120 } },
  ])("rejects malformed, substituted or expired grants", (invalid) => {
    expect(() =>
      readFormworkApiGrant(invalid, tenantId, "kan.example.test"),
    ).toThrow();
  });
  it("rejects reuse on another tenant or tool", () => {
    expect(() =>
      readFormworkApiGrant(key, groupId, "kan.example.test"),
    ).toThrow();
    expect(() =>
      readFormworkApiGrant(key, tenantId, "other.example.test"),
    ).toThrow();
  });
});
