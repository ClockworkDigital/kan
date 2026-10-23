import { t } from "@lingui/core/macro";
import { useState } from "react";

import { issueForms, productionFields } from "@kan/shared";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { api } from "~/utils/api";

export default function GithubIssueForm({
  boardPublicId,
}: {
  boardPublicId: string;
}) {
  const policy = api.githubSync.issuePolicy.useQuery({ boardPublicId });
  const [kind, setKind] = useState<"bug" | "feature">("bug");
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<string[]>([]);
  const submit = api.githubSync.submitIssue.useMutation({ retry: false });
  const labels = {
    "Acceptance criteria": t`Acceptance criteria`,
    "Test plan": t`Test plan`,
    "Impact and risks": t`Impact and risks`,
    "Steps to reproduce": t`Steps to reproduce`,
    "Expected result": t`Expected result`,
    "Actual result": t`Actual result`,
    Environment: t`Environment`,
    "Desired outcome": t`Desired outcome`,
  };
  if (policy.isLoading) return <p role="status">{t`Loading requirements…`}</p>;
  if (policy.error) return <p role="alert">{policy.error.message}</p>;
  if (submit.data)
    return (
      <div className="space-y-4 p-5">
        <p role="status">{t`Issue submitted. Its linked card will appear within five minutes.`}</p>
        <a
          className="underline"
          href={submit.data.url}
          target="_blank"
          rel="noreferrer"
        >{t`View issue on GitHub`}</a>
      </div>
    );
  return (
    <form
      className="space-y-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate({
          boardPublicId,
          kind,
          title,
          answers: answers.slice(0, issueForms[kind].fields.length),
          productionAnswers: answers.slice(issueForms[kind].fields.length),
        });
      }}
    >
      <h2>{t`Submit GitHub issue`}</h2>
      <label className="block">
        {t`Issue type`}
        <select
          className="block w-full bg-transparent"
          value={kind}
          disabled={submit.isPending}
          onChange={(event) => {
            setKind(event.target.value as "bug" | "feature");
            setAnswers([]);
          }}
        >
          <option value="bug">{t`Bug report`}</option>
          <option value="feature">{t`Feature request`}</option>
        </select>
      </label>
      <label className="block">
        {t`Summary`}
        <Input
          required
          maxLength={256}
          value={title}
          disabled={submit.isPending}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {[
        ...issueForms[kind].fields,
        ...(policy.data?.production ? productionFields : []),
      ].map((field, index) => (
        <label className="block" key={field}>
          {labels[field]}
          <textarea
            className="block min-h-20 w-full rounded border bg-transparent p-2"
            required
            maxLength={2000}
            value={answers[index] ?? ""}
            disabled={submit.isPending}
            onChange={(event) =>
              setAnswers((values) => {
                const next = [...values];
                next[index] = event.target.value;
                return next;
              })
            }
          />
        </label>
      ))}
      {submit.error && (
        <p role="alert">
          {submit.error.message}{" "}
          {t`If the request timed out, check GitHub before retrying to avoid a duplicate.`}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={submit.isPending}
        isLoading={submit.isPending}
      >{t`Submit issue`}</Button>
    </form>
  );
}
