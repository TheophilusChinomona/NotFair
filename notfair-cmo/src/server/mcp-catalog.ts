import { getMcpBaseUrl } from "@/lib/mcp-urls";
import { listUserMcpServers } from "@/server/db/user-mcp-servers";
import { getHiddenMcpPresetKeys } from "@/server/db/projects";

export type McpSpec = {
  key: string;
  display_name: string;
  description: string;
  /** HTTPS resource URL the OAuth flow targets. */
  resource_url: string;
  /** RFC 9728 discovery URL. Empty for self-hosted MCPs that use
   *  server-to-server credentials instead of user OAuth. */
  discovery_url: string;
  source: "preset" | "user";
};

const BASE = getMcpBaseUrl();

export const MCP_CATALOG_PRESETS: McpSpec[] = [
  {
    key: "notfair-googleads",
    display_name: "NotFair Google Ads",
    description:
      "Live Google Ads operations: campaigns, bids, budgets, keywords, search terms, change history.",
    resource_url: `${BASE}/api/mcp/google_ads`,
    discovery_url: "", // self-hosted, no user OAuth needed
    source: "preset",
  },
  {
    key: "notfair-metaads",
    display_name: "NotFair Meta Ads",
    description:
      "Live Meta Ads (Facebook + Instagram) operations: campaigns, ad sets, ads, creatives, insights.",
    resource_url: `${BASE}/api/mcp/meta_ads`,
    discovery_url: "", // self-hosted, no user OAuth needed
    source: "preset",
  },
  {
    key: "notfair-googlesearchconsole",
    display_name: "NotFair Google Search Console",
    description:
      "Organic search performance: queries, pages, impressions, clicks, indexing.",
    resource_url: `${BASE}/api/mcp/google_search_console`,
    discovery_url: "", // self-hosted, no user OAuth needed
    source: "preset",
  },
  {
    key: "notfair-gbp",
    display_name: "NotFair Google Business Profile",
    description:
      "Google Business Profile management: accounts, locations, reviews, posts, insights.",
    resource_url: `${BASE}/api/mcp/gbp`,
    discovery_url: "", // self-hosted, no user OAuth needed
    source: "preset",
  },
  {
    key: "notfair-googleanalytics",
    display_name: "NotFair Google Analytics",
    description:
      "GA4 traffic and conversion analytics: sessions, channels, pages, events, audiences.",
    resource_url: `${BASE}/api/mcp/google_analytics`,
    discovery_url: "", // self-hosted, no user OAuth needed
    source: "preset",
  },
  {
    key: "notfair-xads",
    display_name: "NotFair X Ads",
    description:
      "Live X (Twitter) Ads operations: campaigns, line items, promoted posts, analytics.",
    resource_url: `${BASE}/api/mcp/x_ads`,
    discovery_url: "", // self-hosted, no user OAuth needed
    source: "preset",
  },
];

export function isPresetKey(key: string): boolean {
  return MCP_CATALOG_PRESETS.some((p) => p.key === key);
}

export function getMcpPresets(): McpSpec[] {
  return MCP_CATALOG_PRESETS;
}

export function getMcpCatalog(project_slug: string): McpSpec[] {
  const hidden = new Set(getHiddenMcpPresetKeys(project_slug));
  const presets = MCP_CATALOG_PRESETS.filter((p) => !hidden.has(p.key));
  const presetKeys = new Set(presets.map((p) => p.key));
  const userRows = listUserMcpServers(project_slug)
    .filter((row) => !presetKeys.has(row.key))
    .map<McpSpec>((row) => ({
      key: row.key,
      display_name: row.display_name,
      description: row.description,
      resource_url: row.resource_url,
      discovery_url: row.discovery_url,
      source: "user",
    }));
  return [...presets, ...userRows];
}

export function mcpSpecByKey(
  project_slug: string,
  key: string,
): McpSpec | undefined {
  return getMcpCatalog(project_slug).find((m) => m.key === key);
}
