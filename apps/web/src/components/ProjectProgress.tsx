import { t } from "@lingui/core/macro";

export function ProjectProgress({
  done,
  total,
  github = false,
}: {
  done: number;
  total: number;
  github?: boolean;
}) {
  if (!total) return <span className="text-xs">{t`No cards yet`}</span>;
  const percent = Math.round((done / total) * 100);
  const label = github ? t`GitHub issues closed` : t`Cards done`;
  return (
    <span
      className="flex items-center gap-1.5 text-xs tabular-nums"
      title={github ? t`${done} closed, ${total - done} open issues` : label}
    >
      <span
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 w-14 overflow-hidden rounded bg-light-300 dark:bg-dark-400"
      >
        <span
          className="block h-full rounded bg-light-1000 dark:bg-dark-1000"
          style={{ width: `${percent}%` }}
        />
      </span>
      {done}/{total}
    </span>
  );
}
