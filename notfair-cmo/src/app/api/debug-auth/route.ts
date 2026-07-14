import { NextResponse } from "next/server";
import { auth, ensureAuthSchema } from "@/server/auth";
import { getDb } from "@/server/db/db";
import { toNextJsHandler } from "better-auth/next-js";

export const runtime = "nodejs";

export async function GET() {
  const results: Record<string, unknown> = {};
  const db = getDb();

  // 1. Schema check  
  results.schema = db.prepare("PRAGMA table_info('user')").all();

  // 2. Check if there's a user count  
  const count = (db.prepare("SELECT COUNT(*) as n FROM \"user\"").get() as { n: number }).n;
  results.user_count = count;

  // 3. Clean up any test users from earlier tests
  db.prepare("DELETE FROM \"user\" WHERE email LIKE 'test_%@example.com' OR email LIKE 'direct_%@test.com' OR name = 'direct_test' OR email = 'test@example.com'").run();
  results.cleaned_up = true;

  // 4. Check the Better Auth handler with a mock request
  try {
    const handler = toNextJsHandler(auth);
    const testEmail = `test_${Date.now()}@example.com`;
    
    const req = new Request("http://localhost:3326/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Debug User",
        email: testEmail,
        password: "Debug123!",
        confirmPassword: "Debug123!",
      }),
    });

    const resp = await handler.POST(req);
    results.better_auth_status = resp.status;
    results.better_auth_body = await resp.text().catch(() => "(empty)");
    results.better_auth_headers = Object.fromEntries(resp.headers.entries());
  } catch (e) {
    results.better_auth_error = String(e);
  }

  // 5. Check env AFTER loading
  results.env = {
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || "(unset)",
    HAS_SECRET: !!process.env.BETTER_AUTH_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  };

  return NextResponse.json(results);
}
