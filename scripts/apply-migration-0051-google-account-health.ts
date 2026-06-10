/**
 * One-shot, transaction-safe application of
 * `drizzle/0051_add_google_account_health.sql`.
 *
 * Why a script instead of `drizzle-kit migrate`: this repo has post-0029
 * manual migration runners because the Drizzle journal is stale. Keep this
 * migration idempotent and verified against the target database.
 */
import postgres from "postgres";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

function safeDatabaseLabel(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Missing DATABASE_URL — aborting.");
    process.exit(1);
  }

  console.log(`[migrate] DATABASE_URL → ${safeDatabaseLabel(url)}`);
  const sql = postgres(url, { prepare: false, max: 1 });

  try {
    const sqlPath = resolve(process.cwd(), "drizzle/0051_add_google_account_health.sql");
    const sqlText = readFileSync(sqlPath, "utf8");

    const [identity] = await sql<{
      db: string;
      db_user: string;
      server_addr: string | null;
      connection_table: string | null;
    }[]>`
      SELECT current_database() AS db,
             current_user AS db_user,
             inet_server_addr()::text AS server_addr,
             to_regclass('public.ad_platform_connections')::text AS connection_table
    `;
    console.log("[migrate] target identity:", identity);
    console.log(`[migrate] applying ${sqlPath}`);

    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);

      const [column] = (await tx.unsafe(`
        SELECT column_name, is_nullable, data_type, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ad_platform_connections'
          AND column_name = 'account_health'
      `)) as Array<{
        column_name: string;
        is_nullable: string;
        data_type: string;
        column_default: string | null;
      }>;

      if (!column) {
        throw new Error("[migrate] post-check failed: ad_platform_connections.account_health missing — rolling back");
      }
      if (column.is_nullable !== "NO") {
        throw new Error("[migrate] post-check failed: account_health is nullable — rolling back");
      }
      if (column.data_type !== "jsonb") {
        throw new Error(`[migrate] post-check failed: account_health is ${column.data_type}, expected jsonb — rolling back`);
      }
      if (!column.column_default?.includes("'{}'::jsonb")) {
        throw new Error(`[migrate] post-check failed: account_health default is ${column.column_default ?? "NULL"}, expected '{}'::jsonb — rolling back`);
      }

      const [sample] = (await tx.unsafe(`
        SELECT COUNT(*)::int AS total_connections,
               COUNT(*) FILTER (WHERE account_health IS NULL)::int AS null_health_rows
        FROM ad_platform_connections
      `)) as Array<{ total_connections: number; null_health_rows: number }>;
      if (sample.null_health_rows !== 0) {
        throw new Error("[migrate] post-check failed: account_health has NULL rows — rolling back");
      }

      console.log("[migrate] post-check ok:", { column, sample });
    });

    console.log("[migrate] complete");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[migrate] failed:", error);
  process.exit(1);
});
