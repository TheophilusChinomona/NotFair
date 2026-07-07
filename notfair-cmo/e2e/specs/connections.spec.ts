import { test, expect } from "@playwright/test";
import { ConnectionsPage } from "../pages/connections.page";

const NAV_TIMEOUT = 120000;

test.describe("Connections / MCP", () => {
  test("connections page renders without errors", async ({ page }) => {
    test.setTimeout(120000);
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    const connections = new ConnectionsPage(page);
    await connections.goto("anchored-uniforms");
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT });

    expect(errors.length).toBe(0);
  });
});
