/**
 * One-shot, transaction-safe application of
 * `drizzle/0046_add_campaign_benchmark_snapshots.sql`.
 *
 * Why a script instead of `drizzle-kit migrate`: the journal is stale (last
 * tracked migration is 0029); post-0029 manual migrations use explicit apply
 * runners so we don't accidentally re-apply older production migrations.
 *
 * Safety story:
 *   - CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are idempotent.
 *   - RLS enablement is idempotent.
 *   - REVOKE is safe to run repeatedly.
 *   - No DROP, no DELETE, no rewrite of existing data.
 *   - SQL and post-checks run inside one transaction.
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
    const sqlPath = resolve(process.cwd(), "drizzle/0046_add_campaign_benchmark_snapshots.sql");
    const sqlText = readFileSync(sqlPath, "utf8");

    const [identity] = await sql<{
      db: string;
      db_user: string;
      server_addr: string | null;
      benchmark_table: string | null;
    }[]>`
      SELECT current_database() AS db,
             current_user AS db_user,
             inet_server_addr()::text AS server_addr,
             to_regclass('public.campaign_benchmark_snapshots')::text AS benchmark_table
    `;
    console.log("[migrate] target identity:", identity);
    console.log(`[migrate] applying ${sqlPath}`);

    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);

      const [{ exists: tableExists }] = await tx<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'campaign_benchmark_snapshots'
        ) AS exists
      `;
      if (!tableExists) {
        throw new Error("[migrate] post-check failed: campaign_benchmark_snapshots table missing — rolling back");
      }

      const requiredColumns = [
        "id",
        "account_id",
        "campaign_id",
        "snapshot_date",
        "ad_network_type",
        "device",
        "campaign_name",
        "campaign_status",
        "advertising_channel_type",
        "bidding_strategy_type",
        "currency_code",
        "time_zone",
        "industry_category",
        "business_niche",
        "business_domain",
        "geo_target_count",
        "negative_geo_target_count",
        "language_target_count",
        "geo_target_constants",
        "language_constants",
        "impressions",
        "clicks",
        "cost_micros",
        "conversions",
        "conversions_value",
        "search_impression_share",
        "search_top_impression_share",
        "search_absolute_top_impression_share",
        "search_budget_lost_impression_share",
        "search_rank_lost_impression_share",
        "has_sitelinks",
        "sitelink_count",
        "has_callouts",
        "callout_count",
        "has_structured_snippets",
        "structured_snippet_count",
        "has_image_assets",
        "image_asset_count",
        "keyword_broad_impressions",
        "keyword_broad_clicks",
        "keyword_broad_cost_micros",
        "keyword_broad_conversions",
        "keyword_broad_conversions_value",
        "keyword_phrase_impressions",
        "keyword_phrase_clicks",
        "keyword_phrase_cost_micros",
        "keyword_phrase_conversions",
        "keyword_phrase_conversions_value",
        "keyword_exact_impressions",
        "keyword_exact_clicks",
        "keyword_exact_cost_micros",
        "keyword_exact_conversions",
        "keyword_exact_conversions_value",
        "created_at",
      ];
      const columns = await tx<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'campaign_benchmark_snapshots'
          AND column_name = ANY(${requiredColumns})
      `;
      const colNames = new Set(columns.map((row) => row.column_name));
      for (const col of requiredColumns) {
        if (!colNames.has(col)) {
          throw new Error(`[migrate] post-check failed: campaign_benchmark_snapshots.${col} missing — rolling back`);
        }
      }

      const [{ relrowsecurity }] = await tx<{ relrowsecurity: boolean }[]>`
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.campaign_benchmark_snapshots'::regclass
      `;
      if (!relrowsecurity) {
        throw new Error("[migrate] post-check failed: RLS not enabled — rolling back");
      }

      const roleGrants = await tx<{ grantee: string; privilege_type: string }[]>`
        SELECT grantee, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = 'campaign_benchmark_snapshots'
          AND grantee IN ('anon', 'authenticated')
      `;
      if (roleGrants.length > 0) {
        throw new Error(
          `[migrate] post-check failed: Data API role grants remain: ${roleGrants
            .map((grant) => `${grant.grantee}:${grant.privilege_type}`)
            .join(", ")} — rolling back`,
        );
      }

      const sequenceGrants = await tx<{ grantee: string; privilege_type: string }[]>`
        SELECT grantee, privilege_type
        FROM information_schema.role_usage_grants
        WHERE object_schema = 'public'
          AND object_name = 'campaign_benchmark_snapshots_id_seq'
          AND grantee IN ('anon', 'authenticated')
      `;
      if (sequenceGrants.length > 0) {
        throw new Error(
          `[migrate] post-check failed: Data API sequence grants remain: ${sequenceGrants
            .map((grant) => `${grant.grantee}:${grant.privilege_type}`)
            .join(", ")} — rolling back`,
        );
      }

      const requiredIndexes = [
        "campaign_benchmark_account_campaign_date_idx",
        "campaign_benchmark_peer_slice_idx",
        "campaign_benchmark_channel_date_idx",
      ];
      const indexes = await tx<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'campaign_benchmark_snapshots'
          AND indexname = ANY(${requiredIndexes})
      `;
      const indexNames = new Set(indexes.map((row) => row.indexname));
      for (const idx of requiredIndexes) {
        if (!indexNames.has(idx)) {
          throw new Error(`[migrate] post-check failed: index ${idx} missing — rolling back`);
        }
      }
    });

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM campaign_benchmark_snapshots
    `;
    console.log(`[migrate] campaign_benchmark_snapshots row count: ${count}`);
    console.log(`[migrate] sql file applied: ${sqlText.length} bytes`);
    console.log("[migrate] OK");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
