import { google } from "googleapis";
import { z } from "zod";

// ── Auth ─────────────────────────────────────────────────────────────────
// Use GoogleAuth directly to avoid version mismatch between google-auth-library
// instances in the dependency tree. GoogleAuth is accepted by all API constructors
// and resolves credentials lazily at request time.

let cachedAuth: ReturnType<typeof createAuth> | null = null;

function createAuth() {
  return new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/business.manage"],
  });
}

function getAuth() {
  if (!cachedAuth) cachedAuth = createAuth();
  return cachedAuth;
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface Account {
  name: string;
  accountName: string;
  type: string;
  role: string;
}

export interface Location {
  name: string;
  title: string;
  storeCode?: string;
  languageCode: string;
  phoneNumbers?: unknown;
  websiteUri?: string;
  regularHours?: unknown;
  categories?: unknown;
  storefrontAddress?: unknown;
  metadata?: unknown;
  profile?: unknown;
}

export interface Review {
  reviewId: string;
  reviewer: { displayName: string; profilePhotoUrl: string };
  starRating: number;
  comment: string;
  createTime: string;
  updateTime: string;
  reviewReply?: { comment: string; updateTime: string };
  name: string;
}

export interface Post {
  name: string;
  languageCode: string;
  alertType?: string;
  topicType: string;
  event?: Record<string, unknown>;
  offer?: Record<string, unknown>;
  summary: Record<string, unknown>;
  callToAction?: Record<string, unknown>;
  createTime: string;
  updateTime: string;
  state: string;
  searchUrl: string;
}

export interface ReviewReplyResult {
  reviewId: string;
  comment: string;
  updateTime: string;
}

export interface InsightsResult {
  multiDailyMetricTimeSeries: Array<{
    dailyMetric: string;
    timeSeries: {
      datedValues: Array<{
        date: { year: number; month: number; day: number };
        value: string;
      }>;
    };
  }>;
}

// ── Schemas ───────────────────────────────────────────────────────────────

const accountNameSchema = z.string().regex(/^accounts\/[^/]+$/);

const locationNameSchema = z
  .string()
  .regex(/^(accounts\/[^/]+\/locations\/[^/]+|locations\/[^/]+)$/);

// ── GBP REST helpers (reviews, posts — not in googleapis) ─────────────────

async function gbpFetch<T>(
  path: string,
  options: { method?: string; data?: unknown; params?: Record<string, string | number> } = {},
): Promise<T> {
  const client = await getAuth().getClient();
  const token = await client.getAccessToken();
  const accessToken = token?.token;
  if (!accessToken) throw new Error("Failed to obtain GBP access token");

  const url = new URL(`https://mybusiness.googleapis.com/v4/${path}`);
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: options.data ? JSON.stringify(options.data) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GBP API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Accounts ──────────────────────────────────────────────────────────────

export async function listAccounts(): Promise<Account[]> {
  const api = google.mybusinessaccountmanagement({ version: "v1", auth: getAuth() });
  const res = await api.accounts.list({});
  const entries = res.data.accounts ?? [];
  return entries
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .map((e) => ({
      name: e.name ?? "",
      accountName: e.accountName ?? "",
      type: e.type ?? "",
      role: e.role ?? "",
    }));
}

// ── Locations ─────────────────────────────────────────────────────────────

export async function listLocations(accountName: string): Promise<Location[]> {
  accountNameSchema.parse(accountName);
  const api = google.mybusinessbusinessinformation({ version: "v1", auth: getAuth() });
  const res = await api.accounts.locations.list({
    parent: accountName,
    readMask:
      "name,title,storeCode,languageCode,phoneNumbers,websiteUri,regularHours,categories,storefrontAddress,metadata,profile",
    pageSize: 100,
  });
  const entries = res.data.locations ?? [];
  return entries
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .map((e) => ({
      name: e.name ?? "",
      title: e.title ?? "",
      storeCode: e.storeCode ?? undefined,
      languageCode: e.languageCode ?? "",
      phoneNumbers: e.phoneNumbers ?? undefined,
      websiteUri: e.websiteUri ?? undefined,
      regularHours: e.regularHours ?? undefined,
      categories: e.categories ?? undefined,
      storefrontAddress: e.storefrontAddress ?? undefined,
      metadata: e.metadata ?? undefined,
      profile: e.profile ?? undefined,
    }));
}

export async function getLocation(locationName: string): Promise<Location> {
  locationNameSchema.parse(locationName);
  const api = google.mybusinessbusinessinformation({ version: "v1", auth: getAuth() });
  const res = await api.locations.get({
    name: locationName,
    readMask:
      "name,title,storeCode,languageCode,phoneNumbers,websiteUri,regularHours,categories,storefrontAddress,metadata,profile",
  });
  const e = res.data;
  return {
    name: e.name ?? "",
    title: e.title ?? "",
    storeCode: e.storeCode ?? undefined,
    languageCode: e.languageCode ?? "",
    phoneNumbers: e.phoneNumbers ?? undefined,
    websiteUri: e.websiteUri ?? undefined,
    regularHours: e.regularHours ?? undefined,
    categories: e.categories ?? undefined,
    storefrontAddress: e.storefrontAddress ?? undefined,
    metadata: e.metadata ?? undefined,
    profile: e.profile ?? undefined,
  };
}

// ── Reviews ───────────────────────────────────────────────────────────────

export async function listReviews(
  accountName: string,
  locationName: string,
): Promise<Review[]> {
  accountNameSchema.parse(accountName);
  locationNameSchema.parse(locationName);
  const data = await gbpFetch<{ reviews?: Review[] }>(
    `${accountName}/${locationName}/reviews`,
    { params: { pageSize: 100 } },
  );
  return data.reviews ?? [];
}

export async function replyToReview(
  accountName: string,
  locationName: string,
  reviewId: string,
  comment: string,
): Promise<ReviewReplyResult> {
  accountNameSchema.parse(accountName);
  locationNameSchema.parse(locationName);
  return gbpFetch<ReviewReplyResult>(
    `${accountName}/${locationName}/reviews/${reviewId}/reply`,
    { method: "POST", data: { comment } },
  );
}

// ── Posts ─────────────────────────────────────────────────────────────────

export async function listPosts(
  accountName: string,
  locationName: string,
): Promise<Post[]> {
  accountNameSchema.parse(accountName);
  locationNameSchema.parse(locationName);
  const data = await gbpFetch<{ localPosts?: Post[] }>(
    `${accountName}/${locationName}/localPosts`,
    { params: { pageSize: 100 } },
  );
  return data.localPosts ?? [];
}

export async function createPost(
  accountName: string,
  locationName: string,
  post: {
    topicType: string;
    languageCode: string;
    summary: Record<string, unknown>;
    callToAction?: Record<string, unknown>;
    event?: Record<string, unknown>;
    offer?: Record<string, unknown>;
    alertType?: string;
  },
): Promise<Post> {
  accountNameSchema.parse(accountName);
  locationNameSchema.parse(locationName);
  return gbpFetch<Post>(
    `${accountName}/${locationName}/localPosts`,
    { method: "POST", data: post },
  );
}

// ── Insights ──────────────────────────────────────────────────────────────

export async function getInsights(
  locationName: string,
  dailyMetrics: string[],
  startDate: string,
  endDate: string,
): Promise<InsightsResult> {
  locationNameSchema.parse(locationName);
  const api = google.businessprofileperformance({ version: "v1", auth: getAuth() });

  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);

  // fetchMultiDailyMetricsTimeSeries is overloaded (promise + callback). Use
  // the known-correct overload signature by casting at the library boundary.
  const res = await api.locations.fetchMultiDailyMetricsTimeSeries({
    location: locationName,
    dailyMetrics: dailyMetrics,
    "dailyRange.start_date.year": startYear,
    "dailyRange.start_date.month": startMonth,
    "dailyRange.start_date.day": startDay,
    "dailyRange.end_date.year": endYear,
    "dailyRange.end_date.month": endMonth,
    "dailyRange.end_date.day": endDay,
  } as unknown as Parameters<typeof api.locations.fetchMultiDailyMetricsTimeSeries>[0]);

  return (res as unknown as { data: InsightsResult }).data;
}
