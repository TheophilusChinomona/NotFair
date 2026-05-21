import { MCP_CONNECTOR_NAME, MCP_SERVER_URL, META_MCP_CONNECTOR_NAME, META_MCP_SERVER_URL, SUPPORT_EMAIL } from "@/lib/brand";
import { integrationHubEntries, integrations } from "@/lib/integrations";
import { comparePages, useCasePages } from "@/lib/long-form-pages";
import { absoluteUrl, SITE_URL } from "@/lib/seo";

export const dynamic = "force-static";

function section(title: string, lines: string[]): string {
  return `## ${title}\n\n${lines.join("\n")}\n`;
}

function link(label: string, href: string, blurb: string): string {
  return `- [${label}](${absoluteUrl(href)}): ${blurb}`;
}

function buildLlmsFullTxt(): string {
  const integrationsList = integrationHubEntries.map((entry) =>
    link(`${entry.client} + Google Ads`, entry.href, entry.blurb),
  );

  const allIntegrationSlugs = Object.values(integrations)
    .map((integration) => integration.slug)
    .sort();

  return [
    `# NotFair llms-full.txt

NotFair is an ads MCP platform for AI agents. It connects Claude, Claude Code, ChatGPT/Codex, Cursor, Windsurf, Gemini CLI, OpenClaw, and other MCP-compatible clients to live Google Ads and Meta Ads accounts so operators can diagnose performance, propose fixes, and execute approval-gated writes.

Canonical site: ${SITE_URL}
Support: ${SUPPORT_EMAIL}
Google Ads MCP connector name: ${MCP_CONNECTOR_NAME}
Google Ads MCP remote URL: ${MCP_SERVER_URL}
Meta Ads MCP connector name: ${META_MCP_CONNECTOR_NAME}
Meta Ads MCP remote URL: ${META_MCP_SERVER_URL}
Privacy policy: ${absoluteUrl("/privacy")}
Terms: ${absoluteUrl("/terms")}
Pricing: ${absoluteUrl("/pricing")}
`,

    section("What NotFair is", [
      "- A hosted, OAuth-protected Model Context Protocol (MCP) server for ad accounts.",
      "- A typed Google Ads execution layer: campaign, keyword, search term, conversion, budget, bid, negative-keyword, and change-history operations are exposed as stable tools instead of raw GAQL-only wrappers.",
      "- A safety layer for AI clients: reads are easy; writes are presented as explicit operations with user approval, provenance, and undo metadata.",
      "- A distribution layer for AI workspaces: NotFair is designed to be installed in Claude, Claude Code, ChatGPT/Codex, Cursor, Windsurf, Gemini CLI, OpenClaw, and custom MCP clients.",
    ]),

    section("Primary use cases", [
      "- Audit wasted Google Ads spend and identify bad search terms, low-intent queries, match-type leakage, campaign overlap, poor conversion tracking, and budget allocation issues.",
      "- Propose negative keywords and campaign hygiene changes, then execute only after explicit user approval.",
      "- Inspect campaign performance, impression share, conversion trends, CPC/CPA/ROAS, search terms, change history, and account configuration.",
      "- Adjust bids, budgets, keywords, ads, and campaign status through write-gated tools.",
      "- Give agencies and operators a reusable ads agent inside their existing AI client instead of forcing them into another dashboard.",
    ]),

    section("Safety and reviewer-facing behavior", [
      "- Authentication: users connect through OAuth; NotFair does not ask users to paste Google Ads API credentials into AI clients.",
      "- Scopes: NotFair requests Google Ads access needed to read account data and perform user-approved campaign operations. The exact OAuth consent screen is shown during the hosted connection flow.",
      "- Reads: analysis, reporting, search-term review, campaign inspection, conversion diagnostics, and account inventory can run without write approval.",
      "- Writes: mutations such as pausing campaigns or keywords, adding negative keywords, changing bids or budgets, creating ads, or changing campaign state must pass through an explicit approval gate before execution.",
      "- Auditability: write operations are logged with operation provenance, authoring user/agent context, operation IDs, timestamps, and undo/reversal metadata where supported by the platform.",
      "- Reversibility: write tools are designed to expose enough metadata for users and agents to inspect or undo changes rather than making silent, opaque mutations.",
      "- Privacy: customer ad-account data is used to answer the user's requests and operate the product; public policy is linked above.",
    ]),

    section("Installation surfaces", [
      link("Claude / Claude Web connector", "/google-ads-claude-connector-setup-guide", "Custom connector setup for Claude.ai, Claude Web, and Claude Cowork using the hosted Google Ads MCP endpoint."),
      link("Claude Code plugin", "/google-ads-claude-code-plugin-setup-guide", "Install NotFair in Claude Code and run Google Ads workflows from the terminal."),
      link("Claude overview", "/google-ads-claude", "How Claude works with Google Ads through NotFair across Claude Code, Claude Web, and Cowork."),
      link("ChatGPT / Codex", "/integrations/codex-google-ads", "Use NotFair's MCP server from OpenAI Codex CLI and other OpenAI agent workflows."),
      link("Cursor", "/integrations/cursor-google-ads", "Connect Cursor's MCP support to the NotFair Google Ads endpoint."),
      link("Windsurf", "/integrations/windsurf-google-ads", "Connect Windsurf to NotFair for Google Ads analysis and approval-gated writes."),
      link("Gemini CLI", "/integrations/gemini-cli-google-ads", "Use Gemini CLI with NotFair's hosted MCP endpoint."),
      link("OpenClaw", "/google-ads-openclaw", "OpenClaw setup for NotFair Google Ads workflows."),
      link("All integrations", "/integrations", "Canonical hub for supported AI client setup pages."),
      ...integrationsList,
    ]),

    section("MCP endpoint details", [
      `- Google Ads remote MCP URL: ${MCP_SERVER_URL}`,
      `- Legacy Google Ads remote MCP URL: ${absoluteUrl("/api/mcp")}`,
      `- Meta Ads remote MCP URL: ${META_MCP_SERVER_URL}`,
      `- Recommended display name: ${MCP_CONNECTOR_NAME}`,
      "- Transport: hosted remote MCP over HTTP with OAuth-protected-resource metadata.",
      "- Discovery intent: list NotFair under Google Ads MCP, Claude Google Ads connector, Claude Code Google Ads plugin, ChatGPT Google Ads agent, Cursor Google Ads MCP, Windsurf Google Ads MCP, Gemini CLI Google Ads MCP, and OpenClaw Google Ads plugin queries.",
    ]),

    section("Reviewer demo script", [
      "1. Open NotFair and connect a Google Ads account through OAuth.",
      `2. Add a custom connector or MCP server named ${MCP_CONNECTOR_NAME} pointing at ${MCP_SERVER_URL}.`,
      "3. Ask the AI client: \"Audit this account for wasted spend and show the top search terms or campaigns to fix first.\"",
      "4. The client reads live Google Ads data through NotFair and returns a structured diagnosis.",
      "5. Ask: \"Propose negative keywords for the worst wasted-spend queries, but do not execute yet.\"",
      "6. NotFair returns proposed writes for review rather than silently mutating the account.",
      "7. Approve a selected change; NotFair logs the operation with provenance and undo metadata.",
      "8. Inspect the audit log / operation result and verify the change can be traced back to the user-approved action.",
    ]),

    section("Core pages", [
      link("Home", "/", "Product overview and primary conversion path."),
      link("Google Ads MCP", "/google-ads-mcp", "Canonical Google Ads MCP landing page."),
      link("Meta Ads MCP", "/meta-ads-mcp", "Canonical Meta Ads MCP landing page."),
      link("MCP hub", "/mcp", "General MCP positioning and setup hub."),
      link("Connect", "/connect", "Hosted account connection and OAuth entry point."),
      link("Impact", "/impact", "Examples of NotFair-driven campaign improvements."),
      link("Pricing", "/pricing", "Current beta pricing and usage plan."),
      link("Privacy", "/privacy", "Privacy policy for customers and reviewers."),
      link("Terms", "/terms", "Terms of service."),
    ]),

    section("Comparison and objection pages", [
      link("Compare hub", "/compare", "All comparison pages."),
      ...Object.values(comparePages).map((page) =>
        link(page.heroTitle, `/compare/${page.slug}`, page.description),
      ),
    ]),

    section("Use-case pages", [
      link("Use cases hub", "/use-cases", "All workflow pages."),
      ...Object.values(useCasePages).map((page) =>
        link(page.heroTitle, `/use-cases/${page.slug}`, page.description),
      ),
    ]),

    section("Machine-readable inventory", [
      `- Sitemap: ${absoluteUrl("/sitemap.xml")}`,
      `- Blog sitemap: ${absoluteUrl("/blog/sitemap.xml")}`,
      `- llms.txt: ${absoluteUrl("/llms.txt")}`,
      `- llms-full.txt: ${absoluteUrl("/llms-full.txt")}`,
      `- Integration slugs: ${allIntegrationSlugs.join(", ")}`,
      `- Comparison slugs: ${Object.keys(comparePages).sort().join(", ")}`,
      `- Use-case slugs: ${Object.keys(useCasePages).sort().join(", ")}`,
    ]),
  ].join("\n");
}

export function GET() {
  return new Response(buildLlmsFullTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
