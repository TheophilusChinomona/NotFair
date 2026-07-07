import { test, expect } from "@playwright/test";

const NAV_TIMEOUT = 120000;

test.describe("Smoke tests", () => {
  // Warm up — first compile is slow, and server may need a warmup
  test("warmup: app boots", async ({ page }) => {
    test.setTimeout(120000);
    const res = await page.goto("/api/version", { timeout: NAV_TIMEOUT });
    expect(res?.ok()).toBe(true);
  });

  test("login page renders", async ({ page }) => {
    test.setTimeout(120000);
    const res = await page.goto("/login", { timeout: NAV_TIMEOUT });
    expect(res?.ok()).toBe(true);
    await expect(page.locator("h1, h2")).toBeVisible({ timeout: 10000 });
  });

  test("onboarding page renders", async ({ page }) => {
    test.setTimeout(120000);
    const res = await page.goto("/onboarding", { timeout: NAV_TIMEOUT });
    expect(res?.ok()).toBe(true);
    await expect(page.locator("h1, h2")).toBeVisible({ timeout: 10000 });
  });

  test("login page has sign-in form elements", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto("/login", { timeout: NAV_TIMEOUT });
    await expect(page.locator("input[type=email]").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("button, [type=submit]").first()).toBeVisible({ timeout: 10000 });
  });
});
