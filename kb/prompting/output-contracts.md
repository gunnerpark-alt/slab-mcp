---
type: guide
section: prompting
tags: [prompting, output-contracts, json-schema, forbidden-strings, null-policy]
description: "The output format section as a downstream contract: camelCase JSON output keys, snake_case input labels, forbidden strings list, and empty-string null policy."
created: 2026-04-11
updated: 2026-04-15
---

# Output Contracts: JSON Schemas, Forbidden Strings, Null Policies

The output format section of a Clay prompt is a *contract* between the AI and the downstream formulas that parse its result. Broken contracts silently corrupt entire pipelines.

---

## The Core Contract Components

### 1. Exact Field Names

**Canonical casing standard (use this for all new prompts):**
- **Input field labels** (INPUT DEFINITION / INPUT DATA sections): `snake_case` — `company_name`, `company_domain`
- **JSON output keys** (OUTPUT FORMAT / EXAMPLES sections): `camelCase` — `revenueModel`, `hasLogin`, `linkedinUrl`

```
**MANDATORY Formatting Rules:**
- Input field labels: snake_case (company_name, company_domain)
- JSON output keys: camelCase (revenueModel, hasLogin, linkedinUrl)
- NEVER use: spaces, hyphens, PascalCase
```

**Why**: Downstream formulas access output via `{{Col}}?.linkedinUrl` — the casing must match exactly. The model must produce the same field names it was shown in the Output Format section.

> **Legacy note**: Some production prompts (notably the LinkedIn Profile Match prompt) use snake_case for output keys (`linkedin_url`, `confidence_level`). Those work because their downstream formulas also use snake_case. For all new prompts, use camelCase output keys to match the canonical standard.

---

### 2. Forbidden Strings

The single most critical constraint. Models default to natural language non-answers. Downstream formulas can't handle them.

```
**FORBIDDEN (never return these):**
- "No recent..."
- "Unable to..."
- "N/A"
- "Unknown"
- "Not available"
- "I could not find..."
- "As of my knowledge cutoff..."
- "Not found" (unless it is a named enum value in a classification field)
```

**Canonical forbidden list** (from the most-reused prompts):
- `"N/A"` — breaks `=== null` and `.length` checks
- `"Unknown"` — appears truthy, fails empty/null gates
- `"Unable to verify"` — prose in a data field
- `"No information found"` — longer variant of the above
- `"Not found"` — causes `?.toLowerCase().includes("not found")` pollution; use `""` instead

---

### 3. Null Policy: Always Empty String

**Canonical standard: use `""` (empty string) for all missing string values.**

```
Return "" (empty string) when:
- No credible result found after exhaustive search
- Company appears defunct or cannot be identified
- Input is null or empty

NEVER return: "Not found", "N/A", "Unknown", null for string fields.
Return "" always when data is unavailable.
State this policy at least 3 times in the prompt.
```

This applies to both single-value and multi-field JSON output:
```json
{
  "linkedinUrl": "",
  "confidenceLevel": "very low",
  "matchType": ""
}
```

> **Legacy note**: Some legacy prompts use `"Not found"` as the default string for JSON object fields. Those prompts have matching downstream gates (`?.toLowerCase().includes("not found")`). For new prompts, use `""` exclusively — it simplifies downstream formulas to `!!{{Col}}`.

**Boolean/classification fields**: Use `false` or a specific enum value, never `"N/A"` or `""`.

---

### 4. Structured JSON Schema

Always include a concrete example schema, not just a description.

```json
{
  "input_company": [
    {
      "original_level": "L3",
      "legal_name_original": "LinkedIn Ireland Unlimited Company",
      "company_name": "LinkedIn Ireland Unlimited",
      "tax_structure": "Co",
      "city": "Dublin",
      "state_province": "",
      "country": "Ireland",
      "country_code": "IE",
      "normalized_entity_name": "LinkedIn Ireland Unlimited Co",
      "company_domain": "linkedin.com"
    }
  ]
}
```

**Key principles**:
- Show empty strings as `""`, not omitted fields — tells model when fields are optional vs required
- Use real company names in examples (Microsoft, LinkedIn), not `[company]` placeholders
- Include at least one example showing what happens when data is missing

---

### 5. Confidence Levels

Many prompts return a `confidence_level` field. Standardize the enum.

```
confidence: "very high" | "high" | "medium" | "low" | "very low"
```

**Anti-pattern**: Leaving confidence open-ended produces "85%" in one row and "high confidence" in another, making the field unparseable downstream.

---

### 6. Classification Enums

For any field with a fixed set of valid values, enumerate them explicitly.

**match_type** (LinkedIn profile matching):
```
- "Current Employment" — profile shows current position at target company
- "Historical Employment" — past employment with clear timeline
- "Related Entity Employment" — employment at subsidiary/parent/partner
- "No Relationship" — correct person, no company connection
- "Not Found" — no matching profile identified
```

**Why**: If you say "classify as current or historical," the model will also return "Former Employment," "Previous Role," "Past Work," etc. Explicit enum prevents this.

---

## Steps Taken / Audit Log Pattern

Some prompts require a `steps_taken` field — a chronological array of actions performed.

```json
{
  "steps_taken": [
    "Searched LinkedIn for 'John Smith VP Engineering Acme Corp'",
    "Found 3 results, filtered by location match",
    "Verified current employer via company page",
    "Confirmed email domain matches linkedin.com/in/john-smith-acme"
  ]
}
```

**When to use it**:
- High-stakes identity verification (LinkedIn profile match, employment verification)
- Debugging: when a row returns "Not found," the steps log shows what was tried
- Confidence attribution: steps let you verify the model actually checked the right sources

**Cost**: Adds ~200-400 chars of output per row. Use only where debugging value exceeds credit cost.

---

## URL Validation Rules

```
**URL Validation:**
- MUST be functional and lead to correct profile
- Keep original working URLs — don't "standardize" to a broken canonical form
- Regional LinkedIn URLs (br.linkedin.com, ar.linkedin.com) are acceptable
- FORBIDDEN: URLs with tracking params, redirects, or shortened forms
```

---

## Anti-Patterns in Output Contracts

**❌ "Return the relevant information"** — model decides what's relevant  
**❌ "Use any format you find appropriate"** — every row returns a different schema  
**❌ Missing default for optional fields** — sometimes returns `null`, sometimes omits  
**❌ Free-text confidence** — "85%" vs "high" vs "very confident" in same column  
**❌ No forbidden string list** — "N/A", "Unknown", "Unable to find" pollute downstream  
