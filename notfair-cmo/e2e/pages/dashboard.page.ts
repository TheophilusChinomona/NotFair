import { type Page, type Locator } from "@playwright/test";

export class DashboardPage {
  readonly page: Page;
  readonly sidebar: Locator;
  readonly projectName: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sidebar = page.locator("[class*=sidebar], aside, nav");
    this.projectName = page.locator("h1, [data-testid=project-name]");
  }

  async goto() {
    await this.page.goto("/");
  }

  async sidebarLinks() {
    return this.sidebar.locator("a");
  }

  /** Navigate via sidebar link containing `label` text */
  async navigateTo(label: string) {
    await this.sidebar.locator(`a:has-text("${label}")`).first().click();
    await this.page.waitForLoadState("networkidle");
  }
}
