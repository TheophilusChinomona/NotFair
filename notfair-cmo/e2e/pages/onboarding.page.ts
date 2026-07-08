import { type Page, type Locator } from "@playwright/test";

export class OnboardingPage {
  readonly page: Page;
  readonly projectNameInput: Locator;
  readonly websiteUrlInput: Locator;
  readonly createButton: Locator;
  readonly recommendedTiles: Locator;

  constructor(page: Page) {
    this.page = page;
    this.projectNameInput = page.locator("input[placeholder*='Acme'], input[id*=name], input[name=name]");
    this.websiteUrlInput = page.locator("#website_url, input[name=website_url]");
    this.createButton = page.locator("button[type=submit], button:has-text('Create')");
    this.recommendedTiles = page.locator("[data-mcp-key], [class*=connector], [class*=tile]");
  }

  async goto() {
    await this.page.goto("/onboarding");
  }

  async createProject(name: string, websiteUrl?: string) {
    await this.projectNameInput.fill(name);
    if (websiteUrl) await this.websiteUrlInput.fill(websiteUrl);
    await this.createButton.click();
    await this.page.waitForLoadState("networkidle");
  }

  async connectTile(mcpKey: string) {
    await this.page.locator(`[data-mcp-key="${mcpKey}"] button`).click();
    await this.page.waitForLoadState("networkidle");
  }
}
