import { expect, request, test } from "@playwright/test";

import { createTestUser } from "../support/test-user";

test("factory reports update the dashboard and survive reload and connection loss", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(180000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const user = createTestUser();
  const signup = await page.request.post("/api/auth/sign-up/email", {
    data: user,
  });
  expect(signup.ok()).toBe(true);
  const created = await page.request.post("/api/v1/workspaces", {
    data: { name: "Factory test workspace" },
  });
  expect(created.ok()).toBe(true);
  const workspace = (await created.json()) as { publicId: string };
  const keyResponse = await page.request.post("/api/auth/api-key/create", {
    headers: { Origin: baseURL ?? "" },
    data: { name: "Factory test", expiresIn: 86400 },
  });
  expect(keyResponse.ok()).toBe(true);
  const key = (await keyResponse.json()) as { key: string; id: string };
  const publisher = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${key.key}` },
  });
  const endpoint = `/api/v1/workspaces/${workspace.publicId}/factory/jobs`;
  const report = {
    repository: "ClockworkDigital/kan",
    runKey: "sample-run",
    revision: 1,
    snapshot: {
      title: "Sample factory run",
      stage: "building",
      issueNumber: 1,
      prNumber: null as number | null,
      risk: "high",
      builderModel: "test-builder",
      estimatedCostUsd: 0.12,
      elapsedSeconds: 10,
      rounds: [
        {
          round: 1,
          gate: "pending",
          reviews: [{ name: "security", result: "pending", summary: "" }],
        },
      ],
    },
    artifacts: [
      {
        name: "spec.md",
        content:
          "A sample specification. <script>window.artifactExecuted = true</script>",
      },
      { name: "build.md", content: "Implemented the sample." },
      { name: "checks.md", content: "Round 1 failed. Round 2 passed." },
      { name: "review.md", content: "Security review passed." },
    ],
  };
  try {
    expect((await publisher.put(endpoint, { data: report })).ok()).toBe(true);
    await page.goto("/factory");
    await expect(
      page.getByRole("heading", { name: "Sample factory run", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    const card = page.getByRole("article");
    await expect(card.getByText("Building", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "Issue #1" })).toHaveAttribute(
      "href",
      "https://github.com/ClockworkDigital/kan/issues/1",
    );
    await expect(card.getByText("test-builder")).toBeVisible();
    for (const [stage, label] of [
      ["checks", "Checks"],
      ["rework", "Rework"],
      ["review", "Review"],
      ["completed", "Completed"],
    ] as const) {
      report.revision++;
      report.snapshot.stage = stage;
      report.snapshot.rounds = [
        { round: 1, gate: "fail", reviews: [] },
        {
          round: 2,
          gate: stage === "checks" || stage === "rework" ? "pending" : "pass",
          reviews: [
            {
              name: "security",
              result: stage === "completed" ? "pass" : "pending",
              summary: "",
            },
          ],
        },
      ];
      report.snapshot.prNumber = stage === "completed" ? 24 : null;
      expect((await publisher.put(endpoint, { data: report })).ok()).toBe(true);
      await expect(card.getByText(label, { exact: true })).toBeVisible({
        timeout: 15000,
      });
    }
    await page.reload();
    await expect(card.getByText("Completed", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await card.getByText("Inspect artifacts", { exact: true }).click();
    await page.getByText("spec.md", { exact: true }).click();
    await expect(page.locator("pre:visible")).toContainText("<script>");
    expect(
      await page.evaluate(() => Object.hasOwn(window, "artifactExecuted")),
    ).toBe(false);
    await page.route("**/api/trpc/factory.list*", (route) => route.abort());
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Unable to load factory jobs" }),
    ).toContainText("Unable to load factory jobs", { timeout: 15000 });
    await page.unroute("**/api/trpc/factory.list*");
    await expect(card.getByText("Completed", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await card.getByText("Inspect artifacts", { exact: true }).click();
    await expect(page.getByText("review.md", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("factory-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("navigation")).not.toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath("factory-mobile.png"),
      fullPage: true,
    });

    for (let index = 1; index < 8; index++) {
      expect(
        (
          await publisher.put(endpoint, {
            data: {
              ...report,
              runKey: `sample-run-${index}`,
              snapshot: { ...report.snapshot, title: `Sample run ${index}` },
            },
          })
        ).ok(),
      ).toBe(true);
    }
    await expect(page.getByRole("article")).toHaveCount(8, { timeout: 15000 });
    for (let index = 1; index < 8; index++) {
      const extraCard = page.getByRole("article").filter({
        has: page.getByRole("heading", {
          name: `Sample run ${index}`,
          exact: true,
        }),
      });
      await extraCard.getByText("Inspect artifacts", { exact: true }).click();
      await expect(
        extraCard.getByText("review.md", { exact: true }),
      ).toBeVisible();
    }
    let listReads = 0;
    let artifactReads = 0;
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path.includes("factory.list")) listReads++;
      if (path.includes("factory.byId")) artifactReads++;
    });
    await expect
      .poll(() => listReads, { timeout: 15000 })
      .toBeGreaterThanOrEqual(2);
    expect(artifactReads).toBe(0);
    const updatedCard = page.getByRole("article").filter({
      has: page.getByRole("heading", {
        name: "Sample factory run",
        exact: true,
      }),
    });
    await updatedCard.getByText("spec.md", { exact: true }).click();
    report.revision++;
    report.artifacts = [{ name: "spec.md", content: "Updated specification." }];
    expect((await publisher.put(endpoint, { data: report })).ok()).toBe(true);
    await expect(updatedCard.locator("pre:visible")).toHaveText(
      "Updated specification.",
      { timeout: 15000 },
    );
    expect(artifactReads).toBe(1);
    let abortedArtifactReads = 0;
    await page.route("**/api/trpc/factory.byId*", (route) => {
      if (abortedArtifactReads < 2) {
        abortedArtifactReads++;
        return route.abort();
      }
      return route.continue();
    });
    report.revision++;
    report.artifacts = [
      { name: "spec.md", content: "Recovered specification." },
    ];
    expect((await publisher.put(endpoint, { data: report })).ok()).toBe(true);
    await expect(updatedCard.locator("pre")).toHaveText(
      "Recovered specification.",
      { timeout: 15000 },
    );
    await expect(updatedCard.getByRole("alert")).not.toBeVisible();
    expect(abortedArtifactReads).toBe(2);
    expect(artifactReads).toBe(4);
    await page.unroute("**/api/trpc/factory.byId*");
    expect(browserErrors).toEqual([]);
    const unauthorized = await request.newContext({ baseURL });
    expect((await unauthorized.get(endpoint)).status()).toBe(401);
    await unauthorized.dispose();
  } finally {
    await testInfo.attach("browser-errors", {
      body: JSON.stringify(browserErrors),
      contentType: "application/json",
    });
    await publisher.dispose();
    await page.request.post("/api/auth/api-key/delete", {
      headers: { Origin: baseURL ?? "" },
      data: { keyId: key.id },
    });
  }
});
