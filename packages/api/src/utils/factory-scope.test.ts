import { expect, it } from "vitest";

import { assertFactoryScope } from "./factory-scope";
import { assertSyncScope } from "./sync-scope";

it.each(["factory.publish", "factory.list", "factory.byId"])(
  "allows only delegated workspace for %s",
  (path) => {
    const input = { workspacePublicId: "workspace123" };
    expect(() =>
      assertFactoryScope("owner", "factory:workspace123", path, input),
    ).not.toThrow();
    for (const scope of ["workspace123", "factory:another12345", "factory:"]) {
      expect(() => assertFactoryScope("owner", scope, path, input)).toThrow();
    }
    expect(() =>
      assertFactoryScope(undefined, "factory:workspace123", path, input),
    ).toThrow();
  },
);
it.each([
  "card.create",
  "user.getUser",
  "githubSync.settings",
  "factory.delete",
  "workspace.all",
  "integration.providers",
])("denies %s", (path) => {
  expect(() =>
    assertFactoryScope("owner", "factory:workspace123", path, {
      workspacePublicId: "workspace123",
    }),
  ).toThrow();
});
it("never accepts factory scope as sync scope", async () => {
  await expect(
    assertSyncScope(
      {} as never,
      "owner",
      "factory:workspace123",
      "user.getUser",
      {},
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
