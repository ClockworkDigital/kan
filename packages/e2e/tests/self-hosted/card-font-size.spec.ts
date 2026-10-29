import { expect, test } from "@playwright/test";

import { AuthPage } from "../support/pages/auth-page";
import { BoardPage } from "../support/pages/board-page";
import { CardPage } from "../support/pages/card-page";
import { DashboardPage } from "../support/pages/dashboard-page";
import { SelfHostedOnboardingPage } from "../support/pages/self-hosted-onboarding-page";
import { createTestUser } from "../support/test-user";

test("card titles and descriptions follow the saved text size", async ({
  page,
}) => {
  const user = createTestUser();
  await new AuthPage(page).signUp(user);
  await new SelfHostedOnboardingPage(page).createFirstWorkspace(
    "Typography test",
  );
  await new DashboardPage(page).expectSignedInAs(user);
  const board = new BoardPage(page);
  await board.createBoard("Typography board");
  await board.createList("To do");
  await board.createCard("Mixed CASE card title");
  const boardUrl = page.url();
  await board.openCard("Mixed CASE card title");
  await new CardPage(page).editDescription("Mixed CASE description");
  const cardUrl = page.url();

  for (const [preference, size] of [
    ["small", "14px"],
    ["medium", "16px"],
    ["large", "18px"],
  ] as const) {
    await page.goto("/settings/account");
    await page.locator("#font-size-select").selectOption(preference);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("fontSize")))
      .toBe(preference);
    await page.goto(boardUrl);
    await expect(
      page.getByText("Mixed CASE card title", { exact: true }),
    ).toHaveCSS("font-size", size);
    await page.goto(cardUrl);
    await expect(page.locator("textarea.card-body")).toHaveCSS(
      "font-size",
      size,
    );
    const description = page.getByText("Mixed CASE description", {
      exact: true,
    });
    await expect(description).toHaveCSS("font-size", size);
    await expect(description).toHaveCSS("text-transform", "none");
    await page.reload();
    await expect(description).toHaveCSS("font-size", size);
  }
});
