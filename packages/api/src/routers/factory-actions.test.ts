import { beforeEach, expect, it, vi } from "vitest";

import * as factoryRepo from "@kan/db/repository/factory.repo";
import { getProviderForUser } from "@kan/db/repository/integration.repo";

import { assertUserInWorkspace } from "../utils/auth";
import { assertPermission } from "../utils/permissions";
import { factoryRouter } from "./factory";

vi.mock("@kan/db/repository/factory.repo", () => ({ get: vi.fn() }));
vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(() => ({ id: 1 })),
}));
vi.mock("@kan/db/repository/integration.repo", () => ({
  getProviderForUser: vi.fn(),
}));
vi.mock("../utils/auth", () => ({ assertUserInWorkspace: vi.fn() }));
vi.mock("../utils/permissions", () => ({ assertPermission: vi.fn() }));
vi.mock("../utils/encryption", () => ({ decryptToken: () => "user-token" }));
const input = {
  workspacePublicId: "workspace123",
  jobPublicId: "factory12345",
};
const sha = "a".repeat(40);
const pull = {
  title: "PR",
  body: "Details",
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: "clean",
  head: { sha },
  base: { ref: "main" },
};
const caller = (headers = new Headers()) =>
  factoryRouter.createCaller({
    db: {},
    user: { id: "user" },
    headers,
  } as never);
const response = (value: unknown) =>
  ({ ok: true, json: () => Promise.resolve(value) }) as Response;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(factoryRepo.get).mockResolvedValue({
    repository: "ClockworkDigital/kan",
    snapshot: { issueNumber: 52, prNumber: 58 },
  } as never);
  vi.mocked(getProviderForUser).mockResolvedValue({
    accessToken: "encrypted",
  } as never);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({})));
});
it("posts feedback as the current user to the stored issue", async () => {
  await caller().reply({ ...input, body: "More context" });
  expect(getProviderForUser).toHaveBeenCalledWith({}, "user", "github");
  expect(assertPermission).toHaveBeenCalledWith(
    {},
    "user",
    1,
    "workspace:manage",
  );
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/ClockworkDigital/kan/issues/52/comments",
    expect.objectContaining({
      method: "POST",
      body: '{"body":"More context"}',
      headers: expect.objectContaining({
        Authorization: "Bearer user-token",
      }) as Record<string, string>,
    }),
  );
});
it("merges only the reviewed SHA", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(pull))
    .mockResolvedValueOnce(response({ merged: true }));
  expect(
    await caller().merge({ ...input, headSha: sha, method: "squash" }),
  ).toBe(true);
  expect(fetch).toHaveBeenLastCalledWith(
    "https://api.github.com/repos/ClockworkDigital/kan/pulls/58/merge",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ sha, merge_method: "squash" }),
    }),
  );
});
it.each([
  { head: { sha: "b".repeat(40) } },
  { draft: true },
  { state: "closed" },
  { mergeable: null },
  { mergeable_state: "blocked" },
])("rejects unsafe or changed PR: %j", async (change) => {
  vi.mocked(fetch).mockResolvedValueOnce(response({ ...pull, ...change }));
  await expect(
    caller().merge({ ...input, headSha: sha, method: "merge" }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("does not access GitHub for cross-workspace callers", async () => {
  vi.mocked(assertUserInWorkspace).mockRejectedValueOnce(
    new Error("Not a member"),
  );
  await expect(caller().github(input)).rejects.toThrow("Not a member");
  expect(fetch).not.toHaveBeenCalled();
});
it("does not act without manage permission", async () => {
  vi.mocked(assertPermission).mockRejectedValueOnce(new Error("Denied"));
  await expect(caller().reply({ ...input, body: "Reply" })).rejects.toThrow(
    "Denied",
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("requires a current personal GitHub connection", async () => {
  vi.mocked(getProviderForUser).mockResolvedValueOnce(undefined);
  await expect(caller().github(input)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("does not report an unsuccessful GitHub merge as success", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(pull))
    .mockResolvedValueOnce(response({ merged: false }));
  await expect(
    caller().merge({ ...input, headSha: sha, method: "merge" }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

it("returns issue and PR context without upstream internal IDs", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      response({ id: 1, title: "Issue", body: "Question", state: "open" }),
    )
    .mockResolvedValueOnce(
      response([
        {
          id: 2,
          body: "Details?",
          user: { login: "agent", id: 3 },
          created_at: "2026-10-30T12:00:00Z",
        },
      ]),
    )
    .mockResolvedValueOnce(response({ ...pull, id: 4 }))
    .mockResolvedValueOnce(response([]))
    .mockResolvedValueOnce(
      response([{ filename: "test.ts", status: "modified", patch: "+change" }]),
    )
    .mockResolvedValueOnce(
      response([
        {
          id: 99,
          body: "Handle this case",
          user: { login: "reviewer" },
          created_at: "2026-10-30T12:00:00Z",
          path: "test.ts",
          line: null,
          original_line: 12,
        },
      ]),
    );
  const result = await caller().github(input);
  expect(result.issue).toEqual({
    title: "Issue",
    body: "Question",
    state: "open",
  });
  expect(result.comments[0]?.user).toEqual({ login: "agent" });
  expect(result.pull).not.toHaveProperty("id");
  expect(result.files[0]?.patch).toBe("+change");
  expect(result.reviewComments[0]).toEqual({
    body: "Handle this case",
    user: { login: "reviewer" },
    created_at: "2026-10-30T12:00:00Z",
    path: "test.ts",
    line: null,
    original_line: 12,
  });
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/ClockworkDigital/kan/pulls/58/comments?per_page=100",
    expect.anything(),
  );
});
it("does not access another workspace's missing job", async () => {
  vi.mocked(factoryRepo.get).mockResolvedValueOnce(undefined);
  await expect(caller().github(input)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(fetch).not.toHaveBeenCalled();
});
