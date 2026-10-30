import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("signs an app JWT, mints a ClockworkDigital installation token and reuses it", async () => {
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv-test");
  vi.stubEnv(
    "GITHUB_APP_PRIVATE_KEY",
    Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString(
      "base64",
    ),
  );
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 7 }) })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token: "inst", expires_at: expires }),
    });
  vi.stubGlobal("fetch", fetch);
  const { githubInstallationToken } = await import("./github-installation");

  expect(await githubInstallationToken()).toBe("inst");
  expect(await githubInstallationToken()).toBe("inst");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/orgs/ClockworkDigital/installation",
  );
  expect(fetch.mock.calls[1]).toEqual([
    "https://api.github.com/app/installations/7/access_tokens",
    expect.objectContaining({ method: "POST", redirect: "error" }),
  ]);
  const jwt = String(
    new Headers(
      (fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
    ).get("Authorization"),
  ).slice("Bearer ".length);
  const [header, payload, signature] = jwt.split(".");
  expect(
    createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, String(signature), "base64url"),
  ).toBe(true);
  expect(
    JSON.parse(Buffer.from(String(payload), "base64url").toString()),
  ).toMatchObject({
    iss: "Iv-test",
  });
});

it("fails when GitHub refuses the app", async () => {
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv-test");
  vi.stubEnv(
    "GITHUB_APP_PRIVATE_KEY",
    Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString(
      "base64",
    ),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
  const { githubInstallationToken } = await import("./github-installation");
  await expect(githubInstallationToken()).rejects.toThrow("HTTP 401");
});

it("reads repository descriptions and last pushes as the app and caches them", async () => {
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv-test");
  vi.stubEnv(
    "GITHUB_APP_PRIVATE_KEY",
    Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString(
      "base64",
    ),
  );
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 7 }) })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token: "inst", expires_at: expires }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            full_name: "ClockworkDigital/Kan",
            description: " Boards ",
            pushed_at: "2026-10-30T06:00:00Z",
          },
          {
            full_name: "ClockworkDigital/empty",
            description: null,
            pushed_at: null,
          },
        ]),
    });
  vi.stubGlobal("fetch", fetch);
  const { githubRepositories } = await import("./github-installation");

  const repositories = await githubRepositories();
  expect([...repositories]).toEqual([
    [
      "clockworkdigital/kan",
      { description: "Boards", pushedAt: new Date("2026-10-30T06:00:00Z") },
    ],
    ["clockworkdigital/empty", { description: null, pushedAt: null }],
  ]);
  expect(await githubRepositories()).toBe(repositories);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(
    new Headers(
      (fetch.mock.calls[2]?.[1] as RequestInit | undefined)?.headers,
    ).get("Authorization"),
  ).toBe("Bearer inst");
});

it("returns no repositories when the app is not configured", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const { githubRepositories } = await import("./github-installation");
  expect((await githubRepositories()).size).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["write", "read", undefined])(
  "retains the minted token's Issues permission (%s)",
  async (issues) => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv-test");
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString(
        "base64",
      ),
    );
    const expires = new Date(Date.now() + 3600_000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: 7 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              token: "inst",
              expires_at: expires,
              permissions: issues ? { issues } : undefined,
            }),
        }),
    );
    const { githubInstallationAccess, githubInstallationToken } = await import(
      "./github-installation"
    );
    const access = await githubInstallationAccess();
    expect(access.issuesWrite).toBe(issues === "write");
    expect(await githubInstallationAccess()).toBe(access);
    expect(await githubInstallationToken()).toBe("inst");
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);
