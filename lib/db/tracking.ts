import { db, schema } from "./index";
import { eq, and, gt, gte, lt, lte, desc, inArray, sql } from "drizzle-orm";
import type { WriteResult } from "@/lib/google-ads";
import { maybeFireRedditFirstWrite } from "@/lib/reddit-first-write";
import { trackServerEvent } from "@/lib/analytics-server";
import {
  IMPACT_CORRELATION_DISCLAIMER,
  IMPACT_WINDOW_DAYS,
  MIN_AFTER_DAYS_FOR_DIRECTION,
  computeChangeImpactReview,
  computeSnapshotImpact,
  type ChangeRow,
  type ReviewChangeImpact,
  type SnapshotRow,
} from "./impact";

// ─── Compact Code Maps ──────────────────────────────────────────────

export const OP_TYPE = { READ: 0, WRITE: 1 } as const;

/** Tool name → compact code. Add new tools at the end to preserve existing data. */
export const TOOL_CODE = {
  // Writes
  pause_keyword: 0,
  enable_keyword: 1,
  update_bid: 2,
  add_negative_keyword: 3,
  remove_negative_keyword: 4,
  update_budget: 5,
  pause_campaign: 6,
  enable_campaign: 7,
  undo: 8,
  create_campaign: 9,
  remove_campaign: 10,
  create_shopping_campaign: 55,
  create_pmax_campaign: 56,
  create_demand_gen_campaign: 57,
  create_display_campaign: 58,
  create_video_campaign: 59,
  create_app_campaign: 60,
  add_keyword: 11,
  remove_keyword: 12,
  set_tracking_template: 13,
  create_ad_group: 14,
  create_ad: 15,
  pause_ad: 16,
  enable_ad: 17,
  update_ad_final_url: 18,
  update_ad_assets: 19,
  // Campaign settings (compound — separate actions for networks vs location)
  update_campaign_networks: 36,
  add_campaign_location: 37,
  remove_campaign_location: 38,
  rename_campaign: 39,
  rename_ad_group: 40,
  update_bidding: 41,
  update_goal_config: 42,
  update_geo_target_type: 52,
  add_proximity_target: 53,
  remove_proximity_target: 54,
  // Reads (20+)
  get_account_info: 20,
  list_campaigns: 21,
  get_campaign_performance: 22,
  get_keywords: 23,
  get_search_term_report: 24,
  run_gaql_query: 25,
  get_changes: 26,
  list_accessible_customers: 27,
  get_tracking_template: 28,
  list_ad_groups: 29,
  list_ads: 30,
  get_impression_share: 31,
  get_conversion_actions: 32,
  get_account_settings: 33,
  get_campaign_settings: 34,
  get_recommendations: 35,
  review_change_impact: 43,
  // Experiments (drafts & trials)
  create_experiment: 44,
  add_experiment_arms: 45,
  schedule_experiment: 46,
  end_experiment: 47,
  promote_experiment: 48,
  graduate_experiment: 49,
  list_experiment_async_errors: 50,
  create_ad_variation_experiment: 51,
} as const;

type ToolCode = (typeof TOOL_CODE)[keyof typeof TOOL_CODE];

/** Reverse lookup: code → tool name */
export const CODE_TO_TOOL: Record<number, string> = Object.fromEntries(
  Object.entries(TOOL_CODE).map(([name, code]) => [code, name]),
);

export const ENTITY_CODE = {
  keyword: 0,
  campaign: 1,
  unknown: 2,
} as const;

export const CODE_TO_ENTITY: Record<number, string> = Object.fromEntries(
  Object.entries(ENTITY_CODE).map(([name, code]) => [code, name]),
);

/** Resolve tool name string to its compact code. Returns undefined for unknown tools. */
export function toolNameToCode(name: string): ToolCode | undefined {
  return (TOOL_CODE as Record<string, ToolCode>)[name];
}

function getEntityCode(action: string): number {
  if (action.includes("keyword") || action.includes("bid")) return ENTITY_CODE.keyword;
  if (action.includes("campaign") || action.includes("budget") || action.includes("goal_config")) return ENTITY_CODE.campaign;
  return ENTITY_CODE.unknown;
}

// ─── Per-call telemetry (captured at the MCP boundary) ─────────────

export const ERROR_CLASS = {
  THROWN: "THROWN",
  RATE_LIMIT: "RATE_LIMIT",
  WRITE_REJECTED: "WRITE_REJECTED",
  LOGGING: "LOGGING",
} as const;

export type ErrorClass = (typeof ERROR_CLASS)[keyof typeof ERROR_CLASS];

export type CallTelemetry = {
  sessionId?: number | null;
  requestId?: string | null;
  /** Raw camelCase MCP tool name (e.g. "listCampaigns"). */
  toolName?: string | null;
  /** Already-redacted args object (see lib/db/redact.ts). */
  args?: unknown;
  argsSha256?: string | null;
  latencyMs?: number | null;
  bytesOut?: number | null;
  errorClass?: ErrorClass | null;
  /**
   * Human-readable error message for non-success telemetry rows. Populated
   * alongside `errorClass` for THROWN / RATE_LIMIT paths so dashboards don't
   * see `error_class='THROWN'` with `error_message=NULL`. Callers should
   * normalize unknowns through `extractErrorMessage` before setting.
   */
  errorMessage?: string | null;
};

/**
 * Resolve a human-readable action label from an operations row. Prefers the
 * raw `tool_name` (populated for every new row) and falls back to the legacy
 * `tool_code` map for rows written before the telemetry migration.
 */
export function resolveToolLabel(row: {
  toolName: string | null;
  toolCode: number | null;
}): string {
  if (row.toolName) return row.toolName;
  if (row.toolCode != null && CODE_TO_TOOL[row.toolCode]) return CODE_TO_TOOL[row.toolCode];
  return `unknown_${row.toolCode ?? "null"}`;
}

function telemetryColumns(
  telemetry: CallTelemetry | undefined,
  toolNameFallback: string,
) {
  return {
    sessionId: telemetry?.sessionId ?? null,
    requestId: telemetry?.requestId ?? null,
    toolName: telemetry?.toolName ?? toolNameFallback,
    args: (telemetry?.args as object | null) ?? null,
    argsSha256: telemetry?.argsSha256 ?? null,
    latencyMs: telemetry?.latencyMs ?? null,
    bytesOut: telemetry?.bytesOut ?? null,
  };
}

// ─── First-tool-call activation instrumentation ────────────────────

/**
 * Fire PostHog events the first time a user invokes any tool (read or write),
 * so we can measure the signup → first-tool-call drop in the activation
 * funnel. Called BEFORE the insert on both the read and write paths — an
 * empty prior-rows query means "this insert will be the first". Querying
 * before the insert (rather than after with a `gt(id, justInsertedId)`
 * filter) keeps the logic identical across read and write paths, since
 * `logRead` does not call `.returning()`.
 *
 * Never throws — telemetry must never break the user request.
 *
 * IMPORTANT: Every route handler that reaches this code path MUST wrap its
 * response with `after(flushServerEvents)` from `next/server`. Without the
 * flush, posthog-node races the Vercel Lambda freezing and events drop
 * (verified Apr 2026 for `user_signed_up` — 43% loss).
 */
export async function maybeFireFirstToolCallEvent(opts: {
  userId: string | null | undefined;
  toolName: string | null;
  success: number; // 0 or 1
  errorClass: string | null;
  clientSource: string | null;
}): Promise<void> {
  if (!opts.userId) return;

  try {
    const prior = await db()
      .select({ id: schema.operations.id })
      .from(schema.operations)
      .where(eq(schema.operations.userId, opts.userId))
      .limit(1);

    if (prior.length > 0) return;

    trackServerEvent(opts.userId, "first_tool_call_attempted", {
      tool_name: opts.toolName,
      client_source: opts.clientSource,
      success: opts.success === 1,
      error_class: opts.errorClass,
    });

    if (opts.success === 0) {
      trackServerEvent(opts.userId, "first_tool_call_error", {
        tool_name: opts.toolName,
        client_source: opts.clientSource,
        error_class: opts.errorClass,
      });
    }
  } catch (err) {
    console.error("[tracking] maybeFireFirstToolCallEvent failed:", err);
  }
}

// ─── Write Logging ──────────────────────────────────────────────────

export type LogChangeOpts = {
  accountId: string;
  userId: string | null | undefined;
  campaignId: string | null;
  writeResult: WriteResult;
  reasoning?: string;
  clientSource?: string | null;
  telemetry?: CallTelemetry;
  /** Defaults to "google_ads" for back-compat with existing call sites. */
  platform?: "google_ads" | "meta_ads";
};

export async function logChange(opts: LogChangeOpts) {
  const { accountId, userId, campaignId, writeResult, reasoning, clientSource, telemetry, platform } = opts;
  try {
    const code = toolNameToCode(writeResult.action) ?? null;
    if (code === null) {
      console.warn(`[tracking] Unmapped tool name (logged with null tool_code): ${writeResult.action}`);
    }

    // Fire first-tool-call PostHog events BEFORE the insert so the "prior rows"
    // query detects a truly empty history. See `maybeFireFirstToolCallEvent`.
    await maybeFireFirstToolCallEvent({
      userId: userId ?? null,
      toolName: telemetry?.toolName ?? writeResult.action,
      success: writeResult.success ? 1 : 0,
      errorClass:
        telemetry?.errorClass ??
        (writeResult.success ? null : ERROR_CLASS.WRITE_REJECTED),
      clientSource: clientSource ?? null,
    });

    const [inserted] = await db()
      .insert(schema.operations)
      .values({
        accountId,
        userId: userId ?? null,
        campaignId,
        platform: platform ?? "google_ads",
        opType: OP_TYPE.WRITE,
        toolCode: code,
        entityCode: getEntityCode(writeResult.action),
        entityId: writeResult.entityId,
        label: writeResult.label ?? null,
        beforeValue: writeResult.beforeValue,
        afterValue: writeResult.afterValue,
        reasoning: reasoning ?? null,
        clientSource: clientSource ?? null,
        success: writeResult.success ? 1 : 0,
        errorMessage: writeResult.success
          ? null
          : writeResult.error ?? telemetry?.errorMessage ?? null,
        errorClass:
          telemetry?.errorClass ??
          (writeResult.success ? null : ERROR_CLASS.WRITE_REJECTED),
        ...telemetryColumns(telemetry, writeResult.action),
      })
      .returning();

    if (inserted && userId && writeResult.success) {
      void maybeFireRedditFirstWrite({ userId, justInsertedId: inserted.id });
    }

    return inserted;
  } catch (error) {
    console.error("[tracking] Failed to log change:", error);
    return null;
  }
}

// ─── Read Logging ───────────────────────────────────────────────────

export type LogReadOpts = {
  accountId: string;
  userId: string | null | undefined;
  toolName: string;
  campaignId?: string | null;
  clientSource?: string | null;
  telemetry?: CallTelemetry;
  /** Defaults to "google_ads" for back-compat with existing call sites. */
  platform?: "google_ads" | "meta_ads";
};

export async function logRead(opts: LogReadOpts) {
  const { accountId, userId, toolName, campaignId, clientSource, telemetry, platform } = opts;
  try {
    const code = toolNameToCode(toolName) ?? null;

    // Fire first-tool-call PostHog events BEFORE the insert — see logChange.
    await maybeFireFirstToolCallEvent({
      userId: userId ?? null,
      toolName: telemetry?.toolName ?? toolName,
      success: telemetry?.errorClass ? 0 : 1,
      errorClass: telemetry?.errorClass ?? null,
      clientSource: clientSource ?? null,
    });

    await db()
      .insert(schema.operations)
      .values({
        accountId,
        userId: userId ?? null,
        campaignId: campaignId ?? null,
        platform: platform ?? "google_ads",
        opType: OP_TYPE.READ,
        toolCode: code,
        clientSource: clientSource ?? null,
        errorClass: telemetry?.errorClass ?? null,
        errorMessage: telemetry?.errorMessage ?? null,
        // Read "success" mirrors existing semantics: 1 = happy path, 0 = threw.
        success: telemetry?.errorClass ? 0 : 1,
        ...telemetryColumns(telemetry, toolName),
      });
  } catch (error) {
    console.error("[tracking] Failed to log read:", error);
  }
}

// ─── Change History ─────────────────────────────────────────────────

export async function getChanges(
  accountId: string,
  options: { limit?: number; offset?: number; campaignId?: string; platform?: "google_ads" | "meta_ads" } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const conditions = [
    eq(schema.operations.accountId, accountId),
    eq(schema.operations.opType, OP_TYPE.WRITE),
    // Exclude bulk API failures — those count toward rate limits but are not "changes".
    eq(schema.operations.success, 1),
  ];
  if (options.campaignId) {
    conditions.push(eq(schema.operations.campaignId, options.campaignId));
  }
  if (options.platform) {
    conditions.push(eq(schema.operations.platform, options.platform));
  }

  const [rows, countResult] = await Promise.all([
    db()
      .select()
      .from(schema.operations)
      .where(and(...conditions))
      .orderBy(desc(schema.operations.createdAt))
      .limit(limit)
      .offset(offset),
    db()
      .select({ count: sql<number>`count(*)` })
      .from(schema.operations)
      .where(and(...conditions)),
  ]);

  let changeGroups = buildChangeGroups(rows);
  const requestIdsOnPage = Array.from(new Set(changeGroups.flatMap((group) => group.requestIds)));
  const requestCounts = requestIdsOnPage.length === 0
    ? []
    : await db()
      .select({ requestId: schema.operations.requestId, count: sql<number>`count(*)::int` })
      .from(schema.operations)
      .where(and(...conditions, inArray(schema.operations.requestId, requestIdsOnPage)))
      .groupBy(schema.operations.requestId);
  const totalByRequestId = new Map(
    requestCounts
      .filter((row): row is { requestId: string; count: number } => typeof row.requestId === "string")
      .map((row) => [row.requestId, Number(row.count)]),
  );
  changeGroups = changeGroups.map((group) => {
    const totalOperationCount = group.requestIds.length === 0
      ? group.operationCount
      : group.requestIds.reduce((sum, requestId) => sum + (totalByRequestId.get(requestId) ?? 0), 0) || group.operationCount;
    const pageOperationCount = group.operationCount;
    const id = group.grouping === "request" && group.requestIds.length === 1
      ? `cg_request_${group.requestIds[0]}`
      : group.id;
    return {
      ...group,
      id,
      pageOperationCount,
      totalOperationCount,
      partial: totalOperationCount > pageOperationCount,
    };
  });

  const changeGroupByOperationId = new Map<number, string>();
  for (const group of changeGroups) {
    for (const operationId of group.operationIds) changeGroupByOperationId.set(operationId, group.id);
  }

  return {
    changeGroups,
    items: rows.map((row) => ({
      id: row.id,
      changeGroupId: changeGroupByOperationId.get(row.id) ?? `change_${row.id}`,
      action: resolveToolLabel(row),
      entityType: CODE_TO_ENTITY[row.entityCode ?? ENTITY_CODE.unknown] ?? "unknown",
      entityId: row.entityId ?? "",
      label: row.label ?? null,
      beforeValue: row.beforeValue ?? "",
      afterValue: row.afterValue ?? "",
      reasoning: row.reasoning,
      rolledBack: row.rolledBack === 1,
      timestamp: row.createdAt,
    })),
    total: Number(countResult[0]?.count ?? 0),
  };
}

// ─── Change Grouping (derived, no new schema) ───────────────────────

type OperationRow = typeof schema.operations.$inferSelect;

export type ChangeGroup = {
  id: string;
  summary: string;
  theme: string;
  actionFamily: string;
  startedAt: Date;
  endedAt: Date;
  /** Number of operations visible in this getChanges page. */
  pageOperationCount: number;
  /** Total operations known for request-backed groups across all pages. */
  totalOperationCount: number;
  /** True when this page only contains part of the user-intent episode. */
  partial: boolean;
  operationCount: number;
  operationIds: number[];
  requestIds: string[];
  campaignIds: string[];
  scope: string;
  grouping: "request" | "heuristic";
  sampleLabels: string[];
};

const CHANGE_GROUP_GAP_MS = 10 * 60 * 1000;

export function buildChangeGroups(rows: OperationRow[]): ChangeGroup[] {
  if (rows.length === 0) return [];

  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const groups: Array<{
    rows: OperationRow[];
    family: string;
    scope: string;
    grouping: "request" | "heuristic";
  }> = [];

  for (const row of sorted) {
    const family = actionFamily(resolveToolLabel(row));
    const scope = operationScope(row);
    const requestId = row.requestId ?? null;

    let group = requestId
      ? groups.find((candidate) => candidate.rows.some((r) => r.requestId === requestId))
      : null;

    // requestId is authoritative: never merge a new request into a heuristic
    // episode just because the write happened nearby, and never let a later
    // untagged write get absorbed into a request-backed group.
    if (!group && requestId) {
      group = { rows: [], family, scope, grouping: "request" };
      groups.push(group);
    }

    if (!group) {
      group = [...groups]
        .reverse()
        .find((candidate) => {
          if (candidate.grouping === "request") return false;
          const last = candidate.rows.at(-1);
          if (!last || last.requestId) return false;
          const gapMs = row.createdAt.getTime() - last.createdAt.getTime();
          return (
            gapMs >= 0 &&
            gapMs <= CHANGE_GROUP_GAP_MS &&
            candidate.family === family &&
            candidate.scope === scope &&
            (row.userId ?? "") === (last.userId ?? "") &&
            (row.sessionId ?? null) === (last.sessionId ?? null) &&
            (row.clientSource ?? "") === (last.clientSource ?? "")
          );
        }) ?? null;
    }

    if (!group) {
      group = { rows: [], family, scope, grouping: "heuristic" };
      groups.push(group);
    }
    group.rows.push(row);
  }

  return groups
    .map((group) => serializeChangeGroup(group.rows, group.family, group.scope, group.grouping))
    .sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
}

function serializeChangeGroup(
  rows: OperationRow[],
  family: string,
  scope: string,
  grouping: "request" | "heuristic",
): ChangeGroup {
  const first = rows[0];
  const last = rows.at(-1) ?? first;
  const labels = rows.map((row) => row.label).filter((value): value is string => !!value);
  const sampleLabels = Array.from(new Set(labels)).slice(0, 5);
  const campaignIds = Array.from(new Set(rows.map((row) => row.campaignId).filter((value): value is string => !!value)));
  const requestIds = Array.from(new Set(rows.map((row) => row.requestId).filter((value): value is string => !!value)));
  const families = Array.from(new Set(rows.map((row) => actionFamily(resolveToolLabel(row)))));
  const scopes = Array.from(new Set(rows.map(operationScope)));
  const effectiveFamily = families.length === 1 ? family : "mixed";
  const effectiveScope = scopes.length === 1 ? scope : "multi_scope";

  return {
    id: `cg_${first.id}_${last.id}_${rows.length}`,
    summary: summarizeChangeGroup(effectiveFamily, rows, sampleLabels),
    theme: themeForFamily(effectiveFamily),
    actionFamily: effectiveFamily,
    startedAt: first.createdAt,
    endedAt: last.createdAt,
    pageOperationCount: rows.length,
    totalOperationCount: rows.length,
    partial: false,
    operationCount: rows.length,
    operationIds: rows.map((row) => row.id),
    requestIds,
    campaignIds,
    scope: effectiveScope,
    grouping,
    sampleLabels,
  };
}

function actionFamily(action: string) {
  const normalized = action.replace(/[_\s-]/g, "").toLowerCase();
  if (normalized.includes("remove") && (normalized.includes("negative") || normalized.includes("keywordfromnegativelist"))) return "remove_negative_keyword";
  if (normalized.includes("negative") || normalized.includes("keywordtonegativelist")) return "negative_keyword";
  if (normalized.includes("bulkpausekeywords") || normalized.includes("pausekeyword")) return "pause_keyword";
  if (normalized.includes("bulkaddkeywords") || normalized.includes("addkeyword")) return "add_keyword";
  if (normalized.includes("bulkupdatebids") || normalized.includes("updatebid")) return "bid_update";
  if (normalized.includes("budget")) return "budget_change";
  if (normalized.includes("bidding")) return "bidding_change";
  if (normalized.includes("conversionaction")) return "conversion_tracking";
  if (normalized.includes("trackingtemplate")) return "tracking_template";
  if (normalized.includes("adassets") || normalized.includes("adfinalurl") || normalized.includes("createad") || normalized.includes("pausead") || normalized.includes("enablead")) return "ad_creative";
  if (normalized.includes("campaignsettings") || normalized.includes("campaignlanguages") || normalized.includes("campaigngoals")) return "campaign_settings";
  if (normalized.includes("experiment")) return "experiment";
  if (normalized.includes("campaign")) return "campaign_change";
  if (normalized.includes("adgroup")) return "ad_group_change";
  return normalized || "other";
}

function themeForFamily(family: string) {
  switch (family) {
    case "negative_keyword":
    case "remove_negative_keyword": return "search_intent_hygiene";
    case "pause_keyword": return "waste_reduction";
    case "add_keyword": return "keyword_expansion";
    case "bid_update": return "bid_management";
    case "budget_change": return "budget_allocation";
    case "bidding_change": return "bidding_strategy";
    case "conversion_tracking": return "measurement";
    case "tracking_template": return "tracking";
    case "ad_creative": return "creative_quality";
    case "campaign_settings": return "campaign_configuration";
    case "experiment": return "experimentation";
    case "mixed": return "multi_action_change";
    default: return "account_change";
  }
}

function summarizeChangeGroup(family: string, rows: OperationRow[], sampleLabels: string[]) {
  const count = rows.length;
  const plural = count === 1 ? "" : "s";
  const sample = sampleLabels.length > 0 ? ` (e.g. ${sampleLabels.slice(0, 3).join(", ")})` : "";
  switch (family) {
    case "negative_keyword": return `Added/updated ${count} negative keyword operation${plural}${sample}`;
    case "remove_negative_keyword": return `Removed ${count} negative keyword/list operation${plural}${sample}`;
    case "pause_keyword": return `Paused ${count} keyword${plural}${sample}`;
    case "add_keyword": return `Added ${count} keyword${plural}${sample}`;
    case "bid_update": return `Updated ${count} keyword bid${plural}`;
    case "budget_change": return `Changed ${count} campaign budget${plural}`;
    case "bidding_change": return `Changed ${count} bidding strategy setting${plural}`;
    case "conversion_tracking": return `Changed ${count} conversion action${plural}`;
    case "tracking_template": return `Changed ${count} tracking template setting${plural}`;
    case "ad_creative": return `Changed ${count} ad/creative item${plural}`;
    case "campaign_settings": return `Changed ${count} campaign setting${plural}`;
    case "experiment": return `Changed ${count} experiment item${plural}`;
    case "mixed": return `Made ${count} operations in one request${sample}`;
    default: return `Made ${count} ${family} operation${plural}${sample}`;
  }
}

function operationScope(row: OperationRow) {
  const args = isRecord(row.args) ? row.args : {};
  const keys = [
    "sharedSetId",
    "campaignId",
    "adGroupId",
    "assetGroupId",
    "biddingStrategyId",
    "conversionActionId",
    "experimentResourceName",
    "level",
  ];
  const parts = keys
    .map((key) => [key, args[key]] as const)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key, value]) => `${key}:${value}`);
  if (parts.length > 0) return parts.join("|");
  if (row.campaignId) return `campaignId:${row.campaignId}`;
  return "account";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Impact Attribution ─────────────────────────────────────────────

export async function getImpact(
  accountId: string,
  changeId: number,
) {
  // Get the change record — only real (successful) changes have impact.
  const [change] = await db()
    .select()
    .from(schema.operations)
    .where(
      and(
        eq(schema.operations.id, changeId),
        eq(schema.operations.accountId, accountId),
        eq(schema.operations.opType, OP_TYPE.WRITE),
        eq(schema.operations.success, 1),
      ),
    )
    .limit(1);

  if (!change) return null;
  if (!change.campaignId) return { change, impact: null, reason: "No campaign associated" };

  // Window math matches `computeChangeImpactReview` exactly so agents can
  // stitch per-change (`getImpact`) and batch (`reviewChangeImpact`) calls
  // without getting contradictory numbers for the same change.
  // Before: [changeDate - 7d, changeDate)     — 7 days strictly pre-change.
  // After:  [changeDate + 1d, changeDate + 8d) — 7 days strictly post-change.
  // Change day is excluded on both sides: a full-day snapshot dated the
  // change day mixes pre- and post-change hours.
  const changeDate = change.createdAt;
  const changeDateStr = changeDate.toISOString().slice(0, 10);

  const beforeCutoff = new Date(changeDate);
  beforeCutoff.setUTCDate(beforeCutoff.getUTCDate() - IMPACT_WINDOW_DAYS);
  const beforeCutoffStr = beforeCutoff.toISOString().slice(0, 10);

  const afterStart = new Date(changeDate);
  afterStart.setUTCDate(afterStart.getUTCDate() + 1);
  const afterStartStr = afterStart.toISOString().slice(0, 10);
  const afterEnd = new Date(changeDate);
  afterEnd.setUTCDate(afterEnd.getUTCDate() + IMPACT_WINDOW_DAYS + 1);
  const afterEndStr = afterEnd.toISOString().slice(0, 10);

  const beforeSnapshots = await db()
    .select({
      campaignId: schema.campaignBenchmarkThirtyDaySnapshots.campaignId,
      snapshotDate: schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate,
      costMicros: schema.campaignBenchmarkThirtyDaySnapshots.costMicros,
      conversions: schema.campaignBenchmarkThirtyDaySnapshots.conversions,
    })
    .from(schema.campaignBenchmarkThirtyDaySnapshots)
    .where(
      and(
        eq(schema.campaignBenchmarkThirtyDaySnapshots.accountId, accountId),
        eq(schema.campaignBenchmarkThirtyDaySnapshots.campaignId, change.campaignId),
        gte(schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate, beforeCutoffStr),
        lt(schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate, changeDateStr),
      ),
    );

  const afterSnapshots = await db()
    .select({
      campaignId: schema.campaignBenchmarkThirtyDaySnapshots.campaignId,
      snapshotDate: schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate,
      costMicros: schema.campaignBenchmarkThirtyDaySnapshots.costMicros,
      conversions: schema.campaignBenchmarkThirtyDaySnapshots.conversions,
    })
    .from(schema.campaignBenchmarkThirtyDaySnapshots)
    .where(
      and(
        eq(schema.campaignBenchmarkThirtyDaySnapshots.accountId, accountId),
        eq(schema.campaignBenchmarkThirtyDaySnapshots.campaignId, change.campaignId),
        gte(schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate, afterStartStr),
        lt(schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate, afterEndStr),
      ),
    );

  // Same maturity gate as `reviewChangeImpact` so the two surfaces don't
  // contradict each other on the same change: a change 1-2 days old stays
  // `tooNew` everywhere, not "no impact" here but "impact present" there.
  if (beforeSnapshots.length === 0 || afterSnapshots.length < MIN_AFTER_DAYS_FOR_DIRECTION) {
    return {
      change,
      impact: null,
      reason: `Insufficient snapshot data for comparison (have ${beforeSnapshots.length} before / ${afterSnapshots.length} after; need at least 1 before and ${MIN_AFTER_DAYS_FOR_DIRECTION} after).`,
    };
  }

  const base = computeSnapshotImpact(beforeSnapshots, afterSnapshots);

  return {
    change: {
      id: change.id,
      action: resolveToolLabel(change),
      entityId: change.entityId,
      timestamp: change.createdAt,
    },
    impact: {
      before: base.before,
      after: base.after,
      cpaDelta: base.cpaDelta,
      costDelta: base.costDelta,
      conversionsDelta: base.conversionsDelta,
      disclaimer: IMPACT_CORRELATION_DISCLAIMER,
    },
  };
}

// ─── Batch Impact Review ────────────────────────────────────────────

/**
 * Summarize the impact of every successful change in the last `days`.
 * Designed for weekly/ad-hoc reviews by Claude Coworker: one round-trip
 * returns per-change attribution + per-action counts + a campaign-deduped
 * aggregate sum, instead of forcing the agent to stitch getChanges +
 * getCampaignPerformance by hand.
 */
export async function reviewChangeImpact(
  accountId: string,
  options: { days?: number; limit?: number; now?: Date } = {},
): Promise<ReviewChangeImpact> {
  const days = Math.min(Math.max(options.days ?? 7, 1), 90);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const now = options.now ?? new Date();

  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - days);

  const windowConditions = and(
    eq(schema.operations.accountId, accountId),
    eq(schema.operations.opType, OP_TYPE.WRITE),
    eq(schema.operations.success, 1),
    gte(schema.operations.createdAt, windowStart),
  );

  const [rows, totalResult] = await Promise.all([
    db()
      .select()
      .from(schema.operations)
      .where(windowConditions)
      .orderBy(desc(schema.operations.createdAt))
      .limit(limit),
    db()
      .select({ count: sql<number>`count(*)` })
      .from(schema.operations)
      .where(windowConditions),
  ]);
  const totalPopulation = Number(totalResult[0]?.count ?? 0);

  // Prefer the canonical snake_case form via toolCode when available so
  // byAction buckets don't split "pauseKeyword" (post-telemetry-migration
  // rows carrying `tool_name`) and "pause_keyword" (older rows with only
  // `tool_code`) for the SAME logical action.
  const canonicalAction = (row: { toolName: string | null; toolCode: number | null }): string => {
    if (row.toolCode != null && CODE_TO_TOOL[row.toolCode]) return CODE_TO_TOOL[row.toolCode];
    return row.toolName ?? `unknown_${row.toolCode ?? "null"}`;
  };

  const changes: ChangeRow[] = rows.map((row) => ({
    id: row.id,
    action: canonicalAction(row),
    entityType: CODE_TO_ENTITY[row.entityCode ?? ENTITY_CODE.unknown] ?? "unknown",
    entityId: row.entityId ?? "",
    label: row.label,
    campaignId: row.campaignId,
    reasoning: row.reasoning,
    rolledBack: row.rolledBack === 1,
    timestamp: row.createdAt,
  }));

  // Collect unique campaign IDs — one query to grab every snapshot we
  // might need, instead of N+1 per change.
  const campaignIds = Array.from(
    new Set(changes.map((c) => c.campaignId).filter((id): id is string => !!id)),
  );

  let snapshotsByCampaign = new Map<string, SnapshotRow[]>();
  if (campaignIds.length > 0) {
    // Before windows need snapshots up to 7 days before the oldest change;
    // after windows can't exceed `now` because the cron only stores
    // yesterday's data — no point asking the DB for rows that can't exist.
    const snapshotRangeStart = new Date(windowStart);
    snapshotRangeStart.setUTCDate(snapshotRangeStart.getUTCDate() - IMPACT_WINDOW_DAYS);

    const snapshots = await db()
      .select({
        campaignId: schema.campaignBenchmarkThirtyDaySnapshots.campaignId,
        snapshotDate: schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate,
        costMicros: schema.campaignBenchmarkThirtyDaySnapshots.costMicros,
        conversions: schema.campaignBenchmarkThirtyDaySnapshots.conversions,
      })
      .from(schema.campaignBenchmarkThirtyDaySnapshots)
      .where(
        and(
          eq(schema.campaignBenchmarkThirtyDaySnapshots.accountId, accountId),
          inArray(schema.campaignBenchmarkThirtyDaySnapshots.campaignId, campaignIds),
          gte(schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate, snapshotRangeStart.toISOString().slice(0, 10)),
          lte(schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate, now.toISOString().slice(0, 10)),
        ),
      );

    snapshotsByCampaign = snapshots.reduce((map, s) => {
      const arr = map.get(s.campaignId) ?? [];
      arr.push({
        campaignId: s.campaignId,
        snapshotDate: s.snapshotDate,
        costMicros: s.costMicros,
        conversions: s.conversions,
      });
      map.set(s.campaignId, arr);
      return map;
    }, new Map<string, SnapshotRow[]>());
  }

  return computeChangeImpactReview(changes, snapshotsByCampaign, now, days, totalPopulation);
}

// ─── Undo ───────────────────────────────────────────────────────────

const UNDO_WINDOW_DAYS = 7;

/** Actions that map to a reverse Google Ads mutation. */
const REVERSIBLE_ACTIONS: Record<number, number> = {
  [TOOL_CODE.pause_keyword]: TOOL_CODE.enable_keyword,
  [TOOL_CODE.enable_keyword]: TOOL_CODE.pause_keyword,
  [TOOL_CODE.pause_campaign]: TOOL_CODE.enable_campaign,
  [TOOL_CODE.enable_campaign]: TOOL_CODE.pause_campaign,
  [TOOL_CODE.update_bid]: TOOL_CODE.update_bid,
  [TOOL_CODE.update_budget]: TOOL_CODE.update_budget,
  [TOOL_CODE.add_negative_keyword]: TOOL_CODE.remove_negative_keyword,
  [TOOL_CODE.remove_negative_keyword]: TOOL_CODE.add_negative_keyword,
  [TOOL_CODE.create_campaign]: TOOL_CODE.remove_campaign,
  [TOOL_CODE.create_shopping_campaign]: TOOL_CODE.remove_campaign,
  [TOOL_CODE.create_pmax_campaign]: TOOL_CODE.remove_campaign,
  [TOOL_CODE.create_demand_gen_campaign]: TOOL_CODE.remove_campaign,
  [TOOL_CODE.create_display_campaign]: TOOL_CODE.remove_campaign,
  [TOOL_CODE.create_video_campaign]: TOOL_CODE.remove_campaign,
  [TOOL_CODE.create_app_campaign]: TOOL_CODE.remove_campaign,
  [TOOL_CODE.add_keyword]: TOOL_CODE.remove_keyword,
  [TOOL_CODE.set_tracking_template]: TOOL_CODE.set_tracking_template,
  [TOOL_CODE.pause_ad]: TOOL_CODE.enable_ad,
  [TOOL_CODE.enable_ad]: TOOL_CODE.pause_ad,
  [TOOL_CODE.update_ad_final_url]: TOOL_CODE.update_ad_final_url,
  [TOOL_CODE.update_ad_assets]: TOOL_CODE.update_ad_assets,
  [TOOL_CODE.create_ad]: TOOL_CODE.pause_ad,
  [TOOL_CODE.update_campaign_networks]: TOOL_CODE.update_campaign_networks,
  [TOOL_CODE.rename_campaign]: TOOL_CODE.rename_campaign,
  [TOOL_CODE.rename_ad_group]: TOOL_CODE.rename_ad_group,
};

export async function getUndoableChange(accountId: string, changeId: number) {
  // Only successful writes are undoable — failed bulk attempts never changed anything.
  const [change] = await db()
    .select()
    .from(schema.operations)
    .where(
      and(
        eq(schema.operations.id, changeId),
        eq(schema.operations.accountId, accountId),
        eq(schema.operations.opType, OP_TYPE.WRITE),
        eq(schema.operations.success, 1),
      ),
    )
    .limit(1);

  if (!change) return { error: "Change not found" };
  if (change.rolledBack) return { error: "Change was already undone" };

  // Check undo window
  const ageMs = Date.now() - change.createdAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > UNDO_WINDOW_DAYS) {
    return { error: `Change is ${Math.floor(ageDays)} days old. Undo window is ${UNDO_WINDOW_DAYS} days.` };
  }

  // Undo only operates on mapped tool_codes; unmapped new tools gain undo
  // support when added to REVERSIBLE_ACTIONS.
  if (change.toolCode == null || REVERSIBLE_ACTIONS[change.toolCode] === undefined) {
    return { error: `Action "${resolveToolLabel(change)}" is not reversible` };
  }
  const toolName = CODE_TO_TOOL[change.toolCode];

  // Check if entity was modified after this change (stale undo guard) — only successful
  // writes count as modifications.
  const staleConditions = [
    gt(schema.operations.id, changeId),
    eq(schema.operations.accountId, accountId),
    eq(schema.operations.opType, OP_TYPE.WRITE),
    eq(schema.operations.success, 1),
  ];
  if (change.entityCode !== null && change.entityCode !== undefined) {
    staleConditions.push(eq(schema.operations.entityCode, change.entityCode));
  }
  if (change.entityId) {
    staleConditions.push(eq(schema.operations.entityId, change.entityId));
  }
  if (change.rolledBack !== null) {
    staleConditions.push(eq(schema.operations.rolledBack, 0));
  }
  if (change.campaignId) {
    staleConditions.push(eq(schema.operations.campaignId, change.campaignId));
  }
  const [laterChange] = await db()
    .select({ id: schema.operations.id, createdAt: schema.operations.createdAt })
    .from(schema.operations)
    .where(and(...staleConditions))
    .limit(1);

  if (laterChange) {
    return {
      error: `Entity was modified after this change (change #${laterChange.id} on ${laterChange.createdAt.toISOString()}). Undo would overwrite a more recent change. Undo the later change first, or apply the desired state directly.`,
    };
  }

  // Return change with toolName decoded for callers that need the string
  return {
    change: {
      ...change,
      toolName: toolName ?? `unknown_${change.toolCode}`,
    },
  };
}

export async function markRolledBack(changeId: number) {
  await db()
    .update(schema.operations)
    .set({ rolledBack: 1 })
    .where(eq(schema.operations.id, changeId));
}

// ─── Goals ──────────────────────────────────────────────────────────

export async function setGoals(
  accountId: string,
  campaignId: string | null,
  goals: {
    targetCpa?: number;
    monthlyCap?: number;
    maxBidChangePct?: number;
    maxBudgetChangePct?: number;
    maxKeywordPausePct?: number;
  },
) {
  const effectiveCampaignId = campaignId ?? "";

  const [result] = await db()
    .insert(schema.goals)
    .values({
      accountId,
      campaignId: effectiveCampaignId,
      ...goals,
    })
    .onConflictDoUpdate({
      target: [schema.goals.accountId, schema.goals.campaignId],
      set: { ...goals, updatedAt: new Date() },
    })
    .returning();

  return result;
}

export async function getGoals(accountId: string, campaignId?: string) {
  // Get campaign-specific goals first, fall back to account-level
  if (campaignId) {
    const campaignGoals = await db()
      .select()
      .from(schema.goals)
      .where(
        and(
          eq(schema.goals.accountId, accountId),
          eq(schema.goals.campaignId, campaignId),
        ),
      )
      .limit(1);

    if (campaignGoals.length > 0) return campaignGoals[0];
  }

  // Account-level default
  const accountGoals = await db()
    .select()
    .from(schema.goals)
    .where(
      and(
        eq(schema.goals.accountId, accountId),
        eq(schema.goals.campaignId, ""),
      ),
    )
    .limit(1);

  return accountGoals[0] ?? null;
}
