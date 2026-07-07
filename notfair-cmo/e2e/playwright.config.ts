import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["html", { outputFolder: "../playwright-report" }], ["line"]],
  use: {
    baseURL: "http://localhost:3326",
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
