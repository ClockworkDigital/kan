import Link from "next/link";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useState } from "react";
import { HiEllipsisHorizontal } from "react-icons/hi2";
import { twMerge } from "tailwind-merge";

import type { RouterOutputs } from "~/utils/api";
import Avatar from "~/components/Avatar";
import Badge from "~/components/Badge";
import Modal from "~/components/modal";
import { PageHead } from "~/components/PageHead";
import { ProjectProgress } from "~/components/ProjectProgress";
import { useModal } from "~/providers/modal";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";
import { parseGithubBoardName } from "~/utils/github-board-name";
import {
  ProjectDetailsForm,
  projectStatusColours,
  projectStatusLabels,
} from "~/views/board/components/ProjectDetailsForm";

type Project = RouterOutputs["portfolio"]["list"][number];
type Tab = "all" | Project["status"] | "shown";

const dot = (colour: string) => (
  <span
    aria-hidden="true"
    className="h-1.5 w-1.5 rounded-full"
    style={{ backgroundColor: colour }}
  />
);

function ProjectRow({
  project,
  showActions,
}: {
  project: Project;
  showActions: boolean;
}) {
  const { i18n } = useLingui();
  const { openModal } = useModal();
  const statusLabels = projectStatusLabels();
  const github = !!parseGithubBoardName(project.name);

  return (
    <tr className="relative border-b border-light-300 align-top hover:bg-light-100 dark:border-dark-300 dark:hover:bg-dark-100">
      <td className="py-3 pl-2 pr-3">
        <Link
          href={`/boards/${project.boardPublicId}`}
          className="font-bold text-neutral-900 after:absolute after:inset-0 dark:text-dark-1000"
        >
          {project.name}
        </Link>
        {project.details && (
          <p className="mt-0.5 line-clamp-2 text-xs text-light-900 dark:text-dark-900">
            {project.details}
          </p>
        )}
        <div className="flex flex-wrap gap-1">
          <Badge
            value={project.internal ? t`Internal` : t`Client`}
            iconLeft={dot(project.internal ? "#0d9488" : "#ea580c")}
          />
          {project.isArchived && <Badge value={t`Archived`} iconLeft={null} />}
        </div>
      </td>
      <td className="px-3 py-3">
        <Badge
          value={statusLabels[project.status]}
          iconLeft={dot(projectStatusColours[project.status])}
        />
      </td>
      <td className="px-3 py-3">
        <span
          className={twMerge(
            "mt-1 inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ring-1 ring-inset",
            project.shownToClient
              ? "bg-indigo-600/15 text-indigo-700 ring-indigo-600 dark:text-indigo-300"
              : "text-light-900 ring-light-600 dark:text-dark-800 dark:ring-dark-500",
          )}
        >
          {project.shownToClient ? t`Yes` : t`No`}
        </span>
        {project.clients && (
          <p className="mt-1 break-words text-xs text-light-900 dark:text-dark-900">
            {project.clients}
          </p>
        )}
      </td>
      <td className="px-3 py-3">
        <ProjectProgress
          github={github}
          done={project.doneCards}
          total={project.totalCards}
        />
      </td>
      <td className="px-3 py-3 text-sm">
        <p className="whitespace-pre-line break-words text-light-1000 dark:text-dark-950">
          {project.nextSteps || "—"}
        </p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-light-900 dark:text-dark-800">
          {project.updatedByName && (
            <Avatar size="xs" name={project.updatedByName} email="" />
          )}
          {t`Updated ${i18n.date(project.updatedAt, { dateStyle: "medium" })}`}
        </p>
      </td>
      {showActions && (
        <td className="py-3 pr-2">
          {project.canEdit && (
            <button
              type="button"
              aria-label={t`Edit project details for ${project.name}`}
              onClick={() =>
                openModal(
                  "PROJECT_DETAILS",
                  project.boardPublicId,
                  project.name,
                )
              }
              className="relative z-10 rounded p-1 hover:bg-light-200 dark:hover:bg-dark-200"
            >
              <HiEllipsisHorizontal className="h-5 w-5 text-dark-900" />
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

function Portfolio({ workspacePublicId }: { workspacePublicId: string }) {
  const { isOpen, modalContentType, entityId, entityLabel } = useModal();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const projects = api.portfolio.list.useQuery(
    { workspacePublicId },
    { enabled: workspacePublicId.length === 12 },
  );

  const all = projects.data ?? [];
  const inTab = (p: Project, key: Tab) =>
    key === "all" || (key === "shown" ? p.shownToClient : p.status === key);
  const needle = query.trim().toLowerCase();
  const rows = all.filter(
    (p) =>
      inTab(p, tab) &&
      (!needle ||
        [p.name, p.details, p.clients, p.nextSteps]
          .join(" ")
          .toLowerCase()
          .includes(needle)),
  );
  const statusLabels = projectStatusLabels();
  const anyEditable = all.some((p) => p.canEdit);
  const tabs: [Tab, string][] = [
    ["all", t`All`],
    ["not_yet", statusLabels.not_yet],
    ["busy", statusLabels.busy],
    ["beta_testing", statusLabels.beta_testing],
    ["done", statusLabels.done],
    ["shown", t`Shown to clients`],
  ];
  const head =
    "px-3 pb-2 text-left text-xs font-medium text-light-900 dark:text-dark-900";

  return (
    <>
      <Modal
        modalSize="sm"
        isVisible={isOpen && modalContentType === "PROJECT_DETAILS"}
      >
        <ProjectDetailsForm boardPublicId={entityId} boardName={entityLabel} />
      </Modal>
      <input
        type="search"
        aria-label={t`Search projects`}
        placeholder={t`Search projects, clients, next steps…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-4 block w-full max-w-sm rounded-md border-0 bg-light-50 py-1.5 text-sm shadow-sm ring-1 ring-inset ring-light-300 placeholder:text-light-800 focus:ring-2 focus:ring-light-700 dark:bg-dark-50 dark:text-dark-1000 dark:ring-dark-300 dark:placeholder:text-dark-800 dark:focus:ring-dark-500"
      />
      <nav
        aria-label={t`Filter projects`}
        className="mb-2 flex gap-6 overflow-x-auto border-b border-light-300 dark:border-dark-300"
      >
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            className={twMerge(
              "-mb-px whitespace-nowrap border-b-2 border-transparent pb-2 text-sm font-semibold text-light-900 hover:text-light-950 dark:text-dark-900 dark:hover:text-dark-950",
              tab === key &&
                "border-light-1000 text-light-1000 dark:border-dark-1000 dark:text-dark-1000",
            )}
          >
            {label}
            <span className="ml-1.5 rounded-full bg-light-200 px-1.5 py-0.5 text-[10px] text-light-950 dark:bg-dark-300 dark:text-dark-950">
              {all.filter((p) => inTab(p, key)).length}
            </span>
          </button>
        ))}
      </nav>
      {projects.isPending && <p role="status">{t`Loading...`}</p>}
      {projects.isError && (
        <p role="alert">{t`Unable to load the portfolio. Check your connection and workspace access.`}</p>
      )}
      {projects.isSuccess && !all.length && (
        <p className="py-12 text-center text-sm text-light-900 dark:text-dark-900">
          {t`No projects yet. Open a board and choose "Project details" from its menu to add it here.`}
        </p>
      )}
      {projects.isSuccess && !!all.length && !rows.length && (
        <p className="py-12 text-center text-sm text-light-900 dark:text-dark-900">
          {t`No projects match. Try another tab or search.`}
        </p>
      )}
      {!!rows.length && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] table-fixed text-neutral-900 dark:text-dark-1000">
            <thead>
              <tr className="border-b border-light-300 dark:border-dark-300">
                <th
                  scope="col"
                  className={twMerge(head, "w-[26%] pl-2")}
                >{t`Project`}</th>
                <th
                  scope="col"
                  className={twMerge(head, "w-[12%]")}
                >{t`Status`}</th>
                <th
                  scope="col"
                  className={twMerge(head, "w-[16%]")}
                >{t`Shown to client`}</th>
                <th
                  scope="col"
                  className={twMerge(head, "w-[12%]")}
                >{t`Progress`}</th>
                <th scope="col" className={head}>{t`Next steps`}</th>
                {anyEditable && (
                  <th scope="col" className="w-10">
                    <span className="sr-only">{t`Actions`}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((project) => (
                <ProjectRow
                  key={project.boardPublicId}
                  project={project}
                  showActions={anyEditable}
                />
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-xs text-light-900 dark:text-dark-800">
            {t`Progress counts the cards in each board's last list. On GitHub boards that is the Closed list.`}
          </p>
        </div>
      )}
    </>
  );
}

export default function PortfolioView() {
  useLingui();
  const { workspace } = useWorkspace();
  return (
    <div className="m-auto h-full max-w-[1100px] overflow-y-auto p-8 px-5 md:px-12 md:py-12">
      <PageHead title={t`Portfolio | ${workspace.name}`} />
      <h1 className="mb-6 font-bold tracking-tight text-neutral-900 dark:text-dark-1000 sm:text-[1.2rem]">
        {t`Portfolio`}
      </h1>
      <Portfolio
        key={workspace.publicId}
        workspacePublicId={workspace.publicId}
      />
    </div>
  );
}
