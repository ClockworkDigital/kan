import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";

import type { RouterOutputs } from "~/utils/api";
import { api } from "~/utils/api";
import Badge from "./Badge";

function stageLabels() {
  return {
    queued: t`Queued`,
    intake: t`Intake`,
    spec: t`Specification`,
    building: t`Building`,
    checks: t`Checks`,
    rework: t`Rework`,
    review: t`Review`,
    publishing: t`Publishing`,
    babysitting: t`Babysitting`,
    judging: t`Judging`,
    waiting: t`Waiting`,
    needs_info: t`Waiting for information`,
    needs_human: t`Waiting for human review`,
    failed: t`Failed`,
    completed: t`Completed`,
  };
}

type Stage =
  RouterOutputs["factory"]["list"]["jobs"][number]["snapshot"]["stage"];

export function FactoryStageBadge({ stage }: { stage: Stage }) {
  useLingui();
  const colour =
    stage === "failed" || stage === "needs_human"
      ? "bg-red-500"
      : stage === "completed"
        ? "bg-green-500"
        : stage === "waiting" || stage === "needs_info"
          ? "bg-amber-500"
          : "bg-blue-500";
  return (
    <Badge
      value={stageLabels()[stage]}
      iconLeft={<span className={`h-2 w-2 rounded-full ${colour}`} />}
    />
  );
}

export function CardFactoryBadge({ cardPublicId }: { cardPublicId: string }) {
  const job = api.factory.byIssue.useQuery(
    { cardPublicId },
    { refetchInterval: 5000, retry: false },
  );
  return job.isSuccess && job.data ? (
    <FactoryStageBadge stage={job.data.snapshot.stage} />
  ) : null;
}
