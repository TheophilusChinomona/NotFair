// Next.js boots this once per server process via the instrumentation hook.
// We use it to start the cron tick loop — without this call, scheduled jobs
// fire never, the calendar shows no run history, and the detail dialog has
// nothing to render in its Result section.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Eagerly initialize Better Auth schema so the first sign-up doesn't
  // hit a cold-start race where getDb() caches before auth tables exist.
  const { ensureAuthSchema } = await import("@/server/auth");
  await ensureAuthSchema().catch(() => {});
  const { getDb } = await import("@/server/db/db");
  getDb(); // ensure cached before any request
  const { ensureSchedulerRunning } = await import("@/server/scheduler/tick");
  ensureSchedulerRunning();
}
