---
type: guide
section: architecture
tags: [orchestration, workarounds, linkedin-merge, soql, sparse-data-gate]
description: "Advanced Clay patterns for UI gaps: multiple Find People sources merged in one table, sparse-row enrichment skipping via Object.values length check, and AI-generated SOQL query injection."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Orchestration Workarounds & Advanced Builder Patterns

Advanced Clay patterns for problems the UI doesn't solve natively. These are builder-level workarounds extracted from real SE template tables.

---

## Multiple Trigger-Find-People Sources in One Table

Run `find-people` (PDL) and `find-people-linkedin` (Sales Nav) as separate columns in the same table, then merge results with a formula column. Use when a single Find People source misses too many records. Gate each source independently and merge with `[...arr1, ...arr2].filter(Boolean)`.

---

## Object.values Sparse Data Gate

Before running expensive enrichment on a row, check whether the row already has enough data to be useful:

```javascript
Object.values({{rowData}} || {}).filter(v => v && v !== '').length >= 3
```

Skips enrichment on rows that are mostly empty — saves credits and avoids noisy output.

---

## AI-Generated SOQL Queries

Use a `use-ai` column to generate a SOQL WHERE clause from natural language row data, then pass the output to a Salesforce SOQL action. Pattern: prompt takes company name + domain + industry, outputs valid SOQL snippet. Validate with LIMIT 1 test run before using in production.

**Constraint:** Never use `SELECT *` in SOQL — always name fields explicitly.

---

## Confidence-Based LinkedIn Merge (Best-Signal Selector)

When multiple providers return LinkedIn URLs, don't take the first non-null. Use a formula to pick the highest-confidence result:

```javascript
// Priority order: validated > exact name match > any result
[{{provider_validated}}?.url, {{provider_name_match}}?.url, {{provider_fallback}}?.url]
  .find(v => v && v.includes('linkedin.com/in/'))
```

Always strip query params and normalize to bare `/in/username` format before storing.

---

## Dual SEMrush Credential Rotation

SEMrush API has a per-key rate limit. For high-volume tables, configure two SEMrush API keys as separate HTTP API actions on alternating rows. Use a formula column to pre-assign rows to "credential A" or "credential B" based on row index parity, then run each credential's action only on its assigned rows.

---

## Fan-Out Distribution (Route-Row Pattern)

Send rows to different downstream tables or webhooks based on a classification field:

```javascript
// Routing formula — returns the webhook URL to call
{{classification}} === 'enterprise' ? '{{enterprise_webhook_url}}' 
  : {{classification}} === 'smb' ? '{{smb_webhook_url}}'
  : '{{default_webhook_url}}'
```

Use with an HTTP API action that takes the URL from a formula column. Each route gets specialized enrichment.

---

## exclude_if_true Master Gate

Add a single boolean formula column (`exclude_if_true`) that evaluates the full exclusion logic for a row:

```javascript
// All disqualification conditions in one place
{{is_competitor}} || {{employee_count}} < 10 || !{{has_domain}} || {{already_in_crm}}
```

Gate every expensive enrichment column on `!{{exclude_if_true}}`. Centralizes exclusion logic — change it in one place, all downstream columns pick it up.

---

## Execute-Subroutine Pattern

To run subroutine enrichment only for specific rows, use a formula column to build the subroutine input payload conditionally, then pass to the subroutine action. Gate the subroutine on `{{subroutine_input}} !== null`. This avoids running subroutines on rows that don't need them without requiring a separate filter table.

---

## DQ Flag as Universal Disqualification Signal

After any enrichment that might reveal a disqualifying condition (e.g., company is too small, wrong industry), write a `dq_flag` boolean column. All downstream enrichment columns gate on `!{{dq_flag}}`. This pattern lets disqualification from any source propagate immediately to all subsequent steps without rewriting each gate.

---

## Screenshot + Vision AI Pattern

To extract data from a rendered webpage (not raw HTML):

1. Use `screen-shot-get-page` action → returns screenshot URL
2. Pass screenshot URL to `chat-gpt-vision` (or `use-ai` with vision model) with prompt: "Extract [field] from this screenshot. Return only the value, nothing else."

Use for: pricing pages, org chart PDFs, dashboards, SaaS UI screenshots. More reliable than HTML scraping for visual-layout-dependent data.

---

## Contact Batch Limiting via Google Sheets

When enriching contacts per account, limit to the top N contacts (e.g., 5) to control credit spend. Approach:

1. Enrich-company returns contacts array
2. Formula: `({{contacts}} || []).slice(0, 5)`
3. Pass sliced array to Send Table Data → contact enrichment subroutine

For more granular control, write a Google Sheets row per account with `max_contacts` to allow per-account overrides without rebuilding the table.

---

## HubSpot Create-or-Update Pattern

HubSpot has no native upsert. Implement with two actions:

1. `hubspot-find-contact` (lookup by email) — always runs
2. `hubspot-create-contact` (gate: `!{{lookup_result}}?.id`) — only if not found
3. `hubspot-update-contact` (gate: `{{lookup_result}}?.id`) — only if found, passes ID from lookup

Always pass the HubSpot object ID from the lookup result into the update action — never re-look up in the update step.

---

## SFDC foundAtLeastOne Pattern

When running a Salesforce lookup to check if any matching record exists (without caring which), use a formula column after the lookup:

```javascript
// Returns true if Salesforce returned at least one result
({{sf_lookup}}?.records || []).length > 0
```

Gate downstream create actions on `!{{foundAtLeastOne}}`. Prevents duplicate creation when SOQL returns multiple matches.

---

## Terra Approval Webhook Pattern

For workflows requiring human approval before enrichment continues:

1. Send row to Terra (or any approval tool) via HTTP API with a callback webhook URL
2. Enrichment columns after this step have run conditions that check for the approval response field
3. When Terra sends the approved webhook, Clay auto-updates and re-runs gated columns

The key: include the Clay row ID and table ID in the Terra payload so the callback can target the correct row.

---

## AI Model Comparison: Parallel Columns

To A/B test prompt performance across models without separate tables, run the same prompt as two separate `use-ai` columns with different model values (e.g., `claude-sonnet-4-6` vs `gpt-4.1-mini`). Add a third formula column that evaluates quality (e.g., compares output length, checks for required keywords) and selects the winner.

Use this pattern to validate model selection before committing to one in production.

---

## Related

- [[architecture/index|Architecture]] — table design patterns and pipeline stages
- [[enrichment/waterfalls-advanced|Waterfall Advanced]] — advanced gate patterns
- [[enrichment/credit-optimization-advanced|Credit Optimization Advanced]] — credit-aware gate patterns
