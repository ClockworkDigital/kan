import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as portfolioRepo from "@kan/db/repository/portfolio.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { boards, projectStatuses } from "@kan/db/schema";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  assertCanEdit,
  assertPermission,
  hasPermission,
} from "../utils/permissions";

const boardInput = z.object({ boardPublicId: z.string().length(12) });
const fields = z.object({
  status: z.enum(projectStatuses),
  details: z.string().trim().max(600),
  clients: z.string().trim().max(2000),
  shownToClient: z.boolean(),
  internal: z.boolean(),
  nextSteps: z.string().trim().max(2000),
});

async function findBoard(db: dbClient, boardPublicId: string) {
  const board = await db.query.boards.findFirst({
    columns: { id: true, workspaceId: true, createdBy: true },
    where: and(
      eq(boards.publicId, boardPublicId),
      eq(boards.type, "regular"),
      isNull(boards.deletedAt),
    ),
  });
  if (!board) throw new TRPCError({ code: "NOT_FOUND" });
  return board;
}

async function assertCanEditProject(
  db: dbClient,
  userId: string,
  boardPublicId: string,
) {
  const board = await findBoard(db, boardPublicId);
  // Active membership first: assertCanEdit alone lets a removed creator through.
  await assertPermission(db, userId, board.workspaceId, "board:view");
  await assertCanEdit(
    db,
    userId,
    board.workspaceId,
    "board:edit",
    board.createdBy ?? null,
  );
  return board.id;
}

// Mirrors assertCanEdit for callers already known to be active members.
async function editCheck(db: dbClient, userId: string, workspaceId: number) {
  const canEditAll = await hasPermission(db, userId, workspaceId, "board:edit");
  return (createdBy: string | null) => canEditAll || createdBy === userId;
}

export const portfolioRouter = createTRPCRouter({
  progress: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workspaces/{workspacePublicId}/progress",
        protect: true,
        summary: "Get card progress for every board",
        tags: ["Portfolio"],
      },
    })
    .input(z.object({ workspacePublicId: z.string().length(12) }))
    .output(
      z.array(
        z.object({
          boardPublicId: z.string(),
          totalCards: z.number(),
          doneCards: z.number(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const workspace = await workspaceRepo.getByPublicId(
        ctx.db,
        input.workspacePublicId,
      );
      if (!workspace || workspace.deletedAt)
        throw new TRPCError({ code: "NOT_FOUND" });
      await assertPermission(ctx.db, ctx.user.id, workspace.id, "board:view");
      return portfolioRepo.listBoardsForProgress(ctx.db, workspace.id);
    }),
  list: protectedProcedure
    .input(z.object({ workspacePublicId: z.string().length(12) }))
    .query(async ({ ctx, input }) => {
      const workspace = await workspaceRepo.getByPublicId(
        ctx.db,
        input.workspacePublicId,
      );
      if (!workspace || workspace.deletedAt)
        throw new TRPCError({ code: "NOT_FOUND" });
      await assertPermission(ctx.db, ctx.user.id, workspace.id, "board:view");
      const canEdit = await editCheck(ctx.db, ctx.user.id, workspace.id);
      const projects = await portfolioRepo.listByWorkspaceId(
        ctx.db,
        workspace.id,
      );
      return projects.map(({ createdBy, ...project }) => ({
        ...project,
        canEdit: canEdit(createdBy),
      }));
    }),
  byBoardId: protectedProcedure
    .input(boardInput)
    .query(async ({ ctx, input }) => {
      const board = await findBoard(ctx.db, input.boardPublicId);
      await assertPermission(
        ctx.db,
        ctx.user.id,
        board.workspaceId,
        "board:view",
      );
      const canEdit = await editCheck(ctx.db, ctx.user.id, board.workspaceId);
      const project = await portfolioRepo.getByBoardId(ctx.db, board.id);
      return {
        project: project && fields.parse(project),
        canEdit: canEdit(board.createdBy),
      };
    }),
  update: protectedProcedure
    .input(boardInput.merge(fields))
    .mutation(async ({ ctx, input: { boardPublicId, ...values } }) => {
      const boardId = await assertCanEditProject(
        ctx.db,
        ctx.user.id,
        boardPublicId,
      );
      await portfolioRepo.upsert(ctx.db, boardId, values, ctx.user.id);
      return { success: true };
    }),
  remove: protectedProcedure
    .input(boardInput)
    .mutation(async ({ ctx, input }) => {
      const boardId = await assertCanEditProject(
        ctx.db,
        ctx.user.id,
        input.boardPublicId,
      );
      await portfolioRepo.remove(ctx.db, boardId);
      return { success: true };
    }),
});
