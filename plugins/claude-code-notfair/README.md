# NotFair Claude Code Plugin

Claude Code plugin package for NotFair's hosted Google Ads MCP server.

## What this package is

This is the reviewer/distribution-ready Claude Code plugin skeleton for NotFair Google Ads workflows. It gives Claude Code skill instructions for using the hosted NotFair Google Ads MCP endpoint safely.

- MCP endpoint: `https://notfair.co/api/mcp/google_ads`
- Connector name: `NotFair-GoogleAds`
- Review packet: `https://notfair.co/claude-connector-review-packet.txt`
- Full LLM corpus: `https://notfair.co/llms-full.txt`

## Install path

Until an official Claude Code marketplace listing is live, users can connect the remote MCP server directly:

```bash
claude mcp add NotFair-GoogleAds --transport http https://notfair.co/api/mcp/google_ads
```

Then authorize Google Ads through NotFair:

```text
https://notfair.co/connect
```

## Safety model

- Reads can run after OAuth.
- Writes must be proposed first and executed only after explicit user approval.
- Executed writes are logged with operation provenance and undo/reversal metadata where supported.
- Never ask users to paste Google Ads API credentials, developer tokens, refresh tokens, or private account secrets into Claude Code.

## Submission checklist

1. Confirm plugin schema against the current Claude Code plugin docs before marketplace submission.
2. Confirm the hosted MCP endpoint works from a fresh Claude Code install.
3. Record the reviewer demo: connect account → audit wasted spend → propose negatives → approval gate → execute.
4. Submit this package plus `https://notfair.co/claude-connector-review-packet.txt`.
5. After listing approval, update marketing copy to say the plugin is discoverable in Claude Code. Do not claim official availability before approval.
