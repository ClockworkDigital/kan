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
    requestPath = path,
    method = "GET",
    body?: string,
    allowedStatus?: number,
  ) => {
    const response = await fetch(`https://api.github.com/${requestPath}`, {
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
    });
    if (!response.ok && response.status !== allowedStatus)
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message:
          "Unable to access the GitHub issue. Check the App's repository access and Issues permission.",
      });
    return response;
  };
  const issue = z
    .object({
      state: z.string(),
      pull_request: z.unknown().optional(),
      labels: z.array(z.object({ name: z.string() })),
    })
    .parse(await (await request()).json());
  if (issue.pull_request || issue.state !== "open")
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only open GitHub issues can be sent to the factory.",
    });
  return async () => {
    if (!issue.labels.some((label) => label.name.toLowerCase() === "factory")) {
      const labelPath = `repos/${repository}/labels/factory`;
      const label = await request(labelPath, "GET", undefined, 404);
      if (label.status === 404) {
        const created = await request(
          `repos/${repository}/labels`,
          "POST",
          JSON.stringify({
            name: "factory",
            color: "5319E7",
            description: "In the factory queue or being worked on",
          }),
          422,
        );
        // Another send may have created the label concurrently.
        if (created.status === 422) await request(labelPath);
      }
      const applied = await request(
        `${path}/labels`,
        "POST",
        JSON.stringify({ labels: ["factory"] }),
      );
      const labels = z
        .array(z.object({ name: z.string() }))
        .parse(await applied.json());
      if (!labels.some((label) => label.name.toLowerCase() === "factory"))
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: "GitHub did not add the factory label. Please try again.",
        });
    }
  };
}
