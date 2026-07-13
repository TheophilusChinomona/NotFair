import { NextResponse } from "next/server";

import { auth, ensureAuthSchema } from "@/server/auth";
import { toNextJsHandler } from "better-auth/next-js";

const handler = toNextJsHandler(auth);
export const runtime = "nodejs";

export async function GET(req: Request) {
  await ensureAuthSchema();
  return handler.GET(req);
}

export async function POST(req: Request) {
  try {
    await ensureAuthSchema();
    return handler.POST(req);
  } catch (error) {
      console.error("[auth/POST] signup error:", error);
      return NextResponse.json(
        { error: "Signup failed", details: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
  }
}
