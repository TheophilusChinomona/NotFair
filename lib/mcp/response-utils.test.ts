import { describe, expect, it } from "vitest";
import { isSchemaRequest } from "./response-utils";

function mcpRequest(method: string): Request {
  return new Request("https://www.notfair.co/api/mcp/google_ads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  });
}

describe("response-utils — schema request detection", () => {
  it("allows unauthenticated MCP discovery requests, including public resources", async () => {
    for (const method of ["initialize", "tools/list", "resources/list", "resources/read"]) {
      const { schemaOnly, cloned } = await isSchemaRequest(mcpRequest(method));
      expect(schemaOnly, `${method} should bypass auth for discovery`).toBe(true);
      await expect(cloned.json()).resolves.toMatchObject({ method });
    }
  });

  it("does not treat tool calls as schema-only discovery", async () => {
    const { schemaOnly } = await isSchemaRequest(mcpRequest("tools/call"));
    expect(schemaOnly).toBe(false);
  });
});
