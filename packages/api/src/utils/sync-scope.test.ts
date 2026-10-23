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
});
