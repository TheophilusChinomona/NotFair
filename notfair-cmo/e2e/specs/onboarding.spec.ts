import { test, expect } from "@playwright/test";
import { OnboardingPage } from "../pages/onboarding.page";

test.describe("Onboarding flow", () => {
  test("shows the form on initial load", async ({ page }) => {
    test.setTimeout(120000);
    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    await expect(onboarding.createButton).toBeVisible({ timeout: 10000 });
    await expect(onboarding.projectNameInput).toBeVisible({ timeout: 10000 });
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
