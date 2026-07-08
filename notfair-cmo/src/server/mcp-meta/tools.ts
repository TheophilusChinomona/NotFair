import { z } from "zod";
import vm from "node:vm";
import type { ToolDefinition, ToolResult } from "@/server/mcp-server/tools";

// ── Config helpers ────────────────────────────────────────────────────────

function accessToken(): string {
  return process.env.META_ACCESS_TOKEN ?? "";
}

function activeAccountId(): string {
  return process.env.META_AD_ACCOUNT_ID ?? "";
}

const API_BASE = "https://graph.facebook.com/v22.0";

// ── Response helpers ──────────────────────────────────────────────────────

const txt = (text: string): ToolResult => ({ ok: true, content: [{ type: "text", text }] });
const fail = (msg: string): ToolResult => ({ ok: false, error: msg });

// ── Graph API wrappers (used by sandbox and direct tools) ─────────────────

interface GraphCall {
  name: string;
  path: string;
  params?: Record<string, string | undefined>;
  method?: string;
  paged?: boolean;
  limit?: number;
}

async function graphApi(
  path: string,
  params?: Record<string, string | undefined>,
  method?: string,
): Promise<unknown> {
  const token = accessToken();
  if (!token) throw new Error("META_ACCESS_TOKEN not set");

  const url = new URL(
    path.startsWith("http") ? path : `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`,
  );
  url.searchParams.set("access_token", token);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), { method: method ?? "GET" });
  const data = await res.json() as Record<string, unknown>;
  if (data.error) {
    const err = data.error as { message?: string };
    throw new Error(err.message ?? "Graph API error");
  }
  return data;
}

async function graphParallel(
  calls: GraphCall[],
): Promise<Record<string, { ok: boolean; data?: unknown; error?: string; rowCount?: number }>> {
  const results = await Promise.allSettled(
    calls.map((c) =>
      graphApi(c.path, c.params, c.method).then((d) => {
        const rows: unknown[] =
          Array.isArray(d) ? d : Array.isArray((d as Record<string, unknown>)?.data) ? (d as Record<string, unknown>).data as unknown[] : [];
        return { ok: true as const, data: d, rowCount: rows.length };
      }),
    ),
  );
  const out: Record<string, { ok: boolean; data?: unknown; error?: string; rowCount?: number }> = {};
  for (let i = 0; i < calls.length; i++) {
    const r = results[i]!;
    out[calls[i]!.name] =
      r.status === "fulfilled"
        ? r.value
        : { ok: false, error: (r.reason as Error).message };
  }
  return out;
}

async function insights(
  adAccountId?: string,
  options?: Record<string, unknown>,
): Promise<unknown> {
  const accountId = adAccountId ?? activeAccountId();
  if (!accountId) throw new Error("No ad account ID. Set META_AD_ACCOUNT_ID or pass it.");

  const normalized = accountId.startsWith("act_") ? accountId.slice(4) : accountId;
  const params = new URLSearchParams({ access_token: accessToken() });
  if (options) {
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined) params.set(k, String(v));
    }
  }

  const res = await fetch(`${API_BASE}/act_${normalized}/insights?${params}`, { method: "GET" });
  const data = (await res.json()) as Record<string, unknown>;
  if (data.error) {
    const err = data.error as { message?: string };
    throw new Error(err.message ?? "Insights API error");
  }
  return data;
}

// ── Pre-made field strings ────────────────────────────────────────────────

const FIELDS = {
  campaign: "id,name,status,objective,daily_budget,lifetime_budget,budget_remaining,created_time,start_time,updated_time",
  adset: "id,name,status,campaign_id,daily_budget,lifetime_budget,budget_remaining,targeting,created_time,start_time,end_time",
  ad: "id,name,status,adset_id,campaign_id,creative,created_time,updated_time",
  adAccount: "id,name,account_status,currency,amount_spent,balance,min_daily_budget",
  insightsAudit:
    "account_id,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions,cost_per_action_type",
  insightsLite: "campaign_name,impressions,clicks,spend,ctr,cpc,cpm",
};

const HELPERS = {
  getDateRange(days: number): { since: string; until: string } {
    const until = new Date();
    const since = new Date();
    since.setDate(since.getDate() - days);
    return {
      since: since.toISOString().split("T")[0]!,
      until: until.toISOString().split("T")[0]!,
    };
  },
};

// ── Sandbox builder ───────────────────────────────────────────────────────

function buildSandboxCtx(): Record<string, unknown> {
  return {
    ads: {
      graph: graphApi,
      graphParallel,
      insights,
      activeAccountId: activeAccountId(),
      fields: FIELDS,
      helpers: HELPERS,
    },
    console: { log(...args: unknown[]) { /* noop in sandbox */ } },
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Math,
    Date,
    Error,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Reflect,
  };
}

/**
 * Execute user-provided JS code in a sandboxed Node `vm` context.
 * The sandbox exposes `ads.graph`, `ads.graphParallel`, `ads.insights`,
 * `ads.fields.*`, `ads.helpers.getDateRange`, and `ads.activeAccountId`.
 */
export async function runScriptSandbox(code: string): Promise<string> {
  const ctx = vm.createContext(buildSandboxCtx());
  const script = new vm.Script(`(async () => {\n${code}\n})()`);
  const result = await script.runInContext(ctx, { timeout: 30_000, breakOnSigint: true });
  return JSON.stringify(result, null, 2);
}

// ── Mutation helpers ──────────────────────────────────────────────────────

async function handleGraphMutation(
  objectId: string,
  updates: Record<string, string>,
): Promise<ToolResult> {
  const token = accessToken();
  if (!token) return fail("META_ACCESS_TOKEN not set");

  const url = new URL(`${API_BASE}/${objectId}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(updates)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), { method: "POST" });
  const data = (await res.json()) as Record<string, unknown>;
  if (data.error) {
    const errBody = data.error as { message?: string };
    return fail(errBody.message ?? "Graph API error");
  }
  return txt(JSON.stringify(data, null, 2));
}

// ── Tools ─────────────────────────────────────────────────────────────────

export const META_TOOLS: ToolDefinition[] = [
  {
    name: "runScript",
    description:
      "Execute arbitrary JavaScript in a sandbox with Meta Ads API wrappers. " +
      "Provides: ads.graph(path, params?, method?) — single Graph API call; " +
      "ads.graphParallel([{name, path, params?, method?}]) — fan out up to 20 calls; " +
      "ads.insights(adAccountId?, options?) — insights wrapper; " +
      "ads.fields.{campaign,adset,ad,adAccount,insightsAudit,insightsLite} — pre-made field strings; " +
      "ads.helpers.getDateRange(days) — {since, until} date helper; " +
      "ads.activeAccountId — the configured ad account ID. " +
      "Timeouts after 30 seconds. Return value is JSON-serialised.",
    inputSchema: z.object({
      code: z.string().min(1).describe("JavaScript code to execute"),
    }),
    handler: async (input) => {
      const { code } = input as { code: string };
      try {
        const result = await runScriptSandbox(code);
        return txt(result);
      } catch (e: unknown) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    name: "pauseCampaign",
    description: "Pause a Meta Ads campaign by ID.",
    inputSchema: z.object({
      campaignId: z.string().min(1),
    }),
    handler: async (input) => {
      const { campaignId } = input as { campaignId: string };
      return handleGraphMutation(campaignId, { status: "PAUSED" });
    },
  },
  {
    name: "enableCampaign",
    description: "Enable (reactivate) a paused Meta Ads campaign by ID.",
    inputSchema: z.object({
      campaignId: z.string().min(1),
    }),
    handler: async (input) => {
      const { campaignId } = input as { campaignId: string };
      return handleGraphMutation(campaignId, { status: "ACTIVE" });
    },
  },
  {
    name: "pauseAdSet",
    description: "Pause a Meta Ads ad set by ID.",
    inputSchema: z.object({
      adSetId: z.string().min(1),
    }),
    handler: async (input) => {
      const { adSetId } = input as { adSetId: string };
      return handleGraphMutation(adSetId, { status: "PAUSED" });
    },
  },
  {
    name: "enableAdSet",
    description: "Enable (reactivate) a paused Meta Ads ad set by ID.",
    inputSchema: z.object({
      adSetId: z.string().min(1),
    }),
    handler: async (input) => {
      const { adSetId } = input as { adSetId: string };
      return handleGraphMutation(adSetId, { status: "ACTIVE" });
    },
  },
  {
    name: "pauseAd",
    description: "Pause a Meta Ads ad (creative) by ID.",
    inputSchema: z.object({
      adId: z.string().min(1),
    }),
    handler: async (input) => {
      const { adId } = input as { adId: string };
      return handleGraphMutation(adId, { status: "PAUSED" });
    },
  },
  {
    name: "enableAd",
    description: "Enable (reactivate) a paused Meta Ads ad by ID.",
    inputSchema: z.object({
      adId: z.string().min(1),
    }),
    handler: async (input) => {
      const { adId } = input as { adId: string };
      return handleGraphMutation(adId, { status: "ACTIVE" });
    },
  },
  {
    name: "updateCampaignBudget",
    description:
      "Update a campaign's daily or lifetime budget. Values are in account currency (integer minor units, e.g. cents). " +
      "Provide at least one of dailyBudget or lifetimeBudget.",
    inputSchema: z.object({
      campaignId: z.string().min(1),
      dailyBudget: z.number().int().positive().optional(),
      lifetimeBudget: z.number().int().positive().optional(),
    }),
    handler: async (input) => {
      const { campaignId, dailyBudget, lifetimeBudget } = input as {
        campaignId: string;
        dailyBudget?: number;
        lifetimeBudget?: number;
      };
      const updates: Record<string, string> = {};
      if (dailyBudget !== undefined) updates.daily_budget = String(dailyBudget);
      if (lifetimeBudget !== undefined) updates.lifetime_budget = String(lifetimeBudget);
      if (dailyBudget === undefined && lifetimeBudget === undefined) {
        return fail("Provide at least one of dailyBudget or lifetimeBudget");
      }
      return handleGraphMutation(campaignId, updates);
    },
  },
  {
    name: "updateAdSetBudget",
    description:
      "Update an ad set's daily or lifetime budget. Values are in account currency (integer minor units, e.g. cents). " +
      "Provide at least one of dailyBudget or lifetimeBudget.",
    inputSchema: z.object({
      adSetId: z.string().min(1),
      dailyBudget: z.number().int().positive().optional(),
      lifetimeBudget: z.number().int().positive().optional(),
    }),
    handler: async (input) => {
      const { adSetId, dailyBudget, lifetimeBudget } = input as {
        adSetId: string;
        dailyBudget?: number;
        lifetimeBudget?: number;
      };
      const updates: Record<string, string> = {};
      if (dailyBudget !== undefined) updates.daily_budget = String(dailyBudget);
      if (lifetimeBudget !== undefined) updates.lifetime_budget = String(lifetimeBudget);
      if (dailyBudget === undefined && lifetimeBudget === undefined) {
        return fail("Provide at least one of dailyBudget or lifetimeBudget");
      }
      return handleGraphMutation(adSetId, updates);
    },
  },
  {
    name: "renameCampaign",
    description: "Rename a Meta Ads campaign.",
    inputSchema: z.object({
      campaignId: z.string().min(1),
      name: z.string().min(1).max(255),
    }),
    handler: async (input) => {
      const { campaignId, name } = input as { campaignId: string; name: string };
      return handleGraphMutation(campaignId, { name });
    },
  },
];
