---
name: notfair-google-ads-safe-write
description: Execute user-approved Google Ads changes through NotFair MCP. Use only after a user explicitly approves a proposed campaign, keyword, bid, budget, negative keyword, ad, or campaign-state mutation.
---

# NotFair Google Ads Safe Write

Execute Google Ads mutations through NotFair only after explicit user approval.

## Hard rules

- Never execute a write without explicit user approval in the current conversation.
- Never batch unrelated writes into a single vague approval. The user must understand the target, action, and blast radius.
- Before execution, restate the proposed operation: target account/campaign/ad group/resource, exact action, expected impact, and rollback/undo path.
- After execution, report the operation ID, result, affected resources, and undo/reversal metadata where available.

## Workflow

1. Confirm the specific write the user approved.
2. Re-fetch target state if stale or if the change depends on current metrics.
3. Execute the smallest approved operation through NotFair MCP.
4. Verify the result from NotFair's response and, when practical, a follow-up read.
5. Log/report provenance: who approved, what changed, when, operation ID, and undo metadata.

## If approval is ambiguous

Stop and ask for a precise approval. Do not infer approval from a general optimization request.
