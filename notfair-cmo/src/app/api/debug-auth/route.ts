import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { getDb } from "@/server/db/db";
import { toNextJsHandler } from "better-auth/next-js";

export const runtime = "nodejs";

export async function GET() {
  const results: Record<string, unknown> = {};

  try {
    const db = getDb();
    results.user_count = (db.prepare("SELECT COUNT(*) as n FROM \"user\"").get() as { n: number }).n;
    results.tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
  } catch (e) {
    results.db_error = String(e);
  }

  try {
    const ctx = await auth.$context;
    results.has_adapter = !!ctx.adapter;
    // Try to get internal adapter
    const internalAdapter = (ctx as any).internalAdapter;
    results.has_internal_adapter = !!internalAdapter;
  } catch (e) {
    results.context_error = String(e);
  }

  // Try sign-up and catch the actual error
  try {
    const handler = toNextJsHandler(auth);
    const body = JSON.stringify({
      name: "Debug", email: "debug_" + Date.now() + "@test.com",
      password: "Debug123!", confirmPassword: "Debug123!",
    });
    const req = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    // Try to get the raw error by reading the response
    const resp = await handler.POST(req);
    results.signup_status = resp.status;
    results.signup_body = await resp.text().catch(() => "");
    results.signup_ok = resp.ok;
  } catch (e) {
    results.signup_caught = String(e);
    if (e instanceof Error) results.signup_stack = (e.stack || "").split("\n").slice(0, 3);
  }

  results.env = {
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || "(unset)",
    HAS_SECRET: !!process.env.BETTER_AUTH_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  };

  return NextResponse.json(results);
}
