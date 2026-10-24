import { describe, expect, it } from "vitest";

import { parseGithubBoardName } from "./github-board-name";

describe("parseGithubBoardName", () => {
  it("splits the synced board name without changing its casing", () => {
    expect(parseGithubBoardName("GitHub: ClockworkDigital/formwork")).toEqual({
      owner: "ClockworkDigital",
      repo: "formwork",
    });
    expect(parseGithubBoardName("GitHub: my-org/repo.name-v2")).toEqual({
      owner: "my-org",
      repo: "repo.name-v2",
    });
  });

  it.each([
    "Project planning",
    "ClockworkDigital/formwork",
    "GitHub: formwork",
    "GitHub: /formwork",
    "GitHub: ClockworkDigital/",
    "GitHub: ClockworkDigital/formwork/extra",
    "GitHub: Team planning/my board",
  ])("keeps ordinary or incomplete board names intact: %s", (name) => {
    expect(parseGithubBoardName(name)).toBeNull();
  });
});
