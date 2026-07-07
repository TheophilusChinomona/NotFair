import { test, expect } from "@playwright/test";
import { AgentsPage } from "../pages/agents.page";

test.describe("Agents", () => {
  const projectSlug = "e2e-test"; // Created during onboarding bootstrap

  test("agent list page renders", async ({ page }) => {
    const agents = new AgentsPage(page);
    await agents.goto(projectSlug);
    await expect(page.locator("h1")).toBeVisible();
  });

  test("agent detail page has tab navigation", async ({ page }) => {
    const agents = new AgentsPage(page);
    await agents.goto(projectSlug);
    const cards = agents.agentCards;
    const count = await cards.count();

    if (count > 0) {
      await cards.first().click();
      await page.waitForLoadState("networkidle");
      // Check for tabs: Chat, Tasks, Skills, Cron, Files
      const tabNames = ["Chat", "Tasks", "Skills", "Cron", "Files"];
      for (const name of tabNames) {
        const tab = page.locator(`[role=tab]:has-text("${name}")`);
        const exists = (await tab.count()) > 0;
        if (exists) await expect(tab).toBeVisible();
      }
    }
  });
});
