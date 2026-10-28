import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useState } from "react";

import type { RouterOutputs } from "~/utils/api";
import Button from "~/components/Button";
import { PageHead } from "~/components/PageHead";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

type Job = RouterOutputs["factory"]["list"]["jobs"][number];

function stageLabels() {
  return {
    queued: t`Queued`,
    intake: t`Intake`,
    spec: t`Specification`,
    building: t`Building`,
    checks: t`Checks`,
    rework: t`Rework`,
    review: t`Review`,
    needs_info: t`Waiting for information`,
    needs_human: t`Waiting for human review`,
    failed: t`Failed`,
    completed: t`Completed`,
  };
}

function JobCard({
  job,
  workspacePublicId,
}: {
  job: Job;
  workspacePublicId: string;
}) {
  const { i18n } = useLingui();
  const [inspecting, setInspecting] = useState(false);
  const { snapshot } = job;
  const results = {
    pending: t`Pending`,
    pass: t`Passed`,
    fail: t`Failed`,
    skipped: t`Skipped`,
  };
  const risks = { low: t`Low`, medium: t`Medium`, high: t`High` };
  const repositoryUrl = `https://github.com/${job.repository}`;

  return (
    <article className="min-w-0 rounded-lg border border-light-300 bg-light-50 p-5 dark:border-dark-400 dark:bg-dark-100">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="rounded bg-light-200 px-2 py-1 text-sm font-medium dark:bg-dark-300">
          {stageLabels()[snapshot.stage]}
        </span>
        <span className="text-xs text-light-900 dark:text-dark-900">
          {i18n.date(job.updatedAt, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
      </div>
      <h2 className="break-words text-lg font-semibold">{snapshot.title}</h2>
      <p className="mt-1 break-all text-sm text-light-900 dark:text-dark-900">
        {job.repository} · {job.runKey}
      </p>
      <div className="my-3 flex flex-wrap gap-4 text-sm underline">
        {snapshot.issueNumber !== null && (
          <a
            href={`${repositoryUrl}/issues/${snapshot.issueNumber}`}
            target="_blank"
            rel="noreferrer"
          >{t`Issue #${snapshot.issueNumber}`}</a>
        )}
        {snapshot.prNumber !== null && (
          <a
            href={`${repositoryUrl}/pull/${snapshot.prNumber}`}
            target="_blank"
            rel="noreferrer"
          >{t`PR #${snapshot.prNumber}`}</a>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {snapshot.risk !== null && (
          <div>
            <dt className="text-light-900 dark:text-dark-900">{t`Risk`}</dt>
            <dd>{risks[snapshot.risk]}</dd>
          </div>
        )}
        {snapshot.builderModel !== null && (
          <div>
            <dt className="text-light-900 dark:text-dark-900">{t`Builder model`}</dt>
            <dd className="break-all">{snapshot.builderModel}</dd>
          </div>
        )}
        {snapshot.estimatedCostUsd !== null && (
          <div>
            <dt className="text-light-900 dark:text-dark-900">{t`Estimated cost (USD)`}</dt>
            <dd>
              {i18n.number(snapshot.estimatedCostUsd, {
                style: "currency",
                currency: "USD",
              })}
            </dd>
          </div>
        )}
        {snapshot.elapsedSeconds !== null && (
          <div>
            <dt className="text-light-900 dark:text-dark-900">{t`Elapsed time`}</dt>
            <dd>{t`${snapshot.elapsedSeconds} seconds`}</dd>
          </div>
        )}
      </dl>
      {snapshot.rounds.map((round) => (
        <div
          key={round.round}
          className="mt-3 border-t border-light-300 pt-3 text-sm dark:border-dark-400"
        >
          <h3 className="font-medium">{t`Round ${round.round}`}</h3>
          <p>
            {t`Checks`}: {results[round.gate]}
          </p>
          {round.reviews.map((review) => (
            <p key={review.name} className="break-words">
              {review.name}: {results[review.result]}
              {review.summary && ` — ${review.summary}`}
            </p>
          ))}
        </div>
      ))}
      <details
        className="mt-4"
        onToggle={(event) => setInspecting(event.currentTarget.open)}
      >
        <summary className="cursor-pointer font-medium">{t`Inspect artifacts`}</summary>
        {inspecting && (
          <Artifacts
            workspacePublicId={workspacePublicId}
            jobPublicId={job.publicId}
          />
        )}
      </details>
    </article>
  );
}

function Artifacts({
  workspacePublicId,
  jobPublicId,
}: {
  workspacePublicId: string;
  jobPublicId: string;
}) {
  const job = api.factory.byId.useQuery(
    { workspacePublicId, jobPublicId },
    { refetchInterval: 5000, retry: false },
  );
  return (
    <section aria-label={t`Job artifacts`} className="mt-3">
      {job.isPending && <p role="status">{t`Loading...`}</p>}
      {job.isError && (
        <p role="alert">{t`Unable to load job artifacts. Check your connection and access.`}</p>
      )}
      {job.isSuccess &&
        (job.data.artifacts.length ? (
          job.data.artifacts.map((artifact) => (
            <details
              key={artifact.name}
              className="border-t border-light-300 py-3 dark:border-dark-400"
            >
              <summary className="cursor-pointer break-words font-medium">
                {artifact.name}
              </summary>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-light-100 p-3 text-sm dark:bg-dark-200">
                {artifact.content}
              </pre>
            </details>
          ))
        ) : (
          <p>{t`No artifacts published yet.`}</p>
        ))}
    </section>
  );
}

function WorkspaceFactory({
  workspacePublicId,
}: {
  workspacePublicId: string;
}) {
  const [page, setPage] = useState(0);
  const jobs = api.factory.list.useQuery(
    { workspacePublicId, page },
    {
      enabled: workspacePublicId.length === 12,
      refetchInterval: 5000,
      retry: false,
    },
  );

  return (
    <>
      <p className="mb-6 text-sm text-light-900 dark:text-dark-900">{t`Updates automatically every five seconds.`}</p>
      {jobs.isPending && <p role="status">{t`Loading...`}</p>}
      {jobs.isError && (
        <p role="alert">{t`Unable to load factory jobs. Check your connection and workspace access; updates will retry automatically.`}</p>
      )}
      {jobs.isSuccess && (
        <>
          {!jobs.data.jobs.length && (
            <p>{t`No factory jobs yet. Publish a run to this workspace to see its progress here.`}</p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            {jobs.data.jobs.map((job) => (
              <JobCard
                key={job.publicId}
                job={job}
                workspacePublicId={workspacePublicId}
              />
            ))}
          </div>
          <div className="mt-6 flex items-center gap-3">
            <Button
              variant="secondary"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >{t`Previous`}</Button>
            <span>{t`Page ${page + 1}`}</span>
            <Button
              variant="secondary"
              disabled={!jobs.data.hasMore}
              onClick={() => setPage(page + 1)}
            >{t`Next`}</Button>
          </div>
        </>
      )}
    </>
  );
}

export default function FactoryView() {
  useLingui();
  const { workspace } = useWorkspace();
  return (
    <div className="mx-auto h-full max-w-6xl overflow-y-auto p-5 text-neutral-900 dark:text-dark-1000 md:p-10">
      <PageHead title={t`Factory | ${workspace.name}`} />
      <h1 className="mb-2 text-xl font-bold">{t`Software factory`}</h1>
      <WorkspaceFactory
        key={workspace.publicId}
        workspacePublicId={workspace.publicId}
      />
    </div>
  );
}
