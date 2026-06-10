import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { desc, eq, gte } from "drizzle-orm";
import { setGoogleConnectionAccountHealthEntry } from "@/lib/connections/google";
import {
  CONNECTION_HEALTH_KEY,
  authForAccount,
  buildAccountHealthKey,
  buildGoogleAccountHealthFailure,
  buildGoogleAccountHealthSuccess,
  classifyGoogleBenchmarkError,
  collectCampaignTrafficBenchmarkThirtyDaySnapshots,
  parseCustomerIds,
  shouldSkipGoogleAccountHealth,
  upsertCampaignBenchmarkThirtyDaySnapshots,
  type AuthContext,
  type ConnectedAccount,
  type GoogleAccountHealthMap,
} from "@/lib/google-ads";

/**
 * Monthly campaign benchmark snapshot cron job.
 *
 * Triggered by Vercel Cron (see vercel.json). For each connected Google Ads
 * account, refreshes one trailing-30-day account/campaign snapshot. The daily
 * benchmark table has been retired to keep Google Ads API quota and storage
 * bounded.
 */
const BENCHMARK_REFRESH_DAYS = 30;

export async function GET(request: Request) {
  // Verify cron secret to prevent unauthorized access
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const connections = await db()
      .select()
      .from(schema.adPlatformConnections)
      .where(eq(schema.adPlatformConnections.platform, "google_ads"))
      .orderBy(desc(schema.adPlatformConnections.updatedAt));

    const sessions = await db()
      .select()
      .from(schema.mcpSessions)
      .where(gte(schema.mcpSessions.expiresAt, new Date().toISOString()))
      .orderBy(desc(schema.mcpSessions.createdAt));

    const benchmarkDateRange = getDateRangeEndingYesterday(BENCHMARK_REFRESH_DAYS);
    type AccountCandidate = { source: string; auth: AuthContext; connectionId?: number; accountHealth?: GoogleAccountHealthMap };
    const accounts = new Map<string, { candidates: AccountCandidate[] }>();

    let benchmarkSkipped = 0;

    for (const connection of connections) {
      const accountHealth = connection.accountHealth ?? {};
      const connectedAccounts = normalizeConnectedAccounts(connection.accountIds ?? []);
      const accountIds = connectedAccounts.length > 0
        ? connectedAccounts.map((account) => account.id)
        : connection.activeAccountId
          ? [connection.activeAccountId]
          : [];
      if (!connection.activeAccountId && accountIds.length === 0) continue;

      const activeAccount = connectedAccounts.find((account) => account.id === connection.activeAccountId);
      const baseAuth: AuthContext = {
        refreshToken: connection.refreshToken,
        customerId: connection.activeAccountId ?? accountIds[0],
        customerIds: connectedAccounts,
        loginCustomerId: activeAccount?.loginCustomerId ?? null,
        userId: connection.userId,
        authMethod: "oauth",
      };

      const connectionHealth = accountHealth[CONNECTION_HEALTH_KEY];
      if (shouldSkipGoogleAccountHealth(connectionHealth)) {
        benchmarkSkipped += accountIds.length;
        continue;
      }

      for (const accountId of accountIds) {
        const account = connectedAccounts.find((candidate) => candidate.id === accountId);
        const healthKey = buildAccountHealthKey(accountId, account?.loginCustomerId ?? null);
        if (shouldSkipGoogleAccountHealth(accountHealth[healthKey])) {
          benchmarkSkipped++;
          continue;
        }
        addAccountCandidate(accounts, "connection", authForAccount(baseAuth, accountId), {
          connectionId: connection.id,
          accountHealth,
        });
      }
    }

    for (const session of sessions) {
      const connectedAccounts = parseCustomerIds(session.customerIds);
      const accountIds = connectedAccounts.length > 0
        ? connectedAccounts.map((account) => account.id)
        : session.customerId
          ? [session.customerId]
          : [];

      const baseAuth: AuthContext = {
        refreshToken: session.refreshToken,
        customerId: session.customerId,
        customerIds: connectedAccounts,
        loginCustomerId: session.loginCustomerId,
        userId: session.userId,
        clientName: session.clientName,
        clientVersion: session.clientVersion,
        authMethod: "oauth",
        sessionId: session.id,
      };

      for (const accountId of accountIds) {
        addAccountCandidate(accounts, `session:${session.id}`, authForAccount(baseAuth, accountId));
      }
    }

    let errors = 0;
    let benchmarkSnapshotsUpserted = 0;
    let benchmarkErrors = 0;
    const blockedConnections = new Set<number>();

    for (const { candidates } of accounts.values()) {
      let completed = false;

      for (const candidate of candidates) {
        const { source, auth, connectionId, accountHealth } = candidate;
        if (connectionId != null && blockedConnections.has(connectionId)) {
          benchmarkSkipped++;
          continue;
        }

        try {
          const benchmarkRows = await collectCampaignTrafficBenchmarkThirtyDaySnapshots(auth, benchmarkDateRange);
          benchmarkSnapshotsUpserted += await upsertCampaignBenchmarkThirtyDaySnapshots(benchmarkRows);
          if (connectionId != null) {
            const key = buildAccountHealthKey(auth.customerId, auth.loginCustomerId ?? null);
            await setGoogleConnectionAccountHealthEntry({
              connectionId,
              key,
              entry: buildGoogleAccountHealthSuccess(),
            });
          }
          completed = true;
          break;
        } catch (error) {
          benchmarkErrors++;
          if (connectionId != null) {
            const classified = classifyGoogleBenchmarkError(error);
            const key = classified.errorLevel === "connection"
              ? CONNECTION_HEALTH_KEY
              : buildAccountHealthKey(auth.customerId, auth.loginCustomerId ?? null);
            await setGoogleConnectionAccountHealthEntry({
              connectionId,
              key,
              entry: buildGoogleAccountHealthFailure(accountHealth?.[key], classified),
            });
            if (classified.errorLevel === "connection") {
              blockedConnections.add(connectionId);
            }
            console.warn(`[cron/snapshot] Benchmark snapshot failed for ${source}, account ${auth.customerId} (${classified.errorLevel}/${classified.code}):`, classified.message);
          } else {
            console.warn(`[cron/snapshot] Benchmark snapshot failed for ${source}, account ${auth.customerId}:`, error);
          }
        }
      }

      if (!completed) {
        const [{ source, auth }] = candidates;
        console.error(`[cron/snapshot] All candidates failed for ${source}, account ${auth.customerId}`);
        errors++;
      }
    }

    return NextResponse.json({
      success: true,
      connectionsProcessed: connections.length,
      sessionsProcessed: sessions.length,
      accountsProcessed: accounts.size,
      benchmarkDateRange,
      benchmarkSnapshotsUpserted,
      errors,
      benchmarkErrors,
      benchmarkSkipped,
    });
  } catch (error) {
    console.error("[cron/snapshot] Fatal error:", error);
    return NextResponse.json(
      { error: "Snapshot cron failed" },
      { status: 500 },
    );
  }
}

function addAccountCandidate(
  accounts: Map<string, { candidates: Array<{ source: string; auth: AuthContext; connectionId?: number; accountHealth?: GoogleAccountHealthMap }> }>,
  source: string,
  auth: AuthContext,
  extras: { connectionId?: number; accountHealth?: GoogleAccountHealthMap } = {},
) {
  const key = buildAccountHealthKey(auth.customerId, auth.loginCustomerId ?? null);
  const candidate = { source, auth, ...extras };
  const account = accounts.get(key);
  if (account) {
    account.candidates.push(candidate);
  } else {
    accounts.set(key, { candidates: [candidate] });
  }
}

function getDateRangeEndingYesterday(days: number, now = new Date()) {
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
  ));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - Math.max(1, days) + 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function normalizeConnectedAccounts(
  accounts: Array<{ id: string; name?: string; loginCustomerId?: string | null }>,
): ConnectedAccount[] {
  return accounts.map((account) => ({
    id: account.id,
    name: account.name ?? account.id,
    ...("loginCustomerId" in account ? { loginCustomerId: account.loginCustomerId ?? null } : {}),
  }));
}
