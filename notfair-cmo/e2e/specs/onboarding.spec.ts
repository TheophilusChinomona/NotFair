import { test, expect } from "@playwright/test";
import { OnboardingPage } from "../pages/onboarding.page";

const NAV_TIMEOUT = 120000;

test.describe("Onboarding flow", () => {
  test("shows recommended MCP connector tiles", async ({ page }) => {
    test.setTimeout(120000);
    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });
    const tiles = onboarding.recommendedTiles;
    await expect(tiles.first()).toBeVisible({ timeout: 10000 });
    expect(await tiles.count()).toBeGreaterThanOrEqual(3);
  });

  test("create project form has a name input", async ({ page }) => {
    test.setTimeout(120000);
    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    await expect(onboarding.projectNameInput).toBeVisible({ timeout: 10000 });
  });

  test("has a create button", async ({ page }) => {
    test.setTimeout(120000);
    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    await expect(onboarding.createButton).toBeVisible({ timeout: 10000 });
  });
});
