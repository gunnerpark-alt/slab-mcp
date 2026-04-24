---
type: guide
section: enrichment
tags: [waterfall, enrichment, run-conditions, provider-ordering, gates]
description: "Standard waterfall structure with cumulative exclusion gate pattern and the critical distinction between simple null-checks and robust error-aware gates."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Waterfall Enrichment Patterns

A waterfall is a series of enrichments that try multiple providers for the same data point. The first successful result wins; later providers are skipped.

---

## Standard Waterfall Structure

A waterfall has exactly one outer run condition — set on the first action in the waterfall. Individual provider actions inside the waterfall use skip logic.

```
[Waterfall outer run condition: !!{{Domain}} && !{{Existing Email}}]
  Provider 1 (Apollo)     → runs first
  Provider 2 (PDL)        → skips if Apollo returned a result
  Provider 3 (LeadMagic)  → skips if PDL returned a result
  Final Result merge      → formula: {{Apollo Result}} || {{PDL Result}} || {{LeadMagic Result}}
```

**Provider ordering principle:** Cheapest first, highest-quality last as the expensive fallback.

---

## Cumulative Exclusion Gate Pattern

Each successive provider adds one more check to its run condition:

```javascript
// Provider 1: no gate (always runs if outer RC fires)
// Provider 2: gate: !(p1 && p1?.key_field)
// Provider 3: gate: !(p1 && p1?.key_field) && !(p2 && p2?.key_field)
```

**Critical:** The correct gate form is `!(field && field?.property)` — NOT just `!field?.property`. The outer `field &&` guards against the result object itself being null before optional-chaining into the property.

---

## Robust Waterfall (Error-Aware)

Simple `!{{Provider 1}}` won't re-run if Provider 1 ran but returned an error.

```javascript
// Provider 2 run condition — skips if Provider 1 succeeded OR is still pending
!{{Provider 1}} || Clay?.getCellStatus?.({{Provider 1}})?.toLowerCase()?.includes("error")
```

---

## Waterfall Formula Columns (Native formulaWaterfall Type)

Each step is a formula evaluated in order. First non-empty result wins.

**Normalization waterfall step pattern:**
```
Step 1: Preserve original CRM value if already populated and validated
Step 2: Use enrichment/AI result if available
Step 3: Fallback — restore original CRM value IF context hasn't changed (guard required)
```

**Critical for Step 3:** Guard the fallback against context changes:
```javascript
// Only restore original state value if the country hasn't changed
{{[Enriched Country Column]}} === {{[Source Country Column]}} || !{{[Enriched Country Column]}}
  ? {{[Source Original Value Column]}} : ""
```

---

## Common Waterfall Types

**Email waterfall:**
```
Apollo email → Hunter → LeadMagic → Findymail → Final Work Email
(cumulative exclusion pattern)
```

**LinkedIn profile waterfall:**
```
Webhook LinkedIn → LiveData Find → Reverse Contact → LeadMagic → Champify → Final LinkedIn
```

**Domain waterfall:**
```
Webhook website → Use AI → Snov domain → Google domain → HG Insights domain → Merged Website
```

**Domain name resolution waterfall (from company name):**
```
get-domain-from-company-name (step 1, no gate)
  → google-company-to-domain (gate: !(step1 && step1?.domain))
  → hg-insights-find-domain-from-company-name (gate: !(step1 && step1?.domain) && !(step2 && step2?.domain))
```
Always follow with `normalize-url` (type="bareDomain") to clean the result.

**Parent/Child Hierarchy Waterfall:**
```
HitHorizons (EMEA-gated) → HG Insights (global) → Claygent scrape → AI consolidation → AI gap fill
```

---

## Dependent Waterfalls (Waterfall 2 runs after Waterfall 1)

**Problem:** Clay may evaluate Waterfall 2's run condition before Waterfall 1 has resolved.

**Workaround using httpstat.us delay:**
```
Waterfall 1 (Provider A → Provider B → Final Result 1)
→ HTTP GET https://httpstat.us/200?sleep=20000  (delay column)
→ Waterfall 2 (run condition: !{{Final Result 1}})
```

**Alternative:** Restructure into two separate tables.

---

## Domain Validity Gate (Universal Entry Gate)

A Claygent 'Domain Status' action (model=clay-argon) runs as the very first enrichment step. All subsequent enrichments gate on:

```javascript
{{Domain Status Column}}?.toLowerCase() === "valid domain"
```

Always use `.toLowerCase()` — Claygent may return varying capitalization.

---

## Email Verification Statuses

Five statuses returned by `validate-email` providers:

| Status | Meaning | Action |
|---|---|---|
| **Valid** | Specific, active address — confirmed deliverable | Use for sequences |
| **Invalid** | Does not exist (misspelling, deactivated, dead domain) | Remove from list |
| **Catch-all** | Domain accepts all addresses — inbox existence unconfirmed | Use with caution; filter for Conservative strategy |
| **Unknown** | Couldn't verify — mail server temporary issue | Retry later or proceed cautiously |
| **Role-based** | Tied to a job function (`info@`, `sales@`, `support@`) — monitored by teams, not individuals | Lower engagement; exclude from cold outreach |

Statuses change over time as domains update settings. Revalidate lists periodically.

---

## Work Email Waterfall — Built-In Tool

Clay's native Work Email waterfall (`Add enrichment` → `Work Email`) cascades across multiple providers and stops as soon as a valid result is found. You only pay for the provider that finds a match.

**Configuration modes:**
- `Quick setup` — minimal inputs, sensible defaults
- `Full configuration` — unlocks Infer Email and Validation settings

### Infer Email (Free First Step)

Inserts a free step that constructs an email from name + domain using a naming pattern (default: `first.last@domain.com`). If the inferred email passes validation, the waterfall stops — no paid providers called.

- **Cost:** Zero credits for the inference step; validation does cost credits
- **Hit rate:** 31% in Clay's internal testing on a software-industry dataset
- **Enable:** Scroll to bottom of Inputs section → toggle `Include infer-email enrichment as first step?`
- **Inputs required:** Email Pattern (default `first.last@domain.com`), Domain, First Name, Last Name (Middle Name only for `first.[middle_initial].last@domain.com`)

Test on ~10 rows before running at scale — naming conventions vary by industry.

### Validation Settings

`Validation Provider` — which provider validates each email. When set, a validation column is added after each provider step.

`Require validation success?` — when ON, only accepts emails the provider explicitly confirms valid.

`Validation strategy` — risk tolerance for what counts as valid:

| Strategy | Description | Best for |
|---|---|---|
| Conservative | Verified addresses only, no catch-alls | Cold outreach where bounce rate affects sender reputation |
| Balanced | Includes catch-alls | Middle ground — coverage vs precision |
| Aggressive | Wide net, higher risk | Volume and coverage over precision |
| Advanced | Manual fine-grained control | Custom requirements |

`Threshold for duplicate results` (default `0`): Stops the waterfall if the same invalid email appears N times across providers. Set to `2`+ when using Conservative strategy — prevents spending credits on an email you've already decided to reject. `0` disables the feature.

`Output name of successful provider?` — adds a column showing which provider found the email.

`Hide provider columns?` — on by default; hides per-provider intermediate columns for a cleaner table.

---

## Work Email Waterfall with Interlaced Validate Steps

Pair each email finder with its own `validate-email` step immediately after:

```
Find (Provider A) → Validate A (gated on A returning an email)
  → Find (Provider B, gated on A+validate failing) → Validate B
```

This stops the waterfall as soon as a verified email is found. Without interleaving, you might collect 6 candidate emails and validate them all — spending validation credits even when provider 1 already succeeded.

**Provider ordering (most to least common as first step):**
`leadmagic → findymail → prospeo → dropcontact → hunter → datagma → wiza → enrich-person (PDL) → icypeas → fullenrich → bettercontact → enrow → smarte → snov`

---

## Mobile Phone Waterfall

Mirror of email waterfall but uses `clearout-validate-phone` (not `validate-email`). Gate field: `?.phone_numbers[0]`.

---

## Personal Email Waterfall

Uses `enrichley-verify-email` (not `validate-email`). The validator checks `?.valid === true` (boolean). Gate field: `?.personal_email`.

---

## Multi-Model Claygent Waterfall

For high-value extractions where a single model failure would block the row, run the same extraction prompt across three different model backends:

```
use-ai (Navigator) → use-ai (DR Claude, gated on prior returning no result) → use-ai (Argon)
```

---

## Canonical Gate Signal by Data Domain

Pick one canonical output field per data domain to serve as the gate signal for the entire waterfall:

| Data Domain | Gate Signal |
|---|---|
| Financial data | `revenue_band` or `inferred_revenue` |
| Web traffic | `total_visits` |
| LinkedIn profile | `url` |
| Tech stack | `technologiesFound` |

Once ANY provider populates the canonical field, all remaining providers skip.

---

## AI Classification Result as Gate

```javascript
{{ai_result_field}}?.F_B_Program_?.toLowerCase() === 'yes'
```

Always use `?.toLowerCase()` when comparing AI text output.

---

## Waterfall Detection (When Reading schema.json)

Look for:
- Multiple action columns with the same base name: "Email Finder", "Email Finder 2"
- Run conditions that gate on previous columns being empty/errored
- A final formula column that merges: `{{A}} || {{B}} || {{C}}`

**Note:** Waterfall step numbering can be reversed — higher-numbered steps sometimes execute first if columns were reordered after creation. Never assume step number reflects execution sequence.

---

## Related

- [[providers/reference|Provider Reference]] — action keys, credit costs, and provider ordering benchmarks
- [[enrichment/credit-optimization|Credit Optimization]] — cost-effective waterfall ordering and canonical gate signal approach
- [[formulas/syntax|Formula Syntax]] — run condition syntax, `getCellStatus()` usage, and compound gate patterns
- [[use-cases/person-enrichment|Person Enrichment]] — email waterfall and phone waterfall configurations
- [[use-cases/company-enrichment|Company Enrichment]] — firmographic waterfall configuration
- [[use-cases/catalog/personal-email-waterfall|Personal Email Waterfall]] — enrichley-verify-email vs validate-email distinction
- [[use-cases/catalog/email-validation-gate|Email Validation Gate Pattern]] — interlaced validation pattern reference
