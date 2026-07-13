import { NextResponse } from "next/server";
import { auth, ensureAuthSchema } from "@/server/auth";
import { getDb, getDbPath } from "@/server/db/db";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";

export async function GET() {
  const results: Record<string, unknown> = {};
  const errorLog: string[] = [];

  const capture = (label: string, fn: () => unknown) => {
    try {
      results[label] = fn();
    } catch (e) {
      results[label] = `ERROR: ${e}`;
      errorLog.push(`${label}: ${e}`);
    }
  };

  const captureAsync = async (label: string, fn: () => Promise<unknown>) => {
    try {
      results[label] = await fn();
    } catch (e) {
      results[label] = `ERROR: ${e}`;
      errorLog.push(`${label}: ${e}`);
    }
  };

  capture("db_path", getDbPath());
  capture("home", homedir());
  capture("DATA_DIR", join(homedir(), ".notfair-cmo"));
  capture("dir_exists", existsSync(join(homedir(), ".notfair-cmo")));
  capture("db_exists", existsSync(getDbPath()));

  await captureAsync("ensureAuthSchema", async () => {
    await ensureAuthSchema();
    return "ok";
  });

  await captureAsync("auth_context", async () => {
    const ctx = await auth.$context;
    return { hasAdapter: !!ctx.adapter, hasRateLimit: !!ctx.rateLimit };
  });

  capture("db_test", () => {
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM user").get();
    return row;
  });

  // Try to create a user directly
  await captureAsync("direct_user_create", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
      VALUES (?, ?, ?, 0, ?, ?, 'admin')`).run(id, "direct_test", `direct_${Date.now()}@test.com`, now, now);
    return { id, email: "direct_...@test.com" };
  });

  results.env = {
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ? "set" : "missing",
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ? "set" : "missing",
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL ? "set" : "missing",
  };

  if (errorLog.length > 0) results.errors = errorLog;
  return NextResponse.json(results);
}
