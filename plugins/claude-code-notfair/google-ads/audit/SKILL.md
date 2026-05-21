---
name: notfair-google-ads-audit
description: Audit a connected Google Ads account through NotFair MCP. Use when the user asks Claude Code to find wasted spend, account structure problems, search-term issues, conversion tracking problems, or campaign performance opportunities.
---

# NotFair Google Ads Audit

Use NotFair's hosted Google Ads MCP server to diagnose a connected account.

## Preconditions

- The MCP server `NotFair-GoogleAds` should point at `https://notfair.co/api/mcp/google_ads`.
- The user must have connected Google Ads through NotFair OAuth.
- If account access is missing, direct the user to `https://notfair.co/connect`.

## Workflow

1. List or confirm the connected Google Ads account.
2. Pull fresh campaign, search-term, keyword, conversion, budget, bid, and change-history data relevant to the user's question.
3. Separate facts from hypotheses. Include date ranges and freshness metadata when available.
4. Prioritize issues by likely wasted spend or impact.
5. Recommend concrete next actions, but do not execute write operations in this audit skill.

## Output

- Top issues, ordered by estimated impact.
- Evidence: metrics, campaign/ad group/search term examples, and date range.
- Recommended fixes.
- Which fixes require approval-gated writes.
