import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as settingsRepo from "@kan/db/repository/github-sync.repo";
import { getProviderForUser } from "@kan/db/repository/integration.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import { githubInstallationConfigured } from "./github-installation";
import { assertPermission } from "./permissions";

export async function assertSyncScope(
  db: dbClient,
  userId: string | undefined,
  workspacePublicId: string,
  path: string,
  raw: unknown,
) {
  const deny = () => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Outside background sync delegation.",
    });
  };
  if (!userId || workspacePublicId.startsWith("factory:")) return deny();
  const workspace = await workspaceRepo.getByPublicId(db, workspacePublicId);
  if (!workspace) return deny();
  for (const permission of [
    "board:create",
    "card:create",
    "card:edit",
  ] as const)
    await assertPermission(db, userId, workspace.id, permission);
  const settings = await settingsRepo.get(db, workspace.id);
  if (!settings || settings.userId !== userId) return deny();
  const input = z.record(z.unknown()).parse(raw ?? {});
  if (path === "githubSync.settings" || path === "githubSync.report") {
    if (input.workspacePublicId !== workspacePublicId) return deny();
    return;
  }
  if (
    !settings.enabled ||
    !(
      githubInstallationConfigured() ||
      (await getProviderForUser(db, userId, "github"))
    )
  )
    return deny();
  if (path === "user.getUser") return;
  if (["board.all", "permission.getMyPermissions"].includes(path)) {
    if (input.workspacePublicId !== workspacePublicId) return deny();
    return;
  }
  if (path === "githubSync.request") {
    if (input.workspacePublicId !== workspacePublicId) return deny();
    const target = z.string().parse(input.path);
    if (target === "orgs/ClockworkDigital/repos?per_page=100" && !input.changes)
      return;
    const labelRepo =
      /^repos\/(ClockworkDigital\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+)\/labels\?per_page=100$/.exec(
        target,
      )?.[1];
    if (labelRepo) {
      if (input.changes || !settings.repositories.includes(labelRepo))
        return deny();
      return;
    }
    const repo = /^repos\/(ClockworkDigital\/[^/]+)\/issues(?:\?|\/)/.exec(
      target,
    )?.[1];
    if (!repo || !settings.repositories.includes(repo)) return deny();
    return;
  }
  if (path === "board.create") {
    if (
      input.workspacePublicId !== workspacePublicId ||
      !settings.repositories.some((name) => input.name === `GitHub: ${name}`) ||
      (input.visibility && input.visibility !== "private")
    )
      return deny();
    return;
  }
  const boardAllowed = (
    board:
      | {
          workspaceId: number;
          name: string;
          deletedAt: Date | null;
          visibility: string;
        }
      | undefined,
  ) =>
    board &&
    !board.deletedAt &&
    board.workspaceId === workspace.id &&
    board.visibility === "private" &&
    settings.repositories.some((name) => board.name === `GitHub: ${name}`);
  if (path === "board.byId" || path === "label.create") {
    const id = z.string().parse(input.boardPublicId);
    const board = await db.query.boards.findFirst({
      where: (b, { eq }) => eq(b.publicId, id),
    });
    if (!boardAllowed(board)) return deny();
    if (path === "label.create")
      await assertPermission(db, userId, workspace.id, "board:edit");
    return;
  }
  if (path === "label.update") {
    const id = z.string().parse(input.labelPublicId);
    const label = await db.query.labels.findFirst({
      where: (l, { eq }) => eq(l.publicId, id),
      with: { board: true },
    });
    if (!label || label.deletedAt || !boardAllowed(label.board)) return deny();
    await assertPermission(db, userId, workspace.id, "board:edit");
    return;
  }
  if (
    ![
      "card.create",
      "card.update",
      "card.byId",
      "card.addOrRemoveLabel",
    ].includes(path)
  )
    return deny();
  let boardId: number | undefined;
  if (path !== "card.create") {
    const id = z.string().parse(input.cardPublicId);
    const card = await db.query.cards.findFirst({
      where: (c, { eq }) => eq(c.publicId, id),
      with: { list: { with: { board: true } } },
    });
    if (
      !card ||
      card.deletedAt ||
      card.list.deletedAt ||
      !boardAllowed(card.list.board)
    )
      return deny();
    boardId = card.list.board.id;
  }
  if (
    path === "card.update" &&
    Object.keys(input).some(
      (key) =>
        !["cardPublicId", "title", "description", "listPublicId"].includes(key),
    )
  )
    return deny();
  if (path === "card.create" || input.listPublicId) {
    const id = z.string().parse(input.listPublicId);
    const list = await db.query.lists.findFirst({
      where: (l, { eq }) => eq(l.publicId, id),
      with: { board: true },
    });
    if (
      !list ||
      list.deletedAt ||
      !boardAllowed(list.board) ||
      (boardId && boardId !== list.board.id)
    )
      return deny();
    boardId = list.board.id;
  }
  if (path === "card.create" || path === "card.addOrRemoveLabel") {
    const ids =
      path === "card.create"
        ? z.array(z.string()).parse(input.labelPublicIds ?? [])
        : [z.string().parse(input.labelPublicId)];
    if (!ids.length) return;
    const labels = await db.query.labels.findMany({
      where: (l, { inArray }) => inArray(l.publicId, ids),
      columns: { publicId: true, boardId: true, deletedAt: true },
    });
    if (
      labels.length !== new Set(ids).size ||
      labels.some(
        (label) => label.deletedAt !== null || label.boardId !== boardId,
      )
    )
      return deny();
  }
}
