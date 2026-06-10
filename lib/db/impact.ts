/**
 * Pure helpers for computing change-impact attribution from performance
 * snapshots. No database access — easy to unit test and reuse.
 *
 * Methodology: for each successful write, compare the affected campaign's
 * daily averages over the 7 days before vs the 7 days after the change.
 * Snapshots are captured by a daily cron (see app/api/cron/snapshot),
 * which means yesterday's metrics land today. A change made today has
 * zero matured after-data; a change 7d ago has ~6 usable days.
 */

// ─── Types ──────────────────────────────────────────────────────────

/** Narrow snapshot shape the pure helpers consume. Matches
 * the campaign benchmark snapshot metric fields but avoids importing drizzle
 * into the pure module. */
export type SnapshotRow = {
  campaignId: string;
  snapshotDate: string; // YYYY-MM-DD
  costMicros: number | null;
  conversions: number | null;
};

export type WindowAverage = {
  dailyCost: number;
  dailyConversions: number;
  cpa: number | null;
  days: number;
};

export type SnapshotImpact = {
  before: WindowAverage;
  after: WindowAverage;
  costDelta: number;
  conversionsDelta: number;
  cpaDelta: number | null;
};

export type Direction = "improved" | "worsened" | "neutral" | "unknown";

export type ChangeRow = {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  label: string | null;
  campaignId: string | null;
  reasoning: string | null;
  rolledBack: boolean;
  timestamp: Date;
};

export type ChangeImpactItem = {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  label: string | null;
  campaignId: string | null;
  timestamp: string; // ISO
  daysAgo: number;
  rolledBack: boolean;
  reasoning: string | null;
  impact: (SnapshotImpact & { direction: Direction }) | null;
  impactReason: string | null;
  /** Count of OTHER successful writes to the same campaign within this
   * change's 14-day measurement envelope (7 days before + 7 days after).
   * When >0, the before/after delta reflects combined interventions —
   * the agent should not claim sole credit. Earlier writes contaminate
   * the before window; later writes contaminate the after window. */
  otherChangesInWindow: number;
};

export type ActionSummary = {
  action: string;
  count: number;
  matured: number;
  improved: number;
  worsened: number;
  neutral: number;
  uniqueCampaignsAffected: number;
};

export type TruncationReason = "limit_reached" | null;

export type ReviewChangeImpact = {
  window: { days: number; startDate: string; endDate: string; generatedAt: string };
  counts: {
    /** True count of successful writes in the window (may exceed `fetched`). */
    total: number;
    /** Number of changes actually analyzed (capped by the `limit` param). */
    fetched: number;
    /** True when total > fetched — agent should widen the window or raise limit. */
    truncated: boolean;
    /** Why truncation happened. Matches the `truncated` flag: null when not truncated. */
    truncationReason: TruncationReason;
    /** When truncated, tells the agent exactly how to get the rest. */
    continuationHint: string | null;
    matured: number;
    tooNew: number;
    noCampaign: number;
    noData: number;
    rolledBack: number;
  };
  byAction: ActionSummary[];
  aggregate: {
    improved: number;
    worsened: number;
    neutral: number;
    netCostDelta: number;
    netConversionsDelta: number;
    uniqueCampaignsAffected: number;
  };
  /** Per-change attribution. Named `items` to match the list-field convention
   * used by sibling read tools like `getChanges`. */
  items: ChangeImpactItem[];
  notes: string[];
};

// ─── Constants ──────────────────────────────────────────────────────

/** Window on each side of the change date, in days. */
export const IMPACT_WINDOW_DAYS = 7;

/** Minimum after-snapshots required to classify direction. Snapshot cron
 * lags ~1 day, so a change 3 days old has ~2 usable after-days — enough
 * to signal direction without waiting the full 7d window. */
export const MIN_AFTER_DAYS_FOR_DIRECTION = 3;

/** Fractional threshold for "neutral": movements below this are noise. */
export const NEUTRAL_THRESHOLD = 0.05;

/** Truncate `reasoning` in tool responses — the raw string is still in the DB. */
export const MAX_REASONING_CHARS = 240;

/** Shared correlation caveat used by both `getImpact` (single change) and
 * `reviewChangeImpact` (batch review). Kept in one place so the wording
 * can't drift across surfaces. */
export const IMPACT_CORRELATION_DISCLAIMER =
  "Impact is correlational — seasonality, competitor bids, and Google's algorithm can also drive movement.";

// ─── Pure helpers ───────────────────────────────────────────────────

export function averageSnapshots(snapshots: SnapshotRow[]): WindowAverage {
  const days = snapshots.length;
  if (days === 0) return { dailyCost: 0, dailyConversions: 0, cpa: null, days: 0 };

  let totalCost = 0;
  let totalConversions = 0;
  for (const s of snapshots) {
    totalCost += (s.costMicros ?? 0) / 1_000_000;
    totalConversions += s.conversions ?? 0;
  }

  return {
    dailyCost: totalCost / days,
    dailyConversions: totalConversions / days,
    cpa: totalConversions > 0 ? totalCost / totalConversions : null,
    days,
  };
}

export function computeSnapshotImpact(
  before: SnapshotRow[],
  after: SnapshotRow[],
): SnapshotImpact {
  const avgBefore = averageSnapshots(before);
  const avgAfter = averageSnapshots(after);
  return {
    before: avgBefore,
    after: avgAfter,
    costDelta: avgAfter.dailyCost - avgBefore.dailyCost,
    conversionsDelta: avgAfter.dailyConversions - avgBefore.dailyConversions,
    cpaDelta:
      avgAfter.cpa !== null && avgBefore.cpa !== null
        ? avgAfter.cpa - avgBefore.cpa
        : null,
  };
}

export function classifyDirection(impact: SnapshotImpact): Direction {
  // Prefer CPA when both windows have conversions.
  if (impact.cpaDelta !== null && impact.before.cpa !== null && impact.before.cpa > 0) {
    const pct = impact.cpaDelta / impact.before.cpa;
    if (pct < -NEUTRAL_THRESHOLD) return "improved";
    if (pct > NEUTRAL_THRESHOLD) return "worsened";
    return "neutral";
  }

  // Fallback: look at conversions + cost together.
  const conv = impact.conversionsDelta;
  const cost = impact.costDelta;
  const convBase = impact.before.dailyConversions || 0;
  const costBase = impact.before.dailyCost || 0;

  const convPct = convBase > 0 ? Math.abs(conv / convBase) : (conv === 0 ? 0 : Infinity);
  const costPct = costBase > 0 ? Math.abs(cost / costBase) : (cost === 0 ? 0 : Infinity);

  if (convPct < NEUTRAL_THRESHOLD && costPct < NEUTRAL_THRESHOLD) return "neutral";

  // More conversions without more cost → improved.
  if (conv > 0 && cost <= 0) return "improved";
  // Fewer conversions without less cost → worsened.
  if (conv < 0 && cost >= 0) return "worsened";
  // Conflicting signals (e.g. cost up AND conversions up) → can't call it.
  return "unknown";
}

// ─── Review aggregation ─────────────────────────────────────────────

function daysBetween(later: Date, earlier: Date): number {
  // Clamp at 0 so clock-skewed or future-dated timestamps don't produce
  // negative daysAgo, which would poison the "most recent change per
  // campaign" picker in the aggregate.
  return Math.max(
    0,
    Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24)),
  );
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function truncate(s: string | null, max: number): string | null {
  if (s === null) return null;
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Pure aggregation. Takes raw changes + snapshot map, returns a
 * Coworker-friendly impact summary.
 *
 * Callers must:
 *   - pre-filter `changes` to WRITES with success=1 in the window
 *   - provide `snapshotsByCampaign` keyed by campaignId, each array sorted
 *     by snapshotDate (any order works; we filter by date string anyway)
 *   - provide `now` explicitly (dependency injection for testability)
 */
export function computeChangeImpactReview(
  changes: ChangeRow[],
  snapshotsByCampaign: Map<string, SnapshotRow[]>,
  now: Date,
  windowDays: number,
  totalPopulation?: number,
): ReviewChangeImpact {
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

  const items: ChangeImpactItem[] = [];
  let tooNew = 0;
  let noCampaign = 0;
  let noData = 0;
  let rolledBack = 0;
  let matured = 0;

  for (const change of changes) {
    const daysAgo = daysBetween(now, change.timestamp);
    let impact: (SnapshotImpact & { direction: Direction }) | null = null;
    let impactReason: string | null = null;

    if (change.rolledBack) {
      rolledBack++;
      impactReason = "Change was rolled back — impact not attributed.";
    } else if (!change.campaignId) {
      noCampaign++;
      impactReason = "No campaign associated — snapshot attribution requires a campaign.";
    } else {
      // Before: [changeDate - 7d, changeDate)     — 7 days strictly pre-change.
      // After:  [changeDate + 1d, changeDate + 8d) — 7 days strictly post-change.
      // The change-day snapshot is SKIPPED on both sides: since snapshots
      // cover a full calendar day, the one dated `changeDate` mixes pre-
      // and post-change hours and would bias the freshest attributions.
      // Clean symmetric 7-day windows on both sides.
      const allSnaps = snapshotsByCampaign.get(change.campaignId);
      const changeDateStr = dateKey(change.timestamp);
      const beforeCutoff = new Date(change.timestamp);
      beforeCutoff.setUTCDate(beforeCutoff.getUTCDate() - IMPACT_WINDOW_DAYS);
      const beforeCutoffStr = dateKey(beforeCutoff);
      const afterStart = new Date(change.timestamp);
      afterStart.setUTCDate(afterStart.getUTCDate() + 1);
      const afterStartStr = dateKey(afterStart);
      const afterEnd = new Date(change.timestamp);
      afterEnd.setUTCDate(afterEnd.getUTCDate() + IMPACT_WINDOW_DAYS + 1);
      const afterEndStr = dateKey(afterEnd);

      const before = (allSnaps ?? []).filter(
        (s) => s.snapshotDate >= beforeCutoffStr && s.snapshotDate < changeDateStr,
      );
      const after = (allSnaps ?? []).filter(
        (s) => s.snapshotDate >= afterStartStr && s.snapshotDate < afterEndStr,
      );

      if (before.length === 0 && after.length === 0) {
        noData++;
        impactReason = "No snapshots found for this campaign.";
      } else if (after.length < MIN_AFTER_DAYS_FOR_DIRECTION) {
        tooNew++;
        impactReason = `Only ${after.length} day(s) of after-data — need ${MIN_AFTER_DAYS_FOR_DIRECTION}+ to attribute. Snapshots capture yesterday's metrics, so very recent changes need a few days to mature.`;
      } else if (before.length === 0) {
        noData++;
        impactReason = "No snapshots before the change — campaign may be newly tracked.";
      } else {
        const base = computeSnapshotImpact(before, after);
        impact = { ...base, direction: classifyDirection(base) };
        matured++;
      }
    }

    items.push({
      id: change.id,
      action: change.action,
      entityType: change.entityType,
      entityId: change.entityId,
      label: change.label,
      campaignId: change.campaignId,
      timestamp: change.timestamp.toISOString(),
      daysAgo,
      rolledBack: change.rolledBack,
      reasoning: truncate(change.reasoning, MAX_REASONING_CHARS),
      impact,
      impactReason,
      // Filled in below once we've seen every change.
      otherChangesInWindow: 0,
    });
  }

  // Second pass: for each change with a campaign, count how many OTHER
  // successful writes landed on the same campaign within this change's
  // 14-day measurement envelope (7 days before + 7 days after). Earlier
  // same-campaign writes contaminate the before window; later ones
  // contaminate the after window. Either way, the agent's delta can't
  // be claimed as sole attribution.
  const windowMs = IMPACT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  for (let i = 0; i < items.length; i++) {
    const self = items[i];
    if (!self.campaignId) continue;
    const selfTs = new Date(self.timestamp).getTime();
    const envelopeStart = selfTs - windowMs;
    const envelopeEnd = selfTs + windowMs;
    let others = 0;
    for (let j = 0; j < items.length; j++) {
      if (j === i) continue;
      const other = items[j];
      if (other.campaignId !== self.campaignId) continue;
      const otherTs = new Date(other.timestamp).getTime();
      if (otherTs >= envelopeStart && otherTs < envelopeEnd) others++;
    }
    self.otherChangesInWindow = others;
  }

  // ─ Per-action breakdown + aggregate totals in ONE pass over items.
  // Counts are per-change (honest: "you did this 5 times, 3 improved");
  // aggregate sums use unique-campaign dedup with the MOST RECENT matured
  // change as representative, so 5 writes to the same campaign don't
  // 5×-inflate the total. ──────────────────────────────────────────
  type ActionAccumulator = {
    count: number;
    matured: number;
    improved: number;
    worsened: number;
    neutral: number;
    campaigns: Set<string>;
  };
  const byActionMap = new Map<string, ActionAccumulator>();
  const latestByCampaign = new Map<string, ChangeImpactItem>();
  let improved = 0;
  let worsened = 0;
  let neutral = 0;

  for (const item of items) {
    const row: ActionAccumulator =
      byActionMap.get(item.action) ??
      {
        count: 0,
        matured: 0,
        improved: 0,
        worsened: 0,
        neutral: 0,
        campaigns: new Set<string>(),
      };
    row.count++;
    if (item.campaignId) row.campaigns.add(item.campaignId);
    if (item.impact) {
      row.matured++;
      if (item.impact.direction === "improved") {
        row.improved++;
        improved++;
      } else if (item.impact.direction === "worsened") {
        row.worsened++;
        worsened++;
      } else if (item.impact.direction === "neutral") {
        row.neutral++;
        neutral++;
      }
      if (item.campaignId) {
        const existing = latestByCampaign.get(item.campaignId);
        // Explicit timestamp comparison so the tiebreak doesn't depend on
        // Map insertion order or integer-day floor of daysAgo.
        if (
          !existing ||
          new Date(item.timestamp).getTime() > new Date(existing.timestamp).getTime()
        ) {
          latestByCampaign.set(item.campaignId, item);
        }
      }
    }
    byActionMap.set(item.action, row);
  }

  const byAction: ActionSummary[] = Array.from(byActionMap.entries())
    .map(([action, r]) => ({
      action,
      count: r.count,
      matured: r.matured,
      improved: r.improved,
      worsened: r.worsened,
      neutral: r.neutral,
      uniqueCampaignsAffected: r.campaigns.size,
    }))
    .sort((a, b) => b.count - a.count);

  let netCostDelta = 0;
  let netConversionsDelta = 0;
  for (const item of latestByCampaign.values()) {
    if (!item.impact) continue;
    netCostDelta += item.impact.costDelta;
    netConversionsDelta += item.impact.conversionsDelta;
  }

  const total = totalPopulation ?? changes.length;
  const truncated = total > changes.length;
  const truncationReason: TruncationReason = truncated ? "limit_reached" : null;
  const continuationHint = truncated
    ? `Fetched ${changes.length} of ${total} changes in this window. Raise \`limit\` (max 200) or narrow \`days\` to see the rest.`
    : null;

  return {
    window: {
      days: windowDays,
      startDate: dateKey(windowStart),
      endDate: dateKey(now),
      generatedAt: now.toISOString(),
    },
    counts: {
      total,
      fetched: changes.length,
      truncated,
      truncationReason,
      continuationHint,
      matured,
      tooNew,
      noCampaign,
      noData,
      rolledBack,
    },
    byAction,
    aggregate: {
      improved,
      worsened,
      neutral,
      netCostDelta,
      netConversionsDelta,
      uniqueCampaignsAffected: latestByCampaign.size,
    },
    items,
    notes: [
      IMPACT_CORRELATION_DISCLAIMER,
      "aggregate.netCostDelta/netConversionsDelta deduplicate by campaign: each campaign contributes once, using the most recent change's 7-day before/after comparison. This avoids inflating totals when multiple writes hit the same campaign in the window.",
      `Snapshots capture yesterday's daily metrics via a cron job, so changes <${MIN_AFTER_DAYS_FOR_DIRECTION} days old may be too new to attribute.`,
      "Per-action counts (improved/worsened/neutral) are per-change — they answer 'of your N writes, how many moved in a good direction' — and can over-count campaigns affected by multiple writes. When N writes hit the same campaign on the same day, all N share the same before/after measurement; treat them as ONE observation, not N independent ones.",
      "Each item's `otherChangesInWindow` field counts OTHER successful writes to the same campaign within its 14-day measurement envelope (7d before + 7d after). When >0, the delta reflects combined interventions — don't claim sole credit. When truncated=true, this count may undercount confounders clipped by the fetch limit.",
      "Window boundaries are UTC-aligned. Snapshots are stored by Google Ads account-local date (from the Ads API), so non-UTC accounts may see up to 1-day skew at window edges.",
      "When truncated=true, aggregate sums and counts cover ONLY the fetched slice (not the full total). Raise `limit` or narrow `days` to see everything.",
    ],
  };
}
