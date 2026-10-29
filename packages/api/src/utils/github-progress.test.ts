import { afterEach, expect, it, vi } from "vitest";

import { githubIssueCounts } from "./github-progress";

afterEach(() => vi.unstubAllGlobals());
it("keeps partial inaccessible repositories unavailable and accepts real empty totals", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            r0: { open: { totalCount: 0 }, closed: { totalCount: 0 } },
            r1: null,
          },
          errors: [{ message: "not found", path: ["r1"] }],
        }),
      ),
    ),
  );
  const counts = await githubIssueCounts("token", ["org/empty", "org/private"]);
  expect(counts.get("org/empty")).toEqual({ done: 0, total: 0 });
  expect(counts.has("org/private")).toBe(false);
});
it("batches repository requests", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: {} }))),
    );
  vi.stubGlobal("fetch", fetcher);
  await githubIssueCounts(
    "token",
    Array.from({ length: 51 }, (_, i) => `org/repo${i}`),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});
