import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 60000,
  expect: { timeout: 10000 },
  testDir: "./specs",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["html", { outputFolder: "../playwright-report" }], ["line"]],
  use: {
    baseURL: "http://localhost:3326",
    browserName: "chromium",
    navigationTimeout: 120000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
