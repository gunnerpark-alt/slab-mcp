---
type: reference
section: core
tags: [data-model, columns, schema, formula, action]
description: "Defines Clay's four column types (text, formula, action, source), the 8KB/200KB size tiers, and how to correctly reference fields using {{Column Name}} vs {{f_xxxx}}."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Clay Data Model

Clay tables are spreadsheets where every row is a record and every column is either a computation or an API call. Columns run left-to-right within a row.

---

## Column Types

| Type | Description | Output Limit |
|------|-------------|--------------|
| `text` / `basic` | Manual input or imported data | — |
| `formula` | JavaScript expression computed from other columns | 8 KB |
| `action` | Enrichment / API call; has run conditions + cell status | 200 KB |
| `source` | Data source: webhook, find companies/people, CSV import | — |

**Key distinction:** When a formula column hits its 8 KB limit or needs to hold an array safely, wrap the logic in an action column (`Filter List of Objects` is the most common container).

---

## Column Reference Syntax

In `schema.json` formulas store field ID references: `{{f_xxxx}}`  
In the Clay UI and in all paste-ready output, use column names: `{{Column Name}}`

Always output `{{Column Name}}` format, never `{{f_xxxx}}`.

---

## schema.json — Field Structure

```
fields[].id             Internal field ID (format: f_xxxx)
fields[].name           Column name as shown in Clay
fields[].type           Column type: "text" | "formula" | "action" | "source"
fields[].typeSettings   Full configuration object
fieldOrder              Array of field IDs in display order (left → right)
```

For **formula** columns, `typeSettings` contains:
- `formulaText` — the JavaScript expression (field ID refs, not names)
- `formulaType` — output type hint (`"text"`, `"waterfall"`, etc.)
- `formulaWaterfall[]` — array of `{ formula }` steps (if waterfall type)

For **action** columns, `typeSettings` contains:
- `actionKey` — the enrichment provider/action identifier
- `inputsBinding[]` — `{ name, formulaText }` — how inputs are mapped
- `conditionalRunFormulaText` — run condition (if any)
- `authAccountId` — connected account ID

---

## Clay-Specific Functions

```javascript
DOMAIN(url)                // extract domain from URL: "https://clay.com" → "clay.com"
CONCATENATE(a, b, c)       // join strings
UPPER(text)                // uppercase
LOWER(text)                // lowercase
IF(condition, then, else)  // conditional
COALESCE(a, b, c)          // first non-empty value
CONTAINS(text, search)     // true if text contains search string
LEN(text)                  // string length
```

---

## Lookup Column Patterns

Lookup columns (Salesforce SOQL, Filter List of Objects, Audiences) return `{ records: [...] }`, not raw arrays.

```javascript
// BROKEN — not a plain array
{{Salesforce Lookup}}.map(r => r.Name)

// CORRECT
({{Salesforce Lookup}}?.records || []).map(r => r.fields?.Name)

// Access a specific field from first record
{{Salesforce Lookup}}?.records?.[0]?.fields?.["Account Name"]
```

---

## Provider Output Field Access — Non-Obvious Paths

| Provider | Pattern | Note |
|---|---|---|
| Salesforce SOQL | `?.records?.[0]?.fields?.["Field Name"]` | |
| HubSpot lookup | `?.results?.[0]?.properties?.fieldName` | Different from SFDC |
| Dropcontact | `?.data.email` | NOT `.email` |
| Forager phone | `?.phone_numbers[0]` | Array |
| Mixrank person | `?.summary`, `?.headline`, `?.picture_url_orig` | Note `_orig` suffix |
| Claygent | `?.response` | For `useCase="claygent"` |
| Legacy Claygent | `?.result` | `claygent` action key |
| Use AI (content) | `.fieldName` directly on result | No wrapper |
| HG Insights tech | `?.products[0].product_name` | `.products` is array |
| Experience array | `?.experience?.[0]?.title` | First entry = most recent |

---

## Mixed Email Array Consolidation

When a waterfall uses providers returning email in different formats (string vs nested array):

```javascript
// Gate: "does any prior step already have a valid email?"
!([ {{Provider1}}?.email, {{Provider2}}?.email?.[0]?.email ])
  .filter(e => !!e)
  .find(e => e === {{Validate Step}}?.email)

// Consolidation formula
{{Provider1}}?.email || {{Provider2}}?.email?.[0]?.email || ""
```

---

## analysis.json — Automated Analysis

Contains: `issues[]`, `dependencyGraph`, `enrichmentFlow`, `dataQuality`

- `dataQuality.lowFillColumns` — columns with low non-empty % 
- `issues` with `severity: "error"` — dead field ID references, forward-reference bugs

---

## Related

- [[formulas/syntax|Formula Syntax]] — syntax rules and optional-chaining requirements for accessing the fields documented here
- [[core/builder-patterns|Builder Patterns]] — workarounds when formula columns hit the 8 KB limit
- [[providers/reference|Provider Reference]] — full table of provider output field paths
- [[debugging/playbook|Debugging Playbook]] — diagnostic formulas for inspecting column values and schema structure
