---
type: guide
section: architecture
tags: [architecture, pipeline, multi-table, signal-orchestration, column-prefixes]
description: "Standard left-to-right pipeline stages for lead enrichment (IN → identity → enrichment → score → export) and signal orchestration tables, with column naming conventions."
created: 2026-04-11
updated: 2026-04-16
verified: 2026-04-11
---

# Table Architecture Patterns

Common patterns for structuring Clay tables and multi-table pipelines.

---

## Lead Enrichment Pipeline

The most common pattern. Data flows left to right through stages:

```
Source (webhook/import)
  → Input normalization (extract domain, validate email, normalize phone)
  → Identity resolution (find LinkedIn, find company)
  → Employment verification
  → Company enrichment (technographics, headcount, funding)
  → Person enrichment (title, seniority, contact info)
  → Location enrichment (country, state, city standardization)
  → Qualification scoring
  → CRM export (Salesforce, HubSpot)
```

**Key design principles:**
- Input columns (prefixed `IN -`) normalize webhook data before use
- Merge columns (prefixed `Final ` or `Merged `) coalesce multiple sources
- Action columns should have run conditions that skip when input is missing
- Export/sync actions should be last and gate on qualification score

---

## Signal Orchestration

```
Multiple signal sources (job changes, news, intent data, technographic signals)
  → Signal normalization formulas
  → Aggregation formula (combine signals per company)
  → Scoring formula (weight by recency and type)
  → Routing/segmentation (hot/warm/cold buckets)
  → Output (export to CRM, trigger sequence)
```

---

## Account Matching

```
Lead input (email, company name)
  → Domain resolution
  → Salesforce SOQL lookup (match on domain or account name)
  → Match formula: {{SFDC Lookup}}?.records?.[0]?.fields?.["Account ID"]
  → Conditional enrichment (enrich if matched, skip if not)
  → Export (update existing vs create new)
```

**SOQL matching challenges:**
- `LIKE` is too generous — use exact match (`=`) on domain
- For bulk matching: `Website IN ('d1.com', 'd2.com', ...)` — watch SOQL query length limits

---

## Address Standardization Pattern

Used in tables that sync to Salesforce contacts/leads with strict picklist validation:

```
Source (raw address fields from CRM/MAP webhook)
  → Location parse (AI — extracts city/state/country from unstructured data)
  → Country normalization (AI — normalizes to ISO code or full name)
  → State normalization (AI)
  → Merged Country (waterfall: preserve if pre-populated → AI result)
  → Merged State (waterfall: preserve if pre-populated → AI result → fallback with context guard)
  → Merged City
  → CRM sync
```

**Critical:** Waterfall fallback steps that restore original CRM values must guard against context changes — if enrichment updated country, the original state may no longer be valid.

---

## Corporate Hierarchy / Subsidiary Qualification

```
Company list input
  → Subsidiary detection (Claygent: is this a subsidiary? who's the parent?)
  → Domain validation (Claygent: is the website valid and active?)
  → Deduplication (formula: normalize domain → check for duplicates)
  → Parent company resolution (match to existing CRM accounts)
  → Regional routing (EMEA/AMER/APAC based on HQ country)
  → CRM account creation (with correct Record Type ID per region)
```

Multi-prompt system with separate Claygent prompts for each detection step. Dedup before CRM creation.

### Recursive hierarchies (3+ levels)

When discovering subsidiaries recursively (L1 → L2 → L3 → ...), each level feeds the next. **The same company will be rediscovered at deeper levels.** Within-level dedup (unique domain/LinkedIn + "is not parent") catches duplicates within a single table but NOT across tables.

**The principle:** Recursive discovery creates cross-level duplicates. Always gate deeper levels against SFDC state from prior levels. Use a single SOQL ancestry-chain query (`Parent.ParentId`, `Parent.Parent.ParentId`, ...) to check whether a subsidiary is already placed in the hierarchy before creating or updating it.

See [[use-cases/catalog/recursive-hierarchy-ancestor-dedup|Recursive Hierarchy Ancestor Dedup]] for the full pattern and SOQL implementation.

---

## Webhook-Triggered Real-Time Enrichment

```
CRM event (new MQL in Marketo/Salesforce)
  → Webhook to Clay
  → Input normalization
  → Identity resolution
  → Employment verification
  → Contact + company enrichment
  → Qualification scoring
  → Write-back to CRM
  → Set "Clay Enrichment Complete" flag
```

**Critical:** Enrichment must complete BEFORE lead routing. Use a completion flag that downstream workflows gate on. Marketo → Clay webhook must fire BEFORE Marketo → SFDC sync.

---

## Multi-Table Scraping Pipeline

```
Table 1: Seed (1 row per country/category) → generate regions
Table 2: Region expansion (1 row per region) → generate paginated URLs
Table 3: URL processing (1 row per page) → scrape → extract records
Table 4: Record enrichment (1 row per record) → waterfall enrichment
Table 5: Campaign push → export to engagement tool
```

Tables linked via Audiences or webhook triggers. Each table handles one expansion level.

---

## Cron-Based Orchestration

```
Cron service (every N minutes) → webhook to Clay
  → SOQL lookup: records created/modified in last N minutes
  → Process delta records
  → Output (Slack, CRM update, Audiences write)
```

SOQL for time-window: `WHERE CreatedDate = LAST_N_MINUTES:5`

---

## Artificial Delay Between Table Steps (httpstat.us)

Clay has no native "wait N seconds before running" step.

```
https://httpstat.us/200?sleep=30000
```

`sleep` is in milliseconds. Always returns 200 after the specified delay.

**Use cases:**
- `Enrich → Write to table → [delay 30s] → Lookup table`
- Dependent waterfalls where Waterfall 2 should run only after Waterfall 1 completes
- WTT + Lookup race condition fix

**Caveat:** Clay is billed for AWS compute time while the request hangs. Don't use this in tables with thousands of rows. Alternative: Zapier webhook with wait step.

---

## Two-Phase AI Pipeline: Cheap Model for Research, Capable Model for Synthesis

Use cheaper, faster model (e.g., `claude-haiku-4-5`) to gather raw data from the web, then more capable model (`claude-sonnet-4-6`) to reason over results.

Examples:
- Claygent HQ Search (haiku) → Address Normalization (sonnet)
- Employee Count Intelligence (claygent/haiku) → Employee Count Estimate (use-ai/sonnet)

**Never combine web research and structured output formatting into a single AI step.**

---

## AI Structured Output Decomposition: One Action, Many Formulas

When a Claygent or `use-ai` action returns a multi-field JSON object:
1. One action column stores the raw object
2. Individual formula columns extract specific fields via optional chaining (`?.featureRequest`, `?.painPoint`)

One AI credit → multiple downstream columns. Always design prompts to return named JSON object with consistent camelCase keys, then create one formula column per key needed downstream.

---

## Data Provider Tracking Columns

Tables that aggregate data from multiple providers use formula columns named `[Field] Data Provider` (e.g., `Domain Data Provider`). These formulas record which waterfall step successfully populated each data point, enabling lineage auditing and targeted re-enrichment.

---

## Column Naming Conventions

| Prefix | Meaning |
|--------|---------|
| `IN -` | Raw input from webhook/source before normalization |
| `Final ` / `Merged ` | Post-waterfall coalesced value |
| `[Master]` | Export-ready schema layer, shaped for destination system |
| `[QA]` / `[Live]` | Table maturity prefix |
| `0 -` / `1 -` / `2 -` | Numbered prefix for pipeline stage grouping |
| Section dividers | `[text]` type columns with emoji labels |

---

## AI Normalization as First Stage for Messy Inputs

When inputs are inconsistent (free-text company names, mixed domains and LinkedIn URLs), use an AI step as the first action column to extract structured identifiers (domain, LinkedIn URL, legal name) as a single JSON object. Every downstream enrichment references these extracted fields rather than the raw input.

This separates the interpretation problem from the enrichment problem.

---

## AI Company/Domain Match as Pre-Enrichment Quality Gate

Before running expensive enrichment on a domain, insert an AI validation step that:
1. Confirms the domain matches the company name
2. Returns a corrected domain if it doesn't

Downstream formula columns use `correct_domain` as the enrichment input rather than the raw input domain. The AI step is cheap relative to a full enrichment waterfall; ROI is strong.

---

## CRM Lookup as Universal Credit-Saving Gate

In tables that touch a CRM, place the CRM record lookup early and propagate its result as a gate on every downstream enrichment action. If a record already exists in Salesforce or HubSpot, skip the entire enrichment pipeline.

---

## Template-Cloned Enrichment Tables for Campaign Variants

When running the same enrichment pipeline against different lead segments or campaigns, deploy separate table instances per segment (by cloning) rather than adding a segment filter column to a shared table. Each campaign variant can have different downstream columns, webhook targets, or output mappings without complicating a shared table.

Tradeoff: updating the enrichment logic requires touching every clone.

---

## Write to Table (WTT) Deprecation

**Write to Table is deprecated as of early 2026.** Use **Send Table Data** instead.

If you encounter tables still using WTT actions (especially older Sculptor/template tables), replace them with Send Table Data. The behavior is equivalent but WTT will eventually stop working.

---

## Multi-Workspace Credit Splitting (Enterprise Workaround)

Enterprise customers sometimes request multiple Clay workspaces with credits split across teams — a workaround for Clay's lack of native per-team credit allocation.

**Downsides:** no cross-workspace visibility, duplicate table setups, harder to share functions/templates.

---

## Composable Sub-Table Microservice Pattern

Split a large enrichment pipeline into an orchestrator table + independent sub-service tables, each exposed via webhook with a `returnUrl` response path. Sub-services handle a single concern (find work email, find personal email, find LinkedIn URL) and write their output to Audiences. The orchestrator reads from Audiences rather than calling sub-services directly.

**Why this architecture:**
- Sub-services can be reused across multiple orchestrator tables without rebuilding logic
- Each sub-service has its own credit tracking and run history
- Audiences acts as a shared cache — if a sub-service already ran for a contact, the orchestrator reads the cached result and skips the sub-service call entirely (saves credits)
- Sub-services can be independently updated without touching the orchestrator

**Structure:**
```
Orchestrator (Lead Enrichment)
├── Lookup in Audiences (Email)          → check cache first
├── Lookup in Audiences (Work Email)     → check cache first
├── Lookup in Audiences (Personal Email) → check cache first
├── Audiences Combined (FLoO concat)     → single gate for all downstream
│
├── Send Table Data → Find Work Email table   (gated: cache miss for work email)
│     └── webhook + returnUrl
│     └── Upserts result to Audiences
│
├── Send Table Data → Find Personal Email table  (gated: cache miss for personal email)
│     └── webhook + returnUrl
│     └── Upserts result to Audiences
│
└── [Continue enrichment using Audiences Combined as data source]
```

**Sub-service internal structure:**
```
Input webhook (email, name, LinkedIn URL, returnUrl)
  → Audiences lookup (check if already enriched)
  → Enrichment waterfall (only if cache miss)
  → Upsert result to Audiences
  → Send Table Data back to returnUrl row
```

**The three-probe cache check at orchestrator level:** Run separate Audiences lookups by raw email, enriched work email, and enriched personal email. Consolidate with FLoO concat (see [[audiences/index|Audiences — Multi-Probe Lookup]]). If any probe hits, skip the sub-service call entirely.

**Sub-service Upsert key:** Use the Audiences Combined result's email first (to update an existing Audiences record), fall back to raw input email (to create new). This handles the case where the sub-service finds a different email than the one it was called with.

```javascript
// Upsert key waterfall:
{{Audiences Combined}}?.filteredArray?.[0]?.fields?.Email || {{Input Email}}
```

---

## Related

- [[core/builder-patterns|Builder Patterns]] — primitive-level multi-table and scheduling patterns
- [[enrichment/waterfalls|Waterfalls]] — waterfall mechanics and the httpstat.us dependent-waterfall workaround
- [[use-cases/company-enrichment|Company Enrichment]] — canonical lead enrichment pipeline example
- [[integrations/crm|CRM & Integrations]] — webhook timing and CRM sync architecture
- [[audiences/index|Audiences]] — cross-table coordination layer used in multi-table pipelines
