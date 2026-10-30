import { beforeEach, describe, expect, it, vi } from "vitest";

import { get } from "@kan/db/repository/github-sync.repo";
import { getProviderForUser } from "@kan/db/repository/integration.repo";
import { getByPublicId } from "@kan/db/repository/workspace.repo";

import { assertPermission } from "./permissions";
import { assertSyncScope } from "./sync-scope";

vi.mock("@kan/db/repository/github-sync.repo", () => ({ get: vi.fn() }));
vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/integration.repo", () => ({
  getProviderForUser: vi.fn(),
}));
vi.mock("./permissions", () => ({ assertPermission: vi.fn() }));
const board = {
  id: 2,
  workspaceId: 1,
  name: "GitHub: ClockworkDigital/test",
  visibility: "private",
  deletedAt: null,
};
const db = {
  query: {
    cards: { findFirst: vi.fn() },
    lists: { findFirst: vi.fn() },
    boards: { findFirst: vi.fn() },
    labels: { findFirst: vi.fn(), findMany: vi.fn() },
  },
};
const check = (path: string, input: unknown = {}) =>
  assertSyncScope(db as never, "owner", "workspace123", path, input);
describe("background sync scope", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getByPublicId).mockResolvedValue({ id: 1 } as never);
    vi.mocked(get).mockResolvedValue({
      userId: "owner",
      enabled: true,
      repositories: ["ClockworkDigital/test"],
    } as never);
    vi.mocked(getProviderForUser).mockResolvedValue({
      accessToken: "encrypted",
    } as never);
    db.query.cards.findFirst.mockResolvedValue({
      deletedAt: null,
      list: { deletedAt: null, board },
    });
    db.query.lists.findFirst.mockResolvedValue({ deletedAt: null, board });
    db.query.boards.findFirst.mockResolvedValue(board);
    db.query.labels.findFirst.mockResolvedValue({ deletedAt: null, board });
    db.query.labels.findMany.mockResolvedValue([
      { publicId: "label1234567", boardId: board.id, deletedAt: null },
    ]);
  });
  it("allows selected issue requests and card updates", async () => {
    await check("githubSync.request", {
      workspacePublicId: "workspace123",
      path: "repos/ClockworkDigital/test/issues/1",
      changes: { title: "edit" },
    });
    await check("card.update", {
      cardPublicId: "card12345678",
      title: "edit",
      listPublicId: "list12345678",
    });
  });
  it.each([
    "githubSync.save",
    "githubSync.setTopics",
    "integration.providers",
    "integration.saveGitHubToken",
    "user.update",
    "card.delete",
    "board.update",
    "workspace.all",
    "label.delete",
    "label.byPublicId",
    "factory.publish",
    "factory.list",
    "factory.byId",
    "portfolio.list",
    "portfolio.byBoardId",
    "portfolio.update",
    "portfolio.remove",
  ])("denies %s", async (path) => {
    await expect(check(path)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("denies other workspaces, repositories and mutation fields", async () => {
    await expect(
      check("board.all", { workspacePublicId: "another12345" }),
    ).rejects.toThrow();
    await expect(
      check("githubSync.request", {
        workspacePublicId: "workspace123",
        path: "repos/ClockworkDigital/other/issues/1",
      }),
    ).rejects.toThrow();
    await expect(
      check("card.update", { cardPublicId: "card12345678", dueDate: null }),
    ).rejects.toThrow();
    db.query.lists.findFirst.mockResolvedValue({
      deletedAt: null,
      board: { ...board, id: 3 },
    });
    await expect(
      check("card.update", {
        cardPublicId: "card12345678",
        listPublicId: "list12345678",
      }),
    ).rejects.toThrow();
    db.query.boards.findFirst.mockResolvedValue({ ...board, workspaceId: 9 });
    await expect(
      check("board.byId", { boardPublicId: "board1234567" }),
    ).rejects.toThrow();
  });
  it("checks current permission, pause, owner and disconnection", async () => {
    vi.mocked(assertPermission).mockRejectedValueOnce(new Error("revoked"));
    await expect(check("user.getUser")).rejects.toThrow();
    vi.mocked(get).mockResolvedValueOnce({
      userId: "other",
      enabled: true,
    } as never);
    await expect(check("user.getUser")).rejects.toThrow();
    vi.mocked(get).mockResolvedValueOnce({
      userId: "owner",
      enabled: false,
    } as never);
    await expect(check("user.getUser")).rejects.toThrow();
    vi.mocked(getProviderForUser).mockResolvedValue(undefined);
    await expect(
      check("card.byId", { cardPublicId: "card12345678" }),
    ).rejects.toThrow();
  });
  it("allows status polling while paused, but only for the delegated workspace", async () => {
    vi.mocked(get).mockResolvedValue({
      userId: "owner",
      enabled: false,
    } as never);
    await check("githubSync.settings", { workspacePublicId: "workspace123" });
    await expect(
      check("githubSync.settings", { workspacePublicId: "other1234567" }),
    ).rejects.toThrow();
  });

  it("allows selected repository label reads but denies writes and other paths", async () => {
    const input = {
      workspacePublicId: "workspace123",
      path: "repos/ClockworkDigital/test/labels?per_page=100",
    };
    await check("githubSync.request", input);
    for (const path of [
      "repos/ClockworkDigital/other/labels?per_page=100",
      "repos/Other/test/labels?per_page=100",
      "repos/ClockworkDigital/test/labels/bug",
      "repos/ClockworkDigital/test/labels?per_page=100&extra=1",
      "repos/ClockworkDigital/../labels?per_page=100",
    ])
      await expect(
        check("githubSync.request", { ...input, path }),
      ).rejects.toThrow();
    await expect(
      check("githubSync.request", { ...input, changes: { title: "edit" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      check("githubSync.request", {
        ...input,
        workspacePublicId: "other1234567",
      }),
    ).rejects.toThrow();
  });

  const labelInputs = {
    "label.create": { boardPublicId: "board1234567" },
    "label.update": { labelPublicId: "label1234567" },
    "card.addOrRemoveLabel": {
      cardPublicId: "card12345678",
      labelPublicId: "label1234567",
    },
  };
  it.each(Object.entries(labelInputs))(
    "allows %s only in the delegated private board",
    async (path, input) => {
      await check(path, input);
      if (path !== "card.addOrRemoveLabel")
        expect(assertPermission).toHaveBeenCalledWith(
          db,
          "owner",
          1,
          "board:edit",
        );
      for (const invalid of [
        { ...board, workspaceId: 9 },
        { ...board, name: "Kan-only board" },
        { ...board, name: "GitHub: ClockworkDigital/other" },
        { ...board, visibility: "public" },
        { ...board, deletedAt: new Date() },
      ]) {
        db.query.boards.findFirst.mockResolvedValue(invalid);
        db.query.labels.findFirst.mockResolvedValue({
          deletedAt: null,
          board: invalid,
        });
        db.query.cards.findFirst.mockResolvedValue({
          deletedAt: null,
          list: { deletedAt: null, board: invalid },
        });
        await expect(check(path, input)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      }
    },
  );

  it("requires board edit permission for label definitions", async () => {
    vi.mocked(assertPermission).mockImplementation(
      (_db, _user, _workspace, permission) =>
        permission === "board:edit"
          ? Promise.reject(new Error("Denied"))
          : Promise.resolve(),
    );
    for (const path of ["label.create", "label.update"] as const)
      await expect(check(path, labelInputs[path])).rejects.toThrow("Denied");
  });

  it("rejects missing and deleted labels or boards", async () => {
    db.query.boards.findFirst.mockResolvedValue(undefined);
    await expect(
      check("label.create", labelInputs["label.create"]),
    ).rejects.toThrow();
    for (const label of [undefined, { deletedAt: new Date(), board }]) {
      db.query.labels.findFirst.mockResolvedValue(label);
      await expect(
        check("label.update", labelInputs["label.update"]),
      ).rejects.toThrow();
    }
  });

  it.each(["card.create", "card.addOrRemoveLabel"])(
    "rejects foreign, deleted or missing labels during %s",
    async (path) => {
      const input =
        path === "card.create"
          ? { listPublicId: "list12345678", labelPublicIds: ["label1234567"] }
          : labelInputs["card.addOrRemoveLabel"];
      await check(path, input);
      for (const labels of [
        [],
        [{ publicId: "label1234567", boardId: 99, deletedAt: null }],
        [
          {
            publicId: "label1234567",
            boardId: board.id,
            deletedAt: new Date(),
          },
        ],
      ]) {
        db.query.labels.findMany.mockResolvedValue(labels);
        await expect(check(path, input)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      }
    },
  );

  it("lets the app installation stand in for the owner's GitHub connection", async () => {
    const request = {
      workspacePublicId: "workspace123",
      path: "repos/ClockworkDigital/test/issues/1",
    };
    vi.mocked(getProviderForUser).mockResolvedValue(undefined);
    await expect(check("githubSync.request", request)).rejects.toThrow();
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv-test");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "a2V5");
    await expect(check("githubSync.request", request)).resolves.toBeUndefined();
    vi.mocked(get).mockResolvedValueOnce({
      userId: "other",
      enabled: true,
    } as never);
    await expect(check("githubSync.request", request)).rejects.toThrow();
    vi.unstubAllEnvs();
  });

  it.each(Object.entries(labelInputs))(
    "retains owner, pause, provider and permission checks for %s",
    async (path, input) => {
      vi.mocked(assertPermission).mockRejectedValueOnce(new Error("revoked"));
      await expect(check(path, input)).rejects.toThrow();
      vi.mocked(get).mockResolvedValueOnce({
        userId: "other",
        enabled: true,
      } as never);
      await expect(check(path, input)).rejects.toThrow();
      vi.mocked(get).mockResolvedValueOnce({
        userId: "owner",
        enabled: false,
      } as never);
      await expect(check(path, input)).rejects.toThrow();
      vi.mocked(getProviderForUser).mockResolvedValueOnce(undefined);
      await expect(check(path, input)).rejects.toThrow();
      await expect(
        assertSyncScope(db as never, undefined, "workspace123", path, input),
      ).rejects.toThrow();
    },
  );
});
