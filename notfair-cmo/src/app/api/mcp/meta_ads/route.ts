import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { META_TOOLS } from "@/server/mcp-meta/tools";
import { handleJsonRpc, type JsonRpcRequest } from "@/server/mcp-server/jsonrpc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Standalone MCP server for Meta Ads API tools.
 *
 * Authenticated with the META_ACCESS_TOKEN env var as the Bearer token.
 * All Graph API calls use the same token.
 */

const SERVER_INFO = {
  name: "notfair-meta-ads",
  version: "0.1.0",
  tools: META_TOOLS,
};

function unauthorized(): Response {
  return new NextResponse("Unauthorized", { status: 401 });
}

function bearerFrom(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

function verifyMetaAdToken(presented: string | null): boolean {
  if (!presented) return false;
  const expected = process.env.META_ACCESS_TOKEN ?? "";
  if (!expected) return false;
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(presented, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}

export async function POST(req: Request): Promise<Response> {
  const bearer = bearerFrom(req);
  if (!verifyMetaAdToken(bearer)) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      { status: 200 },
    );
  }

  if (Array.isArray(body)) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Batched requests are not supported by this server.",
        },
      },
      { status: 200 },
    );
  }

  const request = body as JsonRpcRequest;
  if (!request || typeof request !== "object" || request.jsonrpc !== "2.0") {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: (request as Record<string, unknown>)?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      },
      { status: 200 },
    );
  }

  const response = await handleJsonRpc(request, SERVER_INFO);
  if (response === null) {
    return new Response(null, { status: 204 });
  }
  return NextResponse.json(response, { status: 200 });
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    name: SERVER_INFO.name,
    transport: "streamable-http",
    note: "POST JSON-RPC with Bearer auth using META_ACCESS_TOKEN.",
  });
}
