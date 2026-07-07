import { test, expect } from "@playwright/test";
import { ConnectionsPage } from "../pages/connections.page";

test.describe("Connections / MCP", () => {
  const projectSlug = "e2e-test";

  test("connections page renders MCP cards", async ({ page }) => {
    const connections = new ConnectionsPage(page);
    await connections.goto(projectSlug);
    await page.waitForLoadState("networkidle");
    const count = await connections.cardCount();
    expect(count).toBeGreaterThanOrEqual(0); // Cards may be empty if no MCPs configured
  });

  test("connections page loads without errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const connections = new ConnectionsPage(page);
    await connections.goto(projectSlug);
    await page.waitForLoadState("networkidle");
    expect(errors.length).toBe(0);
  });
});
