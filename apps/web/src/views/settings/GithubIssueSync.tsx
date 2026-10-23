import { t } from "@lingui/core/macro";
import { useState } from "react";

import Button from "~/components/Button";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

function WorkspaceSync() {
  const { workspace } = useWorkspace();
  const input = { workspacePublicId: workspace.publicId };
  const settings = api.githubSync.settings.useQuery(input, {
    enabled: !!workspace.publicId,
    refetchInterval: 30000,
  });
  const repos = api.githubSync.repositories.useQuery(input, {
    enabled: !!workspace.publicId,
  });
  const [selection, setSelection] = useState<string[] | null>(null);
  const selected = selection ?? settings.data?.repositories ?? [];
  const save = api.githubSync.save.useMutation({
    onSuccess: async () => {
      await settings.refetch();
      setSelection(null);
    },
  });
  const status = settings.data?.status;
  const stale =
    status && Date.now() - Date.parse(status.checkedAt) > 15 * 60 * 1000;
  return (
    <section className="mt-8 space-y-4" aria-label={t`GitHub issue sync`}>
      <h3 className="text-sm font-bold">
        {t`GitHub issue sync`} · {workspace.name}
      </h3>
      <p className="text-sm text-neutral-500 dark:text-dark-900">{t`Choose repositories to sync every five minutes. Each repository gets a board. Titles, descriptions and open or closed status sync both ways. Unchecking a repository keeps its existing cards.`}</p>
      {(settings.isLoading || repos.isLoading) && (
        <p role="status">{t`Loading repositories…`}</p>
      )}
      {(settings.error || repos.error || save.error) && (
        <p role="alert" className="text-sm text-red-600">
          {(settings.error ?? repos.error ?? save.error)?.message}
        </p>
      )}
      {repos.error && (
        <Button
          variant="secondary"
          onClick={() => {
            void repos.refetch();
            void settings.refetch();
          }}
        >{t`Retry`}</Button>
      )}
      {repos.data?.length === 0 && (
        <p>{t`No accessible repositories with issues enabled. Check your GitHub token's repository access.`}</p>
      )}
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {[
          ...new Set([
            ...(repos.data?.map((repo) => repo.name) ?? []),
            ...selected,
          ]),
        ]
          .sort()
          .map((name) => {
            const writable = repos.data?.find(
              (repo) => repo.name === name,
            )?.writable;
            return (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(name)}
                  disabled={
                    save.isPending ||
                    !!settings.error ||
                    (!writable && !selected.includes(name))
                  }
                  onChange={(event) =>
                    setSelection(
                      event.target.checked
                        ? [...selected, name]
                        : selected.filter((value) => value !== name),
                    )
                  }
                />
                {name}{" "}
                {!writable && <span>{t`(write access unavailable)`}</span>}
              </label>
            );
          })}
      </div>
      <p className="text-sm text-neutral-500 dark:text-dark-900">{t`Enabling sync authorizes background access using your saved GitHub token after you sign out. Formwork blocks and Kan permissions still apply. Pause sync or disconnect GitHub to stop it.`}</p>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={
            !selected.length || !repos.data || !settings.data || save.isPending
          }
          isLoading={save.isPending}
          onClick={() =>
            save.mutate({ ...input, repositories: selected, enabled: true })
          }
        >{t`Save and enable sync`}</Button>
        <Button
          variant="secondary"
          disabled={!settings.data?.enabled || save.isPending}
          onClick={() =>
            save.mutate({
              ...input,
              repositories: settings.data?.repositories ?? [],
              enabled: false,
            })
          }
        >{t`Pause sync`}</Button>
      </div>
      {settings.data && (
        <p role="status" className="text-sm">
          {settings.data.enabled ? t`Sync enabled` : t`Sync paused`}
          {save.isSuccess ? t` · Settings saved` : ""}
        </p>
      )}
      {status ? (
        <div className="space-y-1 text-sm">
          <p>
            {t`Last check`}: {new Date(status.checkedAt).toLocaleString()}
          </p>
          <p>
            {t`Cards created`}: {status.created} · {t`GitHub updates`}:{" "}
            {status.updatedGitHub} · {t`Kan updates`}: {status.updatedKan}
          </p>
          <p>
            {t`Conflicts`}: {status.conflicts} · {t`Errors`}: {status.errors}
          </p>
          {(status.conflicts > 0 || status.errors > 0) && (
            <p role="alert">{t`Some issues need attention. Conflicting edits are preserved. Ask the operator to review the sync report.`}</p>
          )}
          {settings.data?.enabled && stale && (
            <p role="alert">{t`Sync has not checked in recently. Ask the operator to check the worker and Formwork access.`}</p>
          )}
        </div>
      ) : (
        <p className="text-sm">{t`Waiting for the first sync check.`}</p>
      )}
    </section>
  );
}

export default function GithubIssueSync() {
  const { workspace } = useWorkspace();
  return <WorkspaceSync key={workspace.publicId} />;
}
