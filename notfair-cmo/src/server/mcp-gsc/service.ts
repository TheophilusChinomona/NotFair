import { google, type Auth } from "googleapis";

export interface SiteListResult {
  sites: Array<{ siteUrl: string; permissionLevel: string }>;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResult {
  rows: SearchAnalyticsRow[];
  totalClicks: number;
  totalImpressions: number;
}

export interface InspectionResult {
  indexStatus: string | null;
  coverageState: string | null;
  mobileUsability: string | null;
  richResultStatus: string | null;
  lastCrawlTime: string | null;
  referringSitemaps: string[] | null;
}

let _client: Auth.OAuth2Client | Auth.JWT | null = null;

async function getClient(): Promise<Auth.OAuth2Client | Auth.JWT> {
  if (_client) return _client;
  const auth = new google.auth.GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/webmasters",
      "https://www.googleapis.com/auth/webmasters.readonly",
    ],
  });
  _client = (await auth.getClient()) as Auth.OAuth2Client | Auth.JWT;
  return _client;
}

export async function listSites(): Promise<SiteListResult> {
  const client = await getClient();
  const gsc = google.searchconsole({ version: "v1", auth: client });
  const res = await gsc.sites.list({});
  const entries = res.data.siteEntry ?? [];
  return {
    sites: entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .map((e) => ({ siteUrl: e.siteUrl ?? "", permissionLevel: e.permissionLevel ?? "" })),
  };
}

export async function querySearchAnalytics(
  siteUrl: string,
  startDate: string,
  endDate: string,
  dimensions?: string[],
  rowLimit?: number,
  type?: string,
): Promise<SearchAnalyticsResult> {
  const client = await getClient();
  const gsc = google.searchconsole({ version: "v1", auth: client });
  const body: Record<string, unknown> = { startDate, endDate, rowLimit: rowLimit ?? 1000 };
  if (dimensions?.length) body.dimensions = dimensions;
  if (type) body.type = type;

  const res = await gsc.searchanalytics.query({ siteUrl, requestBody: body });
  const rows = (res.data.rows ?? []).filter((r): r is NonNullable<typeof r> => r !== null);
  let totalClicks = 0;
  let totalImpressions = 0;
  for (const r of rows) {
    totalClicks += r.clicks ?? 0;
    totalImpressions += r.impressions ?? 0;
  }
  return {
    rows: rows.map((r) => ({
      keys: r.keys ?? [],
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    })),
    totalClicks,
    totalImpressions,
  };
}

export async function inspectUrl(siteUrl: string, inspectionUrl: string): Promise<InspectionResult> {
  const client = await getClient();
  const gsc = google.searchconsole({ version: "v1", auth: client });
  const res = await gsc.urlInspection.index.inspect({ requestBody: { siteUrl, inspectionUrl } });
  const result = res.data.inspectionResult;
  const indexStatus = result?.indexStatusResult;
  const mobile = result?.mobileUsabilityResult;
  const rich = result?.richResultsResult;
  return {
    indexStatus: indexStatus?.indexStatus ?? null,
    coverageState: indexStatus?.coverageState ?? null,
    mobileUsability: mobile?.mobileUsabilityVerdict ?? null,
    richResultStatus: rich?.detectedItems?.length ? (rich.detectedItems[0]?.richResultType ?? null) : null,
    lastCrawlTime: indexStatus?.lastCrawlTime ?? null,
    referringSitemaps: indexStatus?.referringSitemaps ?? null,
  };
}
