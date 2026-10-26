import { beforeEach, expect, it, vi } from "vitest";

import * as boardRepo from "@kan/db/repository/board.repo";
import * as settingsRepo from "@kan/db/repository/github-sync.repo";
import { getProviderForUser } from "@kan/db/repository/integration.repo";
import * as labelRepo from "@kan/db/repository/label.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import { createTRPCRouter } from "../trpc";
import { assertPermission } from "../utils/permissions";
import { labelRouter } from "./label";

vi.mock("@kan/db/repository/board.repo", () => ({
  getWorkspaceAndBoardIdByBoardPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/label.repo", () => ({
  create: vi.fn(),
  update: vi.fn(),
  getWorkspaceAndLabelIdByLabelPublicId: vi.fn(),
}));
vi.mock("../utils/permissions", () => ({ assertPermission: vi.fn() }));
vi.mock("@kan/db/repository/github-sync.repo", () => ({ get: vi.fn() }));
vi.mock("@kan/db/repository/integration.repo", () => ({
  getProviderForUser: vi.fn(),
}));
vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));

const caller = labelRouter.createCaller({
  db: {},
  user: { id: "owner" },
  headers: new Headers(),
} as never);
const fields = { name: "x".repeat(50), colourCode: "#abcdef" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertPermission).mockResolvedValue(undefined);
  vi.mocked(boardRepo.getWorkspaceAndBoardIdByBoardPublicId).mockResolvedValue({
    id: 1,
    workspaceId: 1,
  } as never);
  vi.mocked(labelRepo.getWorkspaceAndLabelIdByLabelPublicId).mockResolvedValue({
    id: 1,
    workspaceId: 1,
  });
  vi.mocked(labelRepo.create).mockResolvedValue({
    id: 1,
    publicId: "label0000001",
    ...fields,
  });
  vi.mocked(labelRepo.update).mockResolvedValue({
    id: 1,
    publicId: "label0000001",
    ...fields,
  });
});

it("preserves full GitHub label names on create and rename", async () => {
  expect(
    await caller.create({ boardPublicId: "board0000001", ...fields }),
  ).toMatchObject(fields);
  expect(
    await caller.update({ labelPublicId: "label0000001", ...fields }),
  ).toMatchObject(fields);
});

it("rejects names longer than GitHub's limit before writing", async () => {
  await expect(
    caller.create({
      boardPublicId: "board0000001",
      ...fields,
      name: "x".repeat(51),
    }),
  ).rejects.toThrow();
  await expect(
    caller.update({
      labelPublicId: "label0000001",
      ...fields,
      name: "x".repeat(51),
    }),
  ).rejects.toThrow();
  expect(labelRepo.create).not.toHaveBeenCalled();
  expect(labelRepo.update).not.toHaveBeenCalled();
});

it("creates and updates through delegated middleware, retaining board edit checks", async () => {
  const board = {
    workspaceId: 1,
    name: "GitHub: ClockworkDigital/kan",
    visibility: "private",
    deletedAt: null,
  };
  const db = {
    query: {
      boards: { findFirst: vi.fn().mockResolvedValue(board) },
      labels: {
        findFirst: vi.fn().mockResolvedValue({ board, deletedAt: null }),
      },
    },
  };
  vi.mocked(workspaceRepo.getByPublicId).mockResolvedValue({ id: 1 } as never);
  vi.mocked(settingsRepo.get).mockResolvedValue({
    userId: "owner",
    enabled: true,
    repositories: ["ClockworkDigital/kan"],
  } as never);
  vi.mocked(getProviderForUser).mockResolvedValue({
    accessToken: "encrypted",
  } as never);
  const delegated = createTRPCRouter({ label: labelRouter }).createCaller({
    db,
    user: { id: "owner" },
    headers: new Headers({ "x-formwork-sync-workspace": "workspace123" }),
  } as never).label;

  expect(
    await delegated.create({ boardPublicId: "board0000001", ...fields }),
  ).toEqual({
    publicId: "label0000001",
    ...fields,
  });
  expect(
    await delegated.update({ labelPublicId: "label0000001", ...fields }),
  ).toEqual({
    publicId: "label0000001",
    ...fields,
  });
  expect(assertPermission).toHaveBeenCalledWith(db, "owner", 1, "board:edit");
  vi.mocked(labelRepo.create).mockClear();
  vi.mocked(labelRepo.update).mockClear();
  vi.mocked(assertPermission).mockImplementation(
    (_db, _user, _workspace, permission) =>
      permission === "board:edit"
        ? Promise.reject(new Error("Revoked"))
        : Promise.resolve(),
  );
  await expect(
    delegated.create({ boardPublicId: "board0000001", ...fields }),
  ).rejects.toThrow("Revoked");
  await expect(
    delegated.update({ labelPublicId: "label0000001", ...fields }),
  ).rejects.toThrow("Revoked");
  expect(labelRepo.create).not.toHaveBeenCalled();
  expect(labelRepo.update).not.toHaveBeenCalled();
});
