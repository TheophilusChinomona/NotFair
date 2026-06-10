import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import * as benchmarkSnapshotsModule from "../lib/google-ads/benchmark-snapshots";

const benchmarkSnapshots = (
  benchmarkSnapshotsModule as typeof benchmarkSnapshotsModule & {
    default?: unknown;
    "module.exports"?: unknown;
  }
).default ?? (
  benchmarkSnapshotsModule as typeof benchmarkSnapshotsModule & { "module.exports"?: unknown }
)["module.exports"] ?? benchmarkSnapshotsModule;

const { inferBusinessClassification } = benchmarkSnapshots as {
  inferBusinessClassification(input: string): { industryCategory: string; businessNiche: string };
};

type AccountCandidate = {
  account_id: string;
  account_text: string | null;
  account_names: string | null;
  domains: string | null;
  landing_pages: string | null;
  rows: number;
  campaigns: number;
};

function loadEnvFile(path = ".env.local") {
  const envPath = resolve(process.cwd(), path);
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] == null) process.env[match[1]] = value;
  }
}

function isActualNiche(niche: string | null | undefined) {
  const normalized = (niche ?? "").trim().toLowerCase();
  return normalized !== "" && normalized !== "other" && normalized !== "unknown" && normalized !== "uncategorized";
}

async function main() {
  loadEnvFile();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Missing DATABASE_URL — aborting.");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const reclassifyAll = process.argv.includes("--all");
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    console.error("--limit must be a positive integer");
    process.exit(1);
  }

  const url = new URL(databaseUrl);
  console.log(`[benchmark-niche-reclassify] DATABASE_URL → ${url.host}`);
  console.log(`[benchmark-niche-reclassify] mode=${apply ? "apply" : "dry-run"}`);
  console.log(`[benchmark-niche-reclassify] scope=${reclassifyAll ? "all accounts" : "accounts without actual niche"}`);

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const candidates = await sql<AccountCandidate[]>`
      WITH candidate_accounts AS (
        SELECT account_id
        FROM campaign_benchmark_30d_snapshots
        GROUP BY account_id
        HAVING ${reclassifyAll}::boolean
          OR NOT bool_or(lower(trim(coalesce(business_niche, ''))) NOT IN ('', 'other', 'unknown', 'uncategorized'))
      ),
      campaign_rollup AS (
        SELECT
          s.account_id,
          s.campaign_name,
          s.business_domain,
          s.business_landing_page_url,
          sum(s.cost_micros)::bigint AS cost_micros,
          sum(s.impressions)::bigint AS impressions,
          count(*)::int AS rows
        FROM campaign_benchmark_30d_snapshots s
        JOIN candidate_accounts n USING (account_id)
        GROUP BY s.account_id, s.campaign_name, s.business_domain, s.business_landing_page_url
      ),
      ranked AS (
        SELECT
          *,
          row_number() OVER (PARTITION BY account_id ORDER BY cost_micros DESC, impressions DESC, rows DESC) AS rn
        FROM campaign_rollup
      ),
      account_names AS (
        SELECT
          account_item->>'id' AS account_id,
          string_agg(DISTINCT account_item->>'name', ' ') AS account_names
        FROM ad_platform_connections c
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.account_ids) = 'array' THEN c.account_ids ELSE '[]'::jsonb END) account_item
        WHERE c.platform = 'google_ads'
          AND account_item ? 'id'
        GROUP BY account_item->>'id'
      )
      SELECT
        ranked.account_id,
        string_agg(campaign_name, ' || ' ORDER BY cost_micros DESC, impressions DESC, rows DESC) FILTER (WHERE rn <= 20) AS account_text,
        max(account_names.account_names) AS account_names,
        string_agg(DISTINCT business_domain, ' ') AS domains,
        string_agg(DISTINCT business_landing_page_url, ' ') AS landing_pages,
        sum(rows)::int AS rows,
        count(*)::int AS campaigns
      FROM ranked
      LEFT JOIN account_names USING (account_id)
      GROUP BY ranked.account_id
      ORDER BY rows DESC
    `;

    const classified = candidates
      .map((candidate) => ({
        ...candidate,
        ...inferBusinessClassification(`${candidate.account_names ?? ""} ${candidate.domains ?? ""} ${candidate.landing_pages ?? ""} ${candidate.account_text ?? ""}`),
      }))
      .filter((candidate) => isActualNiche(candidate.businessNiche))
      .slice(0, limit ?? undefined);

    const byNiche = new Map<string, { accounts: number; rows: number; campaigns: number }>();
    for (const item of classified) {
      const key = `${item.industryCategory} / ${item.businessNiche}`;
      const current = byNiche.get(key) ?? { accounts: 0, rows: 0, campaigns: 0 };
      current.accounts += 1;
      current.rows += item.rows;
      current.campaigns += item.campaigns;
      byNiche.set(key, current);
    }

    console.log(JSON.stringify({
      totalAccountsWithoutActualNicheBefore: candidates.length,
      classifiableAccounts: classified.length,
      stillUnclassifiedIfApplied: candidates.length - classified.length,
      googleAdsCreditsUsed: 0,
      topClassifications: [...byNiche.entries()]
        .map(([classification, stats]) => ({ classification, ...stats }))
        .sort((a, b) => b.accounts - a.accounts || b.rows - a.rows)
        .slice(0, 25),
    }, null, 2));

    if (!apply) return;

    let updatedRows = 0;
    for (const item of classified) {
      const result = await sql`
        UPDATE campaign_benchmark_30d_snapshots
        SET
          industry_category = ${item.industryCategory},
          business_niche = ${item.businessNiche}
        WHERE account_id = ${item.account_id}
          AND (
            ${reclassifyAll}::boolean
            OR lower(trim(coalesce(business_niche, ''))) IN ('', 'other', 'unknown', 'uncategorized')
          )
          AND (
            industry_category IS DISTINCT FROM ${item.industryCategory}
            OR business_niche IS DISTINCT FROM ${item.businessNiche}
          )
      `;
      updatedRows += result.count;
    }

    const [after] = await sql<[{ accounts_without_actual_niche: number; total_accounts: number }]>`
      WITH account_niches AS (
        SELECT
          account_id,
          bool_or(lower(trim(coalesce(business_niche, ''))) NOT IN ('', 'other', 'unknown', 'uncategorized')) AS has_actual_niche
        FROM campaign_benchmark_30d_snapshots
        GROUP BY account_id
      )
      SELECT
        count(*)::int AS total_accounts,
        count(*) FILTER (WHERE NOT has_actual_niche)::int AS accounts_without_actual_niche
      FROM account_niches
    `;

    console.log(JSON.stringify({
      applied: true,
      updatedRows,
      updatedAccounts: classified.length,
      googleAdsCreditsUsed: 0,
      totalAccountsAfter: after.total_accounts,
      accountsWithoutActualNicheAfter: after.accounts_without_actual_niche,
    }, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
