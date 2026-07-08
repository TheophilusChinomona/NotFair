import { test, expect } from "@playwright/test";

const SLUG = "anchored-uniforms";
const NAV_TIMEOUT = 120000;

test.describe("Navigation", () => {
  test("project dashboard has sidebar with nav links", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`/${SLUG}`, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });
    const sidebar = page.locator("[class*=sidebar], aside").first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });
    const links = sidebar.locator("a");
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(3);
    const linkTexts = await links.allTextContents();
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
    await sidebar.locator(`a:has-text("Connections")`).first().click();
    await page.waitForURL("**/connections", { timeout: NAV_TIMEOUT });
    expect(page.url()).toContain("/connections");
  });

  test("can navigate to settings page via sidebar", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`/${SLUG}`, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });
    const sidebar = page.locator("[class*=sidebar], aside").first();
    await sidebar.locator(`a:has-text("Settings")`).first().click();
    await page.waitForURL("**/settings", { timeout: NAV_TIMEOUT });
    expect(page.url()).toContain("/settings");
  });
});
