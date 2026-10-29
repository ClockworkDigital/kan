import { TRPCError } from "@trpc/server";
import { z } from "zod";

// Enumerate the intersection of this user's access and the App's selected repos.
export async function githubAppRepositories(token: string): Promise<unknown[]> {
  async function get(path: string) {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Reconnect GitHub in Kan settings.",
      });
    if (!response.ok) throw new Error("GitHub repository discovery failed");
    return response.json();
  }
  const repos = new Map<number, unknown>();
  for (let page = 1; page <= 100; page++) {
    const { installations } = z
      .object({
        installations: z.array(
          z.object({
            id: z.number().int().positive(),
            account: z.object({ login: z.string() }),
          }),
        ),
      })
      .parse(await get(`user/installations?per_page=100&page=${page}`));
    for (const installation of installations.filter(
      (i) => i.account.login.toLowerCase() === "clockworkdigital",
    )) {
      for (let repoPage = 1; repoPage <= 1000; repoPage++) {
        const { repositories } = z
          .object({
            repositories: z.array(
              z
                .object({
                  id: z.number().int().positive(),
                  full_name: z.string(),
                })
                .passthrough(),
            ),
          })
          .parse(
            await get(
              `user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,
            ),
          );
        for (const repo of repositories)
          if (repo.full_name.startsWith("ClockworkDigital/"))
            repos.set(repo.id, repo);
        if (repositories.length < 100) break;
        if (repoPage === 1000) throw new Error("Too many repositories");
      }
    }
    if (installations.length < 100) return [...repos.values()];
  }
  throw new Error("Too many installations");
}
