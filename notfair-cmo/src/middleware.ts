import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {

  // E2E test mode — skip session validation entirely
  if (process.env.E2E_TEST === "1") {
    return NextResponse.next();
  }
  const { pathname } = request.nextUrl;

  // Skip assets, auth API routes, public endpoints, and bearer-authed MCP routes
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/static") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".svg") ||
    pathname === "/favicon.ico" ||
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/mcp") ||
    pathname.startsWith("/api/mcp-oauth") ||
    pathname.startsWith("/api/oauth") ||
    pathname === "/api/version" ||
    pathname === "/api/auth-status"
  ) {
    return NextResponse.next();
  }

  // Validate the session via the /api/auth/get-session endpoint
  try {
    const res = await fetch(`${request.nextUrl.origin}/api/auth/get-session`, {
      headers: { cookie: request.headers.get("cookie") ?? "" },
      // Mirror the original request's IP/forwarded headers for logging
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.session) {
      return NextResponse.next();
    }
  } catch {
    // Network failure — fail-closed, redirect to login
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("callbackUrl", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!api/auth|api/mcp|api/mcp-oauth|api/oauth|api/auth-status|_next/static|_next/image|favicon.ico).*)",
  ],
};
