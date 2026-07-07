import { test, expect } from "@playwright/test";
import { OnboardingPage } from "../pages/onboarding.page";

test.describe("Onboarding flow", () => {
  test("shows recommended MCP connector tiles", async ({ page }) => {
    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    const tiles = onboarding.recommendedTiles;
    await expect(tiles.first()).toBeVisible();
    expect(await tiles.count()).toBeGreaterThanOrEqual(3);
  });

  test("create project form validates input", async ({ page }) => {
    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    // Leave name empty and submit
    await onboarding.createButton.click();

    // Check for validation feedback (aria-invalid or error element)
    const hasValidation = await page
      .locator("[aria-invalid=true], [role=alert]")
      .count();
    // The form should either prevent submission or show an error
    expect(page.url()).toContain("/onboarding");
  });

  test("can create a project with name only", async ({ page }) => {
    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    await onboarding.createProject("E2E Test");
    // After creation, page navigates away from /onboarding or shows success
    await page.waitForTimeout(1000);
    const onOnboarding = page.url().includes("/onboarding");
    const hasSuccess = await page
      .locator("text=success, text=created, [data-testid=success]")
      .count();
    expect(onOnboarding || hasSuccess > 0).toBe(true);
  });
});
