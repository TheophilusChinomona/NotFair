import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { mcpRpc } from "../src/server/mcp/rpc";

async function main() {
  const url = "https://notfair.co/api/mcp/google_search_console";
  const token = "oat_search_console_57e4434aa4b5d119a90fa501bcc228174fadf6d7cbeb396e468889f63259898b";

  console.log("Listing GSC MCP tools...");
  const listResult = await mcpRpc<{ tools: Array<{ name: string; description: string }> }>(
    url,
    token,
    "tools/list",
    {}
  );

  if (!listResult.ok) {
    console.error("Failed to list tools:", listResult);
    return;
  }

  console.log("Available tools:");
  for (const tool of listResult.result.tools) {
    console.log(`- ${tool.name}: ${tool.description}`);
  }
}

main().catch(console.error);
