---
name: notfair-google-ads-optimize
description: Turn a NotFair Google Ads audit into a ranked optimization plan. Use when the user wants Claude Code to improve keywords, negatives, bids, budgets, ads, or campaign structure before executing approved changes.
---

# NotFair Google Ads Optimize

Use NotFair MCP reads to produce a concrete optimization plan for Google Ads.

## Rules

- Prefer specific account evidence over generic PPC advice.
- Do not execute mutations in this skill. Prepare proposed operations for review.
- Label each recommendation as read-only, approval-gated write, or manual follow-up.
- Explain tradeoffs: expected impact, confidence, and risk.

## Workflow

1. Start from the user's objective: reduce wasted spend, improve CPA/ROAS, increase qualified volume, fix tracking, or clean structure.
2. Pull the minimum fresh data needed to support the recommendation.
3. Group recommendations by operation type: negatives, bids, budgets, campaign state, ads, landing pages, tracking.
4. Produce an ordered plan that the user can approve step by step.
5. For each write candidate, include target resource, proposed change, rationale, expected impact, and rollback/undo considerations.
