import { expect, test } from "@playwright/test";

import { AuthPage } from "../support/pages/auth-page";
import { BoardPage } from "../support/pages/board-page";
import { MembersPage } from "../support/pages/members-page";
import { SelfHostedOnboardingPage } from "../support/pages/self-hosted-onboarding-page";
import { createTestUser } from "../support/test-user";
import { waitForTrpcMutation } from "../support/wait-for-trpc";

test(
  "an editor adds a board to the portfolio and a guest sees it read-only",
  { tag: "@self-hosted" },
  async ({ page, browser }) => {
    test.setTimeout(120_000);
    const owner = createTestUser();
    await new AuthPage(page).signUp(owner);
    await new SelfHostedOnboardingPage(page).createFirstWorkspace(
      "Portfolio workspace",
    );

    const board = new BoardPage(page);
    await board.createBoard("City Hop");
    await board.createList("To do");
    await board.createList("Done");
    await board.createCard("Refund edge cases", "To do");
    await board.createCard("Pilot sign-off", "Done");

    await page
      .getByRole("button", { name: "Board options", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Project details" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Busy" }).click();
    await expect(dialog.getByLabel("Client name(s)")).toBeDisabled();
    await dialog.getByRole("switch", { name: "Shown to client" }).click();
    await dialog.getByLabel("Client name(s)").fill("Transit partner");
    await dialog.getByRole("switch", { name: "Internal project" }).click();
    await dialog.getByLabel("Next steps").fill("Pilot sign-off");
    const saved = waitForTrpcMutation(page, "portfolio.update");
    await dialog.getByRole("button", { name: "Add to Portfolio" }).click();
    await saved;
    await expect(dialog).toBeHidden();

    await page.goto("/portfolio");
    const row = page.getByRole("row", { name: /City Hop/ });
    await expect(row).toContainText("Busy");
    await expect(row).toContainText("Yes");
    await expect(row).toContainText("Transit partner");
    await expect(row).toContainText("1 / 2");
    await expect(row).toContainText("Pilot sign-off");
    await expect(
      page.getByRole("button", { name: /Shown to clients/ }),
    ).toContainText("1");
    await page.getByRole("button", { name: /^Done/ }).click();
    await expect(page.getByText("No projects match")).toBeVisible();
    await page.getByRole("button", { name: /^All/ }).click();

    // Edit from the portfolio row and confirm the row updates.
    await row
      .getByRole("button", { name: "Edit project details for City Hop" })
      .click();
    await dialog.getByRole("button", { name: "Done" }).click();
    const edited = waitForTrpcMutation(page, "portfolio.update");
    await dialog.getByRole("button", { name: "Save" }).click();
    await edited;
    await expect(row).toContainText("Done");

    // A guest sees the same row but cannot edit it.
    const members = new MembersPage(page);
    await members.open();
    const inviteLink = await members.createInviteLink();
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    const guest = createTestUser();
    await new AuthPage(guestPage).signUp(guest);
    await new SelfHostedOnboardingPage(guestPage).createFirstWorkspace(
      "Guest's own workspace",
    );
    await guestPage.goto(inviteLink);
    await guestPage.waitForURL(/\/boards\?workspacePublicId=/, {
      timeout: 20_000,
    });
    await page.reload();
    await members.changeRole(guest.email, "guest");

    await guestPage.goto("/portfolio");
    const guestRow = guestPage.getByRole("row", { name: /City Hop/ });
    await expect(guestRow).toContainText("Done");
    await expect(guestRow).toContainText("Yes");
    await expect(guestRow.getByRole("button")).toHaveCount(0);
    await guestRow.getByRole("link", { name: "City Hop" }).click();
    await guestPage.waitForURL(/\/boards\/[^/]+$/);
    await guestContext.close();
  },
);
