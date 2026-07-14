/**
 * Returns the base URL for MCP API endpoints.
 *
 * Since MCP routes are served at /api/mcp/* on the SAME origin as the app,
 * we use window.location.origin on the client side and fall back to localhost
 * for server-side / SSR. No build-time env var needed.
 *
 * For server-side rendering, this reads BETTER_AUTH_URL from the env, or
 * falls back to localhost:3326 for local development.
 */
export function getMcpBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return (
    process.env.NEXT_PUBLIC_MCP_BASE_URL ||
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL ||
    process.env.BETTER_AUTH_URL ||
    "http://localhost:3326"
  );
}

/** Build a full MCP resource URL from a path like "/api/mcp/google_ads". */
export function mcpUrl(path: string): string {
  const base = getMcpBaseUrl().replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
