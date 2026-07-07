import { test, expect } from "@playwright/test";
import { OnboardingPage } from "../pages/onboarding.page";
import { DashboardPage } from "../pages/dashboard.page";

test.describe("Navigation", () => {
  let projectSlug: string;

  test("onboarding creates a project", async ({ page }) => {
    const onboarding = new OnboardingPage(page);
    await onboarding.goto();
    await onboarding.createProject("E2E Test Project", "http://localhost:3326");
    // After creation the page should navigate away from /onboarding
    await page.waitForTimeout(1500);
    const url = page.url();
    // Extract the slug from the URL — it should contain a non-onboarding path
    if (!url.includes("/onboarding")) {
      projectSlug = url.split("/").pop() ?? "";
    }
    expect(projectSlug.length).toBeGreaterThan(0);
  });

  test("sidebar links are visible on project dashboard", async ({ page }) => {
    test.skip(!projectSlug, "No project slug from previous test");
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    const links = await dashboard.sidebarLinks();
    expect(await links.count()).toBeGreaterThan(0);
  });
});
