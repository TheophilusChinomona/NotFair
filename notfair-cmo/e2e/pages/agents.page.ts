import { type Page, type Locator } from "@playwright/test";

export class AgentsPage {
  readonly page: Page;
  readonly agentList: Locator;
  readonly agentCards: Locator;

  constructor(page: Page) {
    this.page = page;
    this.agentList = page.locator("[data-testid=agent-list]");
    this.agentCards = page.locator("[data-testid=agent-card]");
  }

  async goto(projectSlug: string) {
    await this.page.goto(`/${projectSlug}/agents`);
  }

  async openAgent(name: string) {
    await this.page.locator(`text=${name}`).first().click();
    await this.page.waitForLoadState("networkidle");
  }

  async tab(name: string) {
    await this.page.locator(`[role=tab]:has-text("${name}")`).click();
    await this.page.waitForLoadState("networkidle");
  }
}
