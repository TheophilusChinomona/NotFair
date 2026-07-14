import { NextResponse } from "next/server";
import { auth } from "@/server/auth";

export const runtime = "nodejs";

export async function GET() {
  // Check all env vars that Better Auth uses
  const vars = {
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ? "(set)" : "(unset)",
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_MCP_BASE_URL: process.env.NEXT_PUBLIC_MCP_BASE_URL,
  };

  // Check if Better Auth was initialized with the right baseURL
  // (we can check this by reading the config from the auth object)
  let configInfo: Record<string, unknown> = {};
  try {
    const ctx = await auth.$context;
    configInfo = {
      hasAdapter: !!ctx.adapter,
      adapterName: ctx.adapter?.constructor?.name || "unknown",
      options: {
        baseURL: (ctx as any).options?.baseURL,
        secret: (ctx as any).options?.secret ? "(set)" : "(unset)",
      },
    };
  } catch (e) {
    configInfo = { error: String(e) };
  }

  return NextResponse.json({ env: vars, config: configInfo });
}
