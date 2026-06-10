// @ts-nocheck
/**
 * Apply 0049 campaign benchmark 30d migration.
 *
 * This is intentionally a one-shot/manual production migration because the
 * repo has a stale Drizzle journal and post-0029 migrations are applied via
 * explicit runners.
 *
 * Destructive step: after the 30d table is populated and verified inside the
 * same transaction, the legacy daily table is truncated.
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

type Precheck = {
  db: string;
  db_user: string;
  server_addr: string | null;
  daily_table: string | null;
  monthly_table: string | null;
  daily_rows: number;
  daily_accounts: number;
  daily_account_campaigns: number;
  min_date: string | null;
  max_date: string | null;
};

type Postcheck = {
  monthly_rows: number;
  monthly_accounts: number;
  monthly_account_campaigns: number;
  as_of_date: string | null;
  window_start: string | null;
  window_end: string | null;
  impressions: string | null;
  clicks: string | null;
  cost_micros: string | null;
  daily_rows_remaining: number;
};

async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Missing DATABASE_URL — aborting.");
    process.exit(1);
  }

  console.log(`[migrate-0049] DATABASE_URL → ${safeDatabaseLabel(url)}`);
  const sql = postgres(url, { prepare: false, max: 1 });

  try {
    const sqlPath = resolve(process.cwd(), "drizzle/0049_migrate_campaign_benchmarks_to_30d.sql");
    const sqlText = readFileSync(sqlPath, "utf8");

    const [precheck] = await sql<Precheck[]>`
      SELECT current_database() AS db,
             current_user AS db_user,
             inet_server_addr()::text AS server_addr,
             to_regclass('public.campaign_benchmark_snapshots')::text AS daily_table,
             to_regclass('public.campaign_benchmark_30d_snapshots')::text AS monthly_table,
             (SELECT COUNT(*)::int FROM campaign_benchmark_snapshots) AS daily_rows,
             (SELECT COUNT(DISTINCT account_id)::int FROM campaign_benchmark_snapshots) AS daily_accounts,
             (SELECT COUNT(DISTINCT account_id || ':' || campaign_id)::int FROM campaign_benchmark_snapshots) AS daily_account_campaigns,
             (SELECT MIN(snapshot_date) FROM campaign_benchmark_snapshots) AS min_date,
             (SELECT MAX(snapshot_date) FROM campaign_benchmark_snapshots) AS max_date
    `;
    console.log("[migrate-0049] precheck:", precheck);

    if (!precheck.daily_table) {
      throw new Error("campaign_benchmark_snapshots is missing; cannot roll up daily rows");
    }
    if (!precheck.max_date || precheck.daily_rows <= 0) {
      throw new Error("campaign_benchmark_snapshots has no daily rows to migrate");
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);

      const [postcheck] = await tx.unsafe(`
        SELECT (SELECT COUNT(*)::int FROM campaign_benchmark_30d_snapshots) AS monthly_rows,
               (SELECT COUNT(DISTINCT account_id)::int FROM campaign_benchmark_30d_snapshots) AS monthly_accounts,
               (SELECT COUNT(DISTINCT account_id || ':' || campaign_id)::int FROM campaign_benchmark_30d_snapshots) AS monthly_account_campaigns,
               (SELECT MAX(snapshot_as_of_date)::text FROM campaign_benchmark_30d_snapshots) AS as_of_date,
               (SELECT MIN(window_start_date)::text FROM campaign_benchmark_30d_snapshots) AS window_start,
               (SELECT MAX(window_end_date)::text FROM campaign_benchmark_30d_snapshots) AS window_end,
               (SELECT SUM(impressions)::text FROM campaign_benchmark_30d_snapshots) AS impressions,
               (SELECT SUM(clicks)::text FROM campaign_benchmark_30d_snapshots) AS clicks,
               (SELECT SUM(cost_micros)::text FROM campaign_benchmark_30d_snapshots) AS cost_micros,
               (SELECT COUNT(*)::int FROM campaign_benchmark_snapshots) AS daily_rows_remaining
      `) as Postcheck[];

      if (!postcheck.monthly_rows || postcheck.monthly_rows <= 0) {
        throw new Error("post-check failed: campaign_benchmark_30d_snapshots has no rows — rolling back");
      }
      if (postcheck.as_of_date !== precheck.max_date) {
        throw new Error(`post-check failed: as_of_date ${postcheck.as_of_date} != prior max_date ${precheck.max_date} — rolling back`);
      }
      if (postcheck.daily_rows_remaining !== 0) {
        throw new Error(`post-check failed: daily rows remain (${postcheck.daily_rows_remaining}) — rolling back`);
      }

      const [relRowSecurityRow] = await tx.unsafe(`
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.campaign_benchmark_30d_snapshots'::regclass
      `) as Array<{ relrowsecurity: boolean }>;
      const { relrowsecurity } = relRowSecurityRow!;
      if (!relrowsecurity) {
        throw new Error("post-check failed: RLS not enabled on campaign_benchmark_30d_snapshots — rolling back");
      }

      const roleGrants = await tx.unsafe(`
        SELECT grantee, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = 'campaign_benchmark_30d_snapshots'
          AND grantee IN ('anon', 'authenticated')
      `) as Array<{ grantee: string; privilege_type: string }>;
      if (roleGrants.length > 0) {
        throw new Error(`post-check failed: Data API grants remain on 30d table: ${JSON.stringify(roleGrants)} — rolling back`);
      }

      console.log("[migrate-0049] transactional postcheck:", postcheck);
    });

    const [finalCheck] = await sql<Postcheck[]>`
      SELECT (SELECT COUNT(*)::int FROM campaign_benchmark_30d_snapshots) AS monthly_rows,
             (SELECT COUNT(DISTINCT account_id)::int FROM campaign_benchmark_30d_snapshots) AS monthly_accounts,
             (SELECT COUNT(DISTINCT account_id || ':' || campaign_id)::int FROM campaign_benchmark_30d_snapshots) AS monthly_account_campaigns,
             (SELECT MAX(snapshot_as_of_date)::text FROM campaign_benchmark_30d_snapshots) AS as_of_date,
             (SELECT MIN(window_start_date)::text FROM campaign_benchmark_30d_snapshots) AS window_start,
             (SELECT MAX(window_end_date)::text FROM campaign_benchmark_30d_snapshots) AS window_end,
             (SELECT SUM(impressions)::text FROM campaign_benchmark_30d_snapshots) AS impressions,
             (SELECT SUM(clicks)::text FROM campaign_benchmark_30d_snapshots) AS clicks,
             (SELECT SUM(cost_micros)::text FROM campaign_benchmark_30d_snapshots) AS cost_micros,
             (SELECT COUNT(*)::int FROM campaign_benchmark_snapshots) AS daily_rows_remaining
    `;
    console.log("[migrate-0049] final check:", finalCheck);
    console.log(`[migrate-0049] sql file applied: ${sqlText.length} bytes`);
    console.log("[migrate-0049] OK");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[migrate-0049] FAILED:", err);
  process.exit(1);
});
