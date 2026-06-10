import postgres from "postgres";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCachedCustomer } from "@/lib/google-ads/client";
import { inferBusinessClassification } from "@/lib/google-ads";
import type { AuthContext, ConnectedAccount } from "@/lib/google-ads/types";

type ConnectionRow = {
  id: number;
  user_id: string;
  refresh_token: string;
  active_account_id: string | null;
  account_ids: Array<{ id: string; name?: string; loginCustomerId?: string | null }> | null;
};

type CandidateAccount = {
  account_id: string;
  row_count: number;
  campaign_count: number;
  cost_micros: number;
  campaign_examples: string[];
};

type AccountRoute = {
  refreshToken: string;
  account: ConnectedAccount;
};

type LandingPageRow = {
  campaign?: { id?: string | number; name?: string };
  landing_page_view?: { unexpanded_final_url?: string };
  metrics?: { clicks?: number; cost_micros?: string | number };
};

type AdFinalUrlRow = {
  campaign?: { id?: string | number; name?: string };
  ad_group_ad?: { ad?: { final_urls?: string[] } };
};

type AssetGroupUrlRow = {
  campaign?: { id?: string | number; name?: string };
  asset_group?: { final_urls?: string[] };
};

type UrlSignal = {
  url: string;
  source: "landing_page_view" | "ad_group_ad" | "asset_group";
  campaignId?: string;
  campaignName?: string;
  clicks?: number;
  costMicros?: number;
};

type PageMetadata = {
  url: string;
  title: string;
  description: string;
  h1: string;
  text: string;
};

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

function argNumber(name: string, fallback: number, min: number, max: number) {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(name.length + 3));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeCustomerId(id: string) {
  return id.replace(/[^0-9]/g, "");
}

function normalizeConnectedAccounts(
  accounts: Array<{ id: string; name?: string; loginCustomerId?: string | null }>,
): ConnectedAccount[] {
  return accounts
    .filter((account) => Boolean(account.id))
    .map((account) => ({
      id: normalizeCustomerId(account.id),
      name: account.name ?? normalizeCustomerId(account.id),
      ...("loginCustomerId" in account ? { loginCustomerId: account.loginCustomerId ?? null } : {}),
    }));
}

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
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${quoted}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  return html.match(pattern)?.[1] ?? "";
}

function sanitizeFinalUrl(url: string | undefined) {
  if (!url) return null;
  const cleaned = url.replace(/\{[^}]+\}/g, "").trim();
  try {
    const parsed = new URL(cleaned);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseDomain(url: string | undefined) {
  const sanitized = sanitizeFinalUrl(url);
  if (!sanitized) return null;
  try {
    const parsed = new URL(sanitized);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function urlText(url: string) {
  const sanitized = sanitizeFinalUrl(url) ?? url;
  try {
    const parsed = new URL(sanitized);
    return `${parsed.hostname} ${decodeURIComponent(parsed.pathname).replace(/[-_/]+/g, " ")}`;
  } catch {
    return sanitized;
  }
}

async function fetchPageMetadata(url: string, timeoutMs: number): Promise<PageMetadata> {
  const sanitizedUrl = sanitizeFinalUrl(url) ?? url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(sanitizedUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "NotFairBenchmarkBot/1.0 (+https://notfair.co)",
        accept: "text/html,application/xhtml+xml",
      },
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
    return { url: response.url || url, title, description, h1, text: `${title} ${description} ${h1}` };
  } finally {
    clearTimeout(timeout);
  }
}

class CreditBudgetExceeded extends Error {
  constructor(public readonly used: number, public readonly budget: number, public readonly requested = 1) {
    super(`credit budget exceeded: used ${used}/${budget}, requested ${requested}`);
    this.name = "CreditBudgetExceeded";
  }
}

function makeCreditTracker(budget: number) {
  return {
    used: 0,
    reserve(credits = 1) {
      if (this.used + credits > budget) throw new CreditBudgetExceeded(this.used, budget, credits);
      this.used += credits;
    },
  };
}

function pushUnique(signals: UrlSignal[], signal: UrlSignal) {
  if (!signal.url || signals.some((item) => item.url === signal.url)) return;
  signals.push(signal);
}

async function collectUrlSignals(auth: AuthContext, days: number, credit: ReturnType<typeof makeCreditTracker>, queryDelayMs: number) {
  const customer = getCachedCustomer(auth);
  const signals: UrlSignal[] = [];
  const campaignNames: string[] = [];

  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - Math.max(1, days) + 1);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  try {
    credit.reserve(1);
    const rows = await customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        landing_page_view.unexpanded_final_url,
        metrics.clicks,
        metrics.cost_micros
      FROM landing_page_view
      WHERE campaign.status != 'REMOVED'
        AND segments.date BETWEEN '${startDate}' AND '${endDate}'
        AND metrics.clicks > 0
      ORDER BY metrics.clicks DESC
      LIMIT 50
    `) as LandingPageRow[];
    for (const row of rows) {
      const url = row.landing_page_view?.unexpanded_final_url;
      if (!url) continue;
      const campaignId = row.campaign?.id == null ? undefined : String(row.campaign.id);
      const campaignName = row.campaign?.name;
      if (campaignName) campaignNames.push(campaignName);
      const sanitizedUrl = sanitizeFinalUrl(url);
      if (!sanitizedUrl) continue;
      pushUnique(signals, {
        url: sanitizedUrl,
        source: "landing_page_view",
        campaignId,
        campaignName,
        clicks: Number(row.metrics?.clicks ?? 0),
        costMicros: Number(row.metrics?.cost_micros ?? 0),
      });
    }
  } catch (error) {
    if (error instanceof CreditBudgetExceeded) throw error;
    console.warn(`[landing-enrich] landing_page_view query failed for ${auth.customerId}:`, error);
  }

  if (signals.length === 0) {
    if (queryDelayMs > 0) await sleep(queryDelayMs);
    try {
      credit.reserve(1);
      const rows = await customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          ad_group_ad.ad.final_urls
        FROM ad_group_ad
        WHERE campaign.status != 'REMOVED'
          AND ad_group.status != 'REMOVED'
          AND ad_group_ad.status != 'REMOVED'
        LIMIT 100
      `) as AdFinalUrlRow[];
      for (const row of rows) {
        const campaignId = row.campaign?.id == null ? undefined : String(row.campaign.id);
        const campaignName = row.campaign?.name;
        if (campaignName) campaignNames.push(campaignName);
        for (const url of row.ad_group_ad?.ad?.final_urls ?? []) {
          const sanitizedUrl = sanitizeFinalUrl(url);
          if (sanitizedUrl) pushUnique(signals, { url: sanitizedUrl, source: "ad_group_ad", campaignId, campaignName });
        }
      }
    } catch (error) {
      if (error instanceof CreditBudgetExceeded) throw error;
      console.warn(`[landing-enrich] ad_group_ad final URL query failed for ${auth.customerId}:`, error);
    }
  }

  if (signals.length === 0) {
    if (queryDelayMs > 0) await sleep(queryDelayMs);
    try {
      credit.reserve(1);
      const rows = await customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          asset_group.final_urls
        FROM asset_group
        WHERE campaign.status != 'REMOVED'
          AND asset_group.status != 'REMOVED'
        LIMIT 100
      `) as AssetGroupUrlRow[];
      for (const row of rows) {
        const campaignId = row.campaign?.id == null ? undefined : String(row.campaign.id);
        const campaignName = row.campaign?.name;
        if (campaignName) campaignNames.push(campaignName);
        for (const url of row.asset_group?.final_urls ?? []) {
          const sanitizedUrl = sanitizeFinalUrl(url);
          if (sanitizedUrl) pushUnique(signals, { url: sanitizedUrl, source: "asset_group", campaignId, campaignName });
        }
      }
    } catch (error) {
      if (error instanceof CreditBudgetExceeded) throw error;
      console.warn(`[landing-enrich] asset_group final URL query failed for ${auth.customerId}:`, error);
    }
  }

  return { signals, campaignNames: Array.from(new Set(campaignNames)) };
}

async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL");

  const apply = hasFlag("apply");
  const days = argNumber("days", 30, 1, 365);
  const creditBudget = argNumber("credit-budget", 100, 1, 10000);
  const maxAccounts = argNumber("max-accounts", 333, 1, 5000);
  const accountDelayMs = argNumber("account-delay-ms", 1000, 0, 60000);
  const queryDelayMs = argNumber("query-delay-ms", 500, 0, 60000);
  const httpDelayMs = argNumber("http-delay-ms", 1000, 0, 60000);
  const httpTimeoutMs = argNumber("http-timeout-ms", 5000, 500, 30000);
  const skipHttp = hasFlag("skip-http");
  const skipExistingLandingUrl = !hasFlag("include-existing-url");
  const credit = makeCreditTracker(creditBudget);

  console.log(`[landing-enrich] DATABASE_URL → ${safeDatabaseLabel(url)}`);
  console.log(`[landing-enrich] mode: ${apply ? "apply" : "dry-run"}`);
  console.log(`[landing-enrich] limits: maxAccounts=${maxAccounts}, creditBudget=${creditBudget}, accountDelayMs=${accountDelayMs}, queryDelayMs=${queryDelayMs}, httpDelayMs=${httpDelayMs}, skipHttp=${skipHttp}, skipExistingLandingUrl=${skipExistingLandingUrl}`);

  const sql = postgres(url, { prepare: false, max: 1 });
  try {
    await sql`ALTER TABLE campaign_benchmark_30d_snapshots ADD COLUMN IF NOT EXISTS business_landing_page_url text`;

    const candidates = await sql<CandidateAccount[]>`
      WITH account_niches AS (
        SELECT account_id,
               COUNT(*)::int AS row_count,
               COUNT(DISTINCT campaign_id)::int AS campaign_count,
               COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
               BOOL_OR(lower(trim(coalesce(business_niche, ''))) NOT IN ('', 'other', 'unknown', 'uncategorized')) AS has_actual_niche,
               BOOL_OR(business_landing_page_url IS NOT NULL) AS has_landing_page_url,
               ARRAY_AGG(DISTINCT campaign_name) FILTER (WHERE campaign_name IS NOT NULL) AS campaign_examples
        FROM campaign_benchmark_30d_snapshots
        GROUP BY account_id
      )
      SELECT account_id, row_count, campaign_count, cost_micros, campaign_examples
      FROM account_niches
      WHERE NOT has_actual_niche
        AND (${skipExistingLandingUrl} = false OR NOT has_landing_page_url)
      ORDER BY cost_micros DESC, row_count DESC
      LIMIT ${maxAccounts}
    `;

    const connections = await sql<ConnectionRow[]>`
      SELECT id, user_id, refresh_token, active_account_id, account_ids
      FROM ad_platform_connections
      WHERE platform = 'google_ads'
      ORDER BY updated_at DESC
    `;

    const routeByAccount = new Map<string, AccountRoute>();
    for (const connection of connections) {
      const accounts = normalizeConnectedAccounts(connection.account_ids ?? []);
      const fallback = connection.active_account_id
        ? [{ id: normalizeCustomerId(connection.active_account_id), name: normalizeCustomerId(connection.active_account_id) }]
        : [];
      for (const account of accounts.length > 0 ? accounts : fallback) {
        if (!account.id || routeByAccount.has(account.id)) continue;
        routeByAccount.set(account.id, { refreshToken: connection.refresh_token, account });
      }
    }

    let attempted = 0;
    let withRoute = 0;
    let withUrl = 0;
    let withHttp = 0;
    let updatedAccounts = 0;
    let updatedRows = 0;
    let touchedRows = 0;
    let stillOther = 0;
    let errors = 0;
    let budgetExceeded = false;
    const highlights: unknown[] = [];

    for (const candidate of candidates) {
      const route = routeByAccount.get(candidate.account_id);
      if (!route) {
        errors += 1;
        console.warn(`[landing-enrich] no connection route for account ${candidate.account_id}`);
        continue;
      }
      withRoute += 1;
      attempted += 1;

      const accountName = route.account.name ?? candidate.account_id;
      const auth: AuthContext = {
        refreshToken: route.refreshToken,
        customerId: route.account.id,
        loginCustomerId: route.account.loginCustomerId ?? undefined,
      };

      try {
        console.log(`[landing-enrich] [${attempted}/${candidates.length}] account ${candidate.account_id} (${accountName}); credits=${credit.used}/${creditBudget}`);
        const { signals, campaignNames } = await collectUrlSignals(auth, days, credit, queryDelayMs);
        const bestSignal = signals[0];
        const domain = parseDomain(bestSignal?.url);
        if (bestSignal) withUrl += 1;

        let page: PageMetadata | null = null;
        if (!skipHttp && bestSignal?.url && /^https?:\/\//i.test(bestSignal.url)) {
          if (httpDelayMs > 0) await sleep(httpDelayMs);
          try {
            page = await fetchPageMetadata(bestSignal.url, httpTimeoutMs);
            withHttp += 1;
          } catch (error) {
            console.warn(`[landing-enrich] HTTP metadata failed for ${candidate.account_id} ${bestSignal.url}:`, error);
          }
        }

        const seed = [
          accountName,
          domain ?? "",
          signals.slice(0, 5).map((signal) => urlText(signal.url)).join(" "),
          candidate.campaign_examples.join(" "),
          campaignNames.join(" "),
          page?.text ?? "",
        ].join(" ");
        const classification = inferBusinessClassification(seed);
        const isActual = classification.industryCategory !== "Other" && classification.businessNiche !== "Other";

        let rowsUpdated = 0;
        if (apply && (domain || bestSignal?.url || isActual)) {
          const [countRow] = await sql<{ rows_updated: number }[]>`
            WITH touched AS (
              UPDATE campaign_benchmark_30d_snapshots
              SET business_domain = COALESCE(${domain}, business_domain),
                  business_landing_page_url = COALESCE(${bestSignal?.url ?? null}, business_landing_page_url),
                  industry_category = CASE WHEN ${isActual} THEN ${classification.industryCategory} ELSE industry_category END,
                  business_niche = CASE WHEN ${isActual} THEN ${classification.businessNiche} ELSE business_niche END
              WHERE account_id = ${candidate.account_id}
                AND lower(trim(coalesce(business_niche, ''))) IN ('', 'other', 'unknown', 'uncategorized')
              RETURNING 1
            )
            SELECT COUNT(*)::int AS rows_updated FROM touched
          `;
          rowsUpdated = countRow?.rows_updated ?? 0;
        }

        if (isActual) {
          updatedAccounts += 1;
          updatedRows += rowsUpdated;
        } else {
          stillOther += 1;
        }
        touchedRows += rowsUpdated;

        highlights.push({
          accountId: candidate.account_id,
          accountName,
          domain,
          source: bestSignal?.source ?? null,
          landingPageUrl: bestSignal?.url ?? null,
          pageTitle: page?.title ?? null,
          classification,
          status: isActual ? "classified" : bestSignal ? "url_found_still_other" : "no_url_found",
          rowsUpdated,
          creditsUsed: credit.used,
        });
      } catch (error) {
        if (error instanceof CreditBudgetExceeded) {
          budgetExceeded = true;
          console.warn(`[landing-enrich] stopped by credit budget: ${error.message}`);
          break;
        }
        errors += 1;
        console.warn(`[landing-enrich] account ${candidate.account_id} failed:`, error);
      }

      if (accountDelayMs > 0) await sleep(accountDelayMs);
    }

    const [remaining] = await sql<{ accounts_without_actual_niche: number; rows_without_actual_niche: number }[]>`
      WITH account_niches AS (
        SELECT account_id,
               BOOL_OR(lower(trim(coalesce(business_niche, ''))) NOT IN ('', 'other', 'unknown', 'uncategorized')) AS has_actual_niche
        FROM campaign_benchmark_30d_snapshots
        GROUP BY account_id
      )
      SELECT COUNT(*) FILTER (WHERE NOT has_actual_niche)::int AS accounts_without_actual_niche,
             (SELECT COUNT(*)::int FROM campaign_benchmark_30d_snapshots WHERE lower(trim(coalesce(business_niche, ''))) IN ('', 'other', 'unknown', 'uncategorized')) AS rows_without_actual_niche
      FROM account_niches
    `;

    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      creditBudget,
      creditsUsed: credit.used,
      budgetExceeded,
      candidates: candidates.length,
      attempted,
      withRoute,
      withUrl,
      withHttp,
      updatedAccounts,
      updatedRows,
      touchedRows,
      stillOther,
      errors,
      remaining,
      highlights,
    }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("[landing-enrich] FAILED:", error);
  process.exitCode = 1;
});
