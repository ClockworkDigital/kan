import { beforeEach, expect, it, vi } from "vitest";

import * as boardRepo from "@kan/db/repository/board.repo";
import * as labelRepo from "@kan/db/repository/label.repo";

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

const caller = labelRouter.createCaller({
  db: {},
  user: { id: "owner" },
  headers: new Headers(),
} as never);
const fields = { name: "x".repeat(50), colourCode: "#abcdef" };
beforeEach(() => {
  vi.clearAllMocks();
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
  expect(labelRepo.create).not.toHaveBeenCalled();
});
