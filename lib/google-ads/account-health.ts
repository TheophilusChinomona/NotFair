import { isInvalidGrantError, isScopeError } from "@/lib/auth-errors";
import type { ConnectedAccount } from "./types";

export const CONNECTION_HEALTH_KEY = "__connection__";

export type GoogleAccountHealthErrorLevel = "connection" | "account" | "transient";

export type GoogleAccountHealthEntry = {
  /** Present only on failures. Success entries are derived from lastSuccessAt + no skipUntil. */
  errorLevel?: GoogleAccountHealthErrorLevel;
  lastSuccessAt?: string | null;
  lastFailedAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  /** Null/absent on active routes. Connection-level entries without skipUntil mean skip until reconnect. */
  skipUntil?: string | null;
  consecutiveFailures?: number;
};

export type GoogleAccountHealthMap = Record<string, GoogleAccountHealthEntry>;

export type ClassifiedGoogleBenchmarkError = {
  errorLevel: GoogleAccountHealthErrorLevel;
  code: string;
  message: string;
  skipUntil: string | null;
};

export function normalizeGoogleCustomerId(id: string | null | undefined): string {
  return String(id ?? "").trim().replace(/-/g, "");
}

export function buildAccountHealthKey(
  accountId: string,
  loginCustomerId?: string | null,
): string {
  const normalizedAccountId = normalizeGoogleCustomerId(accountId);
  const normalizedLoginCustomerId = normalizeGoogleCustomerId(loginCustomerId);
  return `${normalizedAccountId}|${normalizedLoginCustomerId || "direct"}`;
}

export function buildRouteKey(
  account: Pick<ConnectedAccount, "id"> & Partial<Pick<ConnectedAccount, "loginCustomerId">>,
): string {
  return buildAccountHealthKey(account.id, account.loginCustomerId ?? null);
}

export function shouldSkipGoogleAccountHealth(
  entry: GoogleAccountHealthEntry | null | undefined,
  now = new Date(),
): boolean {
  if (!entry) return false;
  if (entry.errorLevel === "connection" && !entry.skipUntil) return true;
  if (!entry.skipUntil) return false;
  const skipUntil = Date.parse(entry.skipUntil);
  return Number.isFinite(skipUntil) && skipUntil > now.getTime();
}

export function errorToGoogleBenchmarkMessage(error: unknown): string {
  if (error instanceof Error) {
    const extras = [
      (error as { code?: unknown }).code,
      (error as { status?: unknown }).status,
      (error as { details?: unknown }).details,
      (error as { response?: unknown }).response,
    ]
      .filter((value) => value != null)
      .map((value) => (typeof value === "string" ? value : safeJson(value)))
      .join(" ");
    return `${error.name}: ${error.message}${extras ? ` ${extras}` : ""}`;
  }
  return typeof error === "string" ? error : safeJson(error);
}

export function classifyGoogleBenchmarkError(
  error: unknown,
  now = new Date(),
): ClassifiedGoogleBenchmarkError {
  const message = errorToGoogleBenchmarkMessage(error);
  const lower = message.toLowerCase();

  if (
    isInvalidGrantError(message) ||
    isScopeError(message) ||
    lower.includes("unauthenticated") ||
    lower.includes("authenticationerror") ||
    lower.includes("request had invalid authentication credentials")
  ) {
    return { errorLevel: "connection", code: extractGoogleErrorCode(message, "auth_error"), message, skipUntil: null };
  }

  if (
    lower.includes("deactivated") ||
    lower.includes("not yet enabled") ||
    lower.includes("customer_not_enabled") ||
    lower.includes("customer is not enabled")
  ) {
    return { errorLevel: "account", code: extractGoogleErrorCode(message, "account_deactivated"), message, skipUntil: addDays(now, 30) };
  }

  if (
    lower.includes("login_customer") ||
    lower.includes("login customer") ||
    lower.includes("manager") ||
    lower.includes("client customer")
  ) {
    return { errorLevel: "account", code: extractGoogleErrorCode(message, "login_customer_invalid"), message, skipUntil: addDays(now, 7) };
  }

  if (
    lower.includes("user_permission_denied") ||
    lower.includes("permission_denied") ||
    lower.includes("permission denied") ||
    lower.includes("does not have permission") ||
    lower.includes("the caller does not have permission") ||
    lower.includes("customer not found")
  ) {
    return { errorLevel: "account", code: extractGoogleErrorCode(message, "permission_denied"), message, skipUntil: addDays(now, 7) };
  }

  if (
    lower.includes("rate") ||
    lower.includes("quota") ||
    lower.includes("resource_exhausted") ||
    lower.includes("too many requests") ||
    lower.includes("429") ||
    lower.includes("timeout") ||
    lower.includes("deadline_exceeded") ||
    lower.includes("unavailable") ||
    lower.includes("internal") ||
    lower.includes("econn") ||
    lower.includes("socket") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("500")
  ) {
    return { errorLevel: "transient", code: extractGoogleErrorCode(message, "transient_error"), message, skipUntil: null };
  }

  return { errorLevel: "transient", code: extractGoogleErrorCode(message, "unknown_error"), message, skipUntil: null };
}

export function buildGoogleAccountHealthSuccess(now = new Date()): GoogleAccountHealthEntry {
  return {
    lastSuccessAt: now.toISOString(),
    lastFailedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    skipUntil: null,
    consecutiveFailures: 0,
  };
}

export function buildGoogleAccountHealthFailure(
  previous: GoogleAccountHealthEntry | null | undefined,
  classified: ClassifiedGoogleBenchmarkError,
  now = new Date(),
): GoogleAccountHealthEntry {
  return {
    errorLevel: classified.errorLevel,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastFailedAt: now.toISOString(),
    lastErrorCode: classified.code,
    lastErrorMessage: classified.message.slice(0, 1000),
    skipUntil: classified.skipUntil,
    consecutiveFailures: classified.errorLevel === "transient"
      ? previous?.consecutiveFailures ?? 0
      : (previous?.consecutiveFailures ?? 0) + 1,
  };
}

function addDays(now: Date, days: number) {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractGoogleErrorCode(message: string, fallback: string) {
  const upperToken = message.match(/\b[A-Z][A-Z0-9_]{4,}\b/)?.[0];
  if (upperToken) return upperToken;
  const lowerToken = message.match(/\b[a-z][a-z0-9_]{4,}\b/)?.[0];
  return lowerToken ?? fallback;
}
