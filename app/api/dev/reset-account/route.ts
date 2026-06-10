/**
 * Developer Options: reset the currently logged-in user's data.
 *
 *   GET  → preview (counts per table, no writes)
 *   POST → delete everything for this user (requires { confirm: true })
 *
 * Identity resolves via `identifyUser` (Supabase). Account IDs are sourced
 * from `ad_platform_connections.account_ids`.
 *
 * Scope:
 *   - userId-linked rows: subscriptions, chat threads/messages, tool
 *     permissions, ad-platform connections, GoHighLevel connections, shared
 *     audits, audit snapshots/applies, operations, mcp_sessions, oauth
 *     access tokens / authorization codes that hang off those sessions or
 *     ad-platform connections.
 *   - accountId-linked rows for every customer in the caller's connection:
 *     goals, campaign_benchmark_30d_snapshots, change_interventions (+ children),
 *     accounts (snapshot table), plus any operations / audit rows whose
 *     userId was null at write time.
 *   - Session cookies: legacy app cookies (adsagent_*) AND Supabase sb-*
 *     cookies, so the next request is a true signed-out state.
 *
 * Does NOT delete the `auth.users` row. Devs re-sign-in with the same
 * Google identity to recreate state from scratch.
 *
 * Refuses to run while impersonating another account — devs reset their
 * own data, not someone else's.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq, inArray, or, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db, schema } from "@/lib/db";
import { COOKIE_NAMES, clearSessionCookies } from "@/lib/auth-cookies";
import { requireDevEmail } from "@/lib/dev-access";
import { identifyUser } from "@/lib/auth/identify-user";
import { loadGoogleConnection } from "@/lib/connections/google-read";
import { getEnv } from "@/lib/env";

type StripeMode = "test" | "live";

function stripeKeyFor(mode: StripeMode): string | undefined {
  return getEnv(mode === "test" ? "STRIPE_SECRET_KEY_TEST" : "STRIPE_SECRET_KEY_LIVE");
}

function stripeFor(mode: StripeMode): Stripe | null {
  const key = stripeKeyFor(mode);
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2026-03-25.dahlia", typescript: true });
}

type StripeCustomerRef = { env: StripeMode; stripeCustomerId: string };

async function fetchStripeCustomerRefs(userId: string): Promise<StripeCustomerRef[]> {
  const rows = await db()
    .select({
      env: schema.subscriptions.env,
      stripeCustomerId: schema.subscriptions.stripeCustomerId,
    })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId));
  return rows
    .filter((r): r is { env: string; stripeCustomerId: string } => !!r.stripeCustomerId)
    .map((r) => ({ env: (r.env === "live" ? "live" : "test") as StripeMode, stripeCustomerId: r.stripeCustomerId }));
}

type StripeDeleteResult = { env: StripeMode; stripeCustomerId: string; status: "deleted" | "skipped" | "failed"; error?: string };

async function deleteStripeCustomers(refs: StripeCustomerRef[]): Promise<StripeDeleteResult[]> {
  return Promise.all(
    refs.map(async ({ env, stripeCustomerId }) => {
      const client = stripeFor(env);
      if (!client) {
        return { env, stripeCustomerId, status: "skipped" as const, error: `Missing STRIPE_SECRET_KEY_${env.toUpperCase()}` };
      }
      try {
        await client.customers.del(stripeCustomerId);
        return { env, stripeCustomerId, status: "deleted" as const };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 404 = already gone — treat as success.
        if (/No such customer|resource_missing/i.test(msg)) {
          return { env, stripeCustomerId, status: "deleted" as const };
        }
        return { env, stripeCustomerId, status: "failed" as const, error: msg };
      }
    }),
  );
}

type RealSession = {
  userId: string;
  googleEmail: string | null;
  customerIds: string[];
};

/**
 * Resolve the dev's identity for reset. Sources `accountIds` from
 * `ad_platform_connections` so account-scoped deletes hit every customer
 * the dev has connected. Refuses to run while impersonating — devs reset
 * their own data, not someone else's.
 */
async function loadRealSession(): Promise<RealSession | null> {
  const store = await cookies();
  if (store.get(COOKIE_NAMES.impersonate)?.value) return null;

  const identity = await identifyUser({ source: "dev-reset-account" });
  if (!identity) return null;

  const conn = await loadGoogleConnection(identity.userId);

  return {
    userId: identity.userId,
    googleEmail: conn?.googleEmail ?? identity.googleEmail,
    customerIds: (conn?.customerIds ?? []).map((a) => a.id),
  };
}

type Counts = Record<string, number>;

async function fetchUserScopeIds(userId: string) {
  const [sessions, connections, ghl] = await Promise.all([
    db().select({ id: schema.mcpSessions.id }).from(schema.mcpSessions).where(eq(schema.mcpSessions.userId, userId)),
    db().select({ id: schema.adPlatformConnections.id }).from(schema.adPlatformConnections).where(eq(schema.adPlatformConnections.userId, userId)),
    db().select({ id: schema.goHighLevelConnections.id }).from(schema.goHighLevelConnections).where(eq(schema.goHighLevelConnections.userId, userId)),
  ]);
  return {
    sessionIds: sessions.map((r) => r.id),
    connectionIds: connections.map((r) => r.id),
    ghlIds: ghl.map((r) => r.id),
  };
}

async function fetchInterventionIds(accountIds: string[]): Promise<number[]> {
  if (accountIds.length === 0) return [];
  const rows = await db()
    .select({ id: schema.changeInterventions.id })
    .from(schema.changeInterventions)
    .where(inArray(schema.changeInterventions.accountId, accountIds));
  return rows.map((r) => r.id);
}

async function countAll(userId: string, accountIds: string[]): Promise<Counts> {
  const { sessionIds, connectionIds } = await fetchUserScopeIds(userId);
  const interventionIds = await fetchInterventionIds(accountIds);

  const c = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const Q = () => db().select({ n: sql<number>`count(*)::int` });

  const oauthTokenWhere = (sessionIds.length > 0 || connectionIds.length > 0)
    ? or(
        sessionIds.length > 0 ? inArray(schema.oauthAccessTokens.sessionId, sessionIds) : undefined,
        connectionIds.length > 0 ? inArray(schema.oauthAccessTokens.connectionId, connectionIds) : undefined,
      )
    : sql`false`;
  const authCodeWhere = (sessionIds.length > 0 || connectionIds.length > 0)
    ? or(
        sessionIds.length > 0 ? inArray(schema.authorizationCodes.sessionId, sessionIds) : undefined,
        connectionIds.length > 0 ? inArray(schema.authorizationCodes.connectionId, connectionIds) : undefined,
      )
    : sql`false`;

  const auditAppliesWhere = accountIds.length > 0
    ? or(eq(schema.auditApplies.userId, userId), inArray(schema.auditApplies.accountId, accountIds))
    : eq(schema.auditApplies.userId, userId);
  const auditSnapshotsWhere = accountIds.length > 0
    ? or(eq(schema.auditSnapshots.userId, userId), inArray(schema.auditSnapshots.accountId, accountIds))
    : eq(schema.auditSnapshots.userId, userId);
  const opsWhere = accountIds.length > 0
    ? or(eq(schema.operations.userId, userId), inArray(schema.operations.accountId, accountIds))
    : eq(schema.operations.userId, userId);

  const [
    subscriptions,
    chat_threads,
    chat_messages,
    tool_permissions,
    ad_platform_connections,
    gohighlevel_connections,
    shared_audits,
    audit_applies,
    audit_snapshots,
    operations,
    mcp_sessions,
    oauth_access_tokens,
    authorization_codes,
    goals,
    campaign_benchmark_30d_snapshots,
    change_interventions,
    change_intervention_operations,
    change_intervention_evaluations,
    accounts,
  ] = await Promise.all([
    c(Q().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId))),
    c(Q().from(schema.chatThreads).where(eq(schema.chatThreads.userId, userId))),
    c(Q().from(schema.chatMessages).where(sql`${schema.chatMessages.threadId} in (select id from ${schema.chatThreads} where ${schema.chatThreads.userId} = ${userId})`)),
    c(Q().from(schema.toolPermissions).where(eq(schema.toolPermissions.userId, userId))),
    c(Q().from(schema.adPlatformConnections).where(eq(schema.adPlatformConnections.userId, userId))),
    c(Q().from(schema.goHighLevelConnections).where(eq(schema.goHighLevelConnections.userId, userId))),
    c(Q().from(schema.sharedAudits).where(eq(schema.sharedAudits.ownerUserId, userId))),
    c(Q().from(schema.auditApplies).where(auditAppliesWhere)),
    c(Q().from(schema.auditSnapshots).where(auditSnapshotsWhere)),
    c(Q().from(schema.operations).where(opsWhere)),
    c(Q().from(schema.mcpSessions).where(eq(schema.mcpSessions.userId, userId))),
    c(Q().from(schema.oauthAccessTokens).where(oauthTokenWhere)),
    c(Q().from(schema.authorizationCodes).where(authCodeWhere)),
    accountIds.length > 0 ? c(Q().from(schema.goals).where(inArray(schema.goals.accountId, accountIds))) : Promise.resolve(0),
    accountIds.length > 0 ? c(Q().from(schema.campaignBenchmarkThirtyDaySnapshots).where(inArray(schema.campaignBenchmarkThirtyDaySnapshots.accountId, accountIds))) : Promise.resolve(0),
    accountIds.length > 0 ? c(Q().from(schema.changeInterventions).where(inArray(schema.changeInterventions.accountId, accountIds))) : Promise.resolve(0),
    interventionIds.length > 0 ? c(Q().from(schema.changeInterventionOperations).where(inArray(schema.changeInterventionOperations.changeInterventionId, interventionIds))) : Promise.resolve(0),
    interventionIds.length > 0 ? c(Q().from(schema.changeInterventionEvaluations).where(inArray(schema.changeInterventionEvaluations.changeInterventionId, interventionIds))) : Promise.resolve(0),
    accountIds.length > 0 ? c(Q().from(schema.accounts).where(inArray(schema.accounts.accountId, accountIds))) : Promise.resolve(0),
  ]);

  return {
    subscriptions,
    chat_threads,
    chat_messages,
    tool_permissions,
    ad_platform_connections,
    gohighlevel_connections,
    shared_audits,
    audit_applies,
    audit_snapshots,
    operations,
    mcp_sessions,
    oauth_access_tokens,
    authorization_codes,
    goals,
    campaign_benchmark_30d_snapshots,
    change_interventions,
    change_intervention_operations,
    change_intervention_evaluations,
    accounts,
  };
}

export async function GET() {
  const denied = await requireDevEmail();
  if (denied) return denied;

  const real = await loadRealSession();
  if (!real) {
    return NextResponse.json(
      { error: "No real (non-impersonated) session — sign in or stop impersonating before reset." },
      { status: 400 },
    );
  }

  const [counts, stripeCustomers] = await Promise.all([
    countAll(real.userId, real.customerIds),
    fetchStripeCustomerRefs(real.userId),
  ]);
  const total = Object.values(counts).reduce((s, n) => s + n, 0);

  return NextResponse.json({
    userId: real.userId,
    googleEmail: real.googleEmail,
    accountIds: real.customerIds,
    counts,
    total,
    stripeCustomers,
  });
}

export async function POST(request: Request) {
  const denied = await requireDevEmail();
  if (denied) return denied;

  let body: { confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (body.confirm !== true) {
    return NextResponse.json({ error: "Missing { confirm: true }" }, { status: 400 });
  }

  const real = await loadRealSession();
  if (!real) {
    return NextResponse.json(
      { error: "No real (non-impersonated) session — sign in or stop impersonating before reset." },
      { status: 400 },
    );
  }
  const userId = real.userId;
  const accountIds = real.customerIds;

  const { sessionIds, connectionIds } = await fetchUserScopeIds(userId);
  const interventionIds = await fetchInterventionIds(accountIds);
  const stripeRefs = await fetchStripeCustomerRefs(userId);

  // Stripe customers go first — once the local subscriptions row is gone we
  // lose the customer-id mapping. Best-effort: a Stripe failure is reported
  // back but does not abort the local DB reset.
  const stripeResults = await deleteStripeCustomers(stripeRefs);

  // Order matters: child rows before parents. Each step is idempotent so a
  // partial failure can be retried by re-running reset.
  const deleted: string[] = [];
  const del = async (key: string, fn: () => Promise<unknown>) => {
    await fn();
    deleted.push(key);
  };

  // 1. chat_messages → chat_threads
  await del("chat_messages", () =>
    db().delete(schema.chatMessages).where(
      sql`${schema.chatMessages.threadId} in (select id from ${schema.chatThreads} where ${schema.chatThreads.userId} = ${userId})`,
    ),
  );
  await del("chat_threads", () =>
    db().delete(schema.chatThreads).where(eq(schema.chatThreads.userId, userId)),
  );

  // 2. change_intervention children → change_interventions
  if (interventionIds.length > 0) {
    await del("change_intervention_operations", () =>
      db().delete(schema.changeInterventionOperations).where(
        inArray(schema.changeInterventionOperations.changeInterventionId, interventionIds),
      ),
    );
    await del("change_intervention_evaluations", () =>
      db().delete(schema.changeInterventionEvaluations).where(
        inArray(schema.changeInterventionEvaluations.changeInterventionId, interventionIds),
      ),
    );
  }
  if (accountIds.length > 0) {
    await del("change_interventions", () =>
      db().delete(schema.changeInterventions).where(inArray(schema.changeInterventions.accountId, accountIds)),
    );
  }

  // 3. audit_applies → audit_snapshots
  await del("audit_applies", () =>
    db().delete(schema.auditApplies).where(
      accountIds.length > 0
        ? or(eq(schema.auditApplies.userId, userId), inArray(schema.auditApplies.accountId, accountIds))
        : eq(schema.auditApplies.userId, userId),
    ),
  );
  await del("audit_snapshots", () =>
    db().delete(schema.auditSnapshots).where(
      accountIds.length > 0
        ? or(eq(schema.auditSnapshots.userId, userId), inArray(schema.auditSnapshots.accountId, accountIds))
        : eq(schema.auditSnapshots.userId, userId),
    ),
  );

  // 4. shared_audits, tool_permissions
  await del("shared_audits", () =>
    db().delete(schema.sharedAudits).where(eq(schema.sharedAudits.ownerUserId, userId)),
  );
  await del("tool_permissions", () =>
    db().delete(schema.toolPermissions).where(eq(schema.toolPermissions.userId, userId)),
  );

  // 5. operations
  await del("operations", () =>
    db().delete(schema.operations).where(
      accountIds.length > 0
        ? or(eq(schema.operations.userId, userId), inArray(schema.operations.accountId, accountIds))
        : eq(schema.operations.userId, userId),
    ),
  );

  // 6. account-scoped tables
  if (accountIds.length > 0) {
    await del("goals", () =>
      db().delete(schema.goals).where(inArray(schema.goals.accountId, accountIds)),
    );
    await del("campaign_benchmark_30d_snapshots", () =>
      db().delete(schema.campaignBenchmarkThirtyDaySnapshots).where(inArray(schema.campaignBenchmarkThirtyDaySnapshots.accountId, accountIds)),
    );
    await del("accounts", () =>
      db().delete(schema.accounts).where(inArray(schema.accounts.accountId, accountIds)),
    );
  }

  // 7. oauth tokens / auth codes hanging off our sessions or ad-platform
  //    connections — must precede the parent deletes.
  if (sessionIds.length > 0 || connectionIds.length > 0) {
    await del("oauth_access_tokens", () =>
      db().delete(schema.oauthAccessTokens).where(
        or(
          sessionIds.length > 0 ? inArray(schema.oauthAccessTokens.sessionId, sessionIds) : undefined,
          connectionIds.length > 0 ? inArray(schema.oauthAccessTokens.connectionId, connectionIds) : undefined,
        ),
      ),
    );
    await del("authorization_codes", () =>
      db().delete(schema.authorizationCodes).where(
        or(
          sessionIds.length > 0 ? inArray(schema.authorizationCodes.sessionId, sessionIds) : undefined,
          connectionIds.length > 0 ? inArray(schema.authorizationCodes.connectionId, connectionIds) : undefined,
        ),
      ),
    );
  }

  // 8. ad_platform_connections, gohighlevel_connections, subscriptions
  await del("ad_platform_connections", () =>
    db().delete(schema.adPlatformConnections).where(eq(schema.adPlatformConnections.userId, userId)),
  );
  // Defensive cleanup of GHL PATs even though the FK has ON DELETE CASCADE —
  // makes the count surface accurate and protects against the cascade not
  // firing in test setups that bypass the FK.
  await del("gohighlevel_access_tokens", () =>
    db().delete(schema.goHighLevelAccessTokens).where(eq(schema.goHighLevelAccessTokens.userId, userId)),
  );
  await del("gohighlevel_connections", () =>
    db().delete(schema.goHighLevelConnections).where(eq(schema.goHighLevelConnections.userId, userId)),
  );
  await del("subscriptions", () =>
    db().delete(schema.subscriptions).where(eq(schema.subscriptions.userId, userId)),
  );

  // 9. mcp_sessions LAST — once these go, the caller's cookie token stops
  //    resolving and the next request will redirect to /connect.
  await del("mcp_sessions", () =>
    db().delete(schema.mcpSessions).where(eq(schema.mcpSessions.userId, userId)),
  );

  const response = NextResponse.json({ ok: true, userId, accountIds, deleted, stripe: stripeResults });
  clearSessionCookies(response);
  // Also expire Supabase sb-* cookies so the next request starts from a true
  // signed-out state. Without this, Supabase still resolves the dev's identity
  // post-reset (auth.users isn't deleted), and the re-OAuth flow may skip parts
  // of the new-user codepath we usually want to exercise.
  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (name.startsWith("sb-")) {
      response.cookies.set(name, "", { maxAge: 0, path: "/" });
    }
  }
  return response;
}
