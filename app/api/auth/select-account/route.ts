import { randomUUID } from "crypto";
import { NextResponse, after } from "next/server";
import { getAppOrigin } from "@/lib/app-url";
import { upsertGoogleConnection } from "@/lib/connections/google";
import { recordUserAttribution } from "@/lib/db/attribution";
import { listConnectableAccounts, parseCustomerIds, syncAccountSnapshots, syncCampaignBenchmarkSnapshots } from "@/lib/google-ads";
import { createClient } from "@/lib/supabase/server";
import { trackServerEvent, flushServerEvents } from "@/lib/analytics-server";
import { maybeFireGoogleAdsSignup } from "@/lib/google-ads-signup";
import {
  REDDIT_SIGNUP_ID_COOKIE,
  sendRedditConversion,
  type RedditConversionInput,
} from "@/lib/reddit-capi";
import { sendTiktokSignupConversion } from "@/lib/tiktok-capi";
import { buildXSignupConversionId, X_SIGNUP_ID_COOKIE } from "@/lib/x-signup";
import { getClientIp } from "@/lib/request-ip";
import { attributionToUserMetadata, paidTouchToUserMetadata, sanitizeAttribution, sanitizePaidTouch } from "@/lib/utm";
import { identifyUser } from "@/lib/auth/identify-user";
import { loadGoogleConnection } from "@/lib/connections/google-read";
import { DEFAULT_ACTIVATION_PATH, GOOGLE_ADS_CONNECTED_PATH, safeInternalPathOrDefault } from "@/lib/app-routes";

export async function POST(request: Request) {
  after(flushServerEvents);

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { pendingToken, accounts, next: rawNext } = body;
  const next = safeInternalPathOrDefault(typeof rawNext === 'string' ? rawNext : null, DEFAULT_ACTIVATION_PATH);

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json(
      { error: "Missing accounts array" },
      { status: 400 },
    );
  }

  // Validate accounts shape — accept optional loginCustomerId for manager-routed accounts
  const validAccounts = accounts.filter(
    (a: unknown): a is { id: string; name: string; loginCustomerId?: string } => {
      if (typeof a !== "object" || a === null || !("id" in a)) return false;
      return typeof (a as Record<string, unknown>).id === "string";
    },
  );

  if (validAccounts.length === 0) {
    return NextResponse.json(
      { error: "No valid accounts provided" },
      { status: 400 },
    );
  }

  // Identity from Supabase; connection row is the source of truth for
  // refreshToken + candidate accounts.
  const identity = await identifyUser({ source: "select-account" });
  if (!identity) {
    return NextResponse.json(
      { error: "No active session found" },
      { status: 401 },
    );
  }

  const conn = await loadGoogleConnection(identity.userId);
  if (!conn) {
    // Phase-1 backfill should ensure every live user has a connection row.
    // A missing row here means either a backfill gap or a brand-new user
    // who somehow reached this route before the callback's connection
    // upsert ran. Either way: cannot proceed without a refresh token.
    return NextResponse.json(
      { error: "No Google Ads connection found. Reconnect at /connect." },
      { status: 404 },
    );
  }

  // Verify all selected account IDs are accessible AND resolve loginCustomerId
  // for any manager-routed selections.
  //
  // For pending signups (multi-account picker): the OAuth callback stored a
  // pre-validated list (with loginCustomerId per account) in
  // ad_platform_connections.account_ids — trust that.
  //
  // For existing sessions (account switcher / add-account flow): re-query
  // the user's connectable accounts (which expands managers into their
  // clients) so we can validate manager-routed picks too.
  //
  // `pendingToken` is now an OPTIONAL signal (post-step-2) that this is a
  // fresh-signup multi-account flow. The legacy path verified it as an
  // mcp_sessions.access_token; we now infer "pending" from the connection's
  // missing `activeAccountId`.
  const isPending = !!pendingToken || !conn.customerId;

  type AuthorizedAccount = { id: string; name: string; loginCustomerId?: string };
  let authorized: AuthorizedAccount[];

  if (isPending && conn.customerIds.length > 0) {
    authorized = conn.customerIds.map((a) => ({
      id: a.id,
      name: a.name,
      // Strip nulls so the AuthorizedAccount shape stays loginCustomerId?: string.
      ...(typeof a.loginCustomerId === "string" ? { loginCustomerId: a.loginCustomerId } : {}),
    }));
  } else {
    const { accounts } = await listConnectableAccounts(conn.refreshToken);
    authorized = accounts.map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.loginCustomerId ? { loginCustomerId: a.loginCustomerId } : {}),
    }));
  }

  const authorizedById = new Map(authorized.map((a) => [a.id, a]));
  const inaccessible = validAccounts.filter((a) => !authorizedById.has(a.id));
  if (inaccessible.length > 0) {
    return NextResponse.json(
      {
        error: isPending
          ? `Account(s) not in authorized set: ${inaccessible.map((a) => a.id).join(", ")}`
          : `Account(s) not accessible: ${inaccessible.map((a) => a.id).join(", ")}`,
      },
      { status: 403 },
    );
  }

  // Keep the current primary account if it remains selected; otherwise use the first selected account.
  const primaryAccount =
    validAccounts.find((account) => account.id === conn.customerId) ??
    validAccounts[0];

  // Per-account loginCustomerId — always read from server-side authorized data,
  // never trust the request body (a forged loginCustomerId could let a user act
  // as a manager they don't have access to). Persisting it per-account here is
  // what lets `authForAccount` swap the manager context per tool call, so a
  // single session can mix direct-access and manager-routed accounts.
  const customerIds = JSON.stringify(
    validAccounts.map((a) => {
      const authorized = authorizedById.get(a.id);
      return {
        id: a.id,
        name: a.name || "",
        loginCustomerId: authorized?.loginCustomerId ?? null,
      };
    }),
  );

  await upsertGoogleConnection({
    userId: identity.userId,
    refreshToken: conn.refreshToken,
    activeAccountId: primaryAccount.id,
    accountIds: validAccounts.map((a) => ({
      id: a.id,
      name: a.name || "",
      loginCustomerId: authorizedById.get(a.id)?.loginCustomerId ?? null,
    })),
  });

  // Snapshot account budget/info for dev dashboard (runs after response is sent).
  // Use the server-authorized customerIds JSON so MCC-routed accounts keep loginCustomerId.
  const selectedAccounts = parseCustomerIds(customerIds);
  after(async () => {
    syncAccountSnapshots(conn.refreshToken, selectedAccounts).catch((err) => {
      console.error("[sync-account] Failed to snapshot on select:", err);
    });
    syncCampaignBenchmarkSnapshots(conn.refreshToken, selectedAccounts, { days: 7 }).catch((err) => {
      console.error("[benchmark-snapshots] Failed to backfill on select:", err);
    });
  });

  // First-signup detection: pre-step-2 we used `pendingToken && !session.customerId`.
  // Post-step-2 we use the connection's prior `activeAccountId`. New signups have
  // no active account yet (callback writes the candidate set with activeAccountId=null
  // for multi-account flows; single-account flows pre-set it).
  const isNewSignup = !conn.customerId;

  // Multi-account signups go through this route rather than the auth callback's
  // single-account path, so fire user_signed_up here — otherwise PostHog misses
  // every multi-account signup entirely (17% of signups as of Apr 2026).
  // UTMs and signup_referrer were written to Supabase user_metadata by the
  // callback before branching; read them back so attribution is preserved.
  let redditConversionPayload: RedditConversionInput | null = null;

  // Captured outside the try block so the cookie set + Google Ads upload
  // below can reference them even if the trackServerEvent path threw.
  // Initialize email from `identity.googleEmail` (already validated upstream)
  // so a Supabase outage inside the try doesn't blackhole the conversion —
  // we'll upgrade to `user.email` once we have it.
  let signupEmail: string | null = identity.googleEmail ?? null;
  let signupGclid: string | null = null;

  if (isNewSignup) {
    try {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      const meta = (user?.user_metadata ?? {}) as Record<string, string | undefined>;
      const attribution = sanitizeAttribution(meta);
      const latestPaidTouch = sanitizePaidTouch({
        version: 1,
        utm_source: meta.paid_source,
        utm_medium: meta.paid_medium,
        utm_campaign: meta.paid_campaign,
        utm_term: meta.paid_term,
        utm_content: meta.paid_content,
        gclid: meta.paid_gclid,
        fbclid: meta.paid_fbclid,
        rdt_cid: meta.paid_rdt_cid,
        twclid: meta.paid_twclid,
        first_landing_url: meta.paid_landing_url,
        first_landing_path: meta.paid_landing_path,
        attribution_captured_at: meta.paid_captured_at,
      }) ?? sanitizePaidTouch(meta);
      signupEmail = user?.email ?? identity.googleEmail ?? null;
      signupGclid = latestPaidTouch?.gclid ?? meta.gclid ?? null;
      await recordUserAttribution({
        userId: identity.userId,
        email: user?.email ?? null,
        signupMethod: "google_oauth",
        attribution,
        paidTouch: latestPaidTouch,
        attributionSource: attribution ? "select_account_metadata" : "select_account_missing",
      });
      const clientIp = getClientIp(request);
      trackServerEvent(identity.userId, "user_signed_up", {
        ...attributionToUserMetadata(attribution),
        ...paidTouchToUserMetadata(latestPaidTouch),
        google_email: user?.email ?? identity.googleEmail,
        signup_method: "google_oauth",
        ...(clientIp ? { $ip: clientIp } : {}),
      });

      redditConversionPayload = {
        trackingType: "SignUp",
        conversionId: randomUUID(),
        email: user?.email ?? identity.googleEmail,
        externalId: identity.userId,
        ipAddress: clientIp ?? null,
        userAgent: request.headers.get("user-agent"),
        valueDecimal: 1.0,
        currency: "USD",
      };
    } catch (err) {
      console.error("[select-account] Failed to fire user_signed_up:", err);
    }
  }

  // New signups land in auto mode by default so NotFair starts working
  // immediately instead of dropping users on passive setup docs.
  // Existing users keep the account-management confirmation path.
  const response = NextResponse.json({
    redirectUrl: `${getAppOrigin()}${isNewSignup ? next : GOOGLE_ADS_CONNECTED_PATH}`,
  });
  if (isNewSignup) {
    const xConversionId = buildXSignupConversionId(identity.userId);
    // 600s TTL — single-fire is enforced by clear-on-fire in the tracker,
    // not the TTL. Tight TTLs drop conversions when hydration is slow.
    response.cookies.set("gads_new_signup", "1", { path: "/", maxAge: 600 });
    response.cookies.set(X_SIGNUP_ID_COOKIE, xConversionId, { path: "/", maxAge: 600 });
    if (signupEmail) {
      // Enhanced Conversions for Leads — gtag.js hashes locally before send.
      response.cookies.set("gads_signup_email", signupEmail, {
        path: "/",
        maxAge: 600,
      });
    }
    after(
      maybeFireGoogleAdsSignup({
        userId: identity.userId,
        email: signupEmail,
        gclid: signupGclid,
      }),
    );
  }
  if (redditConversionPayload) {
    response.cookies.set(REDDIT_SIGNUP_ID_COOKIE, redditConversionPayload.conversionId, {
      path: "/",
      maxAge: 600,
    });
    after(sendRedditConversion(redditConversionPayload));
    after(
      sendTiktokSignupConversion({
        eventId: redditConversionPayload.conversionId,
        email: redditConversionPayload.email ?? null,
        externalId: redditConversionPayload.externalId ?? null,
        ipAddress: redditConversionPayload.ipAddress ?? null,
        userAgent: request.headers.get("user-agent"),
        pageUrl: `${getAppOrigin()}/auth/callback`,
        valueDecimal: 1.0,
        currency: "USD",
      }),
    );
  }
  response.cookies.set(
    "gads_connect_event",
    JSON.stringify({
      count: validAccounts.length,
      first: !!isNewSignup,
      destination: isNewSignup ? next : "/connect/google-ads",
    }),
    { path: "/", maxAge: 120 },
  );
  return response;
}
