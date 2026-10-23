import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  installRepositoryPolicy,
  repositoryPolicyFiles,
} from "./github-policy";

describe("repository submission policy", () => {
  it("generates stricter Production forms and lighter Experiment forms", () => {
    const production = repositoryPolicyFiles(true);
    const experiment = repositoryPolicyFiles(false);
    const prod = JSON.parse(
      production[".github/ISSUE_TEMPLATE/formwork-feature.yml"] ?? "",
    ) as {
      body: {
        attributes: { label: string };
        validations: { required: boolean };
      }[];
    };
    expect(prod.body.map((field) => field.attributes.label)).toEqual([
      "Summary",
      "Desired outcome",
      "Acceptance criteria",
      "Test plan",
      "Impact and risks",
    ]);
    expect(prod.body.every((field) => field.validations.required)).toBe(true);
    const exp = JSON.parse(
      experiment[".github/ISSUE_TEMPLATE/formwork-feature.yml"] ?? "",
    ) as { body: unknown[] };
    expect(exp.body).toHaveLength(2);
  });
  it("executes the generated PR check without running PR code", () => {
    const workflow =
      repositoryPolicyFiles(true)[
        ".github/workflows/formwork-requirements.yml"
      ] ?? "";
    const script = workflow
      .split("node --input-type=module <<'NODE'\n")[1]
      ?.split("          NODE")[0]
      ?.replace(/^ {10}/gm, "");
    expect(script).toBeTruthy();
    const directory = mkdtempSync(join(tmpdir(), "kan-policy-"));
    try {
      const event = join(directory, "event.json");
      const check = (topics: string[], body: string) => {
        writeFileSync(event, JSON.stringify({ pull_request: { body } }));
        return spawnSync(process.execPath, ["--input-type=module"], {
          input: `globalThis.fetch = async () => ({ok:true,json:async()=>({topics:${JSON.stringify(topics)}})});\n${script}`,
          env: {
            ...process.env,
            GITHUB_EVENT_PATH: event,
            GITHUB_REPOSITORY: "ClockworkDigital/test",
            GH_TOKEN: "fake",
          },
          timeout: 10000,
        }).status;
      };
      expect(check(["experiment"], "")).toBe(0);
      expect(check(["production"], "")).not.toBe(0);
      expect(
        check(
          ["production"],
          "### Summary\nChange\n### Acceptance criteria\nWorks\n### Test plan\nRun checks\n### Impact and risks\nLow risk\n### Related issue\n#12",
        ),
      ).toBe(0);
      expect(check(["production"], "### Summary\n<!-- empty -->")).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("commits policy files without force and adds the required Production check", async () => {
    const responses = [
      { default_branch: "main" },
      { object: { sha: "old" } },
      { tree: { sha: "base" } },
      { truncated: false, tree: [] },
      { sha: "tree" },
      { sha: "commit" },
      {},
      [],
      {},
    ];
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(responses.shift()),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await installRepositoryPolicy("ClockworkDigital/test", true, "fake");
    const refWrite = fetchMock.mock.calls[6]?.[1] as RequestInit;
    expect(refWrite.method).toBe("PATCH");
    expect(JSON.parse(refWrite.body as string)).toEqual({
      sha: "commit",
      force: false,
    });
    const ruleWrite = fetchMock.mock.calls[8]?.[1] as RequestInit;
    expect(ruleWrite.body).toContain("Production submission requirements");
    expect(ruleWrite.body).toContain('"enforcement":"active"');
    vi.unstubAllGlobals();
  });
  it.each([
    ".github/ISSUE_TEMPLATE/custom.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/pull_request_template.md",
  ])(
    "refuses to overwrite existing %s before changing the branch",
    async (path) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ default_branch: "main" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ object: { sha: "commit" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tree: { sha: "tree" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              truncated: false,
              tree: [{ path, type: "blob" }],
            }),
        });
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        installRepositoryPolicy("ClockworkDigital/test", true, "fake"),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      vi.unstubAllGlobals();
    },
  );
});
