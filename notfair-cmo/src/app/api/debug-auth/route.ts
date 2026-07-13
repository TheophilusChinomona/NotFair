import { NextResponse } from "next/server";
import { auth, ensureAuthSchema } from "@/server/auth";

export const runtime = "nodejs";

export async function GET() {
  const results: Record<string, unknown> = {};

  try {
    await ensureAuthSchema();
    results.schema = "ok";
  } catch (e) {
    results.schema = String(e);
  }

  try {
    const ctx = await auth.$context;
    results.context = "resolved";
    results.hasAdapter = !!ctx.adapter;
  } catch (e) {
    results.context = String(e);
  }

  results.env = {
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ? "set" : "missing",
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ? "set" : "missing",
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL ? "set" : "missing",
  };

  return NextResponse.json(results);
}
