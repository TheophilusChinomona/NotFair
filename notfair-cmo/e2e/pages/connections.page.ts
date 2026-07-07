import { type Page, type Locator } from "@playwright/test";

export class ConnectionsPage {
  readonly page: Page;
  readonly mcpCards: Locator;

  constructor(page: Page) {
    this.page = page;
    this.mcpCards = page.locator("[data-testid=mcp-card]");
  }

  async goto(projectSlug: string) {
    await this.page.goto(`/${projectSlug}/connections`);
  }

  async cardCount() {
    return this.mcpCards.count();
  }
}
