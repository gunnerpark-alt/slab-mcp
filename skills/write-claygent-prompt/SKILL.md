---
name: write-claygent-prompt
description: Write, fix, or review production-grade Claygent / Use AI prompts for Clay. Use when the user wants to create or improve a prompt that classifies job titles, parses articles, scores accounts, synthesizes intelligence, or performs structured web research for company / person / industry data. This skill handles two modes — web research (internet access) and content manipulation (no internet, reasons over inputs only) — picking the mode is the first step. Covers mandatory section structure, casing conventions, anti-hallucination guardrails, null-policy enforcement, output contracts, and the failure modes Claygent prompts hit in production.
---

# Write Claygent Prompt

## Overview

Claygent (and its no-internet sibling Use AI) is Clay's AI agent that runs prompts row-by-row inside a Clay column. A production-grade prompt is more than a question — it's a **contract** between three parties:

1. **The user** who wrote the table and expects consistent output across thousands of rows.
2. **The model** that needs prescriptive rules to be deterministic on edge cases.
3. **The downstream formulas** that parse the output and break silently when the contract drifts.

This skill writes prompts that hold all three contracts at once. It picks one of two modes (web research vs. content manipulation), follows a strict section structure, and applies anti-hallucination + null-policy discipline that's been tuned against real production failures.

**The skill IS the prompt-engineering template.** You don't need a separate "100% optimized prompt" template anymore — the rules below replace it.

---

## STEP 0: PICK YOUR MODE FIRST

Before writing anything, decide which mode you're in. Ask the user if it's not obvious.

| Mode | Internet Access | Use For | Action Key |
|---|---|---|---|
| **Web Research** | YES — Google searches, visits sites, scrapes | Finding facts (HQ address, revenue, employee count, domain discovery), classifying with external lookup, verifying claims | `use-ai` with `useCase="claygent"` |
| **Content Manipulation** | NO — reasons only over provided inputs | Classifying job titles, parsing articles, scoring accounts, synthesizing payloads, transforming formats | `use-ai` with `useCase="use-ai"` |

**The two modes share Sections 1–3 (process, formatting, output contracts). They diverge in the mandatory section structure of the prompt itself (Sections 4 and 5).** Pick once, follow that branch, don't mix.

If you're not sure which mode the task wants:
- Does it require internet to answer? → Web Research.
- Could the answer be derived from the input data alone if the input were rich enough? → Content Manipulation.

---

## SECTION 1: PROMPT GENERATION PROCESS

This applies to both modes.

### Step 0: Diagnose the Current Prompt (mandatory when rewriting, skip when creating)

**If the user is asking you to rewrite, fix, improve, or review an EXISTING prompt in a Clay column, you MUST first fetch a sample of what that prompt actually returns at runtime. The prompt template tells you what was asked; the runtime output tells you what's actually happening — those are often different things.**

Skip this step ONLY when creating a brand-new prompt with no prior runs.

Procedure:

1. **Identify the column.** From the synced schema, locate the action column with `actionKey: "use-ai"` whose prompt the user wants to rewrite. Note its `fieldId`.
2. **Pick 2–3 representative rows.** Use `get_rows` (with the table's URL or tableId) and a query that pulls a mix — at least one obvious-success row, at least one row that looks like an edge case from its surface display. Capture the `_rowId` for each.
3. **Fetch the nested output for each row.** For every captured `_rowId`: call `get_record(tableId, rowId)` and read the cell's `externalContent.fullValue` for the column you're diagnosing.
4. **Read what's actually there.** For each fetched row, examine:
   - `stepsTaken` — the agent's research trail. Did it actually do what the prompt asked? Did it visit the prioritized sources or just defaults? Did it pivot laterally to find the answer somewhere unexpected?
   - `reasoning` / `fitReasoning` / equivalent — the model's own explanation of its answer. Is it consistent with the prompt's classification logic, or has it drifted?
   - `sources` — which sites did it actually cite? Were they the authoritative ones the prompt prioritized, or fallbacks?
   - `confidence` — is it consistent across rows or wildly variable?
   - The output JSON shape — does every row match the prompt's stated schema, or has the shape drifted between rows?
5. **Cross-check upstream.** Look at the cells fed into this prompt's `inputsBinding`. Is the prompt asking the model to determine something an upstream cheaper column already knows? (Common waste pattern: a downstream gpt-5 Claygent computing a fact that a 1-credit geocode upstream already returned.)

This diagnostic almost always changes what you'd rewrite. Without it, you're rewriting a prompt template based on what it *claims* to do — not what it actually does.

Once Step 0 is done (or skipped because you're creating a new prompt), proceed to Step 1.

### Step 1: Gather Requirements

Before writing any prompt, collect from the user. **Ask if any are missing — don't assume.**

1. **Inputs** — what data points will be provided? (column names, types, possible nulls, JSON schemas if complex)
2. **Outputs** — what should the prompt produce? (boolean, classification string, JSON object, written brief)
3. **Output format** — how is it structured? JSON is almost always the right answer for downstream parsing. Briefs need explicit formatting rules.
4. **Tips / domain knowledge** — heuristics, keyword lists, classification rules, source priorities, anything insider.
5. **Edge cases** — ask explicitly: *"Do you have specific edge cases I should handle, or should I identify them from my expertise?"* Always ask. Replicates the user's own decision-making.
6. **Reference data** — does the user have a CSV/spreadsheet/keyword list defining classification logic? If so, ingest and embed.

### Step 2: Summarize Logic — Wait for Confirmation

**Always present a logic summary before writing the full prompt.** This is non-negotiable.

```
Quick summary of what the prompt will do:

Steps 1-X: [Goal / Primary Logic]
- [step description]
- [step description]

Steps X-Y: [Goal / Primary Logic]
- [step description]

Primary Edge Cases:
- Edge Case 1 → Output
- Edge Case 2 → Output

Does that look good? Then I'll go and create the prompt.
```

Wait for user confirmation. Don't write the full prompt until they confirm.

### Step 3: Write the Prompt

Follow the mandatory section structure for your mode (Section 4 for Web Research, Section 5 for Content Manipulation). Apply the formatting rules in Section 2 and the output contracts in Section 3.

### Step 4: Validate Before Delivering

Run the relevant quality checklist (Section 7). The single most common failure is output format inconsistency between the schema definition and the examples.

---

## SECTION 2: FORMATTING RULES (SHARED BY BOTH MODES)

Non-negotiable. These rules are the same across every Clay prompt.

### Section Delimiters

**Major sections** use full-width block delimiters:

```
==========================================
SECTION NAME
==========================================
```

**Minor sections** (subsections inside a major section) use markdown headers (`###`, `####`).

### Variable Casing — Three Different Conventions, One Place Each

| Where | Casing | Example | Wrong |
|---|---|---|---|
| Filler variables in INPUT DATA | ALL CAPS, no wrappers | `COMPANYNAME`, `JOBTITLE`, `ENRICHMENTPAYLOAD` | `{{COMPANYNAME}}`, `{company_name}`, `[TITLE]` |
| Input field labels | snake_case | `company_name: COMPANYNAME` | `Company Name: COMPANYNAME` |
| Output JSON field names | camelCase | `"revenueModel"`, `"hasLogin"`, `"linkedinUrl"` | `"revenue_model"`, `"Revenue Model"` |

### Consistency Rule — The #1 Quality Issue

Output formatting must be **identical** everywhere it appears in the prompt — Output Format section, every Example, every Edge Case reference. Same field names, same casing, same structure. This is the most common quality failure: schema says `companyName`, examples say `company_name`, downstream formula breaks.

**Process:** write the Output Format section first, then copy-paste the exact schema into every example. After writing examples, manually verify each field-for-field.

### Production Convention: `#CONTEXT#` Opener

Many production prompts open with `#CONTEXT#\n` before the OBJECTIVE block. This isn't required, but is widely adopted. Either is fine.

### Imperative Voice — Always

Claygent responds to directive language. Never use passive voice in instructions.

| Wrong | Right |
|---|---|
| "The website should be analyzed" | "Analyze the website" |
| "Information may be extracted from..." | "Extract X from Y" |
| "It is recommended to..." | "You MUST..." |

End the prompt with a clear call to action: `Return your JSON output now.` or `Write your output below:`. Without this, Claygent sometimes echoes input or adds preamble.

---

## SECTION 3: OUTPUT CONTRACTS (SHARED)

The output format section is a **contract** with downstream formulas. Broken contracts silently corrupt entire pipelines. Apply these rules to every prompt regardless of mode.

### Forbidden Strings — Absolute List

The model defaults to natural-language non-answers. Downstream formulas can't handle them.

```
FORBIDDEN — never return any of these as a string value:
- "N/A"
- "Unknown"
- "Not Available"
- "Not Found"  (unless it is a defined enum value in a classification field)
- "Unable to..."
- "I could not find..."
- "As of my knowledge cutoff..."
- "No recent..."
- null  (for string fields)
```

### Null Policy — Always Empty String, Stated 3+ Times

For string fields where data is missing: return `""` (empty string).

Why: `""` is unambiguously falsy in JS — downstream formulas reduce to `!!{{Col}}`. `"Unknown"` is truthy and pollutes every gate. `"N/A"` breaks `=== null` checks.

**State the empty-string policy at least 3 times in the prompt:**
1. In OBJECTIVE.
2. In a dedicated POLICIES FOR NULL RESULTS section.
3. In at least one EXAMPLE that returns the null shape.

Once is not enough. Claygent reverts to "Unknown" if the rule isn't reinforced.

### Boolean and Classification Fields

- Booleans: `true` / `false` literals — never strings.
- Classification fields with a fixed enum: list the allowed values explicitly.
- Confidence: standardize on the enum — don't leave it open.

```
confidence: "very high" | "high" | "medium" | "low" | "very low"
```

If you say *"classify as current or historical"* without enumeration, the model will also return "Former Employment," "Previous Role," "Past Work," etc. Explicit enum prevents this.

### JSON Schema — Show Concrete, Not Abstract

Always show a real example schema, not just a description. Use real example values (Microsoft, LinkedIn, Sephora) not placeholders like `[company]`.

```json
{
  "linkedinUrl": "https://linkedin.com/in/example",
  "matchType": "Current Employment",
  "confidence": "high",
  "stepsTaken": [
    "Searched LinkedIn for 'John Smith VP Engineering Acme'",
    "Filtered by location match",
    "Verified current employer via company page"
  ]
}
```

For optional fields, show empty strings (`""`) explicitly — tells the model the field is required-but-empty rather than omittable.

### Output Format Closing Directive

End the OUTPUT FORMAT section with:

```
Return ONLY the JSON object. No markdown, no code blocks, no backticks, no explanations, no preamble.
```

Without this, Claygent wraps output in `\`\`\`json` blocks, breaking parsing.

### URL Validation (when output includes URLs)

```
URL Validation:
- MUST be functional and lead to the correct profile / page
- Keep the original working URL — don't "standardize" to a broken canonical form
- Regional LinkedIn URLs (br.linkedin.com, ar.linkedin.com) are acceptable
- FORBIDDEN: tracking params, shortened forms, redirects you haven't followed
```

### Steps Taken / Audit Log Pattern (optional)

For high-stakes prompts (identity verification, employment match), include a `stepsTaken` array — chronological actions performed. Adds 200–400 chars of output per row but makes debugging "Not found" rows tractable.

```json
{
  "stepsTaken": [
    "Searched LinkedIn for 'John Smith VP Engineering Acme Corp'",
    "Found 3 results, filtered by location match",
    "Verified current employer via company page"
  ]
}
```

Use only where debugging value exceeds the credit cost.

---

## SECTION 4: WEB RESEARCH MODE — Mandatory Sections

Use this section structure for any prompt with `useCase="claygent"` (internet access).

### The 12 Mandatory Sections, in Order

#### 1. OBJECTIVE
- One to three sentences: role + task + null policy (first mention).
- Always start with: *"You are an expert [DOMAIN] analyst..."*
- State the task in directive language: *"Your task is to..."* or *"You MUST..."*

#### 2. INPUT DEFINITION
- List every input with field name (snake_case), data type, description.
- Note which inputs may be null/empty and how to handle.

#### 3. INPUT DATA
- Filler variables in ALL CAPS, no brackets.

```
company_name: COMPANYNAME
company_domain: COMPANYDOMAIN
```

#### 4. RESEARCH METHODOLOGY / SEARCH STRATEGY

**The core differentiator of a web research prompt.** Quality of this section determines accuracy.

Organize into priority phases — highest-accuracy sources first, fallbacks later.

**Be prescriptive vs. open based on the task type:**

| Task Type | Approach | Example |
|---|---|---|
| Finding specific facts | **Prescriptive** — explicit queries, named sites | `"COMPANYNAME" headquarters address`, `site:sec.gov "COMPANYNAME" 10-K` |
| Analysis or judgment | **Open / Flexible** — guiding principles | "Start with the company website to understand core business, then cross-reference..." |
| Classification with controlled output | **Hybrid** — prescriptive sources for definitive answers, flexible for ambiguous | Check stock exchanges first (definitive), then fall back to business databases |

**Prescriptive example (structured data):**

```
### Phase 1: Direct Company Sources (Highest Priority)
1. Navigate to COMPANYDOMAIN
   - Check: About page, Contact page, Footer
   - Extract: Headquarters address, phone number

### Phase 2: Authoritative Third-Party Sources
Execute these specific search queries:
- "COMPANYNAME" headquarters address
- site:sec.gov "COMPANYNAME" 10-K
- site:crunchbase.com COMPANYNAME
- site:bloomberg.com COMPANYNAME
```

**Open example (analysis):**

```
### Research Approach
1. Start with the company website to understand their core business.
2. Search for recent news, press releases, industry coverage.
3. Analyze job postings for technology and growth signals.
4. Cross-reference findings across multiple sources before concluding.
```

**Search query best practices:**
- Keep queries simple: `"COMPANYNAME" keyword1 keyword2`. Avoid complex Google operators.
- Use `site:` for domain targeting (LinkedIn, Crunchbase, SEC).
- Include company domain when disambiguating common names.
- For international companies: include navigation guidance for foreign-language sites and ccTLDs.

#### 5. KEY DEFINITIONS (if applicable)
- Define classification taxonomies, categories, picklists.
- If the output is from a controlled set, list every value with explicit criteria.
- **Exhaustive definitions prevent hallucinated categories.** If you define 4, the model returns those 4. Vague → invented categories.

#### 6. CLASSIFICATION LOGIC / DECISION FRAMEWORK (if applicable)
- Step-by-step decision logic.
- Priority ordering when categories could overlap.
- Explicit "if X then Y" rules.
- Without priority ordering, ambiguous inputs produce inconsistent results across rows.

#### 7. EDGE CASES (5–8 minimum)

Cover at minimum these 8:
1. Company no longer exists / domain is dead.
2. Recent rebrand or acquisition.
3. Private vs. public data availability.
4. Conflicting information across sources.
5. International / non-English companies.
6. Subsidiaries vs. parent companies.
7. Stealth or pre-launch companies.
8. Null / empty / garbage input.

For each: specify the exact expected output.

#### 8. POLICIES FOR CONFLICTING DATA
- Define a source priority hierarchy (e.g., company website > SEC filings > Crunchbase > news).
- Specify how to resolve when authoritative sources disagree.
- Include a "recency wins" tiebreaker when applicable.
- **Be specific.** *"Use the most authoritative source"* is too vague. *"Company website takes precedence for positioning; SEC filings take precedence for financial facts"* is actionable.

#### 9. POLICIES FOR NULL RESULTS
- Empty string `""` policy (second mention of null policy).
- Specify exact null output format matching OUTPUT FORMAT.

#### 10. OUTPUT FORMAT
- Exact JSON schema with camelCase fields.
- Booleans as `true`/`false`, not strings.
- Closing directive: *"Return ONLY the JSON object. No markdown, no code blocks, no backticks, no explanations, no preamble."*

#### 11. EXAMPLES (5–8, ideally diverse)

Each example MUST include:
1. **Input data** — actual values.
2. **Web Findings** — brief description of what research would find (teaches Claygent the methodology).
3. **Output** — exact JSON matching OUTPUT FORMAT.

Coverage:
- 2–3 happy-path / common scenarios.
- 2–3 edge cases.
- 1 null-result scenario showing empty-string output (third mention of null policy).

**Diversity matters.** Don't use 5 SaaS companies — use a SaaS company, a manufacturer, a non-profit, an international company, and a stealth startup.

#### 12. VALIDATION RULES

```
Before outputting, verify:
1. Every value in your output came from a source you visited (not from memory or inference).
2. No field contains "N/A", "Unknown", "Not Found", or null — use empty string "" instead.
3. All JSON fields match the Output Format schema exactly.
4. Output is valid JSON with no markdown, code blocks, or preamble.

Return your JSON output now.
```

---

## SECTION 5: CONTENT MANIPULATION MODE — Mandatory Sections

Use this section structure for any prompt with `useCase="use-ai"` (no internet).

### The 10 Mandatory Sections, in Order

#### 1. OBJECTIVE
- Role + task description.
- **Explicitly state**: *"This is a content manipulation and reasoning task. You do NOT have access to the internet. You must base your determination solely on the data provided in the inputs and the classification rules below."*
- This internet-restriction line is critical. Without it, Claygent attempts web searches, wastes tokens, and produces inconsistent results.

#### 2. INPUT DEFINITION
- List every input: snake_case field name, data type, description.
- For complex JSON inputs: describe the schema and the key nested fields the prompt will access.
- Note which inputs may be null/empty and how to handle.

#### 3. INPUT DATA
- Filler variables in ALL CAPS, no brackets.

```
job_title: JOBTITLE
company_name: COMPANYNAME
enrichment_payload: ENRICHMENTPAYLOAD
```

#### 4. KEY DEFINITIONS / CLASSIFICATION LOGIC

**The core of a content manipulation prompt.** Where web research has search strategy as its core, this mode has reasoning rules as its core.

- Define every category, taxonomy, keyword, and decision tree.
- **Use priority ordering** — *"evaluate in this order, stop at first match."*
- Include both **inclusion keywords** AND **exclusion keywords** when applicable.
- For scoring/tiering: define all thresholds and weight calculations explicitly.

**Classification pattern:**

```
### Classification Priority Order

Evaluate in the following order. Once a confident match is found, STOP and return that segment.

**Priority 1: [Category Name]**
Keywords: [keyword1], [keyword2]
Exclusions: [excluded_keyword1]
Notes: [special handling rules]

**Priority 2: [Category Name]**
Keywords: [...]
Exclusions: [...]
```

**Scoring/Tiering pattern:**

```
### Scoring Components

Component 1: [Name] (0-X points)
- If [condition]: X points
- If [condition]: Y points

Component 2: [Name] (0-X points)
- [...]

### Tier Thresholds
- Tier 1: Score >= X
- Tier 2: Score >= Y
- Tier 3: Score >= Z
```

**Synthesis / Aggregation pattern:**

```
### Synthesis Instructions

1. Read all three input payloads.
2. For each signal dimension, evaluate:
   - Is there evidence? (boolean)
   - What is the severity? (high/medium/low)
   - What is the source evidence?
3. Aggregate across dimensions using [weighting logic].
4. Produce final determination.
```

#### 5. EDGE CASES (5–8 minimum)

Common content manipulation edge cases:
- Null / empty / whitespace-only input.
- Input in unexpected language or format.
- Input that matches multiple categories.
- Input with contradictory signals.
- Abbreviated or truncated inputs.
- Inputs with special characters / encoding issues.
- Inputs that don't match any defined category (catch-all / "Unknown").

For each: specify exact expected output.

#### 6. POLICIES FOR CONFLICTING SIGNALS
- When multiple input fields suggest different classifications, define resolution logic.
- *"Keyword match takes priority over contextual inference"*, *"If two categories match, use the higher-priority one"*, etc.

#### 7. POLICIES FOR NULL RESULTS
- Empty string `""` for null results (second mention of null policy).
- Exception: if "Unknown" is an explicit category in the taxonomy, that's a valid output.
- Specify exact null output format matching OUTPUT FORMAT.

#### 8. OUTPUT FORMAT
- Exact JSON schema with camelCase fields.
- Format identical everywhere in the prompt.
- For written briefs: specify markdown formatting rules, header hierarchy, sections to include/omit.
- Closing directive: *"Return ONLY the JSON object. No additional commentary."*

#### 9. EXAMPLES (5–8 minimum)

Each example MUST include:
1. **Input data** — actual values.
2. **Reasoning** — brief explanation of how the logic applied (teaches the model the thought process).
3. **Output** — exact JSON matching OUTPUT FORMAT.

Coverage: happy paths + edge cases + null result (third mention of null policy).

**Examples > instructions.** The model learns patterns from worked examples more reliably than from rules. If you can only invest extra effort in one section, invest it here.

#### 10. VALIDATION RULES (optional but recommended)

```
Before outputting, verify:
1. Output matches one of the enum values defined in Key Definitions.
2. All required JSON fields are present.
3. No field contains "N/A", "Unknown", "Not Found", or null — use empty string "" instead.
4. Output is valid JSON with no markdown or preamble.
```

---

## SECTION 6: COMMON FAILURE MODES & PREVENTION

### Failure: Claygent Echoes Input Instead of Generating Output

**Cause:** prompt is too passive. The model treats input data as the answer.

**Prevention:**
- Imperative voice throughout: *"You MUST analyze..."*, *"Write your output below:"*, *"Return ONLY..."*
- End with a clear call to action: *"Return your JSON output now."*
- Add: *"Do NOT output the input data. Do NOT echo the input. Generate a NEW output based on your research/reasoning."*

### Failure: Hallucinated Data

**Cause:** no anti-hallucination guardrails.

**Prevention:**
- *"Every fact in your output must come from a source you visited. Do not infer, guess, or use training data."*
- For value extraction: *"Copy values character-for-character from the source. Do not modify, auto-correct, or transpose."*
- Require source cross-referencing: *"Verify key facts across at least 2 sources before including in output."*

### Failure: Output Format Mismatch

**Cause:** Output Format section says one thing, examples show another.

**Prevention:**
- Write Output Format first, then copy-paste schema into every example.
- After writing examples, verify each field-for-field against the schema.
- Use the quality checklist in Section 7.

### Failure: "Unknown" or "N/A" in Output

**Cause:** null policy stated only once.

**Prevention:**
- State empty-string policy 3+ times: OBJECTIVE, NULL POLICIES section, at least one example.
- Include a dedicated null-result example.
- In VALIDATION: *"Before outputting, verify no field contains 'N/A', 'Unknown', 'Not Found', or 'null'. Replace any such values with empty string."*

### Failure: Markdown Wrapping Instead of Raw JSON

**Cause:** no format restriction.

**Prevention:**
- Add to OUTPUT FORMAT: *"Return ONLY the JSON object. No markdown, no code blocks, no backticks, no explanations, no preamble."*
- *"Your entire response must be valid JSON and nothing else."*

### Failure: Output Casing Inconsistency vs. Source

**Cause:** source data uses different casing than expected (e.g., USASpending.gov uses ALL CAPS, prompt assumes Title Case).

**Prevention:**
- Research the source's actual formatting first.
- Include explicit casing rules in OUTPUT FORMAT.
- Update ALL examples to match the actual source formatting.

### Failure: Content Manipulation Prompt Tries to Search Web

**Cause:** missing internet restriction in OBJECTIVE.

**Prevention:**
- *"You do NOT have access to the internet. You must base your determination solely on the data provided in the inputs."*
- Reinforce in VALIDATION if needed.

### Failure: Null Inputs Cause Malformed Output

**Cause:** no null-input example.

**Prevention:**
- Include an EXAMPLE where the input is null/empty.
- Show the exact null-shape output.

---

## SECTION 7: QUALITY CHECKLISTS

### Web Research Mode

- [ ] (Rewriting only) Step 0 diagnostic ran: fetched get_record on 2-3 representative rows, read stepsTaken / reasoning / sources / output shape from runtime nested JSON
- [ ] OBJECTIVE uses imperative voice and starts with *"You are an expert..."*
- [ ] All 12 mandatory sections present and in order
- [ ] All major sections use `==================` block delimiters
- [ ] Filler variables: ALL CAPS, no brackets
- [ ] Input field labels: snake_case
- [ ] Output JSON: camelCase
- [ ] Output format identical across OUTPUT FORMAT, examples, and edge cases
- [ ] At least 5 examples (happy + edge + null), diverse industries
- [ ] Each example includes: input data, web findings, output
- [ ] Empty-string null policy stated 3+ times (OBJECTIVE, NULL POLICIES, ≥1 example)
- [ ] Search strategy organized by priority phases
- [ ] Edge cases include: rebrands, acquisitions, international, conflicting data, dead domains, null input
- [ ] Conflicting data policy includes specific source priority hierarchy
- [ ] Logic summary was confirmed by user before full prompt was written
- [ ] Prompt ends with directive call to action
- [ ] Anti-hallucination guardrails included (especially for value extraction)

### Content Manipulation Mode

- [ ] (Rewriting only) Step 0 diagnostic ran: fetched get_record on 2-3 representative rows, read reasoning / output shape / confidence consistency from runtime nested JSON
- [ ] OBJECTIVE explicitly states *"no internet access"* / *"content manipulation and reasoning task"*
- [ ] All 10 mandatory sections present and in order
- [ ] All major sections use `==================` block delimiters
- [ ] Filler variables: ALL CAPS, no brackets
- [ ] Input field labels: snake_case
- [ ] Output JSON: camelCase
- [ ] Output format identical across OUTPUT FORMAT, examples, and edge cases
- [ ] At least 5 examples with reasoning
- [ ] Empty-string null policy stated 3+ times
- [ ] Classification logic uses priority ordering
- [ ] Keyword lists include both inclusions AND exclusions
- [ ] Edge cases cover: null input, multi-match, ambiguous, unexpected format
- [ ] Logic summary was confirmed by user before full prompt was written
- [ ] For written brief outputs: markdown formatting rules specified

---

## SECTION 8: ACTION KEYS, MODELS, AND SCHEMA REFERENCE

### Action Keys

| Action Key + useCase | Mode | Output Access in Formula |
|---|---|---|
| `use-ai` with `useCase="claygent"` | Web Research | `?.response` (string) — or direct field access if structured |
| `use-ai` with `useCase="use-ai"` | Content Manipulation | Direct field access — `?.fieldName` |
| `claygent` (legacy) | Web Research | `?.result` or direct field access |

### Model Cost Ladder (Cheapest → Most Capable)

- **`clay-argon`** — lightweight classification, domain status check, binary yes/no. Cheapest.
- **`gpt-4o-mini` / `clay-neon`** — structured JSON output, article summarization, mid-complexity reasoning.
- **`gpt-4o` / `gpt-4.1`** — open-ended multilingual web research, disambiguation, judgment tasks across unpredictable sources.
- **`gpt-5`** — deep reasoning, multi-step inference, when the task requires planning over evidence.

**Match model to task:** cheaper for well-scoped classification, more capable for synthesis across unpredictable sources. Don't pay for `gpt-4o` on a binary "is this a domain?" check.

### Where Prompts Live in Clay's Schema

Claygent and Use AI prompts are stored in `typeSettings.inputsBinding`. When reading a Clay table's schema (e.g., via slab's `sync_table`), look for the binding with `name: "prompt"`:

```json
{
  "actionKey": "use-ai",
  "inputsBinding": [
    { "name": "useCase", "formulaText": "\"claygent\"" },
    { "name": "prompt",  "formulaText": "\"Your prompt text here...\"" },
    { "name": "model",   "formulaText": "\"gpt-4.1-mini\"" }
  ]
}
```

When reviewing or rewriting a prompt, read the existing `prompt` binding's `formulaText`, apply the changes, and return the updated text.

---

## SECTION 9: TEMPLATES

### Web Research Template

```
==========================================
OBJECTIVE
==========================================

You are an expert [DOMAIN] analyst specializing in [SPECIALTY]. Your task is to [TASK DESCRIPTION] using authoritative web sources. Return ONLY the structured output specified below — no additional text, no markdown, no explanations.

If you cannot determine a value with confidence, output an empty string "" for that field. NEVER output "N/A", "Unknown", or "Not Found".

==========================================
INPUT DEFINITION
==========================================

**company_name** — The official name of the company to research. May be null.
**company_domain** — The primary web domain (without protocol). Used as the starting point for research. May be null.

==========================================
INPUT DATA
==========================================

company_name: COMPANYNAME
company_domain: COMPANYDOMAIN

==========================================
RESEARCH METHODOLOGY
==========================================

Execute research in the following priority order:

### Phase 1: Direct Company Sources (Highest Priority)
[...]

### Phase 2: Authoritative Third-Party Sources
[...]

### Phase 3: Supplementary Sources (Fallback)
[...]

==========================================
KEY DEFINITIONS
==========================================

[If applicable — taxonomies, categories, picklists with clear criteria]

==========================================
CLASSIFICATION LOGIC
==========================================

[If applicable — step-by-step decision framework with priority ordering]

==========================================
EDGE CASES
==========================================

[5-8 edge cases with expected outputs]

==========================================
POLICIES
==========================================

### Conflicting Data
[Specific source priority hierarchy and resolution rules]

### Null Results
Output empty string "" for any field where data cannot be confidently determined. NEVER output "N/A", "Unknown", "Not Found", or null.

==========================================
OUTPUT FORMAT
==========================================

Return ONLY a JSON object with no additional text:

{
  "fieldOne": "value",
  "fieldTwo": true,
  "fieldThree": []
}

==========================================
EXAMPLES
==========================================

### Example 1: [Scenario Name]
**Input:**
company_name: Sephora
company_domain: sephora.com

**Web Findings:**
[Brief description of what research would find]

**Output:**
{
  "fieldOne": "value",
  "fieldTwo": true,
  "fieldThree": ["item1", "item2"]
}

### Example 2: [Edge Case Name]
[...]

### Example N: Null Result
**Input:**
company_name: XYZ Stealth Corp
company_domain: xyzstealthcorp.com

**Web Findings:**
Domain is parked. No company information found on any source.

**Output:**
{
  "fieldOne": "",
  "fieldTwo": "",
  "fieldThree": []
}

==========================================
VALIDATION
==========================================

Before outputting, verify:
1. Every value in your output came from a source you visited (not from memory or inference).
2. No field contains "N/A", "Unknown", "Not Found", or null — use empty string "" instead.
3. All JSON fields match the Output Format schema exactly.
4. Output is valid JSON with no markdown, code blocks, or preamble.

Return your JSON output now.
```

### Content Manipulation Template

```
==========================================
OBJECTIVE
==========================================

You are an expert [DOMAIN] analyst. Your task is to [TASK DESCRIPTION] based solely on the provided input data.

This is a content manipulation and reasoning task. You do NOT have access to the internet. You must base your determination solely on the data provided and the classification rules below.

==========================================
INPUT DEFINITION
==========================================

**job_title** — The full job title string of a person. May contain seniority prefixes, functional descriptors, abbreviations, and international variants. May also be null or empty.

==========================================
INPUT DATA
==========================================

job_title: JOBTITLE

==========================================
KEY DEFINITIONS
==========================================

### [Taxonomy Name] (Ordered by Classification Priority)

Evaluate in the following order. Once a match is found, stop and return that segment.

**Priority 1: [Category]**
Keywords: [...]
Exclusions: [...]
Notes: [...]

**Priority 2: [Category]**
[...]

==========================================
CLASSIFICATION LOGIC
==========================================

### Step 1: Check for Null/Empty Input
If input is null, empty, or whitespace-only → output the null shape defined in OUTPUT FORMAT.

### Step 2: Priority Matching
Evaluate against each priority level in order...

### Step 3: Contextual Reasoning
If no keyword match, use contextual reasoning based on [...]

==========================================
EDGE CASES
==========================================

| Scenario | Input | Expected Output |
|----------|-------|-----------------|
| Null input | "" | {"classification": "", "confidence": ""} |
| Multi-match | "VP of Sales Engineering" | Priority determines... |
| [...] | [...] | [...] |

==========================================
POLICIES
==========================================

### Conflicting Signals
[Resolution logic]

### Null Results
Output empty string "" for any field where data cannot be determined.

==========================================
OUTPUT FORMAT
==========================================

Return ONLY a JSON object:

{
  "classification": "value",
  "confidence": "high"
}

==========================================
EXAMPLES
==========================================

### Example 1: [Standard Classification]
**Input:**
job_title: Chief Financial Officer

**Reasoning:**
"Chief" prefix matches C-Level keywords. No exclusions triggered. Priority 3 match.

**Output:**
{
  "classification": "C-Level",
  "confidence": "high"
}

### Example 2: [Ambiguous Input]
[...]

### Example N: [Null Result]
**Input:**
job_title: ""

**Reasoning:**
Input is empty. Null input policy applies.

**Output:**
{
  "classification": "",
  "confidence": ""
}
```

---

## SECTION 10: NOTES FOR CLAUDE

### Behavioral Rules

1. **Always pick the mode first.** Web Research vs. Content Manipulation. Don't blur the boundary — the section structure differs.
2. **Always present a logic summary before writing.** Never skip this step. The user explicitly values alignment before execution.
3. **Always ask edge case questions when unsure.** *"Do you have any specific edge cases I should handle, or should I identify them based on my expertise?"*
4. **Match prescriptiveness to task type.** Structured data gathering needs explicit search queries. Analysis/judgment tasks need guiding principles. Classification with controlled output is hybrid. When in doubt, ask the user.
5. **Never use passive voice.** Imperative language throughout: *"Analyze the website,"* not *"The website should be analyzed."*
6. **Examples are the highest-leverage section.** The model learns patterns from worked examples more reliably than from rules. Invest extra effort here.
7. **Repeat the empty-string policy 3+ times.** Once is not enough. The model reverts to "Unknown" or "N/A" without reinforcement.
8. **Source formatting matters.** When extracting from a specific source (USASpending.gov, LinkedIn, SEC), research what casing and abbreviations the source actually uses, then reflect that in OUTPUT FORMAT and examples.
9. **When a prompt fails in production, the most common fixes are (in order):**
   - Add more directive language (imperative tone, *"YOU MUST"*, *"Return ONLY"*).
   - Add an explicit *"YOUR TASK"* section near the end that restates what to do.
   - Add anti-hallucination rules.
   - Fix output format inconsistencies between schema and examples.
   - Add more examples covering the failure case.

### What This Skill Replaces

This skill encodes the prompt-engineering conventions used across production Clay tables. You don't need a separate "100% optimized prompt template" pasted in — the rules and section structure here ARE that template. When the user references conventions like "the prompt engineering prompt," they mean the rules in this skill.

### What You Don't Need to Be Told

- How to structure a system prompt at the model layer (you already know).
- General prompt engineering theory (you already know).
- How to write examples (you already know — the skill just adds the format constraints).

### What You Need This Skill For

- The Clay-shaped section structure (12 sections for web research, 10 for content manipulation, in this exact order).
- The casing conventions (snake_case input labels, camelCase output, ALL CAPS filler variables).
- The empty-string null policy and the requirement to state it 3+ times.
- The forbidden-strings list and the failure modes that motivate it.
- The "logic summary first, then write" workflow gate.
- The action key + model selection ladder.
- Where prompts live in Clay's schema when you're reading or rewriting an existing one.
