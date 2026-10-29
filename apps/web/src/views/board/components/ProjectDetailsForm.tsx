import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiXMark } from "react-icons/hi2";
import { twMerge } from "tailwind-merge";

import type { RouterInputs } from "~/utils/api";
import Button from "~/components/Button";
import Input from "~/components/Input";
import Toggle from "~/components/Toggle";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

type Fields = Omit<RouterInputs["portfolio"]["update"], "boardPublicId">;
type Status = Fields["status"];

export const projectStatusColours: Record<Status, string> = {
  not_yet: "#dc2626",
  busy: "#ca8a04",
  done: "#65a30d",
};

export const projectStatusLabels = (): Record<Status, string> => ({
  not_yet: t`Not yet`,
  busy: t`Busy`,
  done: t`Done`,
});

const empty: Fields = {
  status: "not_yet",
  details: "",
  clients: "",
  shownToClient: false,
  internal: true,
  nextSteps: "",
};

export function ProjectDetailsForm({
  boardPublicId,
  boardName,
}: {
  boardPublicId: string;
  boardName?: string;
}) {
  const { closeModal } = useModal();
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const saved = api.portfolio.byBoardId.useQuery(
    { boardPublicId },
    { enabled: boardPublicId.length === 12 },
  );
  // Saved values seed the form until the first edit; refetches never overwrite a draft.
  const [draft, setDraft] = useState<Fields | null>(null);
  const fields = draft ?? saved.data ?? empty;
  const set = (patch: Partial<Fields>) => setDraft({ ...fields, ...patch });

  const onSettled = async () => {
    await Promise.all([
      utils.portfolio.list.invalidate(),
      utils.portfolio.byBoardId.invalidate({ boardPublicId }),
    ]);
  };
  const onError = () =>
    showPopup({
      header: t`Unable to save project details`,
      message: t`Please try again later, or contact customer support.`,
      icon: "error",
    });
  const update = api.portfolio.update.useMutation({
    onSuccess: closeModal,
    onError,
    onSettled,
  });
  const remove = api.portfolio.remove.useMutation({
    onSuccess: closeModal,
    onError,
    onSettled,
  });

  const labels = projectStatusLabels();
  // Build Tracker rule: client names belong to projects that were shown to a client.
  const clientsDisabled = !fields.shownToClient && !fields.clients.trim();
  const textArea =
    "block w-full rounded-md border-0 bg-dark-300 bg-white/5 py-1.5 text-sm shadow-sm ring-1 ring-inset ring-light-600 placeholder:text-dark-800 focus:ring-2 focus:ring-inset focus:ring-light-700 dark:text-dark-1000 dark:ring-dark-700 dark:focus:ring-dark-700";
  const label = "mb-1 block text-xs text-light-900 dark:text-dark-900";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate({ boardPublicId, ...fields });
      }}
    >
      <div className="space-y-4 px-5 pt-5">
        <div className="flex w-full items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-neutral-900 dark:text-dark-1000">
              {t`Project details`}
            </h2>
            <p className="text-xs text-light-900 dark:text-dark-900">
              {boardName
                ? t`${boardName} · shown on the Portfolio page`
                : t`Shown on the Portfolio page`}
            </p>
          </div>
          <button
            type="button"
            aria-label={t`Close`}
            className="rounded p-1 hover:bg-light-200 focus:outline-none dark:hover:bg-dark-300"
            onClick={closeModal}
          >
            <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
          </button>
        </div>

        <fieldset>
          <legend className={label}>{t`Status`}</legend>
          <div className="flex gap-2">
            {(Object.keys(labels) as Status[]).map((status) => (
              <button
                key={status}
                type="button"
                aria-pressed={fields.status === status}
                onClick={() => set({ status })}
                className={twMerge(
                  "flex h-8 flex-1 items-center justify-center gap-2 rounded-md text-xs text-light-900 ring-1 ring-inset ring-light-600 dark:text-dark-900 dark:ring-dark-700",
                  fields.status === status &&
                    "bg-light-200 font-semibold text-light-1000 ring-light-900 dark:bg-dark-300 dark:text-dark-1000 dark:ring-dark-800",
                )}
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: projectStatusColours[status] }}
                />
                {labels[status]}
              </button>
            ))}
          </div>
        </fieldset>

        <div>
          <label
            htmlFor="project-details"
            className={label}
          >{t`Details`}</label>
          <Input
            id="project-details"
            maxLength={600}
            value={fields.details}
            onChange={(e) => set({ details: e.target.value })}
          />
        </div>

        <div className="flex gap-6">
          <Toggle
            label={t`Shown to client`}
            labelPosition="after"
            isChecked={fields.shownToClient}
            onChange={() => set({ shownToClient: !fields.shownToClient })}
          />
          <Toggle
            label={t`Internal project`}
            labelPosition="after"
            isChecked={fields.internal}
            onChange={() => set({ internal: !fields.internal })}
          />
        </div>

        <div>
          <label
            htmlFor="project-clients"
            className={label}
          >{t`Client name(s)`}</label>
          <Input
            id="project-clients"
            maxLength={2000}
            disabled={clientsDisabled}
            placeholder={
              clientsDisabled ? t`Turn on "Shown to client" to add` : ""
            }
            value={fields.clients}
            onChange={(e) => set({ clients: e.target.value })}
          />
        </div>

        <div>
          <label
            htmlFor="project-next-steps"
            className={label}
          >{t`Next steps`}</label>
          <textarea
            id="project-next-steps"
            rows={3}
            maxLength={2000}
            className={textArea}
            value={fields.nextSteps}
            onChange={(e) => set({ nextSteps: e.target.value })}
          />
        </div>
      </div>
      <div className="mt-6 flex items-center justify-between gap-2 border-t border-light-600 px-5 pb-5 pt-5 dark:border-dark-600">
        <div>
          {saved.data && (
            <Button
              type="button"
              variant="ghost"
              isLoading={remove.isPending}
              disabled={remove.isPending || update.isPending}
              onClick={() => remove.mutate({ boardPublicId })}
            >
              {t`Remove from Portfolio`}
            </Button>
          )}
        </div>
        <Button
          type="submit"
          isLoading={update.isPending}
          disabled={saved.isPending || update.isPending || remove.isPending}
        >
          {saved.data ? t`Save` : t`Add to Portfolio`}
        </Button>
      </div>
    </form>
  );
}
