import { auth, ensureAuthSchema } from "@/server/auth";
import { toNextJsHandler } from "better-auth/next-js";

const handler = toNextJsHandler(auth);
export const runtime = "nodejs";

export async function GET(req: Request) {
  await ensureAuthSchema();
  return handler.GET(req);
}

export async function POST(req: Request) {
  await ensureAuthSchema();
  return handler.POST(req);
}
