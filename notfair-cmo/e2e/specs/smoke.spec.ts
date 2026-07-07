import { test, expect } from "@playwright/test";

test.describe("Smoke tests", () => {
  test("login page renders", async ({ page }) => {
    const res = await page.goto("/login");
    expect(res?.ok()).toBe(true);
    await expect(page.locator("h1, h2")).toBeVisible();
  });

  test("onboarding page renders", async ({ page }) => {
    const res = await page.goto("/onboarding");
    expect(res?.ok()).toBe(true);
    await expect(page.locator("h1, h2")).toBeVisible();
  });

  test("dashboard (project list) renders", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.ok()).toBe(true);
  });

  test("static API routes respond 200", async ({ page }) => {
    const res = await page.goto("/api/version");
    expect(res?.ok()).toBe(true);
  });

  test("login page has sign-in form elements", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("input[type=email]").first()).toBeVisible();
    await expect(page.locator("button, [type=submit]").first()).toBeVisible();
  });
});
