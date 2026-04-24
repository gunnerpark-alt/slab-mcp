---
type: guide
section: claygent
tags: [claygent, use-ai, web-research, content-manipulation, prompt-structure]
description: "Fundamental distinction between Claygent (live web access) and Use AI (no internet, reasoning only), with the pre-writing process: gather requirements and confirm a logic summary before writing the full prompt."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Claygent and Use AI Prompts

Two distinct prompt types with fundamentally different capabilities. **Never mix them up.**

- **Web Research (Claygent)** — has internet access, gathers new data from the web
- **Content Manipulation (Use AI)** — NO internet access, reasons over data already provided as inputs

---

## Pre-Writing Process

**Step 1: Gather requirements before writing anything**
- Inputs — what data points are available?
- Outputs — what should be extracted/determined?
- Output format — JSON almost always recommended
- Tips / insider info — domain-specific heuristics
- Edge cases — ask the user explicitly; don't assume

**Step 2: Present a logic summary and wait for confirmation**

```
Quick summary of what the prompt will do:

Steps 1-X: [Goal / Primary Logic]
- [step description]

Primary Edge Cases:
- Edge Case 1 → Output
- Edge Case 2 → Output

Does that look good? Then I'll go and create the prompt.
```

Do not write the full prompt until the user confirms.

---

## Mandatory Sections

### Web Research Prompts (Claygent) — all 12 required, in this order:

1. **OBJECTIVE** — role declaration, task description, null policy
2. **INPUT DEFINITION** — snake_case field names, data types, null handling
3. **INPUT DATA** — ALL CAPS filler variables, no brackets: `COMPANYNAME`
4. **RESEARCH METHODOLOGY / SEARCH STRATEGY** — phased approach
5. **KEY DEFINITIONS** — all classification taxonomies, categories, picklists
6. **CLASSIFICATION LOGIC** — step-by-step decision framework with priority ordering
7. **EDGE CASES** — 5-8 minimum
8. **POLICIES FOR CONFLICTING DATA** — specific source priority hierarchy
9. **POLICIES FOR NULL RESULTS** — empty string policy, stated at least 3 times total
10. **OUTPUT FORMAT** — JSON with camelCase fields, booleans as true/false
11. **EXAMPLES** — minimum 5, each with Input + Web Findings + Output
12. **VALIDATION RULES** — 4-point checklist, ending with "Return your JSON output now."

### Content Manipulation Prompts (Use AI) — all 10 required, in this order:

1. **OBJECTIVE** — role declaration + "You do NOT have access to the internet."
2. **INPUT DEFINITION** — snake_case field names, data types, JSON schema if complex
3. **INPUT DATA** — ALL CAPS filler variables, no brackets
4. **KEY DEFINITIONS / CLASSIFICATION LOGIC** — the core of the prompt
5. **EDGE CASES** — 5-8 minimum
6. **POLICIES FOR CONFLICTING SIGNALS** — resolution logic
7. **POLICIES FOR NULL RESULTS** — empty string policy
8. **OUTPUT FORMAT** — camelCase JSON fields
9. **EXAMPLES** — minimum 5, each with Input + Reasoning + Output
10. **VALIDATION RULES** — optional but recommended

---

## Formatting Rules (non-negotiable)

**Section delimiters:**
```
==========================================
SECTION NAME
==========================================
```

**Variable formatting:**
- Filler variables: ALL CAPS, no wrappers — `COMPANYNAME`, `COMPANYDOMAIN`
- Input field labels: snake_case — `company_name`, `company_domain`
- Output JSON: camelCase — `"revenueModel"`, `"hasLogin"`

**Consistency rule:** Output format must be identical everywhere — Output Format section, every Example, every Edge Case reference.

**Production convention:** Open prompts with `#CONTEXT#\n` before the role description.

---

## Search Strategy Decision Framework

| Task Type | Strategy | Example |
|---|---|---|
| Finding specific facts | **Prescriptive** — explicit queries, named sites | `"COMPANYNAME" headquarters address` |
| Analysis or judgment | **Open/Flexible** — guiding principles | "Start with company website, cross-reference" |
| Classification with controlled output | **Hybrid** — prescriptive for definitive, flexible for ambiguous | Check stock exchanges first, fall back to databases |

---

## Required Edge Cases (always include these 8)

1. Company no longer exists / domain is dead
2. Recent rebrand or acquisition
3. Private vs. public data availability
4. Conflicting information across sources
5. International / non-English companies
6. Subsidiaries vs. parent companies
7. Stealth or pre-launch companies
8. Null/empty/garbage input

---

## Output Format Requirements

- JSON with camelCase field names
- Booleans as `true`/`false` — not strings
- Null policy stated at least **3 times**: in Objective, Null Policies section, and Validation
- End with: "Return ONLY the JSON object. No markdown, no code blocks, no backticks, no explanations, no preamble."
- Anti-hallucination: "Every fact must come from a source you visited. Do not infer, guess, or use training data."

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Echoes input instead of generating output | Prompt is too passive | Imperative language; end with "Return your JSON output now." |
| Hallucinated data | No anti-hallucination guardrails | "Every fact must come from a source you visited." |
| Output format mismatch | Schema and examples disagree | Write Output Format first, copy-paste into every example |
| Returns "Unknown" or "N/A" | Null policy stated only once | State empty string policy 3+ times |
| Markdown instead of JSON | No format restriction | "Return ONLY the JSON object. No markdown, no code blocks." |
| Content manipulation tries to search web | No internet restriction | Add "You have NO internet access" in OBJECTIVE section |
| Null inputs cause malformed output | No null example | Add a null-input example |

---

## Action Key and Model Quick Reference

| Action Key | Use Case | Output Access |
|---|---|---|
| `use-ai` with `useCase="claygent"` | Web research | `?.response` (string) |
| `use-ai` with `useCase="use-ai"` | Content manipulation | Direct field access e.g. `?.fieldName` |
| `claygent` (legacy) | Web research | `?.result` or direct field access if structured |

**Model cost ladder (cheapest to most capable):**
- `clay-argon` — lightweight classification, domain status check, binary yes/no
- `gpt-4o-mini` / `clay-neon` — structured JSON output, article summarization
- `gpt-4o` — open-ended multilingual web research, disambiguation, judgment tasks

Match model capability to task ambiguity. Use cheaper models for well-scoped classification; use `gpt-4o` for synthesis across unpredictable sources.

---

## Finding Prompts in schema.json

Claygent and Use AI prompts are stored in `typeSettings.inputsBinding`. Look for the binding with `name: "prompt"` or `name: "instructions"`:

```json
{
  "actionKey": "use-ai",
  "inputsBinding": [
    { "name": "prompt", "formulaText": "\"Your prompt text here...\"" },
    { "name": "model", "formulaText": "\"gpt-4.1-mini\"" }
  ]
}
```

---

## Related

- [[prompting/prompt-anatomy|Prompt Anatomy]] — 8-section structure seen across 3,113 real production prompts (vs the Slab-prescribed 12-section template above — both are valid; anatomy article is derived from empirical analysis)
- [[prompting/ref-company-website-research|Company Website Research (Annotated)]] — full text + line-by-line annotation of the most-reused Clay prompt
- [[prompting/ref-linkedin-profile-match|LinkedIn Profile Match (Annotated)]] — full text + annotation including mandatory pre-output validation block
- [[prompting/output-contracts|Output Contracts]] — JSON schemas, forbidden strings, null policies from real workbooks
- [[formulas/syntax|Formula Syntax]] — how AI output is accessed in formula columns (`?.response` vs direct field access)
- [[providers/reference|Provider Reference]] — model cost ladder and action key quick reference
- [[enrichment/credit-optimization|Credit Optimization]] — model selection by task complexity and `runBudget` parameter
- [[use-cases/company-enrichment|Company Enrichment]] — AI identifier pre-processing and AI enrichment stage patterns
