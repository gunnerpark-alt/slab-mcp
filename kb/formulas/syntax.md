---
type: reference
section: formulas
tags: [formulas, syntax, javascript, lodash, anti-patterns]
description: "Clay formula sandbox constraints: available libraries (Lodash, Moment, Clay utils), 8 critical syntax rules, and a definitive list of broken JS features with their working substitutes."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Formula Syntax Reference

Clay formulas are JavaScript expressions running inside Clay's custom sandboxed environment. They share JS syntax but are **not standard JavaScript** — specific constraints apply.

---

## Runtime Environment

### Available Libraries

| Library | Global | Notes |
|---------|--------|-------|
| Lodash | `_` | Full library |
| Moment.js | `moment` | Core API only — no plugins |
| JSON | `JSON` | `JSON.parse()`, `JSON.stringify()` |
| Clay Utilities | `Clay` (capital C) | `Clay.getCellStatus()`, `Clay.formatForAIPrompt()` |

### NOT Available / Broken

| Feature | Status | Workaround |
|---------|--------|------------|
| `atob()` | Does NOT work | Use external action for Base64 decode |
| `_.template()` | Does NOT work | Use `+` string concatenation |
| Template literals (backticks) | Does NOT work | Use `+` concatenation |
| `return` statements | Does NOT work | Formula IS the expression |
| IIFEs / function wrappers | Does NOT work | Pure expression only (exception: try/catch) |
| `let` / `const` / `var` | Does NOT work at top level | Use inline expressions |
| `.replace(/regex/, str)` | Does NOT work reliably | `.split("x").join("y")` |
| `.replaceAll("x", "y")` | Does NOT work | `.split("x").join("y")` |
| `{...obj}` spread on complex objects | Unreliable | Explicit key mapping |
| `[...arr1, ...arr2]` spread | Unconfirmed | Use `[].concat(arr1).concat(arr2)` |

---

## The 8 Critical Syntax Rules

### Rule 1 — Expressions only: no return, no function wrappers, no variable declarations

```javascript
// BROKEN
return myValue + 1
const x = {{Column}}; x + 1

// CORRECT
{{Column}} + 1
```

**Exception:** IIFEs are acceptable when you need try/catch (e.g., `new URL()`, `JSON.parse()`).

### Rule 2 — No template literals

```javascript
// BROKEN
`${m.name} at ${m.time}`

// CORRECT
m.name + " at " + m.time
```

### Rule 3 — Mandatory optional chaining everywhere

```javascript
// BROKEN — will throw if ANY level is null
{{Enrich person}}.experience.filter(e => e.company)

// CORRECT
{{Enrich person}}?.experience?.filter(e => e?.company)
```

### Rule 4 — No regex in .replace()

```javascript
// BROKEN
{{Domain}}.replace(/https?:\/\//, "")

// CORRECT
{{Domain}}.split("https://").join("").split("http://").join("")
```

### Rule 5 — Lodash for set operations

```javascript
[...new Set(arr)]     // BROKEN
_.uniq(arr)           // CORRECT

_.some(array, pred)   // preferred over .some() — handles null arrays gracefully
```

### Rule 6 — Clay utilities use capital C with full optional chaining

```javascript
// BROKEN
clay.getCellStatus({{Column}})
Clay.getCellStatus({{Column}}).toLowerCase()

// CORRECT
Clay?.getCellStatus?.({{Column}})?.toLowerCase()?.includes("error")
```

Common statuses: `"success"`, `"error"`, `"unknown"` (not run yet), `"running"`

**`Clay.formatForAIPrompt(value)`** — sanitizes a column value for safe inclusion in a Claygent prompt string. Handles nulls and formatting edge cases. Use in prompt formula text instead of raw `{{Column}}` concatenation when the value may have special characters:

```javascript
// In a Claygent prompt formulaText:
"Find the domain for: " + Clay.formatForAIPrompt({{Input Company Name}}) + ". Return JSON."
```

### Rule 7 — No object spread or Object.assign on enrichment objects

```javascript
// BROKEN
{ ...{{Enrich Person}}, identifier: true }

// CORRECT — wrap as named property
{ enrichPersonData: {{Enrich Person}}, identifier: true }
```

### Rule 8 — Type coercion: wrap scores with Number()

```javascript
// BUG — "3" + "1" = "31"
({{Score_A}} || 0) + ({{Score_B}} || 0)

// CORRECT
Number({{Score_A}} || 0) + Number({{Score_B}} || 0)
```

---

## Anti-Pattern Quick Reference

| Anti-Pattern | Fix |
|---|---|
| `return value` | Just `value` |
| `` `${var}` `` | `"" + var` |
| `.replace(/re/, str)` | `.split("x").join("y")` |
| `[...new Set(arr)]` | `_.uniq(arr)` |
| `{...obj}` | Explicit key mapping |
| `{{Col}}.prop` | `{{Col}}?.prop` |
| `const x = ...; x` | Inline expression |
| `{{Lookup}}.map(...)` | `({{Lookup}}?.records \|\| []).map(...)` |
| `{{Filter}}?.map(...)` | `({{Filter}}?.filteredArray \|\| []).map(...)` |
| `clay.getCellStatus()` | `Clay?.getCellStatus?.()` |
| `(score1 \|\| 0) + (score2 \|\| 0)` | `Number(score1 \|\| 0) + Number(score2 \|\| 0)` |

---

## Run Conditions

Run conditions use the same formula syntax — must evaluate truthy for the action to execute. Only reference columns that appear BEFORE the current column.

```javascript
// Run only if input exists
!!{{Domain}}

// Simple waterfall gate
!!{{Domain}} && !{{Enrichment Result}}

// Robust waterfall gate (handles errors, not just empty)
!{{Provider 1}} || Clay?.getCellStatus?.({{Provider 1}})?.toLowerCase()?.includes("error")

// Threshold gate
{{Score}} > 50 && !!{{Email}}

// Compound: input present AND output absent
({{domain}}) && !({{enrich_result}} && {{enrich_result}}?.revenue)
```

### AI "Not Found" String Handling

AI columns return a text string when nothing is found — not null. Gate downstream retry steps by normalizing:

```javascript
{{col}}?.toLowerCase() === "notfound" || {{col}}?.toLowerCase() === "not found"
```

### Compound Waterfall Gate (Multiple Providers)

```javascript
// Gate for 3rd provider: previous two both failed
(!({{p1}} && {{p1}}?.domain)) && !({{p2}} && {{p2}}?.domain)
```

The correct gate form is `!(field && field?.property)` — NOT just `!field?.property`. The outer `field &&` guards against the result object itself being null.

---

## Lookup Column Patterns

```javascript
// Lookup Multiple Rows
({{Lookup Multiple Rows in Other Table}}?.records || []).sort(...)
({{Lookup}}?.records || []).map(r => r.fields?.["Field Name"])

// Filter List of Objects uses .filteredArray
({{My Filter Column}}?.filteredArray || []).map(...)

// Salesforce SOQL
{{Salesforce Lookup}}?.records?.[0]?.fields?.["Account Name"]
({{Salesforce Lookup}}?.records || []).length > 0
```

---

## Source Column Parent Access

When a table has a **Source column** pulling rows from another table (via `route-row` or Find Companies/People), each row carries a `.parent` reference to the originating row. Formulas can access parent row data by column name:

```javascript
// Access parent row fields (bracket notation required — column names have spaces)
{{Source Column}}?.parent?.["Input Company Name"]
{{Source Column}}?.parent?.["Company Domain"]

// Access the current row's own data from the source
{{Source Column}}?.name
{{Source Column}}?.title
{{Source Column}}?.linkedin_url

// Safe conditional on parent URL field
{{Source Column}}?.linkedin_url?.includes("https://www.linkedin") ? {{Source Column}}?.linkedin_url : ""
```

**Key points:**
- `.parent` is always optional-chained (parent may not exist for manually added rows)
- Column name is bracket notation with quotes, not dot notation (`?.["Column Name"]` not `?.columnName`)
- Only columns that exist in the parent table and were included in the route-row payload are available

---

## Claygent Output Patterns

```javascript
// Claygent returns JSON — access properties directly
{{Claygent Company Domain}}?.final_domain
{{Claygent Board Members}}?.board_members       // array output
{{Claygent Result}}?.totalCostToAIProvider       // AI cost in dollars (float)

// Array outputs from Claygent — always guard with || []
({{Claygent Result}}?.companies || []).flat().map(x => x?.company_name || "").filter(Boolean).join(",")

// Multi-level array flatten + join for display
(({{Claygent Result}}?.companies || []).flat().map(event =>
  (event?.company_name || "") + "\n" + (event?.source_url || "")
)).join("\n\n")
```

**`?.totalCostToAIProvider`** — every Claygent (use-ai) column exposes this property on its output. Use it to track AI spend per row:

```javascript
{{Claygent Step 1}}?.totalCostToAIProvider        // cost for this step
({{Step1}}?.totalCostToAIProvider || 0) + ({{Step2}}?.totalCostToAIProvider || 0)  // sum across steps
```

---

## Confirmed Behaviors

| Feature | Works? | Notes |
|---|---|---|
| `.replace()` with string args | YES | Only regex arg is unreliable |
| `.replace()` with regex | UNRELIABLE | Use `.split().join()` |
| `.match()` with regex | YES | Returns match array or null |
| `RegExp.test()` | YES | `/pattern/.test(string)` works |
| `Array.isArray()` | YES | |
| `new URL()` | YES | Can throw — wrap in try/catch IIFE |
| `btoa()` | YES | Works for auth header construction |
| `atob()` | NO | Use Claygent or HTTP API action |
| IIFEs | USUALLY NO | Exception: when you need try/catch |
| `use-ai` output access | via `.response` | `{{field}}?.response` |
| `claygent` JSON output | direct access | `{{field}}?.propertyName` |

---

## Silent JS Precedence Bug

`!{{field}}.status === 'valid'` is always false. Due to operator precedence, `!` binds tighter than `===`.

**Correct forms:**
```javascript
{{field}}?.status !== 'valid'
!({{field}}?.status === 'valid')
```

---

## Formula Generator

Clay can write formula column expressions from a natural language description.

**How to use:** When adding a formula column, describe what you want in plain English — Clay generates the JavaScript expression. Edit as needed before saving.

**Column references in the generator:** Use `/` inside the prompt or description to reference columns by name. The generator inserts the correct `{{Column Name}}` syntax.

**When to use it:** Fastest for common patterns (string joins, conditionals, scoring formulas). For complex logic involving multiple optional chains, review the output carefully — the generator sometimes omits mandatory `?.` guards.

---

## Clay Formatters

Free transformations applied to text, dates, and numbers — no credits consumed.

**Access:** Add column → Formatter (distinct from formula column or action column).

**Common formatters:**
- `Format Date/Time` — converts a date string to a specified format (e.g., `YYYY-MM-DD`, `MMM D, YYYY`)
- Text case transformations (uppercase, lowercase, title case)
- Number formatting (currency, decimal places)
- URL normalization (strip protocol, extract domain)

**Key distinction from formulas:** Formatters are zero-cost; formula columns run in the JS sandbox. For simple transformations (date formatting, case conversion), prefer Formatters to avoid JS edge cases.

---

## Related

- [[core/data-model|Data Model]] — column types and the Clay-specific function library
- [[claygent/prompts|Claygent & Use AI]] — how AI output is accessed in formulas (`?.response` vs direct field)
- [[enrichment/waterfalls|Waterfalls]] — run condition patterns for waterfall gate logic
- [[debugging/playbook|Debugging Playbook]] — how to diagnose formula evaluation failures
