/**
 * HTTP-shaped helpers shared by every MCP route handler. Lifted out of
 * `handler-factory.ts` so the factory can stay focused on auth + telemetry
 * threading. No runtime behavior changes — these helpers are byte-identical
 * to their previous in-factory definitions.
 */

const SCHEMA_METHODS = new Set([
  "initialize",
  "tools/list",
  "resources/list",
  "resources/read",
  "notifications/initialized",
]);

/**
 * Build a 401 response with the RFC 6750 + MCP-spec `WWW-Authenticate` header
 * pointing at the path-aware protected-resource document. Shared by every
 * MCP route handler so a single change here updates the discovery URL for
 * all platforms.
 */
export function buildUnauthorizedResponse(
  request: Request,
  resourceUrlPath: string,
  message: string,
): Response {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const resourceMetadata =
    `${proto}://${host}/.well-known/oauth-protected-resource${resourceUrlPath}`;
  return new Response(
    JSON.stringify({ error: message || "Authentication required" }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
      },
    },
  );
}

/**
 * Configure mcp-handler's URL routing for a given resource path.
 *
 * Two shapes:
 *   - resource path ends in `/mcp` (legacy `/api/mcp`): use `basePath` so
 *     mcp-handler derives `${basePath}/mcp` and `${basePath}/sse`. This
 *     matches the historical `app/api/[transport]/route.ts` setup where the
 *     dynamic `[transport]` segment ("mcp" or "sse") IS the transport name.
 *   - resource path does NOT end in `/mcp` (`/api/mcp/google_ads`): mount
 *     mcp-handler with an explicit `streamableHttpEndpoint` equal to the
 *     resource URL. The route file is a static `route.ts` (no `[transport]`
 *     dynamic). SSE is not exposed for these routes — every modern MCP client
 *     uses streamable-HTTP.
 *
 * `basePath: undefined` is the magic that makes mcp-handler honor the
 * explicit endpoint (the library's default of `""` triggers the derive path).
 */
export function mcpHandlerEndpointConfig(resourceUrlPath: string) {
  if (resourceUrlPath.endsWith("/mcp")) {
    const base = resourceUrlPath.slice(0, -"/mcp".length);
    return { basePath: base.length > 0 ? base : "/", maxDuration: 60 } as const;
  }
  return {
    basePath: undefined,
    streamableHttpEndpoint: resourceUrlPath,
    sseEndpoint: `${resourceUrlPath}/sse`,
    sseMessageEndpoint: `${resourceUrlPath}/message`,
    disableSse: true,
    maxDuration: 60,
  } as const;
}

/**
 * Detects MCP schema-introspection POSTs (initialize, tools/list,
 * notifications/initialized) so the factory can let them through without
 * auth. Returns `cloned` because reading `request.json()` consumes the body
 * and the caller still needs to forward the request to mcp-handler.
 */
export async function isSchemaRequest(
  request: Request,
): Promise<{ schemaOnly: boolean; cloned: Request }> {
  if (request.method !== "POST") return { schemaOnly: false, cloned: request };
  const cloned = request.clone();
  try {
    const body = await request.json();
    const method = body?.method;
    return { schemaOnly: typeof method === "string" && SCHEMA_METHODS.has(method), cloned };
  } catch {
    return { schemaOnly: false, cloned };
  }
}
