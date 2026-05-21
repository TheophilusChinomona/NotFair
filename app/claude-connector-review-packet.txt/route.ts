import { MCP_CONNECTOR_NAME, MCP_SERVER_URL, SUPPORT_EMAIL } from "@/lib/brand";
import { absoluteUrl, SITE_URL } from "@/lib/seo";

export const dynamic = "force-static";

function buildClaudeConnectorReviewPacket(): string {
  return `# NotFair Claude Connector Review Packet

Product: NotFair
Website: ${SITE_URL}
Support contact: ${SUPPORT_EMAIL}
Recommended connector name: ${MCP_CONNECTOR_NAME}
Remote MCP URL: ${MCP_SERVER_URL}
Privacy policy: ${absoluteUrl("/privacy")}
Terms of service: ${absoluteUrl("/terms")}

## Summary

NotFair is a hosted Google Ads MCP server for Claude, Claude Code, Claude Web/Cowork, and other MCP-compatible clients. It lets an authenticated user ask Claude to read live Google Ads data, diagnose wasted spend, propose optimizations, and execute campaign changes only after explicit user approval.

## OAuth flow

1. User chooses to connect NotFair from Claude or from ${absoluteUrl("/connect")}.
2. NotFair starts a hosted OAuth flow with Google.
3. User signs in with Google and grants Google Ads access.
4. NotFair stores the resulting account connection server-side and binds future MCP sessions to the authenticated NotFair user.
5. Claude calls the remote MCP endpoint at ${MCP_SERVER_URL}; the endpoint enforces authentication and account-level authorization before returning data or accepting operations.

## Required Google scopes

- openid
- email
- profile
- https://www.googleapis.com/auth/adwords

The Google Ads scope is needed because the product reads account/campaign data and can execute user-approved Google Ads operations. NotFair does not ask users to paste raw Google Ads API credentials or developer tokens into Claude.

## Read behavior

Read operations can run directly after authentication. Examples include account inventory, campaign performance, search terms, keywords, conversion diagnostics, impression share, budgets, bids, change history, and configuration checks. Read responses include freshness/staleness context where available so Claude can avoid presenting stale numbers as current.

## Write behavior

Write-capable tools are intentionally gated. Examples include adding negative keywords, pausing/enabling campaigns or keywords, changing bids or budgets, creating ads, and other state-changing Google Ads operations. Claude may propose these changes, but execution requires explicit user approval through the NotFair operation flow before the mutation is sent to Google Ads.

## Approval-gated writes

NotFair separates proposal from execution. The agent can generate a recommended operation with rationale and expected impact; the user reviews the proposed operation; only approved operations are executed. This reduces reviewer risk because the connector is not a silent autonomous campaign mutator.

## Audit log and undo metadata

Executed operations are logged with operation provenance, including operation IDs, timestamps, user/agent context, target account/campaign resources, and before/after or undo metadata where supported. The goal is traceable, inspectable, reversible ads work rather than opaque AI side effects.

## Privacy and data handling

Customer ad-account data is used to provide the requested analysis and operations. Public policy: ${absoluteUrl("/privacy")}. Terms: ${absoluteUrl("/terms")}.

## Reviewer demo video script

Title: Connect account → audit wasted spend → propose negatives → approval gate → execute

1. Open ${absoluteUrl("/connect")} and connect a Google Ads account through OAuth.
2. Add a Claude custom connector named ${MCP_CONNECTOR_NAME} with remote URL ${MCP_SERVER_URL}.
3. Ask Claude: "Audit my Google Ads account and identify the top wasted-spend opportunities."
4. Show Claude reading live account/campaign/search-term data through NotFair.
5. Ask Claude: "Propose negative keywords for the worst irrelevant queries, but don't execute yet."
6. Show NotFair returning proposed operations and rationale without mutating the account.
7. Approve one operation.
8. Show the operation result, audit/provenance metadata, and undo/reversal metadata where available.

## Test account / sandbox path

For public safety, this packet does not include shared test credentials. Reviewers can request a sandbox path or time-boxed reviewer access via ${SUPPORT_EMAIL}. The preferred review flow is a dedicated Google Ads test account connected through the normal OAuth path, then exercising read tools and a low-risk approval-gated write.

## Primary setup and product pages

- Claude connector setup: ${absoluteUrl("/google-ads-claude-connector-setup-guide")}
- Claude Code plugin setup: ${absoluteUrl("/google-ads-claude-code-plugin-setup-guide")}
- Google Ads MCP: ${absoluteUrl("/google-ads-mcp")}
- Integrations hub: ${absoluteUrl("/integrations")}
- llms.txt: ${absoluteUrl("/llms.txt")}
- llms-full.txt: ${absoluteUrl("/llms-full.txt")}
`;
}

export function GET() {
  return new Response(buildClaudeConnectorReviewPacket(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
