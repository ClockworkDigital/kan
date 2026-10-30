import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { githubInstallationToken } from "./github-installation";

export function isFactorySender(email: string) {
  return Boolean(
    process.env.FACTORY_SENDER_EMAILS?.split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
      .includes(email.trim().toLowerCase()),
  );
}

export async function factoryIssue(
  card:
    | { githubRepository: string | null; githubIssueNumber: number | null }
    | undefined,
) {
  const repository = card?.githubRepository;
  if (!repository?.startsWith("clockworkdigital/") || !card?.githubIssueNumber)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This card is not linked to a GitHub issue.",
    });
  const path = `repos/${repository}/issues/${card.githubIssueNumber}`;
  const token = await githubInstallationToken();
  const request = async (
    suffix = "",
    method = "GET",
    body?: string,
  ): Promise<unknown> => {
    const response = await fetch(
      `https://api.github.com/${suffix === "/label-exists" ? `repos/${repository}/labels/factory` : path + suffix}`,
      {
        method,
        body,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok)
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message:
          "Unable to access the GitHub issue. Check the App's repository access and Issues permission.",
      });
    return response.json();
  };
  const issue = z
    .object({
      state: z.string(),
      pull_request: z.unknown().optional(),
      labels: z.array(z.object({ name: z.string() })),
    })
    .parse(await request());
  if (issue.pull_request || issue.state !== "open")
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only open GitHub issues can be sent to the factory.",
    });
  return async () => {
    if (!issue.labels.some((label) => label.name === "factory")) {
      await request("/label-exists");
      await request("/labels", "POST", JSON.stringify({ labels: ["factory"] }));
    }
  };
}
