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
    results.schema = db.prepare("PRAGMA table_info('user')").all().length + " columns";
  } catch (e) {
    results.db_error = String(e);
  }

  try {
    const ctx = await auth.$context;
    results.context_ok = true;
    results.has_adapter = !!ctx.adapter;
  } catch (e) {
    results.context_error = String(e);
  }

  try {
    const handler = toNextJsHandler(auth);
    const testEmail = "debug_" + Date.now() + "@test.com";
    const body = JSON.stringify({
      name: "Debug", email: testEmail,
      password: "Debug123!", confirmPassword: "Debug123!",
    });
    const req = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const resp = await handler.POST(req);
    results.signup_status = resp.status;
    results.signup_body = await resp.text().catch(() => "");
  } catch (e) {
    results.handler_error = String(e);
  }

  results.env = {
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ? "set" : "unset",
    HAS_SECRET: !!process.env.BETTER_AUTH_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  };

  return NextResponse.json(results);
}
