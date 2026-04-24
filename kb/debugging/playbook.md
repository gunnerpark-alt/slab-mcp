---
type: guide
section: debugging
tags: [debugging, playbook, diagnostic-formulas, yellow-triangle, action-status]
description: "Step-by-step diagnostic procedures for formula yellow triangles and unexpected action results, with a set of copy-paste diagnostic formula snippets for runtime type inspection."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Debugging Playbook

Diagnostic formulas, failure mode patterns, and step-by-step debugging procedures.

---

## Formula Shows Yellow Triangle ("can't be evaluated")

1. Simplify to minimum: just `{{ColumnName}}` — does the reference resolve?
2. Check column name spelling (case-sensitive, exact match)
3. Add `?.` after every column reference: `{{Col}}?.someProperty`
4. Add complexity back one piece at a time until it breaks

**Diagnostic formulas — run these in a separate test column:**

```javascript
typeof {{Column}}                             // what type is it?
{{Column}} === null                           // is it null?
{{Column}} === undefined                      // is it undefined?
JSON.stringify({{Column}})?.substring(0,200)  // what does it contain?
Object.keys({{Column}} || {}).join(", ")      // what keys does an object have?
{{Column}}?.records?.length                   // how many records in a lookup?
JSON.stringify({{Column}}?.records?.[0])      // inspect first lookup record
Clay?.getCellStatus?.({{Column}})            // what's the enrichment run status?
```

---

## Action Column Returned Unexpected Result

1. Read the record JSON from `.slab/tables/{tableId}/records/{recordId}.json`
2. Find the action column by field ID (cross-reference with `schema.json`)
3. Check `status` — SUCCESS, ERROR_*, SKIPPED, etc.
4. Check `fullValue` for the complete raw response from the provider
5. Check `message` for any error text

**Common statuses:**
- `SUCCESS` — ran and returned data (check `fullValue`)
- `ERROR_BLANK_TOKEN` — auth token missing or expired
- `SKIPPED` — run condition evaluated to false
- `ERROR_*` — provider-specific error (check `message`)

---

## Action Column Not Running (Always Skipped)

1. Find the column in `schema.json`, check `typeSettings.conditionalRunFormulaText`
2. Trace every column referenced in the run condition — are they populated?
3. Check column order — run condition should only reference columns BEFORE this one
4. Test the run condition in isolation: paste it into a formula column to see what it evaluates to

---

## Waterfall Not Progressing Past Step N

1. Check that the previous step returned an empty value (not an error)
2. If the previous step errored, `!{{Previous}}` may still be `false` because an error result is truthy
3. Use `Clay?.getCellStatus?.({{Previous}})?.toLowerCase()?.includes("error")` in the gate

---

## Forward-Reference Bug (Most Common Column-Order Issue)

Run conditions referencing columns that appear LATER in column order cause the gate condition to always evaluate to false/undefined on first run — silently skipping enrichment.

**Diagnosis:** In `analysis.json`, look for `"Run condition references X which appears AFTER this column"` warnings. Issue count > 50 on a waterfall table almost always means a forward-reference cascade.

**Fix:** Reorder columns so every gate only references columns to its left.

---

## Dead Field ID Reference in Run Condition (Silent Skip)

"Run condition references non-existent field ID: f_xxxxxxxxxx." A column was deleted but the run condition still references it. Result: the run condition always evaluates to false — the action silently never runs.

**Fix:** Open the run condition in the formula editor, remove the orphaned `{{f_fieldId}}` reference. The analyzer catches this in `analysis.json` under `issues` with `severity: "error"`.

---

## Fill Rate Issues (column has low % non-empty values)

1. Check `analysis.json` → `dataQuality.lowFillColumns`
2. Find the column in `schema.json`, check its run condition
3. A column with 0% fill that has a run condition may simply never meet that condition
4. Check if it's a waterfall — it may be skipped because earlier providers already filled the value

---

## Waterfall Consolidation Returns Null Despite Provider Hits

Multiple providers found data but the merge formula returns empty.

1. Fetch records for affected rows
2. For each provider column, check `status` and `fullValue`
3. If providers show SUCCESS with data, the bug is in the merge formula
4. Common causes: wrong column name reference, error object being truthy, wrong property path

```javascript
"P1:" + (typeof {{Provider 1}}) + "|P2:" + (typeof {{Provider 2}}) + "|P3:" + (typeof {{Provider 3}})
```

---

## Provider Auth Errors Burning Through Waterfall

Action runs but always returns empty/error. Credentials expired.

1. Check record JSON → action column → `status` and `message`
2. Look for `ERROR_BLANK_TOKEN`
3. Fix: re-authenticate in Clay's integration settings
4. **Warning:** broken auth silently burns credits — every row fails and falls through to next provider

---

## CRM Write-Back Queuing

HubSpot/Salesforce update actions stuck in "queuing".

1. Check target CRM API rate limits (HubSpot: 100/10s standard, 150/s enterprise)
2. Check if target object has workflow triggers (creates back-pressure)
3. Fix: batch writes, consolidate updates into fewer API calls, confirm API tier

---

## Audiences Data Returns Undefined Despite Successful Lookup

`{{Audiences Lookup}}?.records?.[0]?.fields?.Data?.someProperty` returns undefined.

**Cause:** Audiences stores complex objects as JSON strings, not native objects.

**Diagnostic:** `typeof {{Audiences Lookup}}?.records?.[0]?.fields?.["Data"]` — if `"string"`, you need `JSON.parse()`.

```javascript
(() => { try { return JSON.parse({{Audiences Lookup}}?.records?.[0]?.fields?.["Data"]); } catch(e) { return null; } })()
```

---

## Race Condition: Two Lookups Feeding One Merge Column

**Symptom:** Merge column reads from two Lookup columns, but one returns stale or empty data unpredictably.

**Cause:** Clay can execute multiple action columns in parallel. If Lookup B's run condition depends on Lookup A completing, but Clay fires both simultaneously, Lookup B may evaluate before Lookup A has written its result.

**Fix:** Minimize parallel action columns. Restructure so dependent lookups have an explicit run condition that gates on the upstream column having a value, OR use a delay step (httpstat.us pattern).

Key mechanics:
- Common attempted fix: add run condition `{{ Lookup 1 }}` on Lookup 2 — **backfires** if Lookup 1 returns `SUCCESS_NO_DATA` (cell is empty, so condition = false → Lookup 2 never runs)
- Yashy's pragmatic fix: for simple value lookups (e.g. country code lookup), convert to a **formula column** — formulas evaluate after all actions, avoiding the race entirely

---

## Write-to-Table + Lookup Race Condition

**Symptom:** A "Write to Table" action and a "Lookup Record" column run in the same row. The lookup finds nothing, even though the write just populated the target table.

```
Write to Table
→ HTTP GET https://httpstat.us/200?sleep=15000  (15s delay)
→ Lookup Record
```

---

## Claygent Returning Identical Result for Every Row

**Common causes:**
1. The input column reference is wrong — all rows resolve to the same value
2. The prompt doesn't include `{{input_column}}` syntax correctly
3. The column is cached from a previous run

**Debug steps:**
1. Confirm input column has distinct values per row
2. Check that `{{Column Name}}` syntax in the prompt matches the exact column name (case-sensitive)
3. Re-run one row manually and check if output varies

---

## Detecting "Not Found" String Pollution from AI Steps

When a use-ai or Claygent step returns literal "not found" strings as field values:

```javascript
// Diagnose
{{Field}}?.toLowerCase()?.includes("not found")

// Fix: filter at the formula projection level
{{AIResult}}?.field_name?.toLowerCase()?.includes("not found") ? "" : {{AIResult}}?.field_name
```

Apply the fix at the formula extraction layer, not by modifying the AI prompt.

---

## CRM Source Columns Emitting the Literal String 'undefined'

When pulling data from CRM sync source columns, fields that are null in the CRM sometimes arrive in Clay as the literal string `'undefined'` rather than JavaScript `undefined`. This passes a truthiness check.

Fix:
```javascript
field === 'undefined' ? '' : field
```

Check for this literal string as a first step when debugging unexpected values from a CRM source.

---

## Silent JS Precedence Bug: `!x.status === 'valid'` is Always False

`!{{field}}.status === 'valid'` does NOT mean "status is not valid." Due to JS operator precedence, `!` binds tighter than `===`.

**Correct forms:**
```javascript
{{field}}?.status !== 'valid'
!({{field}}?.status === 'valid')
```

---

## Run Condition Anti-Patterns

1. Template literals (backtick strings) are not supported — use string concatenation with `+`
2. `return` statements are not allowed — run conditions must be pure expressions
3. Run conditions that reference columns appearing BEFORE the source column fire before the source record is populated

---

## Related

- [[formulas/syntax|Formula Syntax]] — syntax rules that prevent the most common formula errors
- [[core/data-model|Data Model]] — schema.json structure for reading field IDs and run conditions
- [[enrichment/waterfalls|Waterfalls]] — waterfall-specific failure modes (step not progressing, merge returning null)
- [[integrations/crm|CRM & Integrations]] — CRM sync failure investigation and Salesforce picklist error reference
