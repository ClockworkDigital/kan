import { beforeEach, describe, expect, it, vi } from "vitest";

import * as cardRepo from "@kan/db/repository/card.repo";
import * as activityRepo from "@kan/db/repository/cardActivity.repo";
import * as settingsRepo from "@kan/db/repository/github-sync.repo";
import { getProviderForUser } from "@kan/db/repository/integration.repo";
import * as labelRepo from "@kan/db/repository/label.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import { createTRPCRouter } from "../trpc";
import { assertPermission } from "../utils/permissions";
import { cardRouter } from "./card";

vi.mock("@kan/db/repository/card.repo", () => ({
  create: vi.fn(),
  getWorkspaceAndCardIdByCardPublicId: vi.fn(),
  bulkCreateCardLabelRelationships: vi.fn(),
  getCardLabelRelationship: vi.fn(),
  createCardLabelRelationship: vi.fn(),
  hardDeleteCardLabelRelationship: vi.fn(),
}));
vi.mock("@kan/db/repository/cardActivity.repo", () => ({
  create: vi.fn(),
  bulkCreate: vi.fn(),
}));
vi.mock("@kan/db/repository/label.repo", () => ({
  getAllByPublicIds: vi.fn(),
  getByPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/list.repo", () => ({
  getWorkspaceAndListIdByListPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/github-sync.repo", () => ({ get: vi.fn() }));
vi.mock("@kan/db/repository/integration.repo", () => ({
  getProviderForUser: vi.fn(),
}));
vi.mock("../utils/permissions", () => ({
  assertPermission: vi.fn(),
}));
vi.mock("../utils/webhook", () => ({
  createCardWebhookPayload: vi.fn(),
  sendWebhooksForWorkspace: vi.fn().mockResolvedValue(undefined),
}));

const board = {
  id: 2,
  workspaceId: 1,
  publicId: "board0000001",
  name: "GitHub: ClockworkDigital/kan",
  visibility: "private",
  deletedAt: null,
};
const label = {
  id: 3,
  boardId: board.id,
  publicId: "label0000001",
  name: "GitHub label",
  colourCode: "#abcdef",
  deletedAt: null,
};
const db = {
  query: {
    cards: { findFirst: vi.fn() },
    lists: { findFirst: vi.fn() },
    labels: { findMany: vi.fn() },
  },
};
const createInput = {
  title: "Linked card",
  description: "",
  listPublicId: "list00000001",
  labelPublicIds: [label.publicId],
  memberPublicIds: [],
  position: "end" as const,
};
const toggleInput = {
  cardPublicId: "card00000001",
  labelPublicId: label.publicId,
};
const router = createTRPCRouter({ card: cardRouter });

describe.each([false, true])("card labels with delegation=%s", (delegated) => {
  const caller = router.createCaller({
    db,
    user: { id: "owner" },
    headers: new Headers(
      delegated ? { "x-formwork-sync-workspace": "workspace123" } : {},
    ),
  } as never).card;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertPermission).mockResolvedValue(undefined);
    vi.mocked(workspaceRepo.getByPublicId).mockResolvedValue({
      id: 1,
    } as never);
    vi.mocked(settingsRepo.get).mockResolvedValue({
      userId: "owner",
      enabled: true,
      repositories: ["ClockworkDigital/kan"],
    } as never);
    vi.mocked(getProviderForUser).mockResolvedValue({
      accessToken: "encrypted",
    } as never);
    db.query.cards.findFirst.mockResolvedValue({
      deletedAt: null,
      list: { deletedAt: null, board },
    });
    db.query.lists.findFirst.mockResolvedValue({ deletedAt: null, board });
    db.query.labels.findMany.mockResolvedValue([label]);
    vi.mocked(listRepo.getWorkspaceAndListIdByListPublicId).mockResolvedValue({
      id: 4,
      boardId: board.id,
      workspaceId: 1,
    } as never);
    vi.mocked(cardRepo.getWorkspaceAndCardIdByCardPublicId).mockResolvedValue({
      id: 5,
      boardId: board.id,
      workspaceId: 1,
    } as never);
    vi.mocked(labelRepo.getAllByPublicIds).mockResolvedValue([label]);
    vi.mocked(labelRepo.getByPublicId).mockResolvedValue(label);
    vi.mocked(cardRepo.create).mockResolvedValue({
      id: 5,
      publicId: toggleInput.cardPublicId,
    } as never);
    vi.mocked(cardRepo.bulkCreateCardLabelRelationships).mockResolvedValue([
      { cardId: 5, labelId: label.id },
    ] as never);
    vi.mocked(cardRepo.getCardLabelRelationship).mockResolvedValue(undefined);
    vi.mocked(cardRepo.createCardLabelRelationship).mockResolvedValue({
      cardId: 5,
      labelId: label.id,
    } as never);
    vi.mocked(cardRepo.hardDeleteCardLabelRelationship).mockResolvedValue({
      cardId: 5,
      labelId: label.id,
    } as never);
  });

  it("creates with labels and returns only a public ID, retaining label activity", async () => {
    expect(await caller.create(createInput)).toEqual({
      publicId: toggleInput.cardPublicId,
    });
    expect(cardRepo.bulkCreateCardLabelRelationships).toHaveBeenCalledWith(db, [
      { cardId: 5, labelId: label.id },
    ]);
    expect(activityRepo.bulkCreate).toHaveBeenCalledWith(db, [
      {
        type: "card.updated.label.added",
        cardId: 5,
        labelId: label.id,
        createdBy: "owner",
      },
    ]);
  });

  it("adds and removes labels with their existing activities", async () => {
    expect(await caller.addOrRemoveLabel(toggleInput)).toEqual({
      newLabel: true,
    });
    vi.mocked(cardRepo.getCardLabelRelationship).mockResolvedValue({
      cardId: 5,
      labelId: label.id,
    } as never);
    expect(await caller.addOrRemoveLabel(toggleInput)).toEqual({
      newLabel: false,
    });
    expect(
      vi
        .mocked(activityRepo.create)
        .mock.calls.map(([, activity]) => activity.type),
    ).toEqual(["card.updated.label.added", "card.updated.label.removed"]);
  });

  it.each(["missing", "deleted", "cross-board", "cross-workspace"])(
    "rejects %s labels before any mutation",
    async (kind) => {
      const invalid = { ...label, boardId: kind === "cross-board" ? 9 : 99 };
      const absent = kind === "missing" || kind === "deleted";
      db.query.labels.findMany.mockResolvedValue(absent ? [] : [invalid]);
      vi.mocked(labelRepo.getAllByPublicIds).mockResolvedValue(
        absent ? [] : [invalid],
      );
      vi.mocked(labelRepo.getByPublicId).mockResolvedValue(
        absent ? undefined : invalid,
      );
      const code = delegated ? "FORBIDDEN" : "NOT_FOUND";
      await expect(caller.create(createInput)).rejects.toMatchObject({ code });
      await expect(caller.addOrRemoveLabel(toggleInput)).rejects.toMatchObject({
        code,
      });
      expect(cardRepo.create).not.toHaveBeenCalled();
      expect(cardRepo.bulkCreateCardLabelRelationships).not.toHaveBeenCalled();
      expect(cardRepo.getCardLabelRelationship).not.toHaveBeenCalled();
      expect(activityRepo.create).not.toHaveBeenCalled();
      expect(activityRepo.bulkCreate).not.toHaveBeenCalled();
    },
  );

  it("rejects mixed valid and invalid initial labels before creating the card", async () => {
    await expect(
      caller.create({
        ...createInput,
        labelPublicIds: [label.publicId, "missing00001"],
      }),
    ).rejects.toMatchObject({ code: delegated ? "FORBIDDEN" : "NOT_FOUND" });
    expect(cardRepo.create).not.toHaveBeenCalled();
  });

  it("retains native permission checks", async () => {
    vi.mocked(assertPermission).mockRejectedValue(new Error("Revoked"));
    await expect(caller.create(createInput)).rejects.toThrow("Revoked");
    await expect(caller.addOrRemoveLabel(toggleInput)).rejects.toThrow(
      "Revoked",
    );
    expect(cardRepo.create).not.toHaveBeenCalled();
    expect(cardRepo.getCardLabelRelationship).not.toHaveBeenCalled();
  });

  if (delegated) {
    it("checks current owner, pause, and repository selection", async () => {
      for (const settings of [
        {
          userId: "other",
          enabled: true,
          repositories: ["ClockworkDigital/kan"],
        },
        {
          userId: "owner",
          enabled: false,
          repositories: ["ClockworkDigital/kan"],
        },
        { userId: "owner", enabled: true, repositories: [] },
      ]) {
        vi.mocked(settingsRepo.get).mockResolvedValue(settings as never);
        await expect(caller.create(createInput)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
        await expect(
          caller.addOrRemoveLabel(toggleInput),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(cardRepo.create).not.toHaveBeenCalled();
      expect(cardRepo.getCardLabelRelationship).not.toHaveBeenCalled();
    });

    it("rejects disconnected providers and inactive or unauthorized boards", async () => {
      vi.mocked(getProviderForUser).mockResolvedValueOnce(undefined);
      await expect(caller.create(createInput)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      vi.mocked(getProviderForUser).mockResolvedValueOnce(undefined);
      await expect(caller.addOrRemoveLabel(toggleInput)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      for (const invalid of [
        { ...board, workspaceId: 9 },
        { ...board, visibility: "public" },
        { ...board, deletedAt: new Date() },
        { ...board, name: "Kan-only board" },
      ]) {
        db.query.lists.findFirst.mockResolvedValue({
          deletedAt: null,
          board: invalid,
        });
        db.query.cards.findFirst.mockResolvedValue({
          deletedAt: null,
          list: { deletedAt: null, board: invalid },
        });
        await expect(caller.create(createInput)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
        await expect(
          caller.addOrRemoveLabel(toggleInput),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(cardRepo.create).not.toHaveBeenCalled();
      expect(cardRepo.getCardLabelRelationship).not.toHaveBeenCalled();
    });
  }
});
