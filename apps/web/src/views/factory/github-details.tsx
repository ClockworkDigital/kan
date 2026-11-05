import { t } from "@lingui/core/macro";
import { useState } from "react";

import Button from "~/components/Button";
import { api } from "~/utils/api";

export default function GitHubDetails({
  workspacePublicId,
  jobPublicId,
  revision,
  stage,
  restartPending,
}: {
  workspacePublicId: string;
  jobPublicId: string;
  revision: number;
  stage: string;
  restartPending: boolean;
}) {
  const input = { workspacePublicId, jobPublicId };
  const details = api.factory.github.useQuery(input, { retry: false });
  const [body, setBody] = useState("");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [confirmSha, setConfirmSha] = useState<string>();
  const utils = api.useUtils();
  const restart = api.factory.restart.useMutation({
    onSuccess: () => {
      void utils.factory.list.invalidate();
    },
  });
  const canRestart = [
    "needs_info",
    "needs_human",
    "failed",
    "waiting",
  ].includes(stage);
  const reply = api.factory.reply.useMutation({
    onSuccess: () => {
      setBody("");
      void details.refetch();
    },
  });
  const merge = api.factory.merge.useMutation({
    onSuccess: () => {
      setConfirmSha(undefined);
      void details.refetch();
    },
  });
  const data = details.isSuccess ? details.data : undefined;
  const pull = data?.pull;
  const ready =
    pull?.state === "open" &&
    !pull.draft &&
    pull.mergeable === true &&
    pull.mergeable_state === "clean";
  return (
    <section className="mt-3 space-y-4 text-sm" aria-label={t`GitHub details`}>
      <Button
        variant="secondary"
        disabled={details.isFetching}
        onClick={() => {
          setConfirmSha(undefined);
          void details.refetch();
        }}
      >{t`Refresh GitHub details`}</Button>
      {details.isPending && <p role="status">{t`Loading...`}</p>}
      {details.isError && <p role="alert">{details.error.message}</p>}
      {data && (
        <>
          {data.issue && (
            <div>
              <h3 className="font-semibold">
                {data.issue.title} · {data.issue.state}
              </h3>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">
                {data.issue.body}
              </pre>
              <h4 className="mt-3 font-semibold">{t`Issue discussion`}</h4>
              {data.comments.map((comment, index) => (
                <div
                  key={index}
                  className="mt-3 border-t border-light-300 pt-2 dark:border-dark-400"
                >
                  <p>
                    {comment.user?.login} · {comment.created_at}
                  </p>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">
                    {comment.body}
                  </pre>
                </div>
              ))}
              <form
                className="mt-4 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  reply.mutate({ ...input, body });
                }}
              >
                <label
                  className="block"
                  htmlFor={`reply-${jobPublicId}`}
                >{t`Additional information for the agent`}</label>
                <textarea
                  id={`reply-${jobPublicId}`}
                  value={body}
                  disabled={reply.isPending || restart.isPending}
                  maxLength={60000}
                  required
                  rows={5}
                  onChange={(event) => setBody(event.target.value)}
                  className="w-full rounded border border-light-300 bg-light-50 p-2 dark:border-dark-400 dark:bg-dark-200"
                />
                <p>{t`Posts to the GitHub issue as you. Posting does not restart the runner. Use Restart job to send feedback directly to the runner.`}</p>
                <Button
                  disabled={reply.isPending || !body.trim()}
                  type="submit"
                >{t`Post reply`}</Button>
                {canRestart && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      reply.isPending ||
                      restart.isPending ||
                      restart.isSuccess ||
                      restartPending ||
                      !body.trim() ||
                      body.trim().length > 2000
                    }
                    onClick={() => restart.mutate({ ...input, revision, body })}
                  >{t`Restart job`}</Button>
                )}
                {canRestart && (
                  <p>{t`Restart uses the text above (up to 2,000 characters) and the usual models. It may spend model tokens. It does not post a GitHub comment.`}</p>
                )}
                {restart.isSuccess && (
                  <p role="status">{t`Restart queued. The worker will pick it up when available.`}</p>
                )}
                {restart.isError && <p role="alert">{restart.error.message}</p>}
                {reply.isSuccess && (
                  <p role="status">{t`Reply posted to GitHub.`}</p>
                )}
                {reply.isError && <p role="alert">{reply.error.message}</p>}
              </form>
            </div>
          )}
          {pull && (
            <div className="space-y-3">
              <h3 className="font-semibold">{pull.title}</h3>
              <p>
                {pull.merged ? t`Merged` : pull.state} · {pull.mergeable_state}
              </p>
              <p className="break-all">
                {t`Head commit`}: {pull.head.sha}
              </p>
              <p>
                {t`Target branch`}: {pull.base.ref}
              </p>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">
                {pull.body}
              </pre>
              {data.reviews.map((review, index) => (
                <div key={index}>
                  <p>
                    {review.user?.login} · {review.state}
                  </p>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">
                    {review.body}
                  </pre>
                </div>
              ))}
              {data.reviewComments.map((comment, index) => (
                <div key={index}>
                  <p className="break-all">
                    {comment.user?.login} · {comment.path}
                    {(comment.line ?? comment.original_line) !== null &&
                      `:${comment.line ?? comment.original_line}`}
                  </p>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">
                    {comment.body}
                  </pre>
                </div>
              ))}
              <h4 className="font-semibold">{t`Changed files`}</h4>
              {data.files.map((file) => (
                <details key={file.filename}>
                  <summary className="cursor-pointer break-all">
                    {file.filename} · {file.status}
                  </summary>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">
                    {file.patch ??
                      t`GitHub did not provide a text diff for this file.`}
                  </pre>
                </details>
              ))}
              <p>{t`Up to 100 comments, reviews and files are shown. GitHub may truncate diffs; use the PR link for the complete changes and checks.`}</p>
              {ready && (
                <>
                  <label className="block">
                    {t`Merge method`}
                    <select
                      value={method}
                      disabled={merge.isPending}
                      onChange={(event) => {
                        setMethod(event.target.value as typeof method);
                        setConfirmSha(undefined);
                      }}
                      className="ml-2 rounded bg-light-100 p-2 dark:bg-dark-200"
                    >
                      <option value="squash">{t`Squash`}</option>
                      <option value="merge">{t`Merge commit`}</option>
                      <option value="rebase">{t`Rebase`}</option>
                    </select>
                  </label>
                  {confirmSha === pull.head.sha ? (
                    <div className="space-y-2">
                      <p>{t`Merge this reviewed commit into the target branch?`}</p>
                      <Button
                        disabled={merge.isPending}
                        onClick={() =>
                          merge.mutate({
                            ...input,
                            headSha: confirmSha,
                            method,
                          })
                        }
                      >{t`Confirm merge`}</Button>
                      <Button
                        variant="secondary"
                        disabled={merge.isPending}
                        onClick={() => setConfirmSha(undefined)}
                      >{t`Cancel`}</Button>
                    </div>
                  ) : (
                    <Button
                      disabled={merge.isPending}
                      onClick={() => setConfirmSha(pull.head.sha)}
                    >{t`Merge pull request`}</Button>
                  )}
                </>
              )}
              {!ready && !pull.merged && (
                <p>{t`Merge is unavailable until GitHub reports an open, non-draft PR with a clean merge status. Refresh after checks and reviews finish.`}</p>
              )}
            </div>
          )}
        </>
      )}
      {merge.isSuccess && <p role="status">{t`Pull request merged.`}</p>}
      {merge.isError && <p role="alert">{merge.error.message}</p>}
    </section>
  );
}
