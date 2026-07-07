import { test, expect } from "@playwright/test";
import { SettingsPage } from "../pages/settings.page";

const NAV_TIMEOUT = 120000;

test.describe("Settings", () => {
  test("settings page renders for existing project", async ({ page }) => {
    test.setTimeout(120000);
    const settings = new SettingsPage(page);
    await settings.goto("anchored-uniforms");
    await expect(settings.heading).toBeVisible({ timeout: 10000 });
  });
});
