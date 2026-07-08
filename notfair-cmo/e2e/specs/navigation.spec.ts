import { test, expect } from "@playwright/test";

const SLUG = "anchored-uniforms";
const NAV_TIMEOUT = 120000;

test.describe("Navigation", () => {
  test("project dashboard loads with sidebar and page content", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`/${SLUG}`, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });

    // Verify we're on the project page
    await expect(page).toHaveURL(/\/(anchored-uniforms)/);

    // Sidebar should be visible (shadcn Sidebar component)
    const sidebar = page.locator("[class*=sidebar], aside").first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Page should have rendered content
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 5000 });
  });
});
