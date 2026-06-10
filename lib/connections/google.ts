import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { CONNECTION_HEALTH_KEY, type GoogleAccountHealthEntry } from "@/lib/google-ads/account-health";
import type { ConnectedAccount } from "@/lib/google-ads/types";

/**
 * Anything that exposes `.insert()` — covers both `db()` and a transaction
 * handle yielded by `db().transaction(async (tx) => ...)`. We deliberately
 * keep this loose so callers can pass either without wrestling with
 * Drizzle's transaction generics.
 */
type Executor = Pick<ReturnType<typeof db>, "insert" | "update">;

export type GoogleConnectionInput = {
  userId: string;
  refreshToken: string;
  /** Active customer id; null when ads-less or pending multi-account selection. */
  activeAccountId: string | null;
  /** Connectable accounts from listConnectableAccounts; loginCustomerId is preserved per-row. */
  accountIds: ConnectedAccount[];
  googleEmail?: string | null;
};

/**
 * Upsert a Google Ads connection row keyed on (userId, "google_ads").
 * `ad_platform_connections` is the source of truth for Google ad state.
 */
export async function upsertGoogleConnection(
  input: GoogleConnectionInput,
  executor: Executor = db(),
): Promise<void> {
  const { userId, refreshToken, activeAccountId, accountIds, googleEmail } = input;

  const accountIdsForRow = accountIds.map((a) => ({
    id: a.id,
    name: a.name ?? "",
    // `null` is meaningful (explicit direct-access). `undefined` collapses to absent
    // so we don't write a useless field. See lib/google-ads/types.ts authForAccount.
    ...(a.loginCustomerId !== undefined ? { loginCustomerId: a.loginCustomerId } : {}),
  }));

  const platformMetadata = googleEmail ? { googleEmail } : {};

  await executor
    .insert(schema.adPlatformConnections)
    .values({
      userId,
      platform: "google_ads",
      refreshToken,
      accountIds: accountIdsForRow,
      activeAccountId,
      platformMetadata,
    })
    .onConflictDoUpdate({
      target: [schema.adPlatformConnections.userId, schema.adPlatformConnections.platform],
      set: {
        refreshToken,
        accountIds: accountIdsForRow,
        activeAccountId,
        platformMetadata,
        // A fresh OAuth reconnect repairs connection-level auth failures, but
        // keep per-account failures (deactivated / missing manager access) so
        // benchmark jobs don't immediately re-burn credits on known-bad routes.
        accountHealth: sql`${schema.adPlatformConnections.accountHealth} - ${CONNECTION_HEALTH_KEY}`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Credential-only refresh used by the OAuth callback's `reuseExistingSession`
 * branch. Updates `refreshToken` (and optionally `googleEmail` in
 * platformMetadata) without touching `accountIds` or `activeAccountId` so we
 * don't clobber the user's curation when they re-OAuth on an existing
 * connection. No-op if no row exists yet (caller is expected to upsert
 * separately if so).
 */
export async function refreshGoogleConnectionCredentials(
  args: { userId: string; refreshToken: string; googleEmail?: string | null },
  executor: Executor = db(),
): Promise<void> {
  const { userId, refreshToken, googleEmail } = args;

  const platformMetadataPatch = googleEmail !== undefined && googleEmail !== null
    ? { googleEmail }
    : undefined;

  await executor
    .update(schema.adPlatformConnections)
    .set({
      refreshToken,
      ...(platformMetadataPatch
        ? {
            // Merge into existing jsonb. Drizzle hands raw values straight to pg —
            // we use the SQL-level `||` jsonb concat so we don't blow away
            // whatever else is in platformMetadata.
            platformMetadata: jsonbMerge(platformMetadataPatch),
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.adPlatformConnections.userId, userId),
        eq(schema.adPlatformConnections.platform, "google_ads"),
      ),
    );
}

/**
 * Active-account flip used by the navbar account switcher. Validating that
 * the requested account is in the user's `accountIds` is the caller's job;
 * this helper only writes.
 */
export async function setGoogleConnectionActiveAccount(
  args: { userId: string; activeAccountId: string },
  executor: Executor = db(),
): Promise<void> {
  await executor
    .update(schema.adPlatformConnections)
    .set({ activeAccountId: args.activeAccountId, updatedAt: new Date() })
    .where(
      and(
        eq(schema.adPlatformConnections.userId, args.userId),
        eq(schema.adPlatformConnections.platform, "google_ads"),
      ),
    );
}

export async function setGoogleConnectionAccountHealthEntry(
  args: { connectionId: number; key: string; entry: GoogleAccountHealthEntry },
  executor: Executor = db(),
): Promise<void> {
  await executor
    .update(schema.adPlatformConnections)
    .set({
      accountHealth: sql`jsonb_set(${schema.adPlatformConnections.accountHealth}, ${[args.key]}::text[], ${JSON.stringify(args.entry)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.adPlatformConnections.id, args.connectionId));
}

function jsonbMerge(patch: Record<string, unknown>) {
  // `existing || patch` keeps existing keys, then patch overrides keys also in patch.
  return sql`${schema.adPlatformConnections.platformMetadata} || ${JSON.stringify(patch)}::jsonb`;
}
