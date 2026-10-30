import { describe, expect, it } from "vitest";

import { readFormworkApiGrant } from "./formwork-api";
import {
  readFormworkFactoryGrant,
  readFormworkSyncGrant,
} from "./formwork-sync";

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

describe("factory delegation", () => {
  const factory = {
    ...key,
    metadata: { ...key.metadata, purpose: "formwork-kan-factory" },
  };
  it("accepts persistent factory grants and rejects cross-purpose use", () => {
    expect(
      readFormworkFactoryGrant(factory, tenantId, "kan.test").workspacePublicId,
    ).toBe("workspace123");
    expect(() =>
      readFormworkSyncGrant(factory, tenantId, "kan.test"),
    ).toThrow();
    expect(() => readFormworkFactoryGrant(key, tenantId, "kan.test")).toThrow();
    expect(() => readFormworkApiGrant(factory, tenantId, "kan.test")).toThrow();
  });
  it("rejects wrong owner, tenant, host and expired keys", () => {
    expect(() =>
      readFormworkFactoryGrant(
        { ...factory, userId: tenantId },
        tenantId,
        "kan.test",
      ),
    ).toThrow();
    expect(() =>
      readFormworkFactoryGrant(factory, userId, "kan.test"),
    ).toThrow();
    expect(() =>
      readFormworkFactoryGrant(factory, tenantId, "other.test"),
    ).toThrow();
    expect(() =>
      readFormworkFactoryGrant(
        { ...factory, expiresAt: new Date(0) },
        tenantId,
        "kan.test",
      ),
    ).toThrow();
  });
});
