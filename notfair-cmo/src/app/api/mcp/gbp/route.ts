import { NextResponse } from "next/server";
import { handleJsonRpc, type JsonRpcRequest } from "@/server/mcp-server/jsonrpc";
import { verifyMcpServerSecret } from "@/server/mcp-server/secret";
import { GBP_TOOLS } from "@/server/mcp-gbp/tools";

const SERVER_INFO = {
  name: "notfair-gbp",
  version: "0.1.0",
  tools: GBP_TOOLS,
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unauthorized(): Response {
  return new NextResponse("Unauthorized", { status: 401 });
}

function bearerFrom(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

export async function POST(req: Request): Promise<Response> {
  const bearer = bearerFrom(req);
  if (!verifyMcpServerSecret(bearer)) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 200 },
    );
  }

  if (Array.isArray(body)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch not supported" } },
      { status: 200 },
    );
  }

  const request = body as JsonRpcRequest;
  if (!request || typeof request !== "object" || request.jsonrpc !== "2.0") {
    return NextResponse.json(
      { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid Request" } },
      { status: 200 },
    );
  }

  const response = await handleJsonRpc(request, SERVER_INFO);
  if (response === null) return new Response(null, { status: 204 });
  return NextResponse.json(response, { status: 200 });
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    name: SERVER_INFO.name,
    transport: "streamable-http",
    version: SERVER_INFO.version,
    tools: GBP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema.description ?? {},
    })),
  });
}
