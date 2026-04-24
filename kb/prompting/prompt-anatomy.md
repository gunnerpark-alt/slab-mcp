---
type: guide
section: prompting
tags: [prompting, anatomy, structure, input-definition, output-format]
description: "The 8-section skeleton shared by all high-quality Clay prompts (Input Definition → Edge Cases → DO NOT/ALWAYS → Output Format), with annotated rationale for why each section prevents a specific failure mode."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Prompt Anatomy: The 8-Section Structure

Every high-quality Clay prompt shares the same skeleton. The sections vary in length, but the ordering is consistent across hundreds of production prompts.

---

## The Template

```
# [Task Name]

## Input Definition
## Input Data
## [Strategy / Rules]
## Edge Cases
## Error Prevention (DO NOT / ALWAYS)
## Examples
## Output Format
```

---

## Section Breakdown

### 1. Input Definition

Describes what each variable *means* — not just its name. This prevents the model from guessing context.

```
## Input Definition
**company_name**: The legal or commonly known business name. May include:
- Full legal entity names ("Apple Inc.", "Microsoft Corporation")
- Abbreviated names ("IBM", "GE")
- International names in various character sets
- Subsidiary names that differ from parent
```

**Why it matters**: Models hallucinate when inputs are ambiguous. Explicit definition of what the input *can be* (including messy cases) preempts wrong assumptions.

---

### 2. Input Data

The actual variable injection section — separating definition from values so the model understands which is live data vs. instruction.

```
## Input Data
company_name: "+{{Company Name}}+"
person_email: "+{{Work Email}}+"
```

The `+` delimiters act as boundary markers so the model parses dynamic values correctly even when they contain special characters.

See [[prompting/variable-injection|Variable Injection]] for injection patterns.

---

### 3. Strategy / Rules Section

The main reasoning instructions, often structured as phases or priority-ordered rules.

**Phase pattern** (web research):
```
### Phase 1: Direct Official Source Verification
1. Search: "[company] official website"
2. Cross-reference LinkedIn company page
### Phase 2: Authoritative Business Directories
3. Check Crunchbase, Bloomberg, SEC EDGAR
```

**Priority rule pattern** (input conflict resolution):
```
### Field Priority Hierarchy
1. Validate full_name first — if valid, parse it
2. Check first_name + last_name combo
3. Use email to validate or extract names
4. Extract from email as last resort
```

---

### 4. Edge Cases

Named scenarios for known failure modes. The goal: the model should handle unusual inputs without needing to reason from scratch.

```
## Edge Cases

**Scenario 1: Multiple Domains Found**
- Prioritize .com over other TLDs
- For international companies, use the domain cited most in authoritative sources

**Scenario 2: Recently Acquired Company**
- Search for both current and former names
- Verify domain reflects current legal entity

**Scenario 3: Subsidiary vs Parent**
- Determine if subsidiary has its own domain or uses parent domain
```

---

### 5. Error Prevention (DO NOT / ALWAYS)

Explicit constraint pairs that prevent the most common model mistakes. Paired format forces specification of both the failure mode and the correct behavior.

```
### DO NOT:
- Use tax structure variations not in the standardization table
- Lose geographic information when parsing locations
- Translate foreign language business names to English

### ALWAYS:
- Use EXACT standardized forms from the tax structure table
- Maintain recognizable brand formatting (IBM, AT&T, PayPal)
- Apply consistent country codes (2-letter ISO)
```

---

### 6. Examples (Few-Shot)

Labeled input/output pairs. The best examples cover the happy path plus 2-3 edge cases. See [[prompting/research-prompts|Research Prompts]] for the 7-example pattern.

```
### Example 1: Standard Case
Input: company_name: Microsoft
Output: microsoft.com

### Example 2: Common Name (Disambiguation Required)
Input: company_name: Delta
Output: delta.com  [Delta Air Lines — use industry/revenue to disambiguate]

### Example 3: Null Result
Input: company_name: Blockbuster Video
Output: (empty string) — defunct, no active web presence
```

---

### 7. Quality Assurance Checklist

A numbered checklist the model runs before finalizing output. Uncommon in short prompts, critical in complex normalization/extraction prompts.

```
### Before finalizing, verify:
1. ✅ original_level preserved from input data
2. ✅ "and" → "&" conversion applied
3. ✅ Tax structure from EXACT standardization table
4. ✅ Country code is correct 2-letter ISO
5. ✅ Data quality markers removed (DUPE, TEST, INACTIVE)
```

---

### 8. Output Format

The single most important section for reliability. Must specify:
- Exact field names (snake_case, no variations)
- Data types
- Forbidden output strings
- Default values for missing data
- Whether to return empty string or "Not found"

See [[prompting/output-contracts|Output Contracts]] for full treatment.

---

## Prompt Length by Task Type

| Task Type | Typical Length | Reason |
|-----------|---------------|--------|
| Boolean gate / simple classification | 200–500 chars | Few edge cases |
| Name cleaning | 5–15K chars | Many messy input variants |
| LinkedIn profile matching | 10–35K chars | Complex entity relationships |
| Company validation/research | 8–63K chars | Many source types |
| NAICS classification | ~510K chars | 800+ industry codes with examples |

Longer is not always better — the NAICS prompt is 510K because it embeds a lookup table. The core classification logic is ~2K.

---

## Anti-Patterns

**❌ No input definition** — model guesses what the field contains  
**❌ No output format** — returns prose when formula expects JSON  
**❌ No null policy** — returns "N/A" which breaks `?.verified === true` checks  
**❌ Examples only in the happy path** — fails on edge cases  
**❌ DO NOT without ALWAYS** — tells model what's wrong but not what's right
