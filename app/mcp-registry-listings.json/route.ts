import { MCP_CONNECTOR_NAME, MCP_SERVER_URL, META_MCP_CONNECTOR_NAME, META_MCP_SERVER_URL } from "@/lib/brand";
import { absoluteUrl } from "@/lib/seo";

export const dynamic = "force-static";

const googleAdsListing = {
  name: "io.github.nowork-studio/notfair",
  title: "NotFair-GoogleAds",
  description:
    "Approval-gated Google Ads MCP for Claude, Claude Code, ChatGPT/Codex, Cursor, Windsurf, Gemini CLI, OpenClaw, and custom agents. Diagnose performance, manage keywords, budgets, bids, negatives, campaigns, and campaign state with logged, reversible writes.",
  websiteUrl: absoluteUrl("/google-ads-mcp"),
  repository: {
    url: "https://github.com/nowork-studio/toprank",
    source: "github",
  },
  remotes: [
    {
      type: "streamable-http",
      url: MCP_SERVER_URL,
    },
  ],
  keywords: [
    "google ads mcp",
    "google ads claude",
    "google ads claude code",
    "google ads chatgpt",
    "google ads codex",
    "google ads cursor",
    "google ads windsurf",
    "google ads gemini cli",
    "google ads openclaw",
    "ppc ai agent",
    "approval-gated writes",
  ],
  suggestedConnectorName: MCP_CONNECTOR_NAME,
  safety:
    "Reads run after OAuth. Writes require explicit user approval and are logged with operation provenance and undo metadata where supported.",
  reviewPacketUrl: absoluteUrl("/claude-connector-review-packet.txt"),
};

const metaAdsListing = {
  name: "io.github.nowork-studio/notfair-meta-ads",
  title: "NotFair-MetaAds",
  description:
    "Approval-gated Meta Ads MCP for Claude and MCP-compatible agents. Analyze Facebook and Instagram ad performance, manage budgets and campaign state, and keep writes explicit, logged, and reviewable.",
  websiteUrl: absoluteUrl("/meta-ads-mcp"),
  repository: {
    url: "https://github.com/nowork-studio/toprank",
    source: "github",
  },
  remotes: [
    {
      type: "streamable-http",
      url: META_MCP_SERVER_URL,
    },
  ],
  keywords: [
    "meta ads mcp",
    "facebook ads mcp",
    "instagram ads mcp",
    "meta ads claude",
    "meta ads ai agent",
    "approval-gated writes",
  ],
  suggestedConnectorName: META_MCP_CONNECTOR_NAME,
  safety:
    "Reads run after OAuth. Writes require explicit user approval and are logged with operation provenance and undo metadata where supported.",
};

export function GET() {
  return Response.json(
    {
      note:
        "Suggested public MCP registry metadata for NotFair distribution surfaces. Use this as the canonical copy source when updating official/community directories.",
      servers: [googleAdsListing, metaAdsListing],
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
      },
    },
  );
}
