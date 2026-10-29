import { z } from "zod";

const counts = z.object({
  open: z.object({ totalCount: z.number().int().nonnegative() }),
  closed: z.object({ totalCount: z.number().int().nonnegative() }),
});

// Repository.issues excludes pull requests and includes issues never imported by sync.
export async function githubIssueCounts(token: string, repositories: string[]) {
  const result = new Map<string, { done: number; total: number }>();
  for (let start = 0; start < repositories.length; start += 50) {
    const batch = repositories.slice(start, start + 50);
    const query = batch
      .map((name, i) => {
        const [owner, repo] = name.split("/");
        return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
        open: issues(states: OPEN) { totalCount }
        closed: issues(states: CLOSED) { totalCount }
      }`;
      })
      .join("\n");
    try {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: `query { ${query} }` }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) continue;
      const payload = z
        .object({ data: z.record(z.unknown()).nullish() })
        .parse(await response.json());
      batch.forEach((name, i) => {
        const parsed = counts.safeParse(payload.data?.[`r${i}`]);
        if (parsed.success)
          result.set(name, {
            done: parsed.data.closed.totalCount,
            total: parsed.data.open.totalCount + parsed.data.closed.totalCount,
          });
      });
    } catch {
      // An inaccessible repository or failed batch stays unavailable, never zero.
    }
  }
  return result;
}
