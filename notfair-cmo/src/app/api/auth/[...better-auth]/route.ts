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
    const response = await handler.POST(req);
    // If Better Auth returned an error, log and surface details
    if (!response.ok) {
      const body = await response.text().catch(() => "(empty)");
      console.error("[auth/POST] Better Auth error:", response.status, body);
      return NextResponse.json(
        { error: "Auth service error", status: response.status, details: body },
        { status: response.status },
      );
    }
    return response;
  } catch (error) {
      console.error("[auth/POST] unexpected error:", error);
      return NextResponse.json(
        { error: "Signup failed", details: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
  }
}
