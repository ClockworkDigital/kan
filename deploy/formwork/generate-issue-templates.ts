import { mkdirSync, writeFileSync } from "node:fs";

import { issueForms } from "../../packages/shared/src/issue-forms";

mkdirSync("deploy/formwork/issue-templates", { recursive: true });
for (const [kind, form] of Object.entries(issueForms)) {
  const fields = [
    {
      type: "input",
      id: "summary",
      attributes: { label: "Summary" },
      validations: { required: true },
    },
    ...form.fields.map((label, index) => ({
      type: "textarea",
      id: `field${index}`,
      attributes: { label },
      validations: { required: true },
    })),
  ];
  // JSON is a YAML subset accepted by GitHub's issue forms.
  writeFileSync(
    `deploy/formwork/issue-templates/${kind}.yml`,
    JSON.stringify(
      {
        name: form.name,
        description:
          kind === "bug"
            ? "Report a reproducible problem"
            : "Suggest an improvement",
        title: `[${form.name}] `,
        body: fields,
      },
      null,
      2,
    ) + "\n",
  );
}
