import { NextResponse } from "next/server";
import { getDb } from "@/server/db/db";
import { ensureAuthSchema } from "@/server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await ensureAuthSchema();
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number };
  return NextResponse.json({ hasUsers: row.n > 0 });
}
