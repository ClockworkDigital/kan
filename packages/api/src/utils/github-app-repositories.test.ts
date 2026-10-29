import { afterEach, expect, it, vi } from "vitest";

import { githubAppRepositories } from "./github-app-repositories";

afterEach(() => vi.unstubAllGlobals());
it("discovers only installation repositories available to the current user", async () => {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        installations: [
          { id: 1, account: { login: "ClockworkDigital" } },
          { id: 2, account: { login: "other" } },
        ],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        repositories: [
          {
            id: 123,
            full_name: "ClockworkDigital/selected",
            permissions: { push: false },
          },
        ],
      }),
    );
  vi.stubGlobal("fetch", mock);
  expect(await githubAppRepositories("viewer-token")).toEqual([
    {
      id: 123,
      full_name: "ClockworkDigital/selected",
      permissions: { push: false },
    },
  ]);
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock.mock.calls[1]?.[0]).toBe(
    "https://api.github.com/user/installations/1/repositories?per_page=100&page=1",
  );
  expect(mock.mock.calls[1]?.[1]).toMatchObject({
    headers: { Authorization: "Bearer viewer-token" },
  });
});
it("fails closed on inaccessible installation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
  );
  await expect(githubAppRepositories("viewer-token")).rejects.toThrow();
});

it("returns an empty list for an installation with no accessible repositories", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          installations: [{ id: 1, account: { login: "ClockworkDigital" } }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ repositories: [] })),
  );
  expect(await githubAppRepositories("viewer-token")).toEqual([]);
});
it("asks for reconnection when authorization has been revoked", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
  );
  await expect(githubAppRepositories("revoked")).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    message: "Reconnect GitHub in Kan settings.",
  });
});
