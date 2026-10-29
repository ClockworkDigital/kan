import Link from "next/link";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { motion } from "framer-motion";
import { FaGithub } from "react-icons/fa";
import {
  HiOutlineRectangleStack,
  HiOutlineStar,
  HiStar,
} from "react-icons/hi2";

import Avatar from "~/components/Avatar";
import Badge from "~/components/Badge";
import Button from "~/components/Button";
import PatternedBackground from "~/components/PatternedBackground";
import { ProjectProgress } from "~/components/ProjectProgress";
import { Tooltip } from "~/components/Tooltip";
import { usePermissions } from "~/hooks/usePermissions";
import { useModal } from "~/providers/modal";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";
import { parseGithubBoardName } from "~/utils/github-board-name";
import {
  projectStatusColours,
  projectStatusLabels,
} from "~/views/board/components/ProjectDetailsForm";

const dot = (colour: string) => (
  <span
    aria-hidden="true"
    className="h-1.5 w-1.5 rounded-full"
    style={{ backgroundColor: colour }}
  />
);

export function BoardsList({
  isTemplate,
  archived = false,
}: {
  isTemplate?: boolean;
  archived?: boolean;
}) {
  const { workspace } = useWorkspace();
  const { i18n } = useLingui();
  const { openModal } = useModal();
  const { canCreateBoard } = usePermissions();

  const utils = api.useUtils();
  const updateBoard = api.board.update.useMutation({
    onSuccess: () => {
      void utils.board.all.invalidate();
    },
  });

  const { data, isLoading } = api.board.all.useQuery(
    {
      workspacePublicId: workspace.publicId,
      type: isTemplate ? "template" : "regular",
      archived: archived,
    },
    { enabled: workspace.publicId ? true : false },
  );

  // Portfolio details, when a board has them, show on its tile.
  const portfolio = api.portfolio.list.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !isTemplate && !!workspace.publicId },
  );
  const progress = api.portfolio.progress.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !isTemplate && !!workspace.publicId },
  );
  const projects = new Map(
    portfolio.data?.map((project) => [project.boardPublicId, project]),
  );
  const statusLabels = projectStatusLabels();

  const handleToggleFavorite = (
    e: React.MouseEvent,
    boardPublicId: string,
    currentFavorite: boolean | undefined,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    updateBoard.mutate({
      boardPublicId,
      favorite: !currentFavorite,
    });
  };

  if (isLoading)
    return (
      <div className="3xl:grid-cols-4 grid h-fit w-full grid-cols-1 gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-3">
        <div className="mr-5 flex h-[150px] w-full animate-pulse rounded-md bg-light-200 dark:bg-dark-100" />
        <div className="mr-5 flex h-[150px] w-full animate-pulse rounded-md bg-light-200 dark:bg-dark-100" />
        <div className="mr-5 flex h-[150px] w-full animate-pulse rounded-md bg-light-200 dark:bg-dark-100" />
      </div>
    );

  if (data?.length === 0)
    return (
      <div className="z-10 flex h-full w-full flex-col items-center justify-center space-y-8 pb-[150px]">
        <div className="flex flex-col items-center">
          <HiOutlineRectangleStack className="h-10 w-10 text-light-800 dark:text-dark-800" />
          <p className="mb-2 mt-4 text-[14px] font-bold text-light-1000 dark:text-dark-950">
            {archived
              ? t`No archived boards`
              : t`No ${isTemplate ? "templates" : "boards"}`}
          </p>
          <p className="text-[14px] text-light-900 dark:text-dark-900">
            {archived
              ? t`Boards you archive will appear here.`
              : t`Get started by creating a new ${isTemplate ? "template" : "board"}`}
          </p>
        </div>
        <Tooltip
          content={!canCreateBoard ? t`You don't have permission` : undefined}
        >
          <Button
            onClick={() => {
              if (canCreateBoard) openModal("NEW_BOARD");
            }}
            disabled={!canCreateBoard}
          >
            {t`Create new ${isTemplate ? "template" : "board"}`}
          </Button>
        </Tooltip>
      </div>
    );

  return (
    <motion.div
      className="3xl:grid-cols-4 grid h-fit w-full grid-cols-1 gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-3"
      layout
    >
      {data?.map((board) => {
        const github = parseGithubBoardName(board.name);
        const project = projects.get(board.publicId);
        const counts = progress.data?.find(
          (item) => item.boardPublicId === board.publicId,
        );

        return (
          <motion.div
            key={board.publicId}
            layout
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              layout: {
                type: "spring",
                stiffness: 300,
                damping: 30,
                mass: 1,
              },
              opacity: { duration: 0.2 },
              scale: { duration: 0.2 },
            }}
          >
            <Link
              href={`${isTemplate ? "templates" : "boards"}/${board.publicId}`}
              aria-label={board.name}
              className="block h-full"
            >
              <div className="group relative mr-5 flex h-full min-h-[150px] w-full items-stretch rounded-md border border-dashed border-light-400 bg-light-50 shadow-sm hover:bg-light-200 dark:border-dark-600 dark:bg-dark-50 dark:hover:bg-dark-100">
                <PatternedBackground />
                <button
                  onClick={(e) =>
                    handleToggleFavorite(e, board.publicId, board.favorite)
                  }
                  className={`absolute right-10 top-3 z-10 rounded p-1 transition-all hover:bg-light-300 dark:hover:bg-dark-200 ${
                    board.favorite
                      ? ""
                      : "md:opacity-0 md:group-hover:opacity-100"
                  }`}
                  aria-label={
                    board.favorite
                      ? "Remove from favorites"
                      : "Add to favorites"
                  }
                >
                  {board.favorite ? (
                    <HiStar className="h-5 w-5 text-neutral-700 dark:text-dark-1000" />
                  ) : (
                    <HiOutlineStar className="h-5 w-5 text-neutral-700 dark:text-dark-800" />
                  )}
                </button>
                <FaGithub
                  aria-label={
                    github
                      ? t`GitHub repository linked`
                      : t`No GitHub repository linked`
                  }
                  className={`absolute right-3 top-4 z-10 h-4 w-4 ${github ? "text-neutral-900 dark:text-white" : "text-neutral-400 dark:text-neutral-500"}`}
                />
                <div className="relative flex h-full min-w-0 flex-1 flex-col gap-2 p-5">
                  {project && (
                    <div className="flex flex-wrap gap-1.5 pr-14">
                      <Badge
                        value={statusLabels[project.status]}
                        iconLeft={dot(projectStatusColours[project.status])}
                      />
                      <Badge
                        value={project.internal ? t`Internal` : t`Client`}
                        iconLeft={dot(project.internal ? "#0d9488" : "#ea580c")}
                      />
                      {project.shownToClient && (
                        <span className="mt-1 inline-flex items-center rounded-full bg-indigo-600/15 px-2 py-1 text-[10px] font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600 dark:text-indigo-300">
                          {project.clients
                            ? `${t`Shown`} · ${project.clients}`
                            : t`Shown`}
                        </span>
                      )}
                    </div>
                  )}
                  <h2 className="break-words pr-14 text-left text-2xl font-bold leading-tight text-neutral-700 dark:text-dark-1000">
                    {github?.repo ?? board.name}
                  </h2>
                  {project?.details && (
                    <p className="line-clamp-2 text-left text-xs text-light-900 dark:text-dark-900">
                      {project.details}
                    </p>
                  )}
                  {project?.nextSteps && (
                    <div className="border-t border-light-300 pt-2 text-left text-xs dark:border-dark-300">
                      <p className="text-[10px] uppercase tracking-wide text-light-900 dark:text-dark-800">
                        {t`Next steps`}
                      </p>
                      <p className="whitespace-pre-line break-words text-light-1000 dark:text-dark-950">
                        {project.nextSteps}
                      </p>
                    </div>
                  )}
                  {(project ?? github) && (
                    <div className="mt-auto flex min-w-0 items-center gap-3 text-xs text-light-900 dark:text-dark-900">
                      <ProjectProgress
                        github={!!github}
                        done={counts?.doneCards ?? 0}
                        total={counts?.totalCards ?? 0}
                      />
                      {project && (
                        <>
                          <span className="flex items-center gap-1.5 whitespace-nowrap">
                            {project.updatedByName && (
                              <Avatar
                                size="xs"
                                name={project.updatedByName}
                                email=""
                              />
                            )}
                            {i18n.date(project.updatedAt, {
                              day: "numeric",
                              month: "short",
                            })}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </Link>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
