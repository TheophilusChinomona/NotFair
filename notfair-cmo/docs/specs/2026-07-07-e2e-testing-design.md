# E2E Testing — NotFair CMO Portal

**Date:** 2026-07-07
**Status:** Approved

## Auth Bypass Strategy

The app's middleware validates sessions via `/api/auth/get-session` and redirects unauthenticated
requests to `/login`. For E2E tests, an `E2E_TEST=1` environment variable skips the session check
entirely — tests navigate the app without needing to authenticate.

**Middleware change** (`src/middleware.ts`): guard the session check with
`process.env.E2E_TEST !== "1"`.

## Test Structure

```
notfair-cmo/e2e/
├── pages/                  # Page object models
│   ├── login.page.ts
│   ├── onboarding.page.ts
│   ├── dashboard.page.ts
│   ├── agents.page.ts
│   ├── connections.page.ts
│   ├── settings.page.ts
│   └── tasks.page.ts
├── specs/                  # Test files
│   ├── smoke.spec.ts
│   ├── navigation.spec.ts
│   ├── onboarding.spec.ts
│   ├── agents.spec.ts
│   ├── connections.spec.ts
│   └── settings.spec.ts
├── playwright.config.ts
└── tsconfig.json
```

## Flows

| Flow | Coverage |
|---|---|
| **Smoke** | All app routes return 200, no JS crash, key elements visible |
| **Navigation** | Sidebar + top nav links route correctly, back button works |
| **Onboarding** | Create project, connect MCP tiles, setup watcher |
| **Agents** | Agent list, agent detail (chat, tasks, skills, cron, files tabs) |
| **Connections** | MCP cards render, connect/disconnect interaction |
| **Settings** | Project settings page renders |

## Tech

- `@playwright/test` — dev dependency
- Chromium only (single browser for CI speed)
- Page object model pattern

## CI Pipeline

GitHub Actions on `ubuntu-latest`, triggered on push/PR to relevant paths:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v4
  - run: pnpm install
  - run: npx playwright install chromium
  - run: pnpm dev & npx wait-on http://localhost:3326
  - run: npx playwright test
  - uses: actions/upload-artifact@v4  # on failure
```

- DB: SQLite (default — no external infra needed)
- App instance: shared across all tests (start once, run all)
- Report: `playwright-report/` uploaded on failure

## Files to modify

| File | Change |
|---|---|
| `src/middleware.ts` | Add `E2E_TEST=1` guard |
| `package.json` | Add `@playwright/test` dep, `test:e2e` script |
| — | New: `e2e/playwright.config.ts` |
| — | New: `e2e/tsconfig.json` |
| — | New: `e2e/specs/*.spec.ts` (6 files) |
| — | New: `e2e/pages/*.page.ts` (7 files) |
| — | New: `.github/workflows/e2e.yml` |
