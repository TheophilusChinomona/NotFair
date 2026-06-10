import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { setLastAttemptEmailCookie, setProfileCookie } from "@/lib/auth-cookies";
import { refreshGoogleConnectionCredentials, upsertGoogleConnection } from "@/lib/connections/google";
import { loadGoogleConnection } from "@/lib/connections/google-read";
import { recordUserAttribution } from "@/lib/db/attribution";
import { db, schema } from "@/lib/db";
import { listConnectableAccounts, syncAccountSnapshots, syncCampaignBenchmarkSnapshots, type ConnectableAccount } from "@/lib/google-ads";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin } from "@/lib/app-url";
import { trackServerEvent, flushServerEvents } from "@/lib/analytics-server";
import { REDDIT_SIGNUP_ID_COOKIE, sendRedditConversion } from "@/lib/reddit-capi";
import { sendTiktokSignupConversion } from "@/lib/tiktok-capi";
import { maybeFireGoogleAdsSignup } from "@/lib/google-ads-signup";
import { buildXSignupConversionId, X_SIGNUP_ID_COOKIE } from "@/lib/x-signup";
import { getClientIp } from "@/lib/request-ip";
import {
  UTM_KEYS,
  attributionToUserMetadata,
  paidTouchToUserMetadata,
  parsePaidTouchCookie,
  sanitizeAttribution,
  sanitizePaidTouch,
  type FirstTouchAttribution,
  type PaidTouchAttribution,
  type UtmParams,
} from "@/lib/utm";
import { verifyOAuthNonce } from "@/lib/oauth-nonce";
import { AUTH_ERROR_REASON, AUTH_ERROR_STEP, AUTH_ERROR_MESSAGES, classifyAccountLoadError, classifyGoogleError } from "@/lib/auth-errors";
import { evaluateScopeGrant } from "@/lib/oauth-scope-retry";
import { DEFAULT_ACTIVATION_PATH, safeInternalPathOrDefault } from "@/lib/app-routes";

type AuthState = {
  next?: string;
  popup?: boolean;
  utm?: UtmParams;
  scope_retry?: boolean;
  signup_referrer?: string;
  attribution?: FirstTouchAttribution;
  latest_paid_touch?: PaidTouchAttribution;
};

function getSafeNext(next: string | null | undefined) {
  return safeInternalPathOrDefault(next, DEFAULT_ACTIVATION_PATH);
}

/**
 * Decode the OAuth state param and verify it's legitimate.
 * Primary check: nonce matches the cookie (standard CSRF protection).
 * Fallback: if the cookie was lost (browser privacy settings), verify the
 * nonce against the server-side store (single-use, auto-expiring).
 */
async function verifyState(stateParam: string | null, cookieNonce: string | undefined): Promise<AuthState | null> {
  if (!stateParam) return null;

  try {
    const parsed = JSON.parse(Buffer.from(stateParam, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.nonce) return null;

    // Primary: cookie nonce match
    let verified = false;
    if (cookieNonce && parsed.nonce === cookieNonce) {
      verified = true;
    }

    // Fallback: server-side nonce verification (handles missing cookies)
    if (!verified) {
      verified = await verifyOAuthNonce(parsed.nonce);
      if (verified) {
        console.log("[auth/callback] State verified via server-side nonce (cookie was missing)");
      }
    }

    if (!verified) return null;

    // Extract UTM params if present
    let utm: UtmParams | undefined;
    if (parsed.utm && typeof parsed.utm === "object") {
      const raw = parsed.utm as Record<string, unknown>;
      const cleaned: UtmParams = {};
      for (const key of UTM_KEYS) {
        if (typeof raw[key] === "string") cleaned[key] = raw[key];
      }
      if (Object.keys(cleaned).length > 0) utm = cleaned;
    }

    return {
      next: typeof parsed.next === "string" ? parsed.next : undefined,
      popup: typeof parsed.popup === "boolean" ? parsed.popup : undefined,
      scope_retry: parsed.scope_retry === true ? true : undefined,
      signup_referrer: typeof parsed.signup_referrer === "string" ? parsed.signup_referrer : undefined,
      utm,
      attribution:
        parsed.attribution && typeof parsed.attribution === "object"
          ? sanitizeAttribution(parsed.attribution as Record<string, unknown>) ?? undefined
          : undefined,
      latest_paid_touch:
        parsed.latest_paid_touch && typeof parsed.latest_paid_touch === "object"
          ? sanitizePaidTouch(parsed.latest_paid_touch as Record<string, unknown>) ?? undefined
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Redirect to /connect with a reason code. Connect-page renders copy keyed
 * by reason — keep English out of the URL so it's stable across i18n,
 * shareable in support tickets, and refresh-safe. The optional `message`
 * is a backwards-compat fallback for old links and unmapped reasons.
 *
 * `no_accounts` and `no_client_accounts` route to /manage-ads-accounts so
 * the user can pick a platform (different Google identity, Meta, etc.)
 * instead of being stuck on a Google-Ads-only empty state.
 */
function redirectWithError(origin: string, reason: string, message?: string) {
  if (reason === "no_accounts" || reason === "no_client_accounts") {
    return NextResponse.redirect(`${origin}/manage-ads-accounts`);
  }
  const params = new URLSearchParams({ reason });
  if (message) params.set("error", message);
  return NextResponse.redirect(`${origin}/connect?${params.toString()}`);
}

function describeError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  // gRPC / Google Ads errors are sometimes plain objects
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.details === "string") return obj.details;
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      const first = obj.errors[0];
      if (typeof first?.message === "string") return first.message;
    }
  }

  return "Unknown error";
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function popupPostMessage(origin: string, payload: Record<string, unknown>) {
  return new NextResponse(
    `<!DOCTYPE html><html><body><script>
      if (window.opener) { window.opener.postMessage(${safeJsonForScript(payload)}, ${safeJsonForScript(origin)}); }
      window.close();
    </script></body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}

function popupErrorResponse(origin: string, message: string) {
  return popupPostMessage(origin, {
    type: "GOOGLE_ADS_AUTH_ERROR",
    error: message,
  });
}

function popupAccountSelectionResponse(
  accounts: ConnectableAccount[],
  pendingToken: string,
  origin: string,
  next: string,
) {
  const accountsJson = safeJsonForScript(accounts);
  const pendingTokenJson = safeJsonForScript(pendingToken);
  const originJson = safeJsonForScript(origin);
  const nextJson = safeJsonForScript(next);

  return new NextResponse(
    `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; background: #09090b; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { max-width: 380px; width: 100%; padding: 24px; text-align: center; }
    h2 { font-size: 20px; margin-bottom: 8px; }
    p { color: #a1a1aa; font-size: 14px; margin-bottom: 16px; }
    .group { margin-bottom: 16px; text-align: left; }
    .group-header { display: flex; align-items: center; gap: 6px; margin: 12px 4px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #a1a1aa; }
    .group-header.manager { color: #c4c0b6; }
    .badge { display: inline-block; padding: 2px 6px; background: #27272a; border-radius: 6px; font-size: 10px; font-weight: 500; color: #d4d4d8; text-transform: none; letter-spacing: 0; }
    .account { display: flex; align-items: center; gap: 12px; width: 100%; padding: 14px 16px; margin-bottom: 8px; background: #18181b; border: 1px solid #27272a; border-radius: 12px; color: #fff; text-align: left; cursor: pointer; font-size: 14px; transition: all 0.15s; }
    .account:hover { background: #27272a; border-color: #3f3f46; }
    .account.selected { border-color: #22c55e; background: #052e16; }
    .account input[type="checkbox"] { width: 18px; height: 18px; accent-color: #22c55e; cursor: pointer; flex-shrink: 0; }
    .account-info { flex: 1; min-width: 0; }
    .name { font-weight: 600; }
    .id { color: #71717a; font-size: 12px; font-family: monospace; margin-top: 4px; }
    .connect-btn { display: block; width: 100%; padding: 14px; margin-top: 16px; background: #fff; color: #000; border: none; border-radius: 9999px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .connect-btn:hover:not(:disabled) { background: #e4e4e7; }
    .connect-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .count { color: #a1a1aa; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Select accounts</h2>
    <p>Which Google Ads accounts do you want to manage?</p>
    <div id="accounts"></div>
    <div class="count" id="count"></div>
    <button class="connect-btn" id="connectBtn" disabled>Connect</button>
  </div>
  <script>
    const accounts = ${accountsJson};
    const pendingToken = ${pendingTokenJson};
    const origin = ${originJson};
    const next = ${nextJson};
    const selected = new Set();

    function updateUI() {
      const btn = document.getElementById('connectBtn');
      const count = document.getElementById('count');
      btn.disabled = selected.size === 0;
      btn.textContent = selected.size === 0 ? 'Connect' : 'Connect ' + selected.size + ' account' + (selected.size > 1 ? 's' : '');
      count.textContent = selected.size > 0 ? selected.size + ' of ' + accounts.length + ' selected' : '';
      document.querySelectorAll('.account').forEach(el => {
        const id = el.dataset.id;
        el.classList.toggle('selected', selected.has(id));
        el.querySelector('input').checked = selected.has(id);
      });
    }

    if (!window.opener) { document.querySelector('p').textContent = 'This page must be opened from the app.'; }
    else {
      const container = document.getElementById('accounts');

      // Group accounts: direct first, then by manager
      const groups = new Map();
      for (const a of accounts) {
        const key = a.loginCustomerId || '__direct__';
        const label = a.loginCustomerId ? a.loginCustomerName || ('Manager ' + a.loginCustomerId) : 'Direct access';
        if (!groups.has(key)) groups.set(key, { label, isManager: !!a.loginCustomerId, accounts: [] });
        groups.get(key).accounts.push(a);
      }

      for (const [, group] of groups) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'group';

        const header = document.createElement('div');
        header.className = 'group-header' + (group.isManager ? ' manager' : '');
        if (group.isManager) {
          const labelText = document.createElement('span');
          labelText.textContent = 'Via manager:';
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = group.label;
          header.appendChild(labelText);
          header.appendChild(badge);
        } else {
          header.textContent = group.label;
        }
        groupDiv.appendChild(header);

        group.accounts.forEach(a => {
          const div = document.createElement('div');
          div.className = 'account';
          div.dataset.id = a.id;
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          const info = document.createElement('div');
          info.className = 'account-info';
          const nameDiv = document.createElement('div');
          nameDiv.className = 'name';
          nameDiv.textContent = a.name || 'Untitled account';
          const idDiv = document.createElement('div');
          idDiv.className = 'id';
          idDiv.textContent = a.id;
          info.appendChild(nameDiv);
          info.appendChild(idDiv);
          div.appendChild(cb);
          div.appendChild(info);
          div.onclick = (e) => {
            if (e.target === cb) return;
            cb.checked = !cb.checked;
            if (cb.checked) selected.add(a.id); else selected.delete(a.id);
            updateUI();
          };
          cb.onchange = () => {
            if (cb.checked) selected.add(a.id); else selected.delete(a.id);
            updateUI();
          };
          groupDiv.appendChild(div);
        });

        container.appendChild(groupDiv);
      }

      document.getElementById('connectBtn').onclick = () => {
        const selectedAccounts = accounts.filter(a => selected.has(a.id));
        window.opener.postMessage({
          type: "GOOGLE_ADS_AUTH_SUCCESS",
          pendingToken,
          next,
          accounts: selectedAccounts.map(a => ({ id: a.id, name: a.name })),
          customerId: selectedAccounts[0].id,
          customerName: selectedAccounts[0].name,
        }, origin);
        window.close();
      };
    }
  </script>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}

/**
 * Mint an "ads-less" mcp_sessions row + cookie for a user who completed
 * Google OAuth (with the adwords scope) but has no Google Ads customer to
 * connect — either because the Google identity isn't linked to any Ads
 * account, or because their only path was a manager (MCC) with no clients.
 *
 * The row carries the user's refresh token, so when they later create an
 * Ads account on this same Google identity, /manage-ads-accounts/google-ads can
 * reuse the credentials without forcing another OAuth round-trip.
 *
 * The session is loadable by getSession() (with `pendingSetup: true`) but
 * getSessionAuth() and getAuthContext() still throw — Google-Ads-dependent
 * routes bounce back to /connect, which is the right behavior for a user
 * who hasn't picked an Ads customer yet.
 */
async function mintAdsLessSession({
  refreshToken,
  userId,
  googleEmail,
}: {
  refreshToken: string;
  userId: string | null;
  googleEmail: string | null;
}) {
  // No Supabase userId means there's nothing to anchor identity to —
  // pathological path (signInWithIdToken would normally produce one).
  // The user has no session anchor; nothing to persist.
  if (!userId) return;

  await upsertGoogleConnection({
    userId,
    refreshToken,
    activeAccountId: null,
    accountIds: [],
    googleEmail,
  });
}

async function isFirstGoogleAdsSignup(userId: string | null): Promise<boolean> {
  if (!userId) return false;

  const [mcpRows, connectionRows] = await Promise.all([
    db()
      .select({ id: schema.mcpSessions.id })
      .from(schema.mcpSessions)
      .where(eq(schema.mcpSessions.userId, userId))
      .limit(1),
    db()
      .select({ id: schema.adPlatformConnections.id })
      .from(schema.adPlatformConnections)
      .where(eq(schema.adPlatformConnections.userId, userId))
      .limit(1),
  ]);

  return mcpRows.length === 0 && connectionRows.length === 0;
}

function markGoogleAdsSignup(response: NextResponse, isFirstSignup: boolean, googleEmail: string | null) {
  if (!isFirstSignup) return;

  // 600s TTL: hydration/network can be slow on first render, and the cookie
  // clear-on-fire path is what guarantees single-fire — not the TTL.
  response.cookies.set("gads_new_signup", "1", { path: "/", maxAge: 600 });
  if (googleEmail) {
    // Enhanced Conversions for Leads: gtag.js hashes this locally before
    // sending. Same-domain, same TTL as the signup sentinel.
    response.cookies.set("gads_signup_email", googleEmail, {
      path: "/",
      maxAge: 600,
    });
  }
}

async function createOrRedirectGoogleAdsSession({
  origin,
  userId,
  googleEmail,
  refreshToken,
  popup,
  next,
}: {
  origin: string;
  userId: string | null;
  googleEmail: string | null;
  refreshToken: string;
  popup: boolean;
  next: string;
}) {
  const isFirstSignup = await isFirstGoogleAdsSignup(userId);
  let connectable;

  try {
    connectable = await listConnectableAccounts(refreshToken);
  } catch (error) {
    console.error("[auth] Failed to load Google Ads accounts:", error);
    const raw = describeError(error);
    const msg = classifyAccountLoadError(raw);
    const reason =
      msg === AUTH_ERROR_MESSAGES.SCOPE_INSUFFICIENT
        ? AUTH_ERROR_REASON.SCOPE_DENIED
        : msg === AUTH_ERROR_MESSAGES.NO_ACCOUNTS
          ? "no_accounts"
          : "load_accounts_failed";
    if (popup) return popupErrorResponse(origin, msg);
    const response = redirectWithError(origin, reason);
    if (reason === "no_accounts") {
      setLastAttemptEmailCookie(response, googleEmail);
      // Mint an ads-less session so the user can choose to continue into the
      // app (set up Claude/MCP, connect Meta later, or come back when they
      // have a Google Ads account on this identity). Without this, they'd
      // hit /connect with no session and have nothing to do but retry OAuth.
      await mintAdsLessSession({ refreshToken, userId, googleEmail });
      markGoogleAdsSignup(response, isFirstSignup, googleEmail);
    }
    return response;
  }

  const usableAccounts = connectable.accounts;
  const hasManager = connectable.managers.length > 0;

  if (usableAccounts.length === 0) {
    const msg = hasManager
      ? AUTH_ERROR_MESSAGES.NO_CLIENT_ACCOUNTS
      : AUTH_ERROR_MESSAGES.NO_ACCOUNTS;
    const reason = hasManager ? "no_client_accounts" : "no_accounts";
    if (popup) return popupErrorResponse(origin, msg);
    const response = redirectWithError(origin, reason);
    setLastAttemptEmailCookie(response, googleEmail);
    // Same rationale as the catch branch above — mint an ads-less session
    // so the user can keep using NotFair while they sort out Ads access.
    await mintAdsLessSession({ refreshToken, userId, googleEmail });
    markGoogleAdsSignup(response, isFirstSignup, googleEmail);
    return response;
  }

  if (usableAccounts.length === 1) {
    const account = usableAccounts[0];
    // Emit loginCustomerId explicitly (string | null) so authForAccount can
    // distinguish "direct" from "manager-routed" for this entry.
    const accountIds = [
      { id: account.id, name: account.name || "", loginCustomerId: account.loginCustomerId ?? null },
    ];

    if (!userId) {
      // Pathological — signInWithIdToken normally produces a userId. With no
      // Supabase identity to anchor on, nothing to persist; fall through to
      // an error redirect.
      return redirectWithError(origin, "session_error", "Missing user identity after sign-in.");
    }

    await upsertGoogleConnection({
      userId,
      refreshToken,
      activeAccountId: account.id,
      accountIds,
      googleEmail,
    });

    // Snapshot account budget/info for dev dashboard (runs after response is sent).
    after(async () => {
      syncAccountSnapshots(refreshToken, [
        { id: account.id, loginCustomerId: account.loginCustomerId ?? null },
      ]).catch((err) => {
        console.error("[sync-account] Failed to snapshot on connect:", err);
      });
      syncCampaignBenchmarkSnapshots(refreshToken, [
        { id: account.id, loginCustomerId: account.loginCustomerId ?? null },
      ], { days: 7 }).catch((err) => {
        console.error("[benchmark-snapshots] Failed to backfill on connect:", err);
      });
    });

    if (popup) {
      const response = popupPostMessage(origin, {
        type: "GOOGLE_ADS_AUTH_SUCCESS",
        customerId: account.id,
        customerName: account.name || "Google Ads Account",
        redirectUrl: `${origin}${next}`,
        ...(googleEmail ? { googleEmail } : {}),
      });
      markGoogleAdsSignup(response, isFirstSignup, googleEmail);
      response.cookies.set(
        "gads_connect_event",
        JSON.stringify({ count: 1, first: isFirstSignup, destination: next }),
        { path: "/", maxAge: 120 },
      );
      return response;
    }

    const response = NextResponse.redirect(`${origin}${next}`);
    markGoogleAdsSignup(response, isFirstSignup, googleEmail);
    response.cookies.set(
      "gads_connect_event",
      JSON.stringify({ count: 1, first: isFirstSignup, destination: next }),
      { path: "/", maxAge: 120 },
    );
    return response;
  }

  // Pre-validated accounts stored on the connection row so /api/auth/select-account
  // can verify the user's pick without a second round-trip to Google. Always
  // emit loginCustomerId explicitly (string | null) so authForAccount has a
  // clean signal for direct vs manager-routed instead of guessing from key
  // absence.
  const accountsList = usableAccounts.map((account) => ({
    id: account.id,
    name: account.name,
    loginCustomerId: account.loginCustomerId ?? null,
  }));

  if (!userId) {
    return redirectWithError(origin, "session_error", "Missing user identity after sign-in.");
  }

  await upsertGoogleConnection({
    userId,
    refreshToken,
    // Pending — user hasn't picked yet. accountIds carries the candidate
    // set so /api/auth/select-account can validate the pick off the
    // connection row directly.
    activeAccountId: null,
    accountIds: accountsList,
    googleEmail,
  });

  if (popup) {
    // The selection page identifies the user via Supabase and reads
    // candidates off ad_platform_connections.accountIds.
    return popupAccountSelectionResponse(usableAccounts, "", origin, next);
  }

  // Land new users on /manage-ads-accounts so they can pick a platform
  // (Google or Meta) before being routed to the Google picker. Supabase
  // carries identity; candidate accounts come from the connection row.
  const nextParam = next !== "/connect" ? `?next=${encodeURIComponent(next)}` : "";
  return NextResponse.redirect(
    `${origin}/manage-ads-accounts${nextParam}`,
  );
}

async function reuseExistingSession({
  origin,
  userId,
  googleEmail,
  refreshToken,
  popup,
  next,
}: {
  origin: string;
  userId: string | null;
  googleEmail: string | null;
  refreshToken: string;
  popup: boolean;
  next: string;
}) {
  if (!userId) {
    return null;
  }

  const conn = await loadGoogleConnection(userId);
  if (!conn || !conn.customerId) return null;

  await refreshGoogleConnectionCredentials({
    userId,
    refreshToken,
    googleEmail,
  });

  if (conn.customerIds.length > 0) {
    after(async () => {
      const accounts = conn.customerIds.map((a) => ({
        id: a.id,
        loginCustomerId: a.loginCustomerId ?? null,
      }));
      syncAccountSnapshots(refreshToken, accounts).catch((err) => {
        console.error("[sync-account] Failed to snapshot on reuse:", err);
      });
      syncCampaignBenchmarkSnapshots(refreshToken, accounts, { days: 7 }).catch((err) => {
        console.error("[benchmark-snapshots] Failed to backfill on reuse:", err);
      });
    });
  }

  if (popup) {
    const activeAccount = conn.customerIds.find((a) => a.id === conn.customerId);
    return popupPostMessage(origin, {
      type: "GOOGLE_ADS_AUTH_SUCCESS",
      customerId: conn.customerId,
      customerName: activeAccount?.name || "Google Ads Account",
      redirectUrl: `${origin}${next}`,
    });
  }

  return NextResponse.redirect(`${origin}${next}`);
}

export async function GET(request: Request) {
  // Flush PostHog events after the response ships — keeps the Lambda alive
  // long enough for trackServerEvent()'s async POST to complete. Fires for
  // every return path including the early auth_error redirects.
  after(flushServerEvents);

  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const explicitNext = searchParams.get("next");
  const stateParam = searchParams.get("state");

  if (code && !stateParam) {
    const supabaseCallback = new URL("/auth/supabase/callback", origin);
    supabaseCallback.searchParams.set("code", code);
    if (explicitNext) supabaseCallback.searchParams.set("next", explicitNext);
    return NextResponse.redirect(supabaseCallback);
  }

  // Verify the OAuth state nonce matches the cookie to prevent CSRF
  const cookieStore = await cookies();
  const cookieNonce = cookieStore.get("oauth_nonce")?.value;
  const state = await verifyState(stateParam, cookieNonce);
  if (!state) {
    const reason = !stateParam ? "missing_state" : !cookieNonce ? "missing_cookie" : "nonce_mismatch";
    console.error(`[auth/callback] State verification failed: ${reason}`, {
      hasState: !!stateParam,
      hasCookie: !!cookieNonce,
    });
    trackServerEvent(null, "auth_error", { reason, step: AUTH_ERROR_STEP.STATE_VERIFICATION });
    return NextResponse.redirect(`${origin}/login?error=auth_failed&reason=${reason}`);
  }

  const popup = state.popup === true || searchParams.get("popup") === "1";
  const next = getSafeNext(state.next ?? explicitNext);

  // Check if Google returned an error (e.g. user clicked Cancel on consent screen)
  const googleError = searchParams.get("error");
  if (googleError) {
    const reason = classifyGoogleError(googleError);
    console.error(`[auth/callback] Google OAuth error: ${googleError}`);
    trackServerEvent(null, "auth_error", { reason, step: AUTH_ERROR_STEP.GOOGLE_CONSENT, google_error: googleError });
    return popup
      ? popupErrorResponse(origin, AUTH_ERROR_MESSAGES.CONSENT_DENIED)
      : NextResponse.redirect(`${origin}/login?error=auth_failed&reason=${reason}`);
  }

  if (!code) {
    console.error("[auth/callback] Missing code param in callback URL");
    trackServerEvent(null, "auth_error", { reason: AUTH_ERROR_REASON.MISSING_CODE, step: AUTH_ERROR_STEP.CODE_CHECK });
    return popup
      ? popupErrorResponse(origin, "Authentication failed. Missing code.")
      : NextResponse.redirect(`${origin}/login?error=auth_failed&reason=missing_code`);
  }

  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const redirectUri = `${getAppOrigin()}/auth/callback`;

  if (!clientId || !clientSecret) {
    console.error("[auth/callback] Missing GOOGLE_ADS_CLIENT_ID or CLIENT_SECRET env vars");
    return popup
      ? popupErrorResponse(origin, "Server misconfiguration: missing Google OAuth credentials.")
      : NextResponse.redirect(`${origin}/login?error=auth_failed&reason=server_config`);
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenResponse.json();

  if (
    !tokenResponse.ok ||
    tokenData.error ||
    !tokenData.refresh_token ||
    !tokenData.id_token
  ) {
    const message =
      tokenData.error_description ||
      tokenData.error ||
      "Failed to complete Google authentication";
    console.error("[auth/callback] Token exchange failed:", {
      status: tokenResponse.status,
      error: tokenData.error,
      error_description: tokenData.error_description,
      hasRefreshToken: !!tokenData.refresh_token,
      hasIdToken: !!tokenData.id_token,
    });
    trackServerEvent(null, "auth_error", { reason: AUTH_ERROR_REASON.TOKEN_EXCHANGE, step: AUTH_ERROR_STEP.TOKEN_EXCHANGE, error: tokenData.error });
    return popup
      ? popupErrorResponse(origin, message)
      : NextResponse.redirect(`${origin}/login?error=auth_failed&reason=token_exchange`);
  }

  // Verify the adwords scope was actually granted (Google granular permissions
  // let users uncheck individual scopes on the consent screen). Decision logic
  // is in lib/oauth-scope-retry.ts so it can be unit-tested without standing
  // up Next/Supabase/Google.
  const scopeDecision = evaluateScopeGrant({
    grantedScopesParam: typeof tokenData.scope === "string" ? tokenData.scope : undefined,
    hasScopeRetry: state.scope_retry === true,
    origin,
    next,
    popup,
  });

  if (scopeDecision.outcome === "retry") {
    console.log("[auth/callback] Ads scope denied — auto-retrying once");
    trackServerEvent(null, "auth_error", { reason: AUTH_ERROR_REASON.SCOPE_DENIED_RETRY, step: AUTH_ERROR_STEP.SCOPE_CHECK, is_retry: false });
    const retryResponse = NextResponse.redirect(scopeDecision.retryUrl);
    retryResponse.cookies.set("oauth_nonce", "", { maxAge: 0, path: "/" });
    return retryResponse;
  }

  if (scopeDecision.outcome === "fail") {
    console.error("[auth/callback] Ads scope denied after retry");
    trackServerEvent(null, "auth_error", { reason: AUTH_ERROR_REASON.SCOPE_DENIED, step: AUTH_ERROR_STEP.SCOPE_CHECK, is_retry: true });
    const msg = AUTH_ERROR_MESSAGES.SCOPE_DENIED;
    const scopeResponse = popup
      ? popupErrorResponse(origin, msg)
      : redirectWithError(origin, AUTH_ERROR_REASON.SCOPE_DENIED);
    scopeResponse.cookies.set("oauth_nonce", "", { maxAge: 0, path: "/" });
    return scopeResponse;
  }

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.signInWithIdToken({
    provider: "google",
    token: tokenData.id_token,
    access_token: tokenData.access_token,
  });

  if (authError) {
    console.error("[auth/callback] Supabase sign-in failed:", authError);
    trackServerEvent(null, "auth_error", { reason: AUTH_ERROR_REASON.SUPABASE_AUTH, step: AUTH_ERROR_STEP.SUPABASE_SIGNIN, error: authError.message });
    return popup
      ? popupErrorResponse(origin, "Failed to establish app session.")
      : NextResponse.redirect(`${origin}/login?error=auth_failed&reason=supabase_auth`);
  }

  const user = authData.user ?? authData.session?.user ?? null;

  // Save first-touch attribution data to user metadata on first sign-up.
  // Keep this first-write only: later re-auth should not rewrite acquisition.
  const latestPaidTouch = state.latest_paid_touch ?? parsePaidTouchCookie(request.headers.get("cookie"));
  const attributionMetadata = {
    ...attributionToUserMetadata(state.attribution),
    ...(state.utm ?? {}),
    ...(state.signup_referrer ? { signup_referrer: state.signup_referrer } : {}),
  };
  const paidTouchMetadata = paidTouchToUserMetadata(latestPaidTouch);
  if (user && (Object.keys(attributionMetadata).length > 0 || Object.keys(paidTouchMetadata).length > 0)) {
    const existingMeta = user.user_metadata ?? {};
    const metadataUpdate = {
      ...(!existingMeta.attribution_captured_at && !existingMeta.utm_source && !existingMeta.signup_referrer
        ? attributionMetadata
        : {}),
      ...(!existingMeta.paid_captured_at && !existingMeta.paid_source && !existingMeta.paid_twclid
        ? paidTouchMetadata
        : {}),
    };
    if (Object.keys(metadataUpdate).length > 0) {
      await supabase.auth.updateUser({
        data: metadataUpdate,
      });
    }
  }
  if (user?.id) {
    await recordUserAttribution({
      userId: user.id,
      email: user.email ?? null,
      signupMethod: "google_oauth",
      attribution: state.attribution ?? null,
      paidTouch: latestPaidTouch,
      attributionSource: state.attribution ? "oauth_state" : "oauth_state_missing",
    });
  }

  let response: NextResponse;

  try {
    // Popup connects are account-management flows. Do not short-circuit on the
    // previous selected account; list accounts from the new OAuth grant so the
    // user can actually change/select accounts.
    const reusedResponse = popup ? null : await reuseExistingSession({
      origin,
      userId: user?.id ?? null,
      googleEmail: user?.email ?? null,
      refreshToken: tokenData.refresh_token,
      popup,
      next,
    });

    response = reusedResponse ?? await createOrRedirectGoogleAdsSession({
      origin,
      userId: user?.id ?? null,
      googleEmail: user?.email ?? null,
      refreshToken: tokenData.refresh_token,
      popup,
      next,
    });
  } catch (sessionError) {
    console.error("[auth/callback] Failed to create Google Ads session:", sessionError);
    response = popup
      ? popupErrorResponse(origin, describeError(sessionError))
      : redirectWithError(origin, "session_error", describeError(sessionError));
  }

  // Track signup event with UTM attribution in PostHog
  const isNewSignup = response.cookies.get("gads_new_signup")?.value === "1";
  if (isNewSignup && user?.id) {
    // request.headers.get("referer") is useless here (always accounts.google.com
    // because OAuth redirected through it) — state.signup_referrer carries the
    // real marketing referrer captured before the OAuth bounce.
    const clientIp = getClientIp(request);
    trackServerEvent(user.id, "user_signed_up", {
      ...attributionMetadata,
      ...paidTouchMetadata,
      google_email: user.email,
      signup_method: "google_oauth",
      ...(clientIp ? { $ip: clientIp } : {}),
    });

    const conversionId = randomUUID();
    const xConversionId = buildXSignupConversionId(user.id);
    response.cookies.set(REDDIT_SIGNUP_ID_COOKIE, conversionId, { path: "/", maxAge: 600 });
    response.cookies.set(X_SIGNUP_ID_COOKIE, xConversionId, { path: "/", maxAge: 600 });
    after(
      sendRedditConversion({
        trackingType: "SignUp",
        conversionId,
        email: user.email ?? null,
        externalId: user.id,
        ipAddress: clientIp ?? null,
        userAgent: request.headers.get("user-agent"),
        valueDecimal: 1.0,
        currency: "USD",
      }),
    );

    // Server-side Google Ads signup conversion — catches signups where the
    // browser pixel fails (ITP, ad blockers, slow hydration). Source of truth
    // for the Smart Bidding signal; the browser-side WEBPAGE action is now
    // observation-only (primary_for_goal=false).
    after(
      maybeFireGoogleAdsSignup({
        userId: user.id,
        email: user.email ?? null,
        gclid: latestPaidTouch?.gclid ?? state.attribution?.gclid ?? null,
      }),
    );
    after(
      sendTiktokSignupConversion({
        eventId: conversionId,
        email: user.email ?? null,
        externalId: user.id,
        ipAddress: getClientIp(request) ?? null,
        userAgent: request.headers.get("user-agent"),
        pageUrl: `${origin}/auth/callback`,
        valueDecimal: 1.0,
        currency: "USD",
      }),
    );
  }

  // Clear the one-time OAuth nonce cookie
  response.cookies.set("oauth_nonce", "", { maxAge: 0, path: "/" });

  // Stash display name + avatar in a small dedicated cookie. The Supabase
  // user object only exists for this request — without the profile cookie
  // we'd need to round-trip to Supabase Auth on every render to surface
  // user_metadata in the navbar.
  if (user) {
    const meta = user.user_metadata as
      | { full_name?: string; name?: string; avatar_url?: string; picture?: string }
      | undefined;
    setProfileCookie(response, {
      name: meta?.full_name ?? meta?.name ?? null,
      picture: meta?.avatar_url ?? meta?.picture ?? null,
    });
  }

  return response;
}
