import { beforeEach, expect, it, vi } from "vitest";

import * as cardRepo from "@kan/db/repository/card.repo";

import type * as syncScope from "../utils/sync-scope";
import { assertSyncScope } from "../utils/sync-scope";
import { cardRouter } from "./card";

vi.mock("@kan/db/repository/card.repo", () => ({
  getWorkspaceAndCardIdByCardPublicId: vi.fn(),
  getByPublicId: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../utils/permissions", () => ({
  assertCanEdit: vi.fn(),
  assertPermission: vi.fn(),
}));
vi.mock("../utils/webhook", () => ({
  createCardWebhookPayload: vi.fn(() => ({})),
  sendWebhooksForWorkspace: vi.fn(() => Promise.resolve()),
}));
vi.mock("../utils/sync-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof syncScope>()),
  assertSyncScope: vi.fn(),
}));

const link = {
  cardPublicId: "card00000001",
  githubRepository: "clockworkdigital/kan",
  githubIssueNumber: 49,
};
const caller = (headers: Record<string, string | undefined> = {}) =>
  cardRouter.createCaller({
    db: {},
    user: { id: "owner", email: "owner@example.test" },
    headers: new Headers(
      Object.entries(headers).filter((entry): entry is [string, string] =>
        Boolean(entry[1]),
      ),
    ),
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cardRepo.getWorkspaceAndCardIdByCardPublicId).mockResolvedValue({
    workspaceId: 1,
    listPublicId: "list00000001",
    listName: "Open",
    boardPublicId: "board0000001",
    boardName: "GitHub: ClockworkDigital/kan",
  } as never);
  vi.mocked(cardRepo.getByPublicId).mockResolvedValue({
    id: 1,
    title: "Card",
    description: null,
    dueDate: null,
    list: { publicId: "list00000001", name: "Open" },
  } as never);
  vi.mocked(cardRepo.update).mockResolvedValue({
    id: 1,
    publicId: link.cardPublicId,
    title: "Card",
    description: null,
    dueDate: null,
  });
});

it("lets the sync attach an issue link without other changes", async () => {
  await caller({ "x-formwork-sync-workspace": "workspace123" }).update(link);
  expect(assertSyncScope).toHaveBeenCalled();
  expect(cardRepo.update).toHaveBeenCalledWith(
    {},
    { githubRepository: "clockworkdigital/kan", githubIssueNumber: 49 },
    { cardPublicId: link.cardPublicId },
  );
});

it.each([{}, { "x-formwork-sync-workspace": "factory:workspace123" }])(
  "forbids other callers from linking cards: %o",
  async (headers) => {
    await expect(caller(headers).update(link)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(cardRepo.update).not.toHaveBeenCalled();
  },
);

it("rejects half a link", async () => {
  await expect(
    caller({ "x-formwork-sync-workspace": "workspace123" }).update({
      cardPublicId: link.cardPublicId,
      githubIssueNumber: 49,
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
