import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { HiXMark } from "react-icons/hi2";

import { useModal } from "~/providers/modal";
import { api } from "~/utils/api";
import { parseGithubBoardName } from "~/utils/github-board-name";

export function PriorityHistory({
  workspacePublicId,
}: {
  workspacePublicId: string;
}) {
  const { closeModal } = useModal();
  const { i18n } = useLingui();
  const { data, isLoading } = api.board.priorityHistory.useQuery({
    workspacePublicId,
  });

  return (
    <div className="space-y-4 p-5">
      <div className="flex w-full items-center justify-between">
        <h2 className="text-sm font-bold text-neutral-900 dark:text-dark-1000">
          {t`Priority history`}
        </h2>
        <button
          type="button"
          aria-label={t`Close`}
          className="rounded p-1 hover:bg-light-200 focus:outline-none dark:hover:bg-dark-300"
          onClick={closeModal}
        >
          <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
        </button>
      </div>
      {isLoading ? (
        <div className="h-16 animate-pulse rounded-md bg-light-200 dark:bg-dark-100" />
      ) : !data?.length ? (
        <p className="text-xs text-light-900 dark:text-dark-900">
          {t`No priority changes yet`}
        </p>
      ) : (
        <ul className="max-h-[60vh] space-y-3 overflow-y-auto text-xs">
          {data.map((change, i) => (
            <li
              key={`${change.boardPublicId}-${change.createdAt.getTime()}-${i}`}
            >
              <p className="font-semibold text-light-1000 dark:text-dark-1000">
                {parseGithubBoardName(change.boardName)?.repo ??
                  change.boardName}
                <span className="ml-2 font-normal text-light-900 dark:text-dark-900">
                  {change.fromRank === null
                    ? t`Unranked`
                    : `#${change.fromRank}`}{" "}
                  → #{change.toRank}
                </span>
              </p>
              <p className="text-light-900 dark:text-dark-900">
                {change.changedByName ?? t`Unknown user`} ·{" "}
                {i18n.date(change.createdAt, {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
