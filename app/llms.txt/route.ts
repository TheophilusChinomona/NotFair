import { SUPPORT_EMAIL } from "@/lib/brand";
import { integrationHubEntries, integrations } from "@/lib/integrations";
import { comparePages, useCasePages } from "@/lib/long-form-pages";
import { absoluteUrl, SITE_URL } from "@/lib/seo";

export const dynamic = "force-static";

function section(title: string, lines: string[]): string {
  return `## ${title}\n\n${lines.join("\n")}\n`;
}

function listItem(label: string, href: string, blurb: string): string {
  return `- [${label}](${absoluteUrl(href)}): ${blurb}`;
}

function buildLlmsTxt(): string {
  const header = `# NotFair

> NotFair is the Google Ads diagnosis and execution layer for AI agents. Connect a Google Ads account once and any MCP-compatible AI client (Claude, Claude Code, ChatGPT via Codex, Cursor, Windsurf, Gemini CLI, OpenClaw) can read live campaign data, diagnose performance, and ship approval-gated writes.

NotFair is the typed, safety-gated alternative to free Google Ads MCP servers (which are mostly thin GAQL wrappers) and to one-size-fits-all dashboards (which show data but don't reason about it).

Site: ${SITE_URL}
Pricing: ${absoluteUrl("/pricing")} (free during open beta; usage-priced plan planned for teams)
Status of writes: every Google Ads write — bids, negatives, budgets, ad copy, campaign state — passes through an explicit approval gate and is logged with operation provenance and undo metadata.
Contact: ${SUPPORT_EMAIL}
`;

  const productSection = section("Product surfaces", [
    listItem("Home", "/", "Top-level overview and quick start."),
    listItem("MCP server", "/google-ads-mcp", "What the Google Ads MCP server is and how it's structured."),
    listItem("Connect Google Ads", "/connect", "OAuth flow to authorize NotFair on your Google Ads account."),
    listItem("Pricing", "/pricing", "Current beta pricing and roadmap for paid tiers."),
    listItem("Impact", "/impact", "How operators are using NotFair and the kinds of writes it ships."),
  ]);

  const integrationLines = integrationHubEntries.map((entry) =>
    listItem(`${entry.client} + Google Ads`, entry.href, entry.blurb),
  );
  const integrationSection = section(
    "Integrations (AI client × Google Ads)",
    [
      listItem("Integrations hub", "/integrations", "All supported AI clients."),
      ...integrationLines,
    ],
  );

  const compareSection = section(
    "Comparisons & objection content",
    [
      listItem("Compare hub", "/compare", "All comparison pages."),
      ...Object.values(comparePages).map((p) =>
        listItem(p.heroTitle, `/compare/${p.slug}`, p.description),
      ),
    ],
  );

  const useCaseSection = section(
    "Use cases & workflows",
    [
      listItem("Use cases hub", "/use-cases", "All use-case pages."),
      ...Object.values(useCasePages).map((p) =>
        listItem(p.heroTitle, `/use-cases/${p.slug}`, p.description),
      ),
    ],
  );

  const conceptsSection = section("Key concepts", [
    "- **MCP**: Anthropic's Model Context Protocol — the open standard NotFair speaks. Any MCP-compatible client can use NotFair tools.",
    "- **Typed primitives over raw GAQL**: NotFair exposes documented, stable tool calls instead of handing the model raw Google Ads Query Language.",
    "- **Freshness metadata**: every read response carries freshness metadata so the agent knows when to refetch instead of quoting stale numbers.",
    "- **Approval-gated writes**: bids, negatives, budgets, ad copy, campaign state — every mutation goes through an explicit approval step.",
    "- **Operation provenance**: every write is logged with operation_id, the authoring user/agent, and undo metadata.",
    "- **D0 writes / Weekly Active Writers**: NotFair's North Star is operators shipping real Google Ads changes the first day they connect and returning weekly.",
  ]);

  const setupSection = section("Setup at a glance", [
    "1. Authorize Google Ads at notfair.co/connect (one OAuth flow).",
    "2. Add NotFair to your AI client's MCP config. For most clients this is a single JSON block under `mcpServers` pointing at `https://notfair.co/api/mcp/google_ads`.",
    "3. Open your AI client and ask: \"Audit my Google Ads account and tell me the top three wasted-spend issues.\"",
    "",
    "For client-specific setup snippets, see the integration pages linked above.",
    `Expanded LLM corpus: ${absoluteUrl("/llms-full.txt")}`,
    `Claude connector review packet: ${absoluteUrl("/claude-connector-review-packet.txt")}`,
    `Suggested MCP registry metadata: ${absoluteUrl("/mcp-registry-listings.json")}`,
  ]);

  const slugs = Object.values(integrations).map((i) => i.slug);
  const sitemapSection = section("Machine-readable inventory", [
    `Sitemap (XML): ${absoluteUrl("/sitemap.xml")}`,
    `Integrations covered: ${slugs.join(", ")}`,
    `Comparison pages: ${Object.keys(comparePages).join(", ")}`,
    `Use-case pages: ${Object.keys(useCasePages).join(", ")}`,
  ]);

  return [
    header,
    productSection,
    integrationSection,
    compareSection,
    useCaseSection,
    conceptsSection,
    setupSection,
    sitemapSection,
  ].join("\n");
}

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
