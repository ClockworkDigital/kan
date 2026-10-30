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
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url.endsWith("/issues/49/labels")
              ? [{ name: "factory" }]
              : { state: "open", labels: [] },
          ),
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
const response = (status: number, body: unknown = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;
const openIssue = () =>
  response(200, { state: "open", labels: [{ name: "bug" }] });

it("creates a missing repository label before enqueueing, preserving other labels", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(openIssue())
    .mockResolvedValueOnce(response(404))
    .mockResolvedValueOnce(response(201));
  expect(await caller().sendToFactory(input)).toBe(true);
  expect(
    vi.mocked(fetch).mock.calls.map(([url, options]) => [url, options?.method]),
  ).toEqual([
    ["https://api.github.com/repos/clockworkdigital/kan/issues/49", "GET"],
    ["https://api.github.com/repos/clockworkdigital/kan/labels/factory", "GET"],
    ["https://api.github.com/repos/clockworkdigital/kan/labels", "POST"],
    [
      "https://api.github.com/repos/clockworkdigital/kan/issues/49/labels",
      "POST",
    ],
  ]);
  expect(vi.mocked(fetch).mock.calls[2]?.[1]?.body).toBe(
    JSON.stringify({
      name: "factory",
      color: "5319E7",
      description: "In the factory queue or being worked on",
    }),
  );
  expect(vi.mocked(fetch).mock.calls[3]?.[1]?.body).toBe(
    '{"labels":["factory"]}',
  );
});

it("only reads issue eligibility and does not require a pre-existing label", async () => {
  expect(await caller().canSendToFactory(input)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("handles concurrent label creation by verifying the label exists", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(openIssue())
    .mockResolvedValueOnce(response(404))
    .mockResolvedValueOnce(response(422))
    .mockResolvedValueOnce(response(200));
  expect(await caller().sendToFactory(input)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it.each([403, 429, 500])(
  "does not create or apply labels after a lookup failure (%s)",
  async (status) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(openIssue())
      .mockResolvedValueOnce(response(status));
    await expect(caller().sendToFactory(input)).rejects.toMatchObject({
      code: "BAD_GATEWAY",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it.each([403, 500])(
  "does not enqueue after label creation fails (%s)",
  async (status) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(openIssue())
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(status));
    await expect(caller().sendToFactory(input)).rejects.toMatchObject({
      code: "BAD_GATEWAY",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it("does not swallow an unrelated label validation error", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(openIssue())
    .mockResolvedValueOnce(response(404))
    .mockResolvedValueOnce(response(422))
    .mockResolvedValueOnce(response(404));
  await expect(caller().sendToFactory(input)).rejects.toMatchObject({
    code: "BAD_GATEWAY",
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("does not report success if GitHub omits the applied label", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(openIssue())
    .mockResolvedValueOnce(response(200))
    .mockResolvedValueOnce(response(200, [{ name: "bug" }]));
  await expect(caller().sendToFactory(input)).rejects.toThrow(
    "did not add the factory label",
  );
});
