import { beforeEach, describe, expect, it, vi } from "vitest";

import { getProviderForUser } from "@kan/db/repository/integration.repo";
import { getByPublicId } from "@kan/db/repository/workspace.repo";

import { assertPermission } from "../utils/permissions";
import { githubSyncInput, githubSyncRouter } from "./github-sync";

vi.mock("@kan/db/repository/integration.repo", () => ({
  getProviderForUser: vi.fn(),
}));
vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));
vi.mock("../utils/permissions", () => ({ assertPermission: vi.fn() }));
vi.mock("../utils/encryption", () => ({
  decryptToken: vi.fn(() => "saved-user-token"),
}));

const input = {
  workspacePublicId: "workspace123",
  path: "repos/ClockworkDigital/formwork/issues/1",
};
const db = {};
const caller = githubSyncRouter.createCaller({
  db,
  user: { id: "owner" },
  headers: new Headers(),
} as never);
describe("saved GitHub token for sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getByPublicId).mockResolvedValue({ id: 1 } as never);
    vi.mocked(getProviderForUser).mockResolvedValue({
      accessToken: "encrypted",
    } as never);
    vi.mocked(assertPermission).mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id: 1 }),
        }),
    );
  });
  it("uses only the authenticated user's integration", async () => {
    expect(await caller.request(input)).toEqual({ id: 1 });
    expect(getProviderForUser).toHaveBeenCalledWith(db, "owner", "github");
    const options = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      "Bearer saved-user-token",
    );
    expect(options?.redirect).toBe("error");
  });
  it("fails closed when disconnected", async () => {
    vi.mocked(getProviderForUser).mockResolvedValue(undefined);
    await expect(caller.request(input)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks workspace permissions before reading the token", async () => {
    vi.mocked(assertPermission).mockRejectedValue(new Error("Denied"));
    await expect(caller.request(input)).rejects.toThrow();
    expect(getProviderForUser).not.toHaveBeenCalled();
  });
  it("restricts paths and write fields", async () => {
    for (const path of [
      "https://evil.test",
      "repos/ClockworkDigital/../issues/1",
      "repos/Other/private/issues/1",
      "user",
      "repos/ClockworkDigital/formwork/hooks",
    ])
      expect(githubSyncInput.safeParse({ ...input, path }).success).toBe(false);
    await expect(
      caller.request({
        ...input,
        path: "orgs/ClockworkDigital/repos?per_page=100",
        changes: { title: "x" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
