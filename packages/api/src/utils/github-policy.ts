import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { issueForms, productionFields } from "@kan/shared";

export function repositoryPolicyFiles(production: boolean) {
  const files: Record<string, string> = {};
  for (const [kind, form] of Object.entries(issueForms)) {
    const fields = [
      "Summary",
      ...form.fields,
      ...(production ? productionFields : []),
    ];
    files[`.github/ISSUE_TEMPLATE/formwork-${kind}.yml`] = JSON.stringify(
      {
        name: form.name,
        description: `Submit a ${production ? "Production" : "Experiment"} ${form.name.toLowerCase()}`,
        body: fields.map((label, index) => ({
          type: "textarea",
          id: `field${index}`,
          attributes: { label },
          validations: { required: true },
        })),
      },
      null,
      2,
    );
  }
  files[".github/ISSUE_TEMPLATE/config.yml"] = "blank_issues_enabled: false\n";
  files[".github/pull_request_template.md"] = [
    "Summary",
    ...(production ? productionFields : []),
    ...(production ? ["Related issue"] : []),
  ]
    .map((label) => `### ${label}\n\n`)
    .join("\n");
  files[".github/workflows/formwork-requirements.yml"] =
    `name: Formwork requirements
on:
  pull_request_target:
    types: [opened, edited, reopened, synchronize, ready_for_review]
permissions:
  contents: read
jobs:
  requirements:
    name: Production submission requirements
    runs-on: ubuntu-latest
    steps:
      - name: Validate required information
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          node --input-type=module <<'NODE'
          import fs from 'node:fs';
          const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
          const headers = { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json' };
          const response = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY, { headers });
          if (!response.ok) throw new Error('Cannot verify repository classification');
          const repo = await response.json();
          if ((repo.topics || []).includes('production')) {
            const body = event.pull_request.body || '';
            const required = ${JSON.stringify(["Summary", ...productionFields, "Related issue"])};
            for (const field of required) {
              const sections = body.split(/^### /m).slice(1);
              const section = sections.find(section => section.split('\\n')[0].trim() === field);
              const answer = section ? section.slice(section.indexOf('\\n') + 1).replace(/<!--[\\s\\S]*?-->/g, '').trim() : '';
              if (!answer) throw new Error('Complete: ' + field);
              if (field === 'Related issue' && !/(?:#\\d+|https:\\/\\/github\\.com\\/[^\\s]+\\/issues\\/\\d+)/.test(answer)) throw new Error('Reference a GitHub issue');
            }
          }
          NODE
`;
  return files;
}

// Install in one Git commit; never force-push or overwrite unrelated templates.
export async function installRepositoryPolicy(
  repo: string,
  production: boolean,
  token: string,
) {
  async function request(
    path: string,
    body?: unknown,
    method = "POST",
  ): Promise<unknown> {
    const response = await fetch(
      `https://api.github.com/repos/${repo}${path ? "/" + path : ""}`,
      {
        method: body === undefined ? "GET" : method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok)
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: `GitHub policy setup returned HTTP ${response.status}. Contents, Workflows and Administration write permissions are required. Some policy files may already be installed; classification was not updated.`,
      });
    return response.json();
  }
  const metadata = z
    .object({ default_branch: z.string() })
    .parse(await request(""));
  const ref = z
    .object({ object: z.object({ sha: z.string() }) })
    .parse(
      await request(
        `git/ref/heads/${encodeURIComponent(metadata.default_branch)}`,
      ),
    );
  const commit = z
    .object({ tree: z.object({ sha: z.string() }) })
    .parse(await request(`git/commits/${ref.object.sha}`));
  const tree = z
    .object({
      truncated: z.boolean(),
      tree: z.array(z.object({ path: z.string(), type: z.string() })),
    })
    .parse(await request(`git/trees/${commit.tree.sha}?recursive=1`));
  if (tree.truncated)
    throw new TRPCError({
      code: "CONFLICT",
      message: "Repository tree is too large for automatic policy setup.",
    });
  const files = repositoryPolicyFiles(production);
  const managed = new Set(Object.keys(files));
  const hasManagedFiles = tree.tree.some((item) => managed.has(item.path));
  const hasManagedWorkflow = tree.tree.some(
    (item) => item.path === ".github/workflows/formwork-requirements.yml",
  );
  if (hasManagedFiles && !hasManagedWorkflow)
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Existing submission files need an explicit migration before applying a shared policy.",
    });

  // Existing forms can bypass the Production form; leave them for an explicit migration.
  if (
    tree.tree.some(
      (item) =>
        item.type === "blob" &&
        ((item.path.startsWith(".github/ISSUE_TEMPLATE/") &&
          !managed.has(item.path)) ||
          (/pull_request_template/i.test(item.path) &&
            !managed.has(item.path))),
    )
  )
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This repository has custom templates. Migrate them before applying a shared policy.",
    });
  const nextTree = z.object({ sha: z.string() }).parse(
    await request("git/trees", {
      base_tree: commit.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({
        path,
        mode: "100644",
        type: "blob",
        content,
      })),
    }),
  );
  const nextCommit = z.object({ sha: z.string() }).parse(
    await request("git/commits", {
      message: `feat: apply ${production ? "Production" : "Experiment"} submission requirements`,
      tree: nextTree.sha,
      parents: [ref.object.sha],
    }),
  );
  await request(
    `git/refs/heads/${encodeURIComponent(metadata.default_branch)}`,
    { sha: nextCommit.sha, force: false },
    "PATCH",
  );
  if (production) {
    const rule = {
      name: "Formwork Production submission requirements",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "Production submission requirements" },
            ],
            strict_required_status_checks_policy: true,
          },
        },
      ],
    };
    const rules = z
      .array(z.object({ id: z.number(), name: z.string() }))
      .parse(await request("rulesets?per_page=100"));
    const existing = rules.find((item) => item.name === rule.name);
    await request(
      existing ? `rulesets/${existing.id}` : "rulesets",
      rule,
      existing ? "PUT" : "POST",
    );
  }
}
