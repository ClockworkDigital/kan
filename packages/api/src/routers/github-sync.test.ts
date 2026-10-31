import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as settings from "@kan/db/repository/github-sync.repo";
import { getProviderForUser } from "@kan/db/repository/integration.repo";
import { getByPublicId } from "@kan/db/repository/workspace.repo";

import { createTRPCRouter } from "../trpc";
import {
  githubInstallationAccess,
  githubInstallationConfigured,
} from "../utils/github-installation";
import { assertPermission } from "../utils/permissions";
import { githubSyncInput, githubSyncRouter } from "./github-sync";

vi.mock("@kan/db/repository/github-sync.repo", () => ({
  get: vi.fn(),
  save: vi.fn(),
  report: vi.fn(),
}));
vi.mock("@kan/db/repository/integration.repo", () => ({
  getProviderForUser: vi.fn(),
}));
vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));
vi.mock("../utils/permissions", () => ({ assertPermission: vi.fn() }));
vi.mock("../utils/github-installation", () => ({
  githubInstallationConfigured: vi.fn(() => false),
  githubInstallationAccess: vi.fn(),
  githubInstallationToken: vi.fn(() => Promise.resolve("app-token")),
}));
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
    vi.mocked(settings.get).mockResolvedValue(undefined);
    vi.mocked(settings.save).mockResolvedValue(true);
    vi.mocked(getByPublicId).mockResolvedValue({ id: 1 } as never);
    vi.mocked(getProviderForUser).mockResolvedValue({
      accessToken: "encrypted",
    } as never);
    vi.mocked(assertPermission).mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
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
  it("syncs as the GitHub App for the workspace's sync owner only", async () => {
    vi.mocked(githubInstallationConfigured).mockReturnValue(true);
    vi.mocked(settings.get).mockResolvedValue({ userId: "owner" } as never);
    vi.mocked(getProviderForUser).mockResolvedValue(undefined);
    expect(await caller.request(input)).toEqual({ id: 1 });
    const auth = (call: number) =>
      new Headers(vi.mocked(fetch).mock.calls[call]?.[1]?.headers).get(
        "Authorization",
      );
    expect(auth(0)).toBe("Bearer app-token");
    vi.mocked(settings.get).mockResolvedValue({ userId: "other" } as never);
    vi.mocked(getProviderForUser).mockResolvedValue({
      accessToken: "encrypted",
    } as never);
    await caller.request(input);
    expect(auth(1)).toBe("Bearer saved-user-token");
    vi.mocked(githubInstallationConfigured).mockReturnValue(false);
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
  it("paginates label reads with the saved token and never patches labels", async () => {
    const labels = {
      ...input,
      path: "repos/ClockworkDigital/formwork/labels?per_page=100",
      page: 2,
    };
    await caller.request(labels);
    const [url, options] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toEqual(
      new URL(
        "https://api.github.com/repos/ClockworkDigital/formwork/labels?per_page=100&page=2",
      ),
    );
    expect(options?.method).toBe("GET");
    expect(options?.body).toBeUndefined();
    expect(options?.redirect).toBe("error");
    expect(getProviderForUser).toHaveBeenCalledWith(db, "owner", "github");
    vi.mocked(fetch).mockClear();
    await expect(
      caller.request({ ...labels, page: 1, changes: { title: "write" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
    for (const path of [
      "repos/ClockworkDigital/formwork/labels/bug",
      "repos/ClockworkDigital/formwork/labels?per_page=100&extra=1",
      "repos/Other/formwork/labels?per_page=100",
      "repos/ClockworkDigital/../labels?per_page=100",
    ])
      expect(githubSyncInput.safeParse({ ...labels, path }).success).toBe(
        false,
      );
    expect(
      githubSyncInput.safeParse({ ...labels, changes: { labels: [] } }).success,
    ).toBe(false);
  });
  it("reads issue events for the factory label-actor check but never patches them", async () => {
    const events = {
      ...input,
      path: "repos/ClockworkDigital/formwork/issues/7/events?per_page=100",
      page: 2,
    };
    expect(githubSyncInput.safeParse(events).success).toBe(true);
    await expect(
      caller.request({ ...events, page: 1, changes: { title: "write" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    for (const path of [
      "repos/ClockworkDigital/formwork/issues/7/events",
      "repos/ClockworkDigital/formwork/issues/7/events?per_page=100&extra=1",
      "repos/ClockworkDigital/formwork/issues/7/timeline?per_page=100",
    ])
      expect(githubSyncInput.safeParse({ ...events, path }).success).toBe(
        false,
      );
  });
  it("enforces label scope through the delegated request middleware", async () => {
    vi.mocked(settings.get).mockResolvedValue({
      userId: "owner",
      enabled: true,
      repositories: ["ClockworkDigital/formwork"],
    } as never);
    const delegated = createTRPCRouter({
      githubSync: githubSyncRouter,
    }).createCaller({
      db,
      user: { id: "owner" },
      headers: new Headers({
        "x-formwork-sync-workspace": input.workspacePublicId,
      }),
    } as never);
    const labels = {
      ...input,
      path: "repos/ClockworkDigital/formwork/labels?per_page=100",
      page: 2,
    };
    await delegated.githubSync.request(labels);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toEqual(
      new URL(
        "https://api.github.com/repos/ClockworkDigital/formwork/labels?per_page=100&page=2",
      ),
    );
    vi.mocked(fetch).mockClear();
    await expect(
      delegated.githubSync.request({
        ...labels,
        path: "repos/ClockworkDigital/other/labels?per_page=100",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      delegated.githubSync.request({ ...labels, changes: { title: "write" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("repository selection", () => {
  afterEach(() => {
    vi.mocked(githubInstallationConfigured).mockReturnValue(false);
    vi.mocked(settings.get).mockResolvedValue(undefined);
  });

  it.each([true, false])(
    "uses installation Issues write permission (%s) without a push flag",
    async (issuesWrite) => {
      vi.clearAllMocks();
      vi.mocked(githubInstallationConfigured).mockReturnValue(true);
      vi.mocked(settings.get).mockResolvedValue({ userId: "owner" } as never);
      vi.mocked(githubInstallationAccess).mockResolvedValue({
        token: "app-token",
        expiresAt: Date.now() + 3600_000,
        issuesWrite,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              repositories: [
                {
                  full_name: "ClockworkDigital/test",
                  archived: false,
                  has_issues: true,
                },
              ],
            }),
        }),
      );
      expect(
        await caller.repositories({
          workspacePublicId: input.workspacePublicId,
        }),
      ).toEqual([
        { name: "ClockworkDigital/test", writable: issuesWrite, topics: [] },
      ]);
      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toEqual(
        new URL(
          "https://api.github.com/installation/repositories?per_page=100&page=1",
        ),
      );
      expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBe("GET");
      expect(getProviderForUser).not.toHaveBeenCalled();
      const saving = caller.save({
        workspacePublicId: input.workspacePublicId,
        repositories: ["ClockworkDigital/test"],
        enabled: true,
      });
      if (issuesWrite) {
        await expect(saving).resolves.toEqual({ success: true });
      } else {
        await expect(saving).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
    },
  );

  it("does not fall back to user permissions when installation lookup fails", async () => {
    vi.clearAllMocks();
    vi.mocked(githubInstallationConfigured).mockReturnValue(true);
    vi.mocked(settings.get).mockResolvedValue({ userId: "owner" } as never);
    vi.mocked(githubInstallationAccess).mockRejectedValue(
      new Error("Unavailable"),
    );
    await expect(
      caller.repositories({ workspacePublicId: input.workspacePublicId }),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    expect(fetch).not.toHaveBeenCalled();
    expect(getProviderForUser).not.toHaveBeenCalled();
  });

  it("rejects managing another owner's sync", async () => {
    vi.mocked(settings.get).mockResolvedValue({ userId: "other" } as never);
    await expect(
      caller.save({
        workspacePublicId: input.workspacePublicId,
        repositories: [],
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(settings.save).not.toHaveBeenCalled();
    vi.mocked(settings.get).mockResolvedValue(undefined);
  });
  it("requires write access when enabling, but allows pausing without GitHub", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              full_name: "ClockworkDigital/test",
              archived: false,
              has_issues: true,
              permissions: { push: false },
            },
          ]),
      }),
    );
    await expect(
      caller.save({
        workspacePublicId: input.workspacePublicId,
        repositories: ["ClockworkDigital/test"],
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller.save({
      workspacePublicId: input.workspacePublicId,
      repositories: ["ClockworkDigital/test"],
      enabled: false,
    });
    expect(settings.save).toHaveBeenLastCalledWith(
      db,
      1,
      "owner",
      ["ClockworkDigital/test"],
      false,
    );
  });
});

it("rejects GitHub issue state changes", () => {
  expect(
    githubSyncInput.safeParse({ ...input, changes: { state: "closed" } })
      .success,
  ).toBe(false);
  expect(
    githubSyncInput.safeParse({ ...input, changes: { state: "open" } }).success,
  ).toBe(false);
});

describe("issue submission requirements", () => {
  const issueDb = { query: { boards: { findFirst: vi.fn() } } };
  const submitter = githubSyncRouter.createCaller({
    db: issueDb,
    user: { id: "owner" },
    headers: new Headers(),
  } as never);
  beforeEach(() => {
    vi.clearAllMocks();
    issueDb.query.boards.findFirst.mockResolvedValue({
      workspaceId: 1,
      visibility: "private",
      name: "GitHub: ClockworkDigital/test",
    });
    vi.mocked(settings.get).mockResolvedValue({
      enabled: true,
      repositories: ["ClockworkDigital/test"],
    } as never);
    vi.mocked(assertPermission).mockResolvedValue(undefined);
    vi.mocked(getProviderForUser).mockResolvedValue({
      accessToken: "encrypted",
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            html_url: "https://github.com/ClockworkDigital/test/issues/1",
            topics: [],
          }),
      }),
    );
  });
  it("requires all bug fields, but only one feature answer", async () => {
    await expect(
      submitter.submitIssue({
        boardPublicId: "board1234567",
        kind: "bug",
        title: "Bug",
        answers: ["steps"],
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await submitter.submitIssue({
      boardPublicId: "board1234567",
      kind: "feature",
      title: "Feature",
      answers: ["Desired outcome"],
    });
    expect(getProviderForUser).toHaveBeenCalledWith(issueDb, "owner", "github");
    expect(
      JSON.parse(vi.mocked(fetch).mock.calls[1]?.[1]?.body as string),
    ).toEqual({
      title: "[Feature request] Feature",
      body: "### Desired outcome\n\nDesired outcome",
    });
  });
  it("requires Production details using GitHub classification, not the client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ topics: ["production"] }),
      }),
    );
    await expect(
      submitter.submitIssue({
        boardPublicId: "board1234567",
        kind: "feature",
        title: "Feature",
        answers: ["outcome"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects whitespace, missing permission and unselected boards before GitHub", async () => {
    await expect(
      submitter.submitIssue({
        boardPublicId: "board1234567",
        kind: "feature",
        title: "Feature",
        answers: [" "],
      }),
    ).rejects.toThrow();
    vi.mocked(assertPermission).mockRejectedValueOnce(new Error("Denied"));
    await expect(
      submitter.submitIssue({
        boardPublicId: "board1234567",
        kind: "feature",
        title: "Feature",
        answers: ["outcome"],
      }),
    ).rejects.toThrow();
    vi.mocked(settings.get).mockResolvedValue({
      enabled: true,
      repositories: [],
    } as never);
    await expect(
      submitter.submitIssue({
        boardPublicId: "board1234567",
        kind: "feature",
        title: "Feature",
        answers: ["outcome"],
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("repository topics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getByPublicId).mockResolvedValue({ id: 1 } as never);
    vi.mocked(settings.get).mockResolvedValue(undefined);
    vi.mocked(assertPermission).mockResolvedValue(undefined);
    vi.mocked(getProviderForUser).mockResolvedValue({
      accessToken: "encrypted",
    } as never);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                full_name: "ClockworkDigital/test",
                archived: false,
                has_issues: true,
                topics: ["existing"],
              },
            ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ names: ["existing", "internal-tool"] }),
        }),
    );
  });
  const topicsInput = {
    workspacePublicId: "workspace123",
    repository: "ClockworkDigital/test",
    expectedNames: ["existing"],
    names: ["existing", "internal-tool"],
  };
  it("writes the full topic selection using the owner's token", async () => {
    expect(await caller.setTopics(topicsInput)).toEqual({
      names: topicsInput.names,
    });
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(getProviderForUser).toHaveBeenLastCalledWith(db, "owner", "github");
  });
  it("rejects stale edits before writing", async () => {
    await expect(
      caller.setTopics({ ...topicsInput, expectedNames: [] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid names and checks current workspace permission", async () => {
    await expect(
      caller.setTopics({ ...topicsInput, names: ["Invalid Topic"] }),
    ).rejects.toThrow();
    vi.mocked(assertPermission).mockRejectedValue(new Error("Denied"));
    await expect(caller.setTopics(topicsInput)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("accepts the organisation defaults repository without permitting path traversal", () => {
  expect(
    githubSyncInput.safeParse({
      workspacePublicId: "workspace123",
      path: "repos/ClockworkDigital/.github/issues?state=open&per_page=100",
    }).success,
  ).toBe(true);
  expect(
    githubSyncInput.safeParse({
      workspacePublicId: "workspace123",
      path: "repos/ClockworkDigital/../issues/1",
    }).success,
  ).toBe(false);
});
