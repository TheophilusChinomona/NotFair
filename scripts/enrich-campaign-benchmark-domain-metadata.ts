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
  account_names: string | null;
  domains: string[] | null;
  landing_pages: string[] | null;
  account_text: string | null;
  rows: number;
  campaigns: number;
  spend: number;
};

type PageMetadata = {
  fetchedUrl: string;
  title: string;
  description: string;
  h1: string;
};

type ClassifiedCandidate = AccountCandidate & {
  metadata: PageMetadata | null;
  industryCategory: string;
  businessNiche: string;
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

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argNumber(name: string, fallback: number, min: number, max: number) {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(name.length + 3));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function isActualNiche(niche: string | null | undefined) {
  const normalized = (niche ?? "").trim().toLowerCase();
  return normalized !== "" && normalized !== "other" && normalized !== "unknown" && normalized !== "uncategorized";
}

function isSafeBenchmarkNiche(industryCategory: string, businessNiche: string) {
  if (!isActualNiche(businessNiche)) return false;
  const classification = `${industryCategory} / ${businessNiche}`.toLowerCase();
  return !new Set([
    "b2b saas / saas / business software",
    "local services / local services",
    "ecommerce / ecommerce",
    "home services / home services",
    "real estate / real estate",
    "finance / insurance / finance / insurance",
    "education / education",
    "healthcare / healthcare",
    "travel / hospitality / travel / hospitality",
  ]).has(classification);
}

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaContent(html: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["'][^>]*>`, "i"),
  ];
  return patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) ?? "";
}

function normalizeDomain(domain: string) {
  return domain.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
}

async function fetchPageMetadata(domain: string, timeoutMs: number): Promise<PageMetadata | null> {
  const normalized = normalizeDomain(domain);
  if (!normalized || normalized.includes(" ")) return null;

  const urls = [`https://${normalized}/`, `https://www.${normalized}/`, `http://${normalized}/`];
  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 NotFairBenchmarkClassifier/1.0",
        },
      });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) continue;
      const html = (await response.text()).slice(0, 250_000);
      const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
      const description = stripHtml(extractMetaContent(html, "description") || extractMetaContent(html, "og:description"));
      const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
      return { fetchedUrl: response.url || url, title, description, h1 };
    } catch {
      // Try the next scheme/host variant. Network failures are expected for dead/parked domains.
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

async function mapLimit<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main() {
  loadEnvFile();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");

  const apply = hasFlag("apply");
  const maxAccounts = argNumber("max-accounts", 250, 1, 5000);
  const concurrency = argNumber("concurrency", 8, 1, 50);
  const httpTimeoutMs = argNumber("http-timeout-ms", 4000, 500, 30000);
  const skipHttp = hasFlag("skip-http");

  const url = new URL(databaseUrl);
  console.log(`[domain-enrich] DATABASE_URL → ${url.host}`);
  console.log(`[domain-enrich] mode=${apply ? "apply" : "dry-run"}; maxAccounts=${maxAccounts}; concurrency=${concurrency}; httpTimeoutMs=${httpTimeoutMs}; skipHttp=${skipHttp}`);

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const candidates = await sql<AccountCandidate[]>`
      WITH no_actual AS (
        SELECT account_id
        FROM campaign_benchmark_30d_snapshots
        GROUP BY account_id
        HAVING NOT bool_or(lower(trim(coalesce(business_niche, ''))) NOT IN ('', 'other', 'unknown', 'uncategorized'))
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
        JOIN no_actual n USING (account_id)
        WHERE s.business_domain IS NOT NULL
        GROUP BY s.account_id, s.campaign_name, s.business_domain, s.business_landing_page_url
      ),
      ranked AS (
        SELECT *, row_number() OVER (PARTITION BY account_id ORDER BY cost_micros DESC, impressions DESC, rows DESC) AS rn
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
        max(account_names.account_names) AS account_names,
        array_agg(DISTINCT business_domain) FILTER (WHERE business_domain IS NOT NULL) AS domains,
        array_agg(DISTINCT business_landing_page_url) FILTER (WHERE business_landing_page_url IS NOT NULL) AS landing_pages,
        string_agg(campaign_name, ' || ' ORDER BY cost_micros DESC, impressions DESC, rows DESC) FILTER (WHERE rn <= 20) AS account_text,
        sum(rows)::int AS rows,
        count(*)::int AS campaigns,
        (sum(cost_micros) / 1000000.0)::float8 AS spend
      FROM ranked
      LEFT JOIN account_names USING (account_id)
      GROUP BY ranked.account_id
      ORDER BY spend DESC NULLS LAST, rows DESC
      LIMIT ${maxAccounts}
    `;

    let fetched = 0;
    const classified = await mapLimit(candidates, concurrency, async (candidate, index): Promise<ClassifiedCandidate> => {
      const domain = candidate.domains?.[0] ?? null;
      const metadata = !skipHttp && domain ? await fetchPageMetadata(domain, httpTimeoutMs) : null;
      if (metadata) fetched += 1;
      const primarySeed = [
        candidate.account_names ?? "",
        candidate.domains?.join(" ") ?? "",
        candidate.landing_pages?.join(" ") ?? "",
        metadata?.fetchedUrl ?? "",
        metadata?.title ?? "",
        metadata?.description ?? "",
        metadata?.h1 ?? "",
      ].join(" ");
      const fallbackSeed = [
        primarySeed,
        candidate.account_text ?? "",
      ].join(" ");
      const primaryClassification = inferBusinessClassification(primarySeed);
      const classification = isSafeBenchmarkNiche(primaryClassification.industryCategory, primaryClassification.businessNiche)
        ? primaryClassification
        : inferBusinessClassification(fallbackSeed);
      if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
        console.log(`[domain-enrich] processed ${index + 1}/${candidates.length}; fetched=${fetched}`);
      }
      return { ...candidate, metadata, ...classification };
    });

    const actual = classified.filter((candidate) => isSafeBenchmarkNiche(candidate.industryCategory, candidate.businessNiche));
    const byNiche = new Map<string, { accounts: number; rows: number; campaigns: number; spend: number }>();
    for (const item of actual) {
      const key = `${item.industryCategory} / ${item.businessNiche}`;
      const current = byNiche.get(key) ?? { accounts: 0, rows: 0, campaigns: 0, spend: 0 };
      current.accounts += 1;
      current.rows += item.rows;
      current.campaigns += item.campaigns;
      current.spend += Number(item.spend ?? 0);
      byNiche.set(key, current);
    }

    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      googleAdsCreditsUsed: 0,
      candidates: candidates.length,
      homepageMetadataFetched: fetched,
      classifiableAccounts: actual.length,
      stillUnclassifiedIfApplied: candidates.length - actual.length,
      topClassifications: [...byNiche.entries()]
        .map(([classification, stats]) => ({ classification, ...stats, spend: Number(stats.spend.toFixed(2)) }))
        .sort((a, b) => b.accounts - a.accounts || b.rows - a.rows)
        .slice(0, 25),
      highlights: actual.slice(0, 40).map((item) => ({
        accountId: item.account_id,
        domains: item.domains?.slice(0, 2) ?? [],
        title: item.metadata?.title ?? null,
        classification: `${item.industryCategory} / ${item.businessNiche}`,
        rows: item.rows,
        campaigns: item.campaigns,
        spend: Number(Number(item.spend ?? 0).toFixed(2)),
      })),
    }, null, 2));

    if (!apply) return;

    let updatedRows = 0;
    for (const item of actual) {
      const result = await sql`
        UPDATE campaign_benchmark_30d_snapshots
        SET
          industry_category = ${item.industryCategory},
          business_niche = ${item.businessNiche}
        WHERE account_id = ${item.account_id}
          AND lower(trim(coalesce(business_niche, ''))) IN ('', 'other', 'unknown', 'uncategorized')
      `;
      updatedRows += result.count;
    }

    const [after] = await sql<[{ accounts_without_actual_niche: number; total_accounts: number; rows_without_actual_niche: number }]>`
      WITH account_niches AS (
        SELECT
          account_id,
          bool_or(lower(trim(coalesce(business_niche, ''))) NOT IN ('', 'other', 'unknown', 'uncategorized')) AS has_actual_niche
        FROM campaign_benchmark_30d_snapshots
        GROUP BY account_id
      )
      SELECT
        count(*)::int AS total_accounts,
        count(*) FILTER (WHERE NOT has_actual_niche)::int AS accounts_without_actual_niche,
        (SELECT count(*)::int FROM campaign_benchmark_30d_snapshots WHERE lower(trim(coalesce(business_niche, ''))) IN ('', 'other', 'unknown', 'uncategorized')) AS rows_without_actual_niche
      FROM account_niches
    `;

    console.log(JSON.stringify({
      applied: true,
      updatedAccounts: actual.length,
      updatedRows,
      googleAdsCreditsUsed: 0,
      totalAccountsAfter: after.total_accounts,
      accountsWithoutActualNicheAfter: after.accounts_without_actual_niche,
      rowsWithoutActualNicheAfter: after.rows_without_actual_niche,
    }, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[domain-enrich] FAILED:", error);
  process.exit(1);
});
