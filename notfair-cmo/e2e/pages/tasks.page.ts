import { type Page, type Locator } from "@playwright/test";

export class TasksPage {
  readonly page: Page;
  readonly taskList: Locator;

  constructor(page: Page) {
    this.page = page;
    this.taskList = page.locator("[data-testid=task-list]");
  }

  async goto(projectSlug: string) {
    await this.page.goto(`/${projectSlug}/tasks`);
  }
}
