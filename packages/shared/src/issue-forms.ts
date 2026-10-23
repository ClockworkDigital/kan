export const issueForms = {
  bug: {
    name: "Bug report",
    fields: [
      "Steps to reproduce",
      "Expected result",
      "Actual result",
      "Environment",
    ],
  },
  feature: { name: "Feature request", fields: ["Desired outcome"] },
} as const;

export const productionFields = [
  "Acceptance criteria",
  "Test plan",
  "Impact and risks",
] as const;
