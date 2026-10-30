import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getByPublicId } from "@kan/db/repository/card.repo";

import { cardRouter } from "./card";

vi.mock("@kan/db/repository/card.repo", () => ({
  getWorkspaceAndCardIdByCardPublicId: vi.fn(() =>
    Promise.resolve({ workspaceId: 1 }),
  ),
  getByPublicId: vi.fn(() =>
    Promise.resolve({
      githubRepository: "clockworkdigital/kan",
      githubIssueNumber: 49,
    }),
  ),
}));
vi.mock("../utils/permissions", () => ({ assertPermission: vi.fn() }));
vi.mock("../utils/github-installation", () => ({
  githubInstallationToken: vi.fn(() => Promise.resolve("app-token")),
}));

const input = { cardPublicId: "card00000001" };
const caller = (email = "owner@example.test") =>
  cardRouter.createCaller({
    db: {},
    user: { id: "owner", email },
    headers: new Headers(),
  } as never);
beforeEach(() => {
  vi.stubEnv("FACTORY_SENDER_EMAILS", " OWNER@example.test, ");
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ state: "open", labels: [] }),
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("allows the owner and posts the existing label with the App token", async () => {
  expect(await caller().sendToFactory(input)).toBe(true);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/clockworkdigital/kan/issues/49/labels",
    expect.objectContaining({
      method: "POST",
      body: '{"labels":["factory"]}',
      headers: expect.objectContaining({
        Authorization: "Bearer app-token",
      }) as Record<string, string>,
    }),
  );
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(1);
});
it.each(["other@example.test", ""])("denies non-owners: %s", async (email) => {
  await expect(caller(email).sendToFactory(input)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, ""])("denies when allowlist is %s", async (value) => {
  vi.stubEnv("FACTORY_SENDER_EMAILS", value);
  await expect(caller().sendToFactory(input)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
it.each([
  { githubRepository: null, githubIssueNumber: null },
  { githubRepository: "other/kan", githubIssueNumber: 49 },
])("rejects unlinked or non-Clockwork cards", async (link) => {
  vi.mocked(getByPublicId).mockResolvedValueOnce({
    // A description link alone is not identity.
    description:
      '<p><a href="https://github.com/ClockworkDigital/kan/issues/49">GitHub issue #49</a></p><hr>',
    ...link,
  } as never);
  await expect(caller().sendToFactory(input)).rejects.toThrow("not linked");
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects closed issues", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ state: "closed", labels: [] }),
  } as Response);
  await expect(caller().sendToFactory(input)).rejects.toThrow("Only open");
});
it("does not write an already queued issue", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({ state: "open", labels: [{ name: "factory" }] }),
  } as Response);
  await caller().sendToFactory(input);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("hides the action from other users without fetching GitHub", async () => {
  expect(await caller("other@example.test").canSendToFactory(input)).toBe(
    false,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("hides the action for closed issues", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ state: "closed", labels: [] }),
  } as Response);
  expect(await caller().canSendToFactory(input)).toBe(false);
});
it("never posts when the factory label does not exist", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ state: "open", labels: [] }),
  } as Response);
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
  await expect(caller().sendToFactory(input)).rejects.toMatchObject({
    code: "BAD_GATEWAY",
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([, options]) => options?.method === "GET"),
  ).toBe(true);
});
