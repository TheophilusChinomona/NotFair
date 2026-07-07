import { test, expect } from "@playwright/test";
import { SettingsPage } from "../pages/settings.page";

test.describe("Settings", () => {
  const projectSlug = "e2e-test";

  test("settings page renders", async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto(projectSlug);
    await expect(settings.heading).toBeVisible();
  });
});
