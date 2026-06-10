import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, schema } from "./index";
import { CODE_TO_ENTITY, resolveToolLabel } from "./tracking";
import {
  evaluateIntervention,
  inferInterventionGoal,
  summarizeInterventionActions,
  type InterventionEvaluation,
} from "./impact-monitor";

type OperationRow = typeof schema.operations.$inferSelect;
type ChangeInterventionRow = typeof schema.changeInterventions.$inferSelect;

const AUTO_MERGE_MAX_GAP_MS = 6 * 60 * 60 * 1000;
const IMPACT_MONITOR_SCHEMA_ERROR_CODE = "IMPACT_MONITOR_SCHEMA_MISSING";
const IMPACT_MONITOR_SCHEMA_ERROR_MESSAGE = "Impact Monitor tables are missing or stale. Run the latest Drizzle migrations before using /impact-monitor.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isMissingImpactMonitorSchemaError(error: unknown) {
  if (!isRecord(error)) return false;

  const code = typeof error.code === "string" ? error.code : null;
  const message = typeof error.message === "string" ? error.message : "";
  if (!message) return false;

  return (
    code === IMPACT_MONITOR_SCHEMA_ERROR_CODE
    || message === IMPACT_MONITOR_SCHEMA_ERROR_MESSAGE
    || (((code === "42P01" || code === "42703") && /change_intervention/i.test(message))
      || /relation .*change_intervention/i.test(message)
      || /column .*change_intervention/i.test(message))
  );
}

function remapImpactMonitorSchemaError(error: unknown): never {
  if (isMissingImpactMonitorSchemaError(error)) {
    const remapped = new Error(IMPACT_MONITOR_SCHEMA_ERROR_MESSAGE) as Error & { code?: string };
    remapped.code = IMPACT_MONITOR_SCHEMA_ERROR_CODE;
    throw remapped;
  }
  throw error;
}

async function withImpactMonitorSchemaGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    remapImpactMonitorSchemaError(error);
  }
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function defaultInterventionName(campaignId: string, interventionDate: string) {
  return `Campaign ${campaignId} · ${interventionDate}`;
}

function deriveStoredStatus(resultLabel: string) {
  switch (resultLabel) {
    case "too_new":
      return "watching";
    case "likely_worsened":
    case "highly_confounded":
      return "needs_attention";
    case "rolled_back":
      return "archived";
    default:
      return "ready_for_review";
  }
}

async function findExistingInterventionForOperation(operation: OperationRow, interventionDate: string) {
  const candidates = await db()
    .select()
    .from(schema.changeInterventions)
    .where(
      and(
        eq(schema.changeInterventions.accountId, operation.accountId),
        eq(schema.changeInterventions.campaignId, operation.campaignId!),
        eq(schema.changeInterventions.interventionDate, interventionDate),
      ),
    )
    .orderBy(desc(schema.changeInterventions.startedAt))
    .limit(5);

  if (operation.requestId) {
    const sameRequest = candidates.find((candidate) => asStringArray(candidate.requestIds).includes(operation.requestId!));
    if (sameRequest) return sameRequest;
  }

  return candidates.find((candidate) => {
    const candidateEnd = candidate.endedAt ?? candidate.startedAt;
    const gapMs = operation.createdAt.getTime() - candidateEnd.getTime();
    return gapMs >= 0 && gapMs <= AUTO_MERGE_MAX_GAP_MS;
  }) ?? null;
}

async function refreshInterventionMetadata(intervention: ChangeInterventionRow) {
  const links = await db()
    .select({
      action: schema.changeInterventionOperations.action,
      requestId: schema.changeInterventionOperations.requestId,
      createdAt: schema.changeInterventionOperations.createdAt,
    })
    .from(schema.changeInterventionOperations)
    .where(eq(schema.changeInterventionOperations.changeInterventionId, intervention.id))
    .orderBy(schema.changeInterventionOperations.operationOrder);

  const actions = links.map((link) => link.action);
  const inferred = inferInterventionGoal(actions);
  const requestIds = Array.from(new Set(links.map((link) => link.requestId).filter((value): value is string => !!value)));
  const startedAt = links[0]?.createdAt ?? intervention.startedAt;
  const endedAt = links.at(-1)?.createdAt ?? intervention.endedAt ?? intervention.startedAt;

  await db()
    .update(schema.changeInterventions)
    .set({
      changeSummary: summarizeInterventionActions(actions),
      requestIds,
      endedAt,
      primaryMetric: intervention.primaryMetric ?? inferred.primaryMetric,
      goalDirection: intervention.goalDirection ?? inferred.goalDirection,
      hypothesis: intervention.hypothesis ?? inferred.hypothesis,
      updatedAt: new Date(),
      startedAt,
    })
    .where(eq(schema.changeInterventions.id, intervention.id));
}

export async function autoTrackChangeIntervention(args: { operation: OperationRow }) {
  return withImpactMonitorSchemaGuard(async () => {
    const { operation } = args;
    if (operation.opType !== 1 || operation.success !== 1 || !operation.campaignId) return null;

    const interventionDate = dateKey(operation.createdAt);
    const action = resolveToolLabel(operation);
    const inferred = inferInterventionGoal([action]);

    let intervention = await findExistingInterventionForOperation(operation, interventionDate);
    if (!intervention) {
      const [created] = await db()
        .insert(schema.changeInterventions)
        .values({
          accountId: operation.accountId,
          campaignId: operation.campaignId,
          interventionDate,
          name: defaultInterventionName(operation.campaignId, interventionDate),
          changeSummary: summarizeInterventionActions([action]),
          hypothesis: inferred.hypothesis,
          primaryMetric: inferred.primaryMetric,
          goalDirection: inferred.goalDirection,
          requestIds: operation.requestId ? [operation.requestId] : [],
          startedAt: operation.createdAt,
          endedAt: operation.createdAt,
          status: "watching",
        })
        .returning();
      intervention = created;
    }

    const orderResult = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.changeInterventionOperations)
      .where(eq(schema.changeInterventionOperations.changeInterventionId, intervention.id));

    await db()
      .insert(schema.changeInterventionOperations)
      .values({
        changeInterventionId: intervention.id,
        operationId: operation.id,
        operationOrder: Number(orderResult[0]?.count ?? 0) + 1,
        requestId: operation.requestId ?? null,
        action,
        entityType: CODE_TO_ENTITY[operation.entityCode ?? 2] ?? "unknown",
        entityRef: operation.entityId ?? null,
        label: operation.label ?? null,
        createdAt: operation.createdAt,
      })
      .onConflictDoNothing({ target: schema.changeInterventionOperations.operationId });

    await refreshInterventionMetadata(intervention);
    return intervention.id;
  });
}

async function getLatestEvaluations(interventionIds: number[]) {
  if (interventionIds.length === 0) return new Map<number, typeof schema.changeInterventionEvaluations.$inferSelect>();
  const rows = await db()
    .select()
    .from(schema.changeInterventionEvaluations)
    .where(inArray(schema.changeInterventionEvaluations.changeInterventionId, interventionIds))
    .orderBy(desc(schema.changeInterventionEvaluations.createdAt));

  const latest = new Map<number, typeof schema.changeInterventionEvaluations.$inferSelect>();
  for (const row of rows) {
    if (!latest.has(row.changeInterventionId)) latest.set(row.changeInterventionId, row);
  }
  return latest;
}

export async function listChangeInterventions(
  accountId: string,
  options: { status?: string; campaignId?: string; limit?: number; offset?: number } = {},
) {
  return withImpactMonitorSchemaGuard(async () => {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const conditions = [eq(schema.changeInterventions.accountId, accountId)];
    if (options.status === "reviewed") {
      conditions.push(inArray(schema.changeInterventions.status, ["reviewed", "ready_for_review", "needs_attention"]));
    } else if (options.status) {
      conditions.push(eq(schema.changeInterventions.status, options.status));
    }
    if (options.campaignId) conditions.push(eq(schema.changeInterventions.campaignId, options.campaignId));

    const [rows, totalResult] = await Promise.all([
      db()
        .select()
        .from(schema.changeInterventions)
        .where(and(...conditions))
        .orderBy(desc(schema.changeInterventions.startedAt))
        .limit(limit)
        .offset(offset),
      db()
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.changeInterventions)
        .where(and(...conditions)),
    ]);

    const interventionIds = rows.map((row) => row.id);
    const [latestEvaluations, operationCounts] = await Promise.all([
      getLatestEvaluations(interventionIds),
      interventionIds.length === 0
        ? Promise.resolve([] as Array<{ changeInterventionId: number; count: number }>)
        : db()
            .select({
              changeInterventionId: schema.changeInterventionOperations.changeInterventionId,
              count: sql<number>`count(*)::int`,
            })
            .from(schema.changeInterventionOperations)
            .where(inArray(schema.changeInterventionOperations.changeInterventionId, interventionIds))
            .groupBy(schema.changeInterventionOperations.changeInterventionId),
    ]);

    const countsByIntervention = new Map(operationCounts.map((row) => [row.changeInterventionId, row.count]));

    return {
      items: rows.map((row) => ({
        id: row.id,
        campaignId: row.campaignId,
        interventionDate: row.interventionDate,
        name: row.name,
        changeSummary: row.changeSummary,
        hypothesis: row.hypothesis,
        primaryMetric: row.primaryMetric,
        goalDirection: row.goalDirection,
        status: row.status,
        requestIds: asStringArray(row.requestIds),
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        operationCount: countsByIntervention.get(row.id) ?? 0,
        latestEvaluation: latestEvaluations.get(row.id)
          ? {
              resultLabel: latestEvaluations.get(row.id)!.resultLabel,
              confidence: latestEvaluations.get(row.id)!.confidence,
              primaryMetricName: latestEvaluations.get(row.id)!.primaryMetricName,
              primaryMetricDeltaPct: latestEvaluations.get(row.id)!.primaryMetricDeltaPct,
              reasonSummary: latestEvaluations.get(row.id)!.reasonSummary,
              createdAt: latestEvaluations.get(row.id)!.createdAt,
            }
          : null,
      })),
      total: Number(totalResult[0]?.count ?? 0),
    };
  });
}

export async function getChangeIntervention(accountId: string, changeInterventionId: number) {
  return withImpactMonitorSchemaGuard(async () => {
    const [intervention] = await db()
      .select()
      .from(schema.changeInterventions)
      .where(
        and(
          eq(schema.changeInterventions.id, changeInterventionId),
          eq(schema.changeInterventions.accountId, accountId),
        ),
      )
      .limit(1);

    if (!intervention) return null;

    const [operations, latestEvaluation] = await Promise.all([
      db()
        .select({
          id: schema.changeInterventionOperations.id,
          operationId: schema.changeInterventionOperations.operationId,
          operationOrder: schema.changeInterventionOperations.operationOrder,
          requestId: schema.changeInterventionOperations.requestId,
          action: schema.changeInterventionOperations.action,
          entityType: schema.changeInterventionOperations.entityType,
          entityRef: schema.changeInterventionOperations.entityRef,
          label: schema.changeInterventionOperations.label,
          createdAt: schema.changeInterventionOperations.createdAt,
          rolledBack: schema.operations.rolledBack,
        })
        .from(schema.changeInterventionOperations)
        .leftJoin(schema.operations, eq(schema.operations.id, schema.changeInterventionOperations.operationId))
        .where(eq(schema.changeInterventionOperations.changeInterventionId, changeInterventionId))
        .orderBy(schema.changeInterventionOperations.operationOrder),
      db()
        .select()
        .from(schema.changeInterventionEvaluations)
        .where(eq(schema.changeInterventionEvaluations.changeInterventionId, changeInterventionId))
        .orderBy(desc(schema.changeInterventionEvaluations.createdAt))
        .limit(1),
    ]);

    return {
      id: intervention.id,
      accountId: intervention.accountId,
      campaignId: intervention.campaignId,
      interventionDate: intervention.interventionDate,
      name: intervention.name,
      changeSummary: intervention.changeSummary,
      hypothesis: intervention.hypothesis,
      primaryMetric: intervention.primaryMetric,
      goalDirection: intervention.goalDirection,
      status: intervention.status,
      requestIds: asStringArray(intervention.requestIds),
      startedAt: intervention.startedAt,
      endedAt: intervention.endedAt,
      operations: operations.map((operation) => ({
        id: operation.id,
        operationId: operation.operationId,
        operationOrder: operation.operationOrder,
        requestId: operation.requestId,
        action: operation.action,
        entityType: operation.entityType,
        entityRef: operation.entityRef,
        label: operation.label,
        createdAt: operation.createdAt,
        rolledBack: operation.rolledBack === 1,
      })),
      latestEvaluation: latestEvaluation[0] ?? null,
    };
  });
}

function toSnapshotEnvelopeEnd(startedAt: Date, afterWindowDays: number) {
  const end = new Date(startedAt);
  end.setUTCDate(end.getUTCDate() + afterWindowDays + 1);
  return end;
}

export async function evaluateChangeIntervention(
  accountId: string,
  changeInterventionId: number,
  options: { baselineWindowDays?: number; afterWindowDays?: number; now?: Date } = {},
) {
  return withImpactMonitorSchemaGuard(async () => {
    const intervention = await getChangeIntervention(accountId, changeInterventionId);
    if (!intervention) throw new Error("Change intervention not found.");

    const baselineWindowDays = Math.min(Math.max(options.baselineWindowDays ?? 7, 1), 30);
    const afterWindowDays = Math.min(Math.max(options.afterWindowDays ?? 7, 1), 30);
    const now = options.now ?? new Date();

    const snapshotsStart = new Date(intervention.startedAt);
    snapshotsStart.setUTCDate(snapshotsStart.getUTCDate() - baselineWindowDays);
    const afterStart = new Date(intervention.startedAt);
    afterStart.setUTCDate(afterStart.getUTCDate() + 1);
    const snapshotsEnd = toSnapshotEnvelopeEnd(intervention.startedAt, afterWindowDays);

    const [snapshots, otherInterventions, existingEvaluations] = await Promise.all([
      db()
        .select({
          snapshotDate: schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate,
          campaignId: schema.campaignBenchmarkThirtyDaySnapshots.campaignId,
          costMicros: schema.campaignBenchmarkThirtyDaySnapshots.costMicros,
          conversions: schema.campaignBenchmarkThirtyDaySnapshots.conversions,
          impressions: schema.campaignBenchmarkThirtyDaySnapshots.impressions,
          clicks: schema.campaignBenchmarkThirtyDaySnapshots.clicks,
        })
        .from(schema.campaignBenchmarkThirtyDaySnapshots)
        .where(
          and(
            eq(schema.campaignBenchmarkThirtyDaySnapshots.accountId, accountId),
            eq(schema.campaignBenchmarkThirtyDaySnapshots.campaignId, intervention.campaignId),
            gte(schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate, dateKey(snapshotsStart)),
            lt(schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate, dateKey(snapshotsEnd)),
          ),
        ),
      db()
        .select({
          id: schema.changeInterventions.id,
          startedAt: schema.changeInterventions.startedAt,
        })
        .from(schema.changeInterventions)
        .where(
          and(
            eq(schema.changeInterventions.accountId, accountId),
            eq(schema.changeInterventions.campaignId, intervention.campaignId),
            gte(schema.changeInterventions.startedAt, afterStart),
            lt(schema.changeInterventions.startedAt, snapshotsEnd),
          ),
        ),
      db()
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.changeInterventionEvaluations)
        .where(eq(schema.changeInterventionEvaluations.changeInterventionId, changeInterventionId)),
    ]);

    const confounderCountInternal = otherInterventions.filter((row) => row.id !== changeInterventionId).length;

    const evaluation: InterventionEvaluation = evaluateIntervention({
      startedAt: intervention.startedAt,
      actions: intervention.operations.map((operation) => ({
        action: operation.action,
        createdAt: operation.createdAt,
        rolledBack: operation.rolledBack,
      })),
      snapshots,
      primaryMetric: intervention.primaryMetric,
      goalDirection: intervention.goalDirection,
      baselineWindowDays,
      afterWindowDays,
      confounderCountInternal,
      now,
    });

    const [stored] = await db()
      .insert(schema.changeInterventionEvaluations)
      .values({
        changeInterventionId,
        evaluationVersion: Number(existingEvaluations[0]?.count ?? 0) + 1,
        baselineWindowDays,
        afterWindowDays,
        daysSinceStart: evaluation.daysSinceStart,
        confounderCountInternal: evaluation.confounderCountInternal,
        confidence: evaluation.confidence,
        resultLabel: evaluation.resultLabel,
        primaryMetricName: evaluation.primaryMetricName,
        primaryMetricBefore: evaluation.primaryMetricBefore,
        primaryMetricAfter: evaluation.primaryMetricAfter,
        primaryMetricDeltaPct: evaluation.primaryMetricDeltaPct,
        supportingMetrics: evaluation.supportingMetrics,
        reasonSummary: evaluation.reasonSummary,
        reasonCodes: evaluation.reasonCodes,
      })
      .returning();

    await db()
      .update(schema.changeInterventions)
      .set({
        status: deriveStoredStatus(evaluation.resultLabel),
        updatedAt: new Date(),
      })
      .where(eq(schema.changeInterventions.id, changeInterventionId));

    return {
      ...intervention,
      latestEvaluation: stored,
    };
  });
}

export async function evaluateWatchingChangeInterventions(options: {
  accountId?: string;
  limit?: number;
  now?: Date;
  baselineWindowDays?: number;
  afterWindowDays?: number;
} = {}) {
  return withImpactMonitorSchemaGuard(async () => {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    const rows = await db()
      .select({
        id: schema.changeInterventions.id,
        accountId: schema.changeInterventions.accountId,
      })
      .from(schema.changeInterventions)
      .where(
        options.accountId
          ? and(
              eq(schema.changeInterventions.status, "watching"),
              eq(schema.changeInterventions.accountId, options.accountId),
            )
          : eq(schema.changeInterventions.status, "watching"),
      )
      .orderBy(desc(schema.changeInterventions.startedAt))
      .limit(limit);

    const results = [] as Array<{
      changeInterventionId: number;
      accountId: string;
      status: "evaluated" | "failed";
      resultLabel?: string;
      error?: string;
    }>;

    for (const row of rows) {
      try {
        const evaluated = await evaluateChangeIntervention(row.accountId, row.id, {
          now: options.now,
          baselineWindowDays: options.baselineWindowDays,
          afterWindowDays: options.afterWindowDays,
        });
        results.push({
          changeInterventionId: row.id,
          accountId: row.accountId,
          status: "evaluated",
          resultLabel: evaluated.latestEvaluation.resultLabel,
        });
      } catch (error) {
        results.push({
          changeInterventionId: row.id,
          accountId: row.accountId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      total: rows.length,
      evaluated: results.filter((row) => row.status === "evaluated").length,
      failed: results.filter((row) => row.status === "failed").length,
      results,
    };
  });
}
