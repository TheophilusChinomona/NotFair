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
    return new Response(JSON.stringify({ error: "Internal server error", details: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
