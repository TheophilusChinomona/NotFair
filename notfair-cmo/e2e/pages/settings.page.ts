import { type Page, type Locator } from "@playwright/test";

export class SettingsPage {
  readonly page: Page;
  readonly heading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.locator("h1");
  }

  async goto(projectSlug: string) {
    await this.page.goto(`/${projectSlug}/settings`);
  }
}
