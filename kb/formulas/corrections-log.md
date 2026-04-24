---
type: reference
section: formulas
tags: [corrections, bugs, formulas, audit, changelog]
description: "Dated log of confirmed Clay formula bugs and fixes from production table audits, including Object.assign failure on enrichment objects and Audiences JSON round-trip stringify requirement."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Formulas — Corrections Log

Dated log of confirmed bugs, fixes, and non-obvious patterns extracted from real production tables. Read this when debugging unexpected formula behavior.

**Core syntax rules:** → [[formulas/syntax|Formula Syntax]]
**Advanced patterns:** → [[formulas/advanced-patterns|Advanced Patterns]]

---

## Active Corrections

### [2026-04-04] Full SE template audit: 35+ action keys and 10+ patterns missing
**Status:** active
**Problem:** Systematic audit of all 17 SE golden tables revealed 35+ undocumented action keys and 10+ undocumented patterns. Key gaps: phone waterfall (8-provider extended version), domain resolution waterfall, ecommerce/retail detection stack, parallel LinkedIn finding, redirect+domain validation, Dropcontact output path (`.data.email` not `.email`), HubSpot output structure vs Salesforce, Gong/Snowflake/Apify/Google Docs integrations, Typeform source extraction, table-level-ai, mixed email array consolidation.
**Fix:** Updated providers.md (40+ new entries), enrichment-tactics.md, enrichment-tactics-advanced.md, integrations.md, core.md. All now current.

---

### [2026-04-04] 11 providers + 3 patterns missing from providers.md
**Status:** active
**Problem:** Missing: PredictLeads job/events actions, SimilarWeb engagement metrics, Nymblr, Contactout (phone), Forager, Icypeas, Datagma variants (mobile, email-v3), Aviato, Beauhurst, La Growth Machine, screen-shot-get-page, chat-gpt-vision. Phone waterfall pattern, PredictLeads 3-action guide, screenshot+vision pattern also absent.
**Fix:** All providers added to providers.md. Patterns added to enrichment-tactics.md and enrichment-tactics-advanced.md.

---

### [2026-02] Object.assign / _.merge failure on enrichment objects
**Status:** active
**Problem:** `Object.assign({}, {{Enrichment}}, { identifier: true })` and `_.merge()` both fail silently on complex nested enrichment JSON.
**Fix:** Wrap enrichment as a named property:
```javascript
{ data: {{Enrichment}}, identifier: true }
```

---

### [2026-02] Audiences JSON round-tripping
**Status:** active
**Problem:** Data written to Audiences as objects arrives back as stringified JSON. Direct property access fails.
**Fix:** Always `JSON.stringify()` before writing. Always `JSON.parse()` when reading. Wrap parse in try/catch IIFE:
```javascript
(() => { try { return JSON.parse({{field}}); } catch(e) { return null; } })()
```

---

### [2026-04-01] Waterfall fallback restores invalid value after context change
**Status:** active
**Problem:** A fallback step restores the original CRM value when enrichment returns empty — but if enrichment changed a related field (e.g., country changed), the restored value (e.g., state) is now invalid for the new context. CRM rejects the write.
**Fix:** Guard the fallback on context match:
```javascript
{{[Enriched Context Column]}} === {{[Source Context Column]}} || !{{[Enriched Context Column]}}
  ? {{[Source Original Value]}} : ""
```
**Applies to:** Any waterfall fallback that restores original CRM data for a field whose validity depends on another enriched field.

---

## Schema-Learner Extracted Fixes

These were identified by analyzing production table schemas across real Clay builds.

---

### Extract jurisdiction from companyHierarchy array

```javascript
(companyHierarchy || []).find(i => 
  i?.hierarchyType?.join(',')?.toLowerCase()?.includes('input')
)
```

`|| []` prevents null errors before `.find()`. `join(',')` flattens multi-value `hierarchyType` arrays for a single `.includes()` check. Swap `'input'` for `'ultimate_parent'` or `'subsidiary'` for other hierarchy rows.

---

### Clean raw DNS MX answers: two regex replacements

DNS responses include a TTL prefix and trailing dot: `300 aspmx.l.google.com.`. Strip both:
```javascript
value.replace(/^\d+\s+/, '').replace(/\.$/, '').toLowerCase()
```

**Note:** `.replace()` with regex is flagged as unreliable in Clay's sandbox. Prefer `.split().join()` for literal replacements; for regex patterns, reformulate with `.startsWith()`, `.slice()`, or explicit checks.

---

### Google Workspace: detect via TWO MX hostname patterns

```javascript
mx.includes('aspmx.l.google.com') || mx.includes('googlemail.com')
```

Checking only `aspmx.l.google.com` misses legacy Google Apps domains using `googlemail.com` routing.

---

### Array fallback: (expr || []) before array methods

```javascript
({{field}}?.someArray || []).find(...)
```

Always wrap nullable array properties with `|| []` before `.find()`, `.filter()`, or `.some()`. Use `_.some()` (not native `.some()`) in run conditions for null-safe array membership checks.

---

### Date formatting patterns

```javascript
// Format date from enrichment API
!{{field}}?.registeredOn ? '' : moment({{field}}?.registeredOn).format('MM-DD-YYYY')

// Domain age in years (1 decimal place, no toFixed)
Math.round(((days / 365) * 10) / 10)
```

---

### Run condition anti-patterns: template literals and return statements

Two confirmed syntax errors found in production:
1. **Template literals** (backtick strings) — not supported in Clay run conditions. Use string concatenation with `+`.
2. **Return statements** — not allowed. Run conditions must be pure expressions, not function bodies.
3. **Forward reference** — run conditions that reference `{{f_subroutine_source}}` fire before the source column is populated if the column appears before the source in table order. Ensure source columns appear left of any column whose run condition references them.

---

### regex in .replace() — use split/join instead

Clay's QA tool explicitly flags `.replace(regex, ...)` as unreliable. Safe equivalent:
```javascript
// Instead of: value.replace(/pattern/, 'replacement')
// Use: value.split('pattern').join('replacement')
```
For regex patterns that can't be expressed as literals, reformulate with `.startsWith()`, `.endsWith()`, `.slice()`, or explicit conditional checks.

---

### Forward-reference anti-pattern: run conditions referencing downstream columns

Run conditions that reference columns appearing LATER in column order will see empty/null values at execution time — gate will evaluate incorrectly.

**Fix:** Only reference columns that are strictly earlier (to the left) in column order. When adding a new provider to an existing waterfall, always append to the END and verify the new column's position relative to all columns that reference it.

*Evidence: [Live] Funding + Expansion Events — Crunchbase gate warning; [Live] Company Firmographic Waterfalls — SMARTe, Clearbit, Serpstat gate warnings*

---

### Missing optional chaining on action output causes warnings

```javascript
// Wrong — causes column warning:
{{field}}.industry

// Correct:
{{field}}?.industry
```

All formula references to action output fields must use `?.` optional chaining.

---

### Single `&` vs `&&` in gate conditions

Single `&` is bitwise AND — not logical AND. Gate conditions must use `&&`.

```javascript
// Wrong:
condition1 & condition2

// Correct:
condition1 && condition2
```

*Evidence: Table 1 'Find companies Table' — [Enrich Company (4)] gate*

---

### Dropcontact output path: `.data.email` not `.email`

```javascript
// Wrong:
!(result && result?.email)

// Correct:
!(result && result?.data.email)
```

*Evidence: Multiple tables using dropcontact-enrich-person*

---

### Mixrank: all profile fields need optional chaining

Fields `.name`, `.first_name`, `.last_name`, `.location_name`, `.url`, `.latest_experience_title` all require `?.`:
```javascript
{{MixrankResult}}?.first_name   // correct
{{MixrankResult}}.first_name    // generates warning
```

*Evidence: t_u95EncJgxiHc — 70 warnings from enrich-person-with-mixrank-v2*

---

### Massive waterfall column-order bug: validate steps reference later finders

**Symptom:** Issue count > 100 on a phone or email waterfall table.
**Root cause:** `validate-email` and `clearout-validate-phone` columns reference finder columns that appear LATER in field order — occurs when finders are added without reordering.
**Fix:** Reorder so each validate step appears immediately after the finder it validates. Each subsequent finder appears after its preceding validate step.

*Evidence: t_sTk2h4xUhJfU — 266 warnings*

---

### Two null-coalescing patterns for string gate conditions

```javascript
// Pattern A (verbose):
(!{{f}} ? "" : {{f}})?.toLowerCase() === "valid"

// Pattern B (preferred, shorter):
({{f}} || "").toLowerCase() === "valid"
```

---

## Related

- [[formulas/syntax|Formula Syntax]] — the 8 critical syntax rules
- [[formulas/advanced-patterns|Advanced Patterns]] — complex formula patterns
- [[enrichment/waterfalls-advanced|Waterfall Advanced]] — waterfall-specific patterns and bugs
