/**
 * Backfill Google Ads campaign benchmark snapshots for existing connections.
 *
 * Default window is 30 completed days. In traffic mode, the collector writes
 * compact account/campaign/30-day snapshots, so this is safe to re-run. Defaults to 50
 * account routes per invocation; pass --max-accounts explicitly for larger,
 * scheduled batches after checking Google Ads API quota headroom.
 */
import postgres from "postgres";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BenchmarkCreditBudgetExceeded,
  CONNECTION_HEALTH_KEY,
  buildAccountHealthKey,
  buildGoogleAccountHealthFailure,
  buildGoogleAccountHealthSuccess,
  classifyGoogleBenchmarkError,
  inferBusinessClassification,
  parseCustomerIds,
  shouldSkipGoogleAccountHealth,
  syncCampaignBenchmarkSnapshots,
  type BenchmarkCreditCounter,
  type BenchmarkSnapshotMode,
  type ConnectedAccount,
  type GoogleAccountHealthEntry,
  type GoogleAccountHealthMap,
} from "@/lib/google-ads";

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

type ConnectionRow = {
  id: number;
  user_id: string;
  refresh_token: string;
  active_account_id: string | null;
  account_ids: Array<{ id: string; name?: string; loginCustomerId?: string | null }> | null;
  account_health: GoogleAccountHealthMap | null;
};

type SessionRow = {
  id: number;
  user_id: string | null;
  refresh_token: string;
  customer_id: string | null;
  customer_ids: string | null;
  login_customer_id: string | null;
  client_name: string | null;
  client_version: string | null;
};

type BackfillJob = {
  refreshToken: string;
  account: ConnectedAccount;
  source: "connection" | "active_session";
  sourceId: number;
  userId: string | null;
  accountHealth?: GoogleAccountHealthMap;
};

type CoverageStats = {
  row_count: number;
  recent_row_count: number;
  campaign_count: number;
  last_created_at: string | null;
};

function normalizeConnectedAccounts(
  accounts: Array<{ id: string; name?: string; loginCustomerId?: string | null }>,
): ConnectedAccount[] {
  return accounts
    .filter((account) => Boolean(account.id))
    .map((account) => ({
      id: account.id,
      name: account.name ?? account.id,
      ...("loginCustomerId" in account ? { loginCustomerId: account.loginCustomerId ?? null } : {}),
    }));
}

function parseDaysArg() {
  const daysArg = process.argv.find((arg) => arg.startsWith("--days="));
  if (!daysArg) return 30;
  const days = Number(daysArg.slice("--days=".length));
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be an integer between 1 and 365");
  }
  return days;
}

function parseConcurrencyArg() {
  const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
  if (!concurrencyArg) return 1;
  const concurrency = Number(concurrencyArg.slice("--concurrency=".length));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new Error("--concurrency must be an integer between 1 and 10");
  }
  return concurrency;
}

function parseMaxAccountsArg() {
  const maxAccountsArg = process.argv.find((arg) => arg.startsWith("--max-accounts="));
  if (!maxAccountsArg) return 50;
  const maxAccounts = Number(maxAccountsArg.slice("--max-accounts=".length));
  if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 5000) {
    throw new Error("--max-accounts must be an integer between 1 and 5000");
  }
  return maxAccounts;
}

function parseModeArg(): BenchmarkSnapshotMode {
  const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
  if (!modeArg) return "full";
  const mode = modeArg.slice("--mode=".length);
  if (mode !== "traffic" && mode !== "full") {
    throw new Error("--mode must be traffic or full");
  }
  return mode;
}

function parseCreditBudgetArg() {
  const budgetArg = process.argv.find((arg) => arg.startsWith("--credit-budget="));
  if (!budgetArg) return null;
  const budget = Number(budgetArg.slice("--credit-budget=".length));
  if (!Number.isInteger(budget) || budget < 1 || budget > 100000) {
    throw new Error("--credit-budget must be an integer between 1 and 100000");
  }
  return budget;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function parseIncludeActiveSessionsArg() {
  if (hasFlag("no-active-sessions")) return false;
  return true;
}

function parsePrioritizeUncoveredArg() {
  if (hasFlag("no-prioritize-uncovered")) return false;
  return true;
}

function parseAllowErrorsArg() {
  return hasFlag("allow-errors");
}

function routeKey(account: Pick<ConnectedAccount, "id"> & Partial<Pick<ConnectedAccount, "loginCustomerId">>) {
  return buildAccountHealthKey(account.id, account.loginCustomerId ?? null);
}

function accountKey(account: Pick<ConnectedAccount, "id">) {
  return account.id;
}

function addJob(
  jobs: BackfillJob[],
  seen: Set<string>,
  job: BackfillJob,
) {
  const key = routeKey(job.account);
  if (seen.has(key)) return false;
  seen.add(key);
  jobs.push(job);
  return true;
}

async function setConnectionHealthEntry(
  sql: postgres.Sql,
  connectionId: number,
  key: string,
  entry: GoogleAccountHealthEntry,
) {
  await sql`
    UPDATE ad_platform_connections
    SET account_health = jsonb_set(account_health, ${[key]}::text[], ${sql.json(entry)}::jsonb, true),
        updated_at = now()
    WHERE id = ${connectionId}
  `;
}

function healthEntryForJob(job: BackfillJob, key: string) {
  return job.accountHealth?.[key] ?? null;
}

function healthSkipReason(entry: GoogleAccountHealthEntry | null | undefined) {
  if (!entry) return null;
  if (entry.errorLevel === "connection" && !entry.skipUntil) return "connection error until reconnect";
  if (entry.skipUntil) return `skip_until ${entry.skipUntil}`;
  return null;
}

function sortJobsByCoverage(jobs: BackfillJob[], coverage: Map<string, CoverageStats>) {
  return jobs.sort((a, b) => {
    const aCoverage = coverage.get(accountKey(a.account));
    const bCoverage = coverage.get(accountKey(b.account));
    const aRecentRows = aCoverage?.recent_row_count ?? 0;
    const bRecentRows = bCoverage?.recent_row_count ?? 0;
    if (aRecentRows !== bRecentRows) return aRecentRows - bRecentRows;

    const aRows = aCoverage?.row_count ?? 0;
    const bRows = bCoverage?.row_count ?? 0;
    if (aRows !== bRows) return aRows - bRows;

    const aCampaigns = aCoverage?.campaign_count ?? 0;
    const bCampaigns = bCoverage?.campaign_count ?? 0;
    if (aCampaigns !== bCampaigns) return aCampaigns - bCampaigns;

    if (a.source !== b.source) return a.source === "connection" ? -1 : 1;
    return routeKey(a.account).localeCompare(routeKey(b.account));
  });
}

function parseHttpEnrichOtherDomainsArg() {
  const enrichArg = process.argv.find((arg) => arg.startsWith("--http-enrich-other-domains="));
  if (!enrichArg) return 0;
  const limit = Number(enrichArg.slice("--http-enrich-other-domains=".length));
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
    throw new Error("--http-enrich-other-domains must be an integer between 0 and 1000");
  }
  return limit;
}

type DomainEnrichmentCandidate = {
  business_domain: string;
  campaign_count: number;
  row_count: number;
  cost_micros: number;
  campaign_examples: string[];
};

type DomainEnrichmentResult = {
  domain: string;
  status: "updated" | "still_other" | "fetch_failed";
  industryCategory?: string;
  businessNiche?: string;
  rowsUpdated?: number;
  campaignsUpdated?: number;
  title?: string;
  reason?: string;
};

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaContent(html: string, name: string) {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  return html.match(pattern)?.[1] ?? "";
}

async function fetchHomepageText(domain: string) {
  const urls = [`https://${domain}/`, `http://${domain}/`];
  let lastError: unknown;

  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "NotFairBenchmarkBot/1.0 (+https://notfair.co)",
          accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !contentType.toLowerCase().includes("text/html")) {
        throw new Error(`non-html content-type ${contentType}`);
      }
      const html = (await response.text()).slice(0, 200_000);
      const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
      const description = stripHtml(
        extractMetaContent(html, "description") || extractMetaContent(html, "og:description") || "",
      );
      const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
      return { url, title, description, h1, text: `${title} ${description} ${h1}` };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function enrichOtherDomainsFromHttp(
  sql: postgres.Sql,
  days: number,
  limit: number,
): Promise<DomainEnrichmentResult[]> {
  if (limit <= 0) return [];

  const candidates = await sql<DomainEnrichmentCandidate[]>`
    SELECT business_domain,
           COUNT(DISTINCT account_id || ':' || campaign_id)::int AS campaign_count,
           COUNT(*)::int AS row_count,
           COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
           ARRAY_AGG(DISTINCT campaign_name) FILTER (WHERE campaign_name IS NOT NULL) AS campaign_examples
    FROM campaign_benchmark_30d_snapshots
    WHERE industry_category = 'Other'
      AND business_domain IS NOT NULL
      AND business_domain != ''
      AND snapshot_as_of_date = (SELECT MAX(snapshot_as_of_date) FROM campaign_benchmark_30d_snapshots)
    GROUP BY business_domain
    ORDER BY cost_micros DESC, campaign_count DESC
    LIMIT ${limit}
  `;

  const results: DomainEnrichmentResult[] = [];
  for (const candidate of candidates) {
    try {
      const homepage = await fetchHomepageText(candidate.business_domain);
      const classification = inferBusinessClassification(
        `${candidate.business_domain} ${candidate.campaign_examples.join(" ")} ${homepage.text}`,
      );

      if (classification.industryCategory === "Other") {
        results.push({
          domain: candidate.business_domain,
          status: "still_other",
          title: homepage.title || undefined,
          reason: "HTTP metadata did not match a known classifier rule",
        });
        continue;
      }

      const [updated] = await sql<{ rows_updated: number; campaigns_updated: number }[]>`
        WITH touched AS (
          UPDATE campaign_benchmark_30d_snapshots
          SET industry_category = ${classification.industryCategory},
              business_niche = ${classification.businessNiche}
          WHERE industry_category = 'Other'
            AND business_domain = ${candidate.business_domain}
          RETURNING account_id, campaign_id
        )
        SELECT COUNT(*)::int AS rows_updated,
               COUNT(DISTINCT account_id || ':' || campaign_id)::int AS campaigns_updated
        FROM touched
      `;

      results.push({
        domain: candidate.business_domain,
        status: "updated",
        industryCategory: classification.industryCategory,
        businessNiche: classification.businessNiche,
        rowsUpdated: updated?.rows_updated ?? 0,
        campaignsUpdated: updated?.campaigns_updated ?? 0,
        title: homepage.title || undefined,
      });
    } catch (error) {
      results.push({
        domain: candidate.business_domain,
        status: "fetch_failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

function percent(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function money(micros: number, denominator = 1) {
  return denominator > 0 ? micros / 1_000_000 / denominator : null;
}

function roundMetric(value: number | null, digits = 4) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const CHANNEL_NAMES: Record<string, string> = {
  "2": "SEARCH",
  "3": "DISPLAY",
  "4": "SHOPPING",
  "5": "HOTEL",
  "6": "VIDEO",
  "7": "MULTI_CHANNEL",
  "9": "LOCAL",
  "10": "PERFORMANCE_MAX",
  "11": "SMART",
  "13": "LOCAL_SERVICES",
  "14": "DEMAND_GEN",
  "15": "TRAVEL",
};

function normalizeChannel(value: string | null) {
  if (!value) return "UNKNOWN";
  return CHANNEL_NAMES[value] ?? value;
}

async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Missing DATABASE_URL — aborting.");
    process.exit(1);
  }

  const days = parseDaysArg();
  const concurrency = parseConcurrencyArg();
  const maxAccounts = parseMaxAccountsArg();
  const mode = parseModeArg();
  const creditBudget = parseCreditBudgetArg();
  const httpEnrichOtherDomains = parseHttpEnrichOtherDomainsArg();
  const includeActiveSessions = parseIncludeActiveSessionsArg();
  const prioritizeUncovered = parsePrioritizeUncoveredArg();
  const allowErrors = parseAllowErrorsArg();
  const creditCounter: BenchmarkCreditCounter = { used: 0, budget: creditBudget };
  console.log(`[benchmark-backfill] DATABASE_URL → ${safeDatabaseLabel(url)}`);
  console.log(`[benchmark-backfill] window: last ${days} completed days`);
  console.log(`[benchmark-backfill] mode: ${mode}`);
  console.log(`[benchmark-backfill] credit budget: ${creditBudget ?? "none"}`);
  console.log(`[benchmark-backfill] HTTP enrichment cap: ${httpEnrichOtherDomains} Other domains`);
  console.log(`[benchmark-backfill] include active sessions: ${includeActiveSessions}`);
  console.log(`[benchmark-backfill] prioritize uncovered accounts: ${prioritizeUncovered}`);
  console.log(`[benchmark-backfill] allow per-account errors: ${allowErrors}`);
  console.log(`[benchmark-backfill] concurrency: ${concurrency}`);
  console.log(`[benchmark-backfill] max accounts this run: ${maxAccounts}`);

  const sql = postgres(url, { prepare: false, max: 1 });
  try {
    const [identity] = await sql<{
      db: string;
      db_user: string;
      server_addr: string | null;
      benchmark_table: string | null;
    }[]>`
      SELECT current_database() AS db,
             current_user AS db_user,
             inet_server_addr()::text AS server_addr,
             to_regclass('public.campaign_benchmark_30d_snapshots')::text AS benchmark_table
    `;
    console.log("[benchmark-backfill] target identity:", identity);
    if (!identity.benchmark_table) {
      throw new Error("campaign_benchmark_30d_snapshots is missing; run migration 0049 first");
    }

    const connections = await sql<ConnectionRow[]>`
      SELECT id, user_id, refresh_token, active_account_id, account_ids, account_health
      FROM ad_platform_connections
      WHERE platform = 'google_ads'
      ORDER BY updated_at DESC
    `;
    console.log(`[benchmark-backfill] google_ads connections: ${connections.length}`);

    const activeSessions = includeActiveSessions
      ? await sql<SessionRow[]>`
          SELECT id, user_id, refresh_token, customer_id, customer_ids, login_customer_id, client_name, client_version
          FROM mcp_sessions
          WHERE expires_at >= ${new Date().toISOString()}
            AND user_id IS NOT NULL
          ORDER BY created_at DESC
        `
      : [];
    console.log(`[benchmark-backfill] active legacy sessions included: ${activeSessions.length}`);

    const jobs: BackfillJob[] = [];
    const seen = new Set<string>();
    let skippedByHealth = 0;

    for (const connection of connections) {
      const accountHealth = connection.account_health ?? {};
      const connectedAccounts = normalizeConnectedAccounts(connection.account_ids ?? []);
      const accounts = connectedAccounts.length > 0
        ? connectedAccounts
        : connection.active_account_id
          ? [{ id: connection.active_account_id, name: connection.active_account_id }]
          : [];

      const connectionHealth = accountHealth[CONNECTION_HEALTH_KEY];
      if (shouldSkipGoogleAccountHealth(connectionHealth)) {
        skippedByHealth += accounts.length;
        console.log(`[benchmark-backfill] skipping connection ${connection.id}: ${healthSkipReason(connectionHealth)}`);
        continue;
      }

      for (const account of accounts) {
        const key = routeKey(account);
        const entry = accountHealth[key];
        if (shouldSkipGoogleAccountHealth(entry)) {
          skippedByHealth += 1;
          console.log(`[benchmark-backfill] skipping account ${account.id}${account.loginCustomerId ? ` via ${account.loginCustomerId}` : ""}: ${healthSkipReason(entry)}`);
          continue;
        }
        addJob(jobs, seen, {
          refreshToken: connection.refresh_token,
          account,
          source: "connection",
          sourceId: connection.id,
          userId: connection.user_id,
          accountHealth,
        });
      }
    }

    for (const session of activeSessions) {
      const connectedAccounts = parseCustomerIds(session.customer_ids);
      const accounts = connectedAccounts.length > 0
        ? connectedAccounts
        : session.customer_id
          ? [{ id: session.customer_id, name: session.customer_id, loginCustomerId: session.login_customer_id }]
          : [];

      for (const account of accounts) {
        addJob(jobs, seen, {
          refreshToken: session.refresh_token,
          account,
          source: "active_session",
          sourceId: session.id,
          userId: session.user_id,
        });
      }
    }

    console.log(`[benchmark-backfill] unique account routes: ${jobs.length}`);
    console.log(`[benchmark-backfill] skipped by account health: ${skippedByHealth}`);

    if (prioritizeUncovered) {
      const coverageRows = await sql<(CoverageStats & { account_id: string })[]>`
        SELECT account_id,
               COUNT(*)::int AS row_count,
               COUNT(*) FILTER (
                 WHERE snapshot_as_of_date = (SELECT MAX(snapshot_as_of_date) FROM campaign_benchmark_30d_snapshots)
               )::int AS recent_row_count,
               COUNT(DISTINCT account_id || ':' || campaign_id)::int AS campaign_count,
               MAX(created_at)::text AS last_created_at
        FROM campaign_benchmark_30d_snapshots
        GROUP BY account_id
      `;
      const coverage = new Map(coverageRows.map((row) => [row.account_id, row]));
      sortJobsByCoverage(jobs, coverage);
      const uncoveredRoutes = jobs.filter((job) => (coverage.get(accountKey(job.account))?.row_count ?? 0) === 0).length;
      const noRecentRoutes = jobs.filter((job) => (coverage.get(accountKey(job.account))?.recent_row_count ?? 0) === 0).length;
      console.log(`[benchmark-backfill] prioritized coverage gaps: uncoveredRoutes=${uncoveredRoutes}, noRecentRoutes=${noRecentRoutes}`);
    }

    const selectedJobs = jobs.slice(0, maxAccounts);
    if (selectedJobs.length < jobs.length) {
      console.log(`[benchmark-backfill] limiting this run to ${selectedJobs.length}/${jobs.length} account routes`);
    }

    let nextJob = 0;
    let accountsAttempted = 0;
    let rowsUpserted = 0;
    let errors = 0;
    let budgetExceeded = false;
    const blockedConnections = new Set<number>();

    async function worker(workerId: number) {
      while (!budgetExceeded) {
        const index = nextJob++;
        if (index >= selectedJobs.length) return;
        const job = selectedJobs[index]!;
        const { refreshToken, account } = job;
        const healthKey = routeKey(account);

        if (job.source === "connection" && blockedConnections.has(job.sourceId)) {
          skippedByHealth += 1;
          console.log(`[benchmark-backfill] [${index + 1}/${selectedJobs.length} w${workerId}] skipping account ${account.id}: connection ${job.sourceId} blocked by earlier auth failure`);
          continue;
        }

        accountsAttempted += 1;

        try {
          console.log(`[benchmark-backfill] [${index + 1}/${selectedJobs.length} w${workerId}] syncing account ${account.id}${account.loginCustomerId ? ` via ${account.loginCustomerId}` : ""}`);
          const summary = await syncCampaignBenchmarkSnapshots(refreshToken, [account], { days, mode, creditCounter, throwOnAccountError: true });
          rowsUpserted += summary.rows;
          errors += summary.errors;
          budgetExceeded = budgetExceeded || summary.budgetExceeded;
          if (job.source === "connection" && summary.errors === 0 && !summary.budgetExceeded) {
            await setConnectionHealthEntry(sql, job.sourceId, healthKey, buildGoogleAccountHealthSuccess());
          }
          console.log(`[benchmark-backfill] [${index + 1}/${selectedJobs.length} w${workerId}] account ${account.id}: rows=${summary.rows}, errors=${summary.errors}, credits=${summary.creditsUsed}/${summary.creditBudget ?? "none"}`);
        } catch (error) {
          if (error instanceof BenchmarkCreditBudgetExceeded) {
            budgetExceeded = true;
            console.warn(`[benchmark-backfill] [${index + 1}/${selectedJobs.length} w${workerId}] stopped by credit budget:`, error.message);
            continue;
          }
          errors += 1;
          if (job.source === "connection") {
            const classified = classifyGoogleBenchmarkError(error);
            const key = classified.errorLevel === "connection" ? CONNECTION_HEALTH_KEY : healthKey;
            const previous = healthEntryForJob(job, key);
            await setConnectionHealthEntry(sql, job.sourceId, key, buildGoogleAccountHealthFailure(previous, classified));
            if (classified.errorLevel === "connection") {
              blockedConnections.add(job.sourceId);
            }
            console.warn(`[benchmark-backfill] [${index + 1}/${selectedJobs.length} w${workerId}] account ${account.id} failed (${classified.errorLevel}/${classified.code}):`, classified.message);
          } else {
            console.warn(`[benchmark-backfill] [${index + 1}/${selectedJobs.length} w${workerId}] account ${account.id} failed:`, error);
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, selectedJobs.length) }, (_, i) => worker(i + 1)));

    const httpEnrichmentResults = await enrichOtherDomainsFromHttp(sql, days, httpEnrichOtherDomains);
    if (httpEnrichmentResults.length > 0) {
      const updated = httpEnrichmentResults.filter((result) => result.status === "updated");
      console.log("[benchmark-backfill] HTTP enrichment:", {
        requested: httpEnrichOtherDomains,
        attempted: httpEnrichmentResults.length,
        updatedDomains: updated.length,
        campaignsUpdated: updated.reduce((sum, result) => sum + (result.campaignsUpdated ?? 0), 0),
        rowsUpdated: updated.reduce((sum, result) => sum + (result.rowsUpdated ?? 0), 0),
        results: httpEnrichmentResults,
      });
    }

    const [coverage] = await sql<{
      row_count: number;
      account_count: number;
      campaign_count: number;
      min_date: string | null;
      max_date: string | null;
    }[]>`
      SELECT COUNT(*)::int AS row_count,
             COUNT(DISTINCT account_id)::int AS account_count,
             COUNT(DISTINCT account_id || ':' || campaign_id)::int AS campaign_count,
             MIN(window_start_date) AS min_date,
             MAX(snapshot_as_of_date) AS max_date
      FROM campaign_benchmark_30d_snapshots
    `;

    const industryRows = await sql<{
      industry_category: string;
      business_niche: string | null;
      currency_code: string;
      advertising_channel_type: string | null;
      account_count: number;
      campaign_count: number;
      row_count: number;
      impressions: number;
      clicks: number;
      cost_micros: number;
      conversions: number;
      conversions_value: number;
    }[]>`
      SELECT industry_category,
             COALESCE(business_niche, industry_category, 'Other') AS business_niche,
             currency_code,
             advertising_channel_type,
             COUNT(DISTINCT account_id)::int AS account_count,
             COUNT(DISTINCT account_id || ':' || campaign_id)::int AS campaign_count,
             COUNT(*)::int AS row_count,
             COALESCE(SUM(impressions), 0)::float8 AS impressions,
             COALESCE(SUM(clicks), 0)::float8 AS clicks,
             COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
             COALESCE(SUM(conversions), 0)::float8 AS conversions,
             COALESCE(SUM(conversions_value), 0)::float8 AS conversions_value
      FROM campaign_benchmark_30d_snapshots
      WHERE snapshot_as_of_date = (SELECT MAX(snapshot_as_of_date) FROM campaign_benchmark_30d_snapshots)
      GROUP BY industry_category, business_niche, currency_code, advertising_channel_type
      HAVING COALESCE(SUM(impressions), 0) > 0 OR COALESCE(SUM(cost_micros), 0) > 0
      ORDER BY cost_micros DESC
      LIMIT 20
    `;

    const industryAverages = industryRows.map((row) => ({
      industry: row.industry_category,
      niche: row.business_niche ?? row.industry_category ?? "Other",
      channel: normalizeChannel(row.advertising_channel_type),
      currency: row.currency_code,
      accounts: row.account_count,
      campaigns: row.campaign_count,
      rows: row.row_count,
      spend: roundMetric(money(row.cost_micros), 2),
      impressions: Math.round(row.impressions),
      clicks: Math.round(row.clicks),
      conversions: roundMetric(row.conversions, 2),
      ctr: roundMetric(percent(row.clicks, row.impressions), 4),
      avgCpc: roundMetric(money(row.cost_micros, row.clicks), 2),
      cvr: roundMetric(percent(row.conversions, row.clicks), 4),
      cpa: roundMetric(money(row.cost_micros, row.conversions), 2),
      roas: roundMetric(percent(row.conversions_value, money(row.cost_micros) ?? 0), 4),
    }));

    console.log("[benchmark-backfill] industry averages:", industryAverages);

    console.log("[benchmark-backfill] summary:", {
      mode,
      creditBudget,
      creditsUsed: creditCounter.used,
      budgetExceeded,
      accountsAttempted,
      skippedByHealth,
      rowsUpserted,
      errors,
      httpEnrichment: {
        requested: httpEnrichOtherDomains,
        attempted: httpEnrichmentResults.length,
        updatedDomains: httpEnrichmentResults.filter((result) => result.status === "updated").length,
      },
      coverage,
      industryAverages,
    });

    if (errors > 0 && !allowErrors) {
      process.exitCode = 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .catch((err) => {
    console.error("[benchmark-backfill] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // lib/db keeps a singleton postgres pool open; this one-shot script should
    // terminate after all writes and verification logs are flushed.
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });
