/**
 * Returns the base URL for MCP API endpoints.
 *
 * In production, set NEXT_PUBLIC_MCP_BASE_URL to your app's public origin
 * (e.g. "https://cmo.example.com"). Falls back to BETTER_AUTH_URL, then
 * to "http://localhost:3326" for local development.
 */
export function getMcpBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_MCP_BASE_URL ||
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL ||
    "http://localhost:3326"
  );
}

/** Build a full MCP resource URL from a path like "/api/mcp/google_ads". */
export function mcpUrl(path: string): string {
  const base = getMcpBaseUrl().replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
