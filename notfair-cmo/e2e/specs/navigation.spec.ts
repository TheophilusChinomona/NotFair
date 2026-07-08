import { test, expect } from "@playwright/test";

const SLUG = "anchored-uniforms";
const NAV_TIMEOUT = 120000;

test.describe("Navigation", () => {
  async function expectSidebarHasLinks(page: import("@playwright/test").Page, min: number) {
    const sidebar = page.locator("[class*=sidebar], aside").first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });
    // Client-side rendered links may take time — retry until count is reached
    await expect(async () => {
      const count = await sidebar.locator("a").count();
      expect(count).toBeGreaterThanOrEqual(min);
    }).toPass({ timeout: 15000 });
  }

  test("project dashboard has sidebar with nav links", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`/${SLUG}`, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });

    const sidebar = page.locator("[class*=sidebar], aside").first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });
    await expect(async () => {
      const count = await sidebar.locator("a").count();
      expect(count).toBeGreaterThanOrEqual(3);
    }).toPass({ timeout: 15000 });

    const linkTexts = await sidebar.locator("a").allTextContents();
    const fullText = linkTexts.join(" ");
    expect(fullText).toContain("Home");
    expect(fullText).toContain("Connections");
    expect(fullText).toContain("Settings");
  });

  test("can navigate to connections page via sidebar", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`/${SLUG}`, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });

    const sidebar = page.locator("[class*=sidebar], aside").first();
    await expectSidebarHasLinks(page, 3);
    await sidebar.locator(`a:has-text("Connections")`).first().click();
    await page.waitForURL("**/connections", { timeout: NAV_TIMEOUT });
    expect(page.url()).toContain("/connections");
  });

  test("can navigate to settings page via sidebar", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`/${SLUG}`, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });

    const sidebar = page.locator("[class*=sidebar], aside").first();
    await expectSidebarHasLinks(page, 3);
    await sidebar.locator(`a:has-text("Settings")`).first().click();
    await page.waitForURL("**/settings", { timeout: NAV_TIMEOUT });
    expect(page.url()).toContain("/settings");
  });
});
