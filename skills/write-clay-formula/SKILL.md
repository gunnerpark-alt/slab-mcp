---
name: write-clay-formula
description: Write, fix, debug, or review Clay formulas. Use when the user wants to add a formula column to a Clay table, repair an existing formula throwing a yellow triangle, score accounts based on multiple inputs, transform an enrichment payload into structured fields, or audit a formula for correctness. Clay formulas are JavaScript expressions that run in a sandboxed environment with specific constraints — this skill covers the runtime, the syntax rules, the production bugs we've actually hit, and the formula-generation workflow.
---

# Write Clay Formula

## Overview

Clay formulas are **JavaScript expressions** that run inside Clay's sandboxed evaluator. They are NOT scripts. They power formula columns to transform, extract, score, and reshape data flowing between Clay tables.

**Clay formulas are not standard JS.** They share JS syntax but the sandbox bans several common features. The most frequent cause of formula failure is writing standard JS instead of Clay-compatible expressions. This skill documents what works, what doesn't, and the exact production bugs we've hit and fixed.

The goal isn't to teach JavaScript — the goal is to **trigger your existing JS knowledge plus the Clay-specific constraints on top**. Don't reinvent wheels Claude already knows; just respect the sandbox.

---

## SECTION 1: RUNTIME ENVIRONMENT

### Available Libraries

| Library | Access | Notes |
|---|---|---|
| **Lodash** | `_` (global) | Full library. Confirmed: `_.uniq`, `_.compact`, `_.get`, `_.flatten`, `_.sortBy`, `_.intersection`, `_.difference`, `_.deburr`, `_.capitalize`, `_.startCase`, `_.truncate`, `_.clamp`, `_.inRange`, `_.pick`, `_.omit`, `_.has`, `_.countBy`, `_.groupBy`, `_.sumBy`, `_.meanBy`, `_.maxBy`, `_.minBy`, `_.chunk`, `_.sample`, `_.shuffle`, `_.invert`, `_.flattenDeep`, `_.escapeRegExp`, `_.words`, `_.uniqBy`, `_.times`, `_.sampleSize`, `_.findIndex`, plus all core string/array/object/number utilities. |
| **Moment.js** | `moment` (global) | Core API only — no plugins. Confirmed: `.format()`, `.diff()`, `.quarter()`, `.isoWeek()`, `.startOf()`, `.endOf()`, `.fromNow()`, `.toNow()`, `.isBetween()`, `.isBefore()`, `.isAfter()`, `.isValid()`, `.valueOf()`, `.dayOfYear()`, `moment.max()`, `moment.min()`, `moment.duration().humanize()`. |
| **JSON** | `JSON` (global) | `JSON.parse()`, `JSON.stringify()` with replacer array and spacing args. |
| **Clay Utilities** | `Clay` (global, capital C) | `Clay.getCellStatus()` — see Rule 10 below. |

### Standard JS — Confirmed Working

- `Math.*` — `round`, `ceil`, `floor`, `random`, `min`, `max`, `abs`, `pow`
- `Number.*` — `isFinite`, `isNaN`, `isInteger`
- `parseInt()`, `parseFloat()`, `Number()`, `String()`, `Boolean()`
- `Date.now()`, `new Date()`, `.getTime()`
- `encodeURIComponent()`, `decodeURIComponent()`
- `btoa()` — Base64 encode (`atob` does NOT work)
- `new URL(string)` → `.hostname`, `.pathname`, `.searchParams.get()`
- `typeof`, `Array.isArray()`
- `Object.keys()`, `Object.values()`, `Object.entries()`
- `String.prototype`: `.padStart()`, `.padEnd()`, `.normalize()`, `.replace()` (string args only), `.trim()`, `.split()`, `.toLowerCase()`, `.toUpperCase()`, `.includes()`, `.indexOf()`, `.slice()`, `.substring()`, `.charAt()`, `.match()` (with regex)
- `Array.prototype`: `.map()`, `.filter()`, `.some()`, `.every()`, `.find()`, `.findIndex()`, `.sort()`, `.slice()`, `.join()`, `.includes()`, `.reduce()`, `.flat()`, `.flatMap()`, `.concat()`, `.indexOf()`, `.forEach()`
- Array/object literals, ternary operator, all comparison/logical/math operators

### NOT Available / Broken

| Feature | Status | Workaround |
|---|---|---|
| `atob()` | Does not work (even though `btoa()` does) | Use a Claygent or HTTP API action for Base64 decode |
| `_.template()` | Does not work | Use string concatenation |
| FormulaJS | Not available in formula columns | N/A — only in Clayscript |
| `moment().businessDiff()` | Not available (requires plugin) | Calculate manually or use Claygent |
| Template literals (backticks) | Does not work | Use `+` concatenation |
| `return` statements | Does not work | Formula IS the expression |
| IIFEs / function wrappers | Do not work | Pure expression only |
| `let` / `const` / `var` at top level | Do not work | Inline everything; `const` inside `.reduce()` callbacks may work but is unreliable |
| `.replace()` with regex args | Does not work | `.split("target").join("replacement")` |
| `.replaceAll()` | Does not work | `.split("target").join("replacement")` |
| `matchAll()` | Returns iterator, not practically usable | Use `.match(/pattern/g)` (returns array) |
| `Object.assign()` on enrichment objects | Unreliable | Wrap as a named property: `{ data: obj, identifier: true }` |
| `_.merge()` / `_.assign()` on enrichment objects | Unreliable | Same — wrap, don't merge |
| Object spread `{...obj}` on enrichment objects | Unreliable | Explicitly map fields or wrap as named property |
| Array spread `[...arr1, ...arr2]` | Unconfirmed — use with caution | `[].concat(arr1).concat(arr2)` or `_.flatten([arr1, arr2])` |

### The `.replace()` Gotcha

The single most common syntax error.

```javascript
// WORKS — string replacement
"hello world".replace("hello", "hi")

// DOES NOT WORK — regex replacement
"hello world".replace(/hello/g, "hi")

// WORKAROUND — split/join for global string replace
"hello world hello".split("hello").join("hi")
```

There is one anecdotal exception (`.replace(/[\[\]"]/g, '')` has been reported working in some contexts), but regex replace is generally unreliable. Avoid.

---

## SECTION 2: THE 10 SYNTAX RULES

These are non-negotiable. Violating any one produces "formula can't be evaluated" (the yellow triangle) or silent wrong output.

### Rule 1: Pure Expression Only

Clay formulas must be a single expression. No `return`, no IIFE, no variable declarations.

```javascript
// WRONG
return myValue + 1
(function() { return myValue + 1; })()
(() => { return myValue + 1; })()
const x = {{Column}}; x + 1

// CORRECT
{{Column}} + 1
```

Think of the formula as the right-hand side of `const result = ...`. **When logic gets too complex for one expression, break it into multiple Clay columns.** That's the correct approach, not a compromise.

### Rule 2: Mustache Syntax for Column References

```javascript
{{Employee Count}} >= 500 ? "Enterprise" : "SMB"
{{Enrich person (2)}}?.experience
{{Brand Services Synthesis}}?.["Brand Deals & Campaign Execution"]?.services_provided
```

The `{{` and `}}` are mandatory. Bare names fail.

### Rule 3: No Template Literals

```javascript
// WRONG
`${m.name} at ${m.time}`

// CORRECT
m.name + " at " + m.time
```

### Rule 4: Optional Chaining Everywhere

Data in Clay is frequently null. Every property access needs `?.`.

```javascript
// WRONG
{{Enrich person}}.experience.filter(e => e.company)

// CORRECT
{{Enrich person}}?.experience?.filter(e => e?.company)

// WRONG — missing ?. on subfield
{{Column}}?.field.subfield

// CORRECT
{{Column}}?.field?.subfield
```

When in doubt, add `?.`. It never hurts a working formula.

### Rule 5: Type Coercion Traps

Columns that look like numbers may be strings. Catastrophic in scoring.

```javascript
// BUG — concatenates: "3" + "1" + "5" = "315"
({{Score_A}} || 0) + ({{Score_B}} || 0) + ({{Score_C}} || 0)

// FIX
Number({{Score_A}} || 0) + Number({{Score_B}} || 0) + Number({{Score_C}} || 0)
```

**Diagnostic:** if your scoring formula outputs "315502" instead of "16," strings are concatenating. Wrap with `Number()`.

### Rule 6: Null Handling Patterns

```javascript
({{My Column}} || [])      // default array
({{My Column}} || "")      // default string
({{My Column}} || 0)       // default number
!!{{My Column}}            // boolean existence check
```

### Rule 7: Object Merging Doesn't Work on Complex Objects

`Object.assign()`, `_.merge()`, `_.assign()`, and object spread all fail unpredictably on enrichment payloads. **Never merge into a complex enrichment object.**

```javascript
// WRONG — fail on enrichment objects
[Object.assign({}, {{Enrich Person}}, { identifier: true })]
[_.merge({}, {{Enrich Person}}, { identifier: true })]
[{...{{Enrich Person}}, identifier: true}]

// CORRECT — wrap as a named property
[{ enrichPersonData: {{Enrich Person}}, identifier: true }]

// CORRECT — stringify if downstream expects a string
[{ enrichPersonData: JSON.stringify({{Enrich Person}}), identifier: true }]
```

### Rule 8: Array Literals Work Natively

Clay treats array literals as native arrays. No `JSON.stringify()` unless you specifically want a string.

```javascript
// Native array — works with downstream actions
[{ myField: {{Some Column}}, identifier: true }]

// String — only when you specifically need it
JSON.stringify([{ myField: {{Some Column}}, identifier: true }])
```

### Rule 9: Lookup Columns Wrap in `{ records: [...] }`

This is the #1 cause of "formula returns blank." Lookup columns are NOT raw arrays.

```javascript
// WRONG
{{Lookup Multiple Rows in Other Table}}.sort(...)

// CORRECT
({{Lookup Multiple Rows in Other Table}}?.records || []).sort(...)
```

Filter List of Objects columns wrap in `.filteredArray`:

```javascript
({{My Filter Column}}?.filteredArray || []).map(...)
```

### Rule 10: `Clay.getCellStatus()` — Capital C, Full Optional Chaining

```javascript
// WRONG — lowercase clay
clay.getCellStatus({{My Column}})

// WRONG — missing optional chaining
Clay.getCellStatus({{My Column}}).toLowerCase()

// CORRECT
Clay?.getCellStatus?.({{My Column}})?.toLowerCase()?.includes("error")
```

Common statuses: `"success"`, `"error"`, `"unknown"` (not run), `"running"`.

---

## SECTION 3: LIBRARY QUICK REFERENCE

### Lodash — Most Useful Functions

**String:**
```javascript
_.capitalize("hello")              // "Hello"
_.startCase("john_doe")            // "John Doe"
_.camelCase("foo bar")             // "fooBar"
_.kebabCase("foo bar")             // "foo-bar"
_.snakeCase("foo bar")             // "foo_bar"
_.truncate("long string", { length: 20, separator: " " })
_.deburr("déjà vu")               // "deja vu" — strips diacriticals
_.escapeRegExp("price: $5.00")
_.words("fooBar")                  // ["foo", "Bar"]
```

**Array:**
```javascript
_.uniq([1, 2, 2, 3])
_.uniqBy(arr, "property")
_.compact([0, null, "", false, "a", 1])      // ["a", 1]
_.flatten([[1, 2], [3, 4]])
_.flattenDeep(...)
_.intersection([1, 2, 3], [2, 3, 4])         // [2, 3]
_.difference([1, 2, 3], [2, 3, 4])           // [1]
_.sortBy(arr, "property")
_.chunk([1, 2, 3, 4, 5], 2)                  // [[1,2], [3,4], [5]]
_.sample(arr) / _.shuffle(arr)
_.groupBy(arr, "property")
_.countBy(["a", "b", "a"])                   // { a: 2, b: 1 }
_.sumBy / _.meanBy / _.maxBy / _.minBy(arr, "score")
```

**Object:**
```javascript
_.get(obj, "deeply.nested.path", "default")  // safe deep access
_.has(obj, "path")
_.pick(obj, ["key1", "key2"])
_.omit(obj, ["unwanted"])
_.invert({ a: 1, b: 2 })                     // { 1: "a", 2: "b" }
```

**Number:**
```javascript
_.clamp(value, 0, 100)
_.inRange(value, 5, 10)
```

### Moment.js — Most Useful Methods

```javascript
// Create / parse
moment()
moment("2025-01-15")
moment("2025-01-15", "YYYY-MM-DD")
moment(1706745600000)              // Unix ms

// Compare
moment().isBefore(moment("2025-06-01"))
moment().isAfter(...)
moment().isBetween("2025-01-01", "2025-12-31")
moment().isValid()
moment.max(a, b) / moment.min(a, b)

// Format / output
moment().format("YYYY-MM-DD")      // "2025-03-17"
moment().format("MMM D, YYYY")     // "Mar 17, 2025"
moment().fromNow()                  // "3 days ago"
moment().valueOf()                  // Unix ms (HubSpot)
moment().quarter() / .isoWeek() / .dayOfYear()
moment.duration(30, "days").humanize()

// Manipulate
moment().startOf("month") / .endOf("quarter")
moment().add(30, "days") / .subtract(1, "year")
```

### JSON Patterns

```javascript
// Parse string-stored JSON
JSON.parse({{API Response Column}})?.data?.email

// Stringify with key filter (strip unwanted fields)
JSON.stringify(obj, ["name", "email"])

// Pretty print (debugging)
JSON.stringify(obj, null, 2)

// Safe parse with type check (input may be already-parsed object)
(typeof {{Column}} === "string" ? JSON.parse({{Column}}) : {{Column}})?.myField
```

### URL Parsing

```javascript
new URL({{Website}})?.hostname
new URL({{URL Column}})?.pathname
new URL({{URL Column}})?.searchParams?.get("utm_source")
```

---

## SECTION 4: FORMULA GENERATION PROCESS

**Follow this every time you write a Clay formula.**

### Step 1: Gather Information

Before writing anything, establish:

1. **Exact column names** — including spaces, parentheses, numbers. Ask if not provided.
2. **Data shape** — is the source a lookup (`.records`)? A filter (`.filteredArray`)? A raw enrichment object? A string? An array? Ask for a sample if complex.
3. **Desired output type** — string? number? boolean? array? JSON string?
4. **Edge cases** — what should happen when data is null/missing?

If any of these are unclear, ASK before writing.

### Step 2: Pre-Write Trap Check

Mentally check before typing:

- [ ] Using anything from the "NOT Available" list?
- [ ] `.replace()` with regex? → Switch to `.split().join()`
- [ ] `Object.assign` or spread on a complex object? → Wrap instead
- [ ] Template literals? → Switch to `+` concatenation
- [ ] Variable declarations? → Inline expression
- [ ] `return`? → Remove
- [ ] Lookup column without `.records`? → Add `.records`
- [ ] Filter column without `.filteredArray`? → Add `.filteredArray`
- [ ] Summing values that might be strings? → Wrap with `Number()`
- [ ] Every property access using `?.`?
- [ ] `Clay.getCellStatus` with lowercase `clay`? → Capital `C`

### Step 3: Write

1. Write the happy path first (assume all data exists).
2. Add `?.` at every property access.
3. Add null fallbacks (`|| []`, `|| ""`, `|| 0`).
4. Wrap numeric values with `Number()` if there's any chance they're strings.
5. Mentally test with sample data.

### Step 4: Pre-Delivery Validation

- [ ] Pure expression (no `return`, `const`, `function`)?
- [ ] All column references in `{{ }}`?
- [ ] Every property access using `?.`?
- [ ] Null cases handled with fallbacks?
- [ ] Scoring formula values wrapped in `Number()`?
- [ ] Lookup columns using `.records`?
- [ ] Filter columns using `.filteredArray`?
- [ ] Only string `.replace()` (not regex)?
- [ ] `+` concatenation (not template literals)?
- [ ] Complex enough to suggest splitting into multiple columns?

### Step 5: When the Formula Fails

When a formula throws "can't be evaluated" and you can't immediately spot why:

1. **Simplify radically.** Reduce to the smallest possible expression that works, then add complexity back one step at a time. Never keep tweaking a complex formula — strip it down first.
2. **Run diagnostics:**
   ```javascript
   typeof {{Column}}                           // What type is this?
   {{Column}}?.records?.length                 // Does it have .records?
   JSON.stringify({{Column}}?.records?.[0])    // What does the first record look like?
   Object.keys({{Column}} || {}).join(", ")    // What keys exist?
   Clay?.getCellStatus?.({{Column}})           // What's the status?
   ```
3. **Build incrementally.** Get each piece working; have the user test at each step.
4. **Never guess.** If you don't know why it failed, ask the user to test a simpler version so you can isolate the issue.

---

## SECTION 5: COMMON PATTERNS

### Pattern 1: Simple Conditional

```javascript
{{Employee Count}} >= 500 ? "Enterprise" : "SMB"
```

### Pattern 2: Nested Ternary (Multi-Level)

```javascript
{{Employee Count}} >= 5000 ? "Enterprise" :
{{Employee Count}} >= 500 ? "Mid-Market" :
{{Employee Count}} >= 50 ? "SMB" :
"Startup"
```

### Pattern 3: Boolean Logic with Short-Circuit

```javascript
{{Critical Creator Services Count}} > 3 && !{{Public Figures Cohort}} && 5 || ""
```

### Pattern 4: Scoring (Number-Safe Additive Ternaries)

```javascript
Number({{CRM Platforms}}?.includes("HubSpot") ? 3 : 0) +
Number({{Employee Count}} >= 500 ? 3 : {{Employee Count}} >= 150 ? 2 : {{Employee Count}} >= 50 ? 1 : 0) +
Number({{Sales Team Size}} >= 200 ? 3 : {{Sales Team Size}} >= 50 ? 2 : {{Sales Team Size}} >= 10 ? 1 : 0) +
Number({{Sales Engagement Platforms}} ? 2 : 0) +
Number({{CEO Joined in last 12 months}} === true ? 2 : 0)
```

### Pattern 5: Array Filter + Map

```javascript
({{Enrich person (2)}}?.experience || [])
  ?.filter(exp => exp?.is_current && exp?.company_domain)
  ?.map(exp => exp?.company_domain)
```

### Pattern 6: Array → Comma-Separated String

```javascript
(_.uniq(
  ({{Enrich person (2)}}?.current_experience || [])
    ?.filter(exp => exp?.is_current && exp?.company_domain)
    ?.map(exp => exp?.company_domain)
) || []).join(", ")
```

### Pattern 7: JSON Stringification

```javascript
JSON.stringify(
  ({{Enrich person}}?.experience || [])
    ?.map(exp => ({
      company:    exp?.company    || null,
      title:      exp?.title      || null,
      start_date: exp?.start_date || null
    }))
)
```

### Pattern 8: Bracket Notation for Special Property Names

```javascript
{{Creator Services Synthesis}}?.["Channel Strategy / Management / Product Adoption"]?.services_provided
```

### Pattern 9: String Matching

```javascript
{{CRM Platforms}}?.includes("HubSpot")                              // substring
{{CRM Platforms}}?.match(/Sales Cloud.*Service Cloud|Service Cloud.*Sales Cloud/)
{{Company Name}}?.toLowerCase()?.includes("salesforce")             // case-insensitive
```

### Pattern 10: Array Membership (`.some()`)

```javascript
({{Enrich LinkedIn}}?.experience || []).some(exp =>
  exp?.company?.toLowerCase()?.includes("salesforce") ||
  exp?.company?.toLowerCase()?.includes("slack") ||
  exp?.company?.toLowerCase()?.includes("tableau")
)
```

### Pattern 11: Extracting + Formatting Nested Data

```javascript
{{AA Meeting Status}}?.currentMeetings
  ?.map(m => m?.meetingName + "\n" + m?.day + " at " + m?.time + " — " + m?.meetingType)
  ?.join("\n\n") || ""
```

### Pattern 12: Conditional with Complex Object Access

```javascript
{{Creator Services Synthesis}}?.["Channel Strategy / Management / Product Adoption"]?.services_provided
  ? {{Creator Services Synthesis}}?.["Channel Strategy / Management / Product Adoption"]?.description + "\n\nEvidence:\n" + ({{Creator Services Synthesis}}?.["Channel Strategy / Management / Product Adoption"]?.evidence?.slice(0,3)?.map(e => e?.url)?.filter(u => u)?.join("\n") || "")
  : ""
```

### Pattern 13: Region-Based Threshold Lookup

```javascript
{{Primary Country}} == "United States" ? (
  {{Monthly Website Traffic}} >= 8452 ? 5 :
  {{Monthly Website Traffic}} >= 297  ? 3 : 1
) :
{{Primary Country}} == "United Kingdom" ? (
  {{Monthly Website Traffic}} >= 2159 ? 5 :
  {{Monthly Website Traffic}} >= 190  ? 3 : 1
) : null
```

### Pattern 14: Date Comparison

```javascript
{{Notion Query}}?.results?.length > 0 ?
  ((new Date() - new Date(
    {{Notion Query}}?.results
      ?.sort((a, b) => new Date(b?.properties?.["Date Created"]?.date?.start) - new Date(a?.properties?.["Date Created"]?.date?.start))
      ?.[0]?.properties?.["Date Created"]?.date?.start
  )) / (1000 * 60 * 60 * 24) > 30) :
  true
```

### Pattern 15: Handle String-Stored JSON

```javascript
(typeof {{My Column}} === "string" ? JSON.parse({{My Column}}) : {{My Column}})?.myField
```

### Pattern 16: Gated Composite Score

```javascript
{{Brand Deals Cohort}} ? (
  Number({{Traffic_Score_BrandDeals}}        || 0) +
  Number({{YT_Score_BrandDeals}}             || 0) +
  Number({{IGTT_Score_BrandDeals}}           || 0) +
  Number({{BrandServices_Score_BrandDeals}}  || 0) +
  Number({{Critical Brand Services Count}}   || 0)
) : null
```

### Pattern 17: Lookup Cross-Table Join

```javascript
({{Lookup Opportunities}}?.records || []).filter(p => p?.["Opportunity ID"]).map(p => ({
  email:           p?.Email,
  opportunityId:   p?.["Opportunity ID"],
  perPersonCost:   ((({{Lookup Opps}}?.records || []).find(o => o?.Id === p?.["Opportunity ID"]) || {})?.Amount || 0) / (({{Lookup Opportunities}}?.records || []).filter(x => x?.["Opportunity ID"] === p?.["Opportunity ID"]).length || 1)
}))
```

### Pattern 18: Merge Two Lookup Columns Safely

```javascript
[].concat({{Domain Fuzzy Lookup}}?.records || [])
  .concat({{Name Fuzzy Lookup}}?.records || [])
  .filter((r, i, arr) => arr.findIndex(a => a?.Id === r?.Id) === i)
```

### Pattern 19: Row Indexing

```javascript
(_.findIndex({{Lookup Multiple Rows}}?.records, r => r?.["LinkedIn Profile"]?.toLowerCase() === {{LinkedIn Profile}}?.toLowerCase()) + 1) || 0
```

### Pattern 20: Enrichment Status Waterfall

```javascript
{{Webhook}}?.MailingCountry && {{Webhook}}?.Manual_Mailing_Address__c ? "DID NOT RUN" :
({{Enrich Person Enrichment Status}} || "")?.toLowerCase()?.includes("not found") ? "NOT FOUND" :
{{Parsed Location}}?.country ? "SUCCESS" :
(Clay?.getCellStatus?.({{Enrich person}})?.toLowerCase()?.includes("error")) ? "ERROR" :
"NOT FOUND"
```

### Pattern 21: Wrap for Audiences Update

```javascript
[{"Marketing Notes": !{{IN -Marketing_Notes_C}} ? ({{Sales Intelligence Brief}}?.Summary || "") : (({{Sales Intelligence Brief}}?.Summary || "") + "\n\n" + ({{IN -Marketing_Notes_C}} || ""))}]
```

### Pattern 22: Source Tracking String

```javascript
_.compact([
  {{Phone Source}}    && ("Mobile("   + {{Phone Source}}    + ")"),
  {{Email Source}}    && ("Email("    + {{Email Source}}    + ")"),
  {{LinkedIn Source}} && ("LinkedIn(" + {{LinkedIn Source}} + ")")
]).length > 0 ? "Clay AI Sourced_" + _.compact([
  {{Phone Source}}    && ("Mobile("   + {{Phone Source}}    + ")"),
  {{Email Source}}    && ("Email("    + {{Email Source}}    + ")"),
  {{LinkedIn Source}} && ("LinkedIn(" + {{LinkedIn Source}} + ")")
]).join(",") : ""
```

### Pattern 23: Safe Deep Access with Lodash

```javascript
_.get(JSON.parse({{API Response}}), "data.results[0].score", 0)
```

### Pattern 24: Defensive Date Personalization

```javascript
moment({{Last Activity}}).isValid() ? moment({{Last Activity}}).fromNow() : "No activity"
```

### Pattern 25: International Name Normalization

```javascript
_.deburr({{Full Name}} || "")
```

### Pattern 26: URL Domain Extraction (with fallback)

```javascript
new URL({{Website}} || "https://placeholder.com")?.hostname?.replace("www.", "")
```

### Pattern 27: Global String Replacement (No Regex)

```javascript
({{Tags}} || "").split(",").join(";")            // commas → semicolons
({{Raw Value}} || "").split('"').join("")        // strip all quotes
({{Input}} || "").split(" ").join("")            // remove all spaces
```

### Pattern 28: Extract from Hierarchy Array

```javascript
({{companyHierarchy}} || []).find(i =>
  i?.hierarchyType?.join(',')?.toLowerCase()?.includes('input')
)
```

`|| []` prevents null errors before `.find()`. `join(',')` flattens multi-value `hierarchyType` arrays for a single `.includes()` check. Swap `'input'` for `'ultimate_parent'` or `'subsidiary'` for other hierarchy rows.

### Pattern 29: Google Workspace Detection (TWO MX Patterns)

```javascript
mx.includes('aspmx.l.google.com') || mx.includes('googlemail.com')
```

Checking only `aspmx.l.google.com` misses legacy Google Apps domains using `googlemail.com` routing.

### Pattern 30: Domain Age in Years (No `.toFixed()`)

```javascript
Math.round(((days / 365) * 10) / 10)
```

`.toFixed()` returns a string and breaks downstream numeric comparisons — use `Math.round` and integer division instead.

---

## SECTION 6: DEBUGGING ERRORS

### Yellow Triangle — "Formula can't be evaluated"

The most common error. Causes:

1. Syntax error — missing parenthesis, bad operator, broken chain.
2. Unsupported feature — `return`, IIFE, template literals, `const`.
3. Column name mismatch — exact match required (spaces, parens, casing).
4. Regex in `.replace()` — switch to `.split().join()`.

**Approach:** simplify radically, then add complexity one piece at a time.

### Formula Returns Blank / Undefined

1. Missing `?.` somewhere — null propagates to undefined.
2. Lookup column accessed without `.records`.
3. Filter column accessed without `.filteredArray`.
4. `.getCellStatus()` returns null, breaking the chain.

**Fix:** add `|| ""` or `|| []` at intermediate steps and at the end.

### Formula Returns `[object Object]`

Outputting a raw object. Either access specific properties or wrap with `JSON.stringify()`.

### Formula Returns Concatenated Numbers Like "315502"

Values are strings. Wrap with `Number()`:
```javascript
Number({{Score_A}} || 0) + Number({{Score_B}} || 0)
```

### `Object.assign` / Spread Fails on Enrichment Data

Doesn't work on complex enrichment objects. Wrap, don't merge:
```javascript
[{ data: {{Enrich Person}}, identifier: true }]
```

---

## SECTION 7: ANTI-PATTERNS

| Anti-Pattern | Why It Breaks | Correct Alternative |
|---|---|---|
| `return value` | No return statements | Just `value` |
| `(function() { ... })()` | IIFE not supported | Pure expression with ternaries |
| `(() => { ... })()` | Arrow IIFE not supported | Pure expression |
| `const x = ...; x` | Variable declarations not supported | Inline the expression |
| `` `${var}` `` | Template literals not supported | `var1 + " " + var2` |
| `.replace(/regex/, str)` | Regex in replace doesn't work | `.split("target").join("replacement")` |
| `.replaceAll("a", "b")` | Not available | `.split("a").join("b")` |
| `[...new Set(arr)]` | Unreliable | `_.uniq(arr)` |
| `{...obj, newField: val}` | Unreliable on complex objects | `{ data: obj, newField: val }` |
| `Object.assign({}, obj, extra)` | Fails on enrichment objects | `{ data: obj, ...extra }` or explicit mapping |
| `input["Column Name"]` | Wrong reference syntax | `{{Column Name}}` |
| `input.columnName` | Wrong reference syntax | `{{Column Name}}` |
| `clay.getCellStatus()` | Wrong casing | `Clay?.getCellStatus?.()` |
| `{{Lookup}}.map(...)` | Lookup is not a raw array | `({{Lookup}}?.records \|\| []).map(...)` |
| Missing `?.` anywhere | Null reference crash | Add `?.` everywhere |
| `{{Column}}?.field.subfield` | Missing `?.` on subfield | `{{Column}}?.field?.subfield` |
| `({{Score}} \|\| 0) + ({{Score2}} \|\| 0)` | String concat if scores are strings | `Number({{Score}} \|\| 0) + Number({{Score2}} \|\| 0)` |
| `atob()` | Not available in sandbox | External action |
| `_.template()` | Not available | String concatenation |
| `moment().businessDiff()` | Plugin not loaded | Manual calculation |
| `condition1 & condition2` | Single `&` is bitwise, not logical | `condition1 && condition2` |

---

## SECTION 8: CONFIRMED PRODUCTION BUGS

These are confirmed bugs from real production audits. Read this section when debugging unexpected behavior.

### Object.assign / `_.merge` Failure on Enrichment Objects

`Object.assign({}, {{Enrichment}}, { identifier: true })` and `_.merge()` both fail silently on complex nested enrichment JSON. Wrap as a named property:

```javascript
{ data: {{Enrichment}}, identifier: true }
```

### Audiences JSON Round-Tripping Requires Stringify/Parse

Data written to Audiences as objects arrives back as stringified JSON. Direct property access fails on read.

```javascript
// Write: stringify first
[{ enrichPersonData: JSON.stringify({{Enrich Person}}), identifier: true }]

// Read: parse with try/catch — but IIFEs don't work in formulas, so use safe-parse pattern
(typeof {{Lookup field}} === "string" ? JSON.parse({{Lookup field}}) : {{Lookup field}})?.myField
```

### Waterfall Fallback Restores Stale Value After Context Change

A fallback step restores the original CRM value when enrichment returns empty — but if enrichment changed a related field (e.g., `country` changed), the restored value (e.g., `state`) is now invalid for the new context. CRM rejects the write.

```javascript
// Guard the fallback on context match:
{{Enriched Country}} === {{Webhook Source}}?.MailingCountry
  ? {{Source Original Value}}
  : ""
```

Applies to any waterfall fallback that restores original CRM data for a field whose validity depends on another enriched field.

### Forward-Reference Anti-Pattern in Run Conditions

Run conditions referencing columns that appear LATER in column order will see empty/null values at execution time — the gate evaluates incorrectly.

**Fix:** only reference columns strictly to the LEFT of the gated column. When adding a new provider to an existing waterfall, append to the END and verify position relative to all columns whose run conditions reference it.

### Run Condition Syntax: Three Common Errors

1. **Template literals (backticks)** — not supported. Use `+`.
2. **Return statements** — not allowed. Run conditions are pure expressions.
3. **Single `&` instead of `&&`** — single `&` is bitwise, not logical.

### Missing Optional Chaining on Action Output

```javascript
// WRONG — causes column warning
{{field}}.industry

// CORRECT
{{field}}?.industry
```

All formula references to action output fields must use `?.` optional chaining.

### Array Fallback Before Array Methods

Always wrap nullable array properties with `|| []` before `.find()`, `.filter()`, or `.some()`. Use `_.some()` (not native `.some()`) in run conditions for null-safe array membership checks.

```javascript
({{field}}?.someArray || []).find(...)
```

### Date-Formatted Output: Avoid `.toFixed()` for Numbers

`.toFixed()` returns a string and breaks numeric comparisons downstream. Use `Math.round()` and integer division.

```javascript
// WRONG — returns "1.4" string
((days / 365)).toFixed(1)

// CORRECT — returns 1.4 number
Math.round(((days / 365) * 10) / 10)
```

---

## SECTION 9: NOTES FOR CLAUDE

### Behavioral Rules

1. **Never write `return` statements.** Ever. Not even inside `.reduce()` callbacks at the top level. The formula IS the expression.
2. **Never use IIFEs or function wrappers.** No `(() => { ... })()`, no `(function() { ... })()`.
3. **Never use template literals.** Always `+` concatenation.
4. **Never use `.replace()` with regex args.** Use `.split().join()`.
5. **Never use `Object.assign()` or spread on complex enrichment objects.** Wrap as a named property.
6. **Always use `?.` on every property access.** No exceptions.
7. **Always access lookup columns with `.records` and filter columns with `.filteredArray`.**
8. **Always wrap scoring values with `Number()` if there's any chance they're strings.**
9. **Always use `Clay` (capital C) for `getCellStatus`, with full optional chaining.**
10. **When a formula fails and you can't identify why, simplify radically and build back up.** Never keep tweaking a complex broken formula — strip it down first.
11. **Suggest breaking into multiple columns when logic gets complex.** That's the correct approach, not a compromise.
12. **When the user says "wrong syntax" or "fix this," follow the rules in this skill.** Don't improvise — use documented patterns.

### What This Skill Is and Isn't

This skill triggers your existing JavaScript knowledge and overlays Clay's specific constraints. It is NOT a JS tutorial — assume you already know `.map`, `.filter`, ternaries, optional chaining. What you don't know without this skill is:

- The sandbox's banned features (no `return`, no template literals, no `const` at top, no regex `.replace`)
- The Clay-specific column reference syntax (`{{ }}`)
- The wrapping conventions for lookup (`.records`) and filter (`.filteredArray`) columns
- The production bugs that have actually bitten people (Object.assign on enrichments, Audiences JSON round-trip, waterfall context-change)
- The credit-saving idiom (use Formatters for zero-credit transformations; formula columns run in the sandbox at no extra cost beyond compute)

### Confirmed Working Methods

`_.uniq()`, `_.compact()`, `_.get()`, `_.flatten()`, `_.sortBy()`, `_.intersection()`, `_.difference()`, `_.deburr()`, `_.capitalize()`, `_.startCase()`, `_.truncate()`, `_.clamp()`, `_.inRange()`, `_.pick()`, `_.omit()`, `_.has()`, `_.countBy()`, `_.groupBy()`, `_.sumBy()`, `_.meanBy()`, `_.maxBy()`, `_.minBy()`, `_.chunk()`, `_.sample()`, `_.shuffle()`, `_.invert()`, `_.flattenDeep()`, `_.escapeRegExp()`, `_.words()`, `_.uniqBy()`, `_.times()`, `_.sampleSize()`, `_.findIndex()`, `.some()`, `.every()`, `.filter()`, `.map()`, `.find()`, `.findIndex()`, `.sort()`, `.slice()`, `.join()`, `.includes()`, `.match()` (with regex), `.reduce()`, `.flat()`, `.flatMap()`, `.concat()`, `.indexOf()`, `JSON.stringify()`, `JSON.parse()`, `new Date()`, `Date.now()`, `moment()` (full core API), `typeof`, `Array.isArray()`, `Object.keys()`, `Object.values()`, `Object.entries()`, `Number()`, `parseInt()`, `parseFloat()`, `encodeURIComponent()`, `btoa()`, `new URL()`, `Math.*`, `Number.isFinite()`, `Number.isNaN()`, `Number.isInteger()`, `String.padStart()`, `String.padEnd()`, `String.normalize()`, `Clay?.getCellStatus?.()`, `.replace()` (string args only).

### Workflow: JSON Round-Tripping Through Audiences

1. Stringify before write: `[{ enrichPersonData: JSON.stringify({{Enrich Person}}), identifier: true }]`
2. Pass through Filter List of Objects: `{{Stringify JSON}}?.filteredArray?.["0"]?.enrichPersonData`
3. Store the string in Audiences via Upsert
4. Retrieve via Lookup in Audiences
5. Re-materialize: `[{ enrichPersonData: JSON.parse({{Lookup}}?.records?.[0]?.fields?.["Field Name"]), identifier: true }]`
