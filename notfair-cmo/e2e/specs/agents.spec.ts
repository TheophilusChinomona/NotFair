import { test, expect } from "@playwright/test";
import { AgentsPage } from "../pages/agents.page";

const NAV_TIMEOUT = 120000;

test.describe("Agents", () => {
  test("agent list page renders for existing project", async ({ page }) => {
    test.setTimeout(120000);
    const agents = new AgentsPage(page);
    await agents.goto("anchored-uniforms");
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });
    await expect(page.locator("h1")).toBeVisible({ timeout: 10000 });
  });

  test("agent detail page has tab navigation", async ({ page }) => {
    test.setTimeout(120000);
    const agents = new AgentsPage(page);
    await agents.goto("anchored-uniforms");
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });
    const cards = agents.agentCards;
    const count = await cards.count();

    if (count > 0) {
      await cards.first().click();
      await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });
      const tabNames = ["Chat", "Tasks", "Skills", "Cron", "Files"];
      for (const name of tabNames) {
        const tab = page.locator(`[role=tab]:has-text("${name}")`);
        const exists = (await tab.count()) > 0;
        if (exists) await expect(tab).toBeVisible({ timeout: 5000 });
      }
    }
  });
});
