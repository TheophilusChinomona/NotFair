import { test, expect } from "@playwright/test";

const SLUG = "anchored-uniforms";
const NAV_TIMEOUT = 120000;

test.describe("Navigation", () => {
  test("project dashboard has sidebar elements", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`/${SLUG}`, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });

    // Sidebar should be visible (shadcn Sidebar component)
    const sidebar = page.locator("[class*=sidebar], aside").first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Check for key workspace links containing the project slug
    // (sidebar may be in icon mode, so links use SVG icons + aria-labels)
    const homeLink = page.locator(`a[href*="/${SLUG}"]`).first();
    await expect(homeLink).toBeVisible({ timeout: 10000 });
  });

  test("can navigate to project-specific pages", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`/${SLUG}`, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });

    // Verify the page rendered and we're on the project page
    await expect(page).toHaveURL(/\/(anchored-uniforms)/);
    await expect(page.locator("h1, [class*=project-name]").first()).toBeVisible({ timeout: 5000 });
  });
});
