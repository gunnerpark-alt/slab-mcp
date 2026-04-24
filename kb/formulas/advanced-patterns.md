---
type: guide
section: formulas
tags: [formulas, lodash, advanced-patterns, optional-chaining, type-coercion]
description: "Production-ready formula patterns: Lodash quick reference, safe optional-chaining idioms, type coercion traps, and complex array/object manipulation examples from real Clay tables."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Advanced Formula Patterns

Complex formula patterns, real-world examples, and edge cases for Clay's sandboxed JavaScript environment. Assumes familiarity with [[formulas/syntax|Formula Syntax]] — read that first for the 8 critical rules, anti-patterns, and run condition basics.

---

## Library Quick Reference

### Lodash — Most Useful Functions

```javascript
// String
_.capitalize("hello")                    // "Hello"
_.startCase("john_doe")                  // "John Doe"
_.camelCase("foo bar")                   // "fooBar"
_.truncate("long string", { length: 20, separator: " " })
_.deburr("déjà vu")                     // "deja vu" — strips diacriticals
_.escapeRegExp("price: $5.00")           // "price: \\$5\\.00"
_.words("fooBar")                        // ["foo", "Bar"]

// Array
_.uniq([1, 2, 2, 3])                    // [1, 2, 3]
_.uniqBy(arr, "property")
_.compact([0, null, "", false, "a", 1]) // ["a", 1]
_.flatten([[1, 2], [3, 4]])             // [1, 2, 3, 4]
_.flattenDeep([[1, [2]], [3, [4, [5]]]])
_.intersection([1, 2, 3], [2, 3, 4])   // [2, 3]
_.difference([1, 2, 3], [2, 3, 4])     // [1]
_.sortBy(arr, "property")
_.chunk([1, 2, 3, 4, 5], 2)            // [[1,2], [3,4], [5]]
_.groupBy(arr, "property")
_.countBy(["a", "b", "a"])             // { a: 2, b: 1 }
_.sumBy(arr, "score")
_.meanBy(arr, "score")
_.maxBy(arr, "score")
_.minBy(arr, "score")

// Object
_.get(obj, "deeply.nested.path", "default")
_.has(obj, "path")
_.pick(obj, ["key1", "key2"])
_.omit(obj, ["unwanted"])
_.invert({ a: 1, b: 2 })              // { 1: "a", 2: "b" }

// Number
_.clamp(value, 0, 100)
_.inRange(value, 5, 10)

// Collection
_.findIndex(arr, r => r?.Id === targetId)
_.sample([1, 2, 3])                    // random element
_.shuffle([1, 2, 3])
```

### Moment.js — Most Useful Methods

```javascript
// Creating / Parsing
moment()                               // now
moment("2025-01-15")                   // parse string
moment("2025-01-15", "YYYY-MM-DD")    // parse with explicit format
moment(1706745600000)                  // parse Unix ms

// Comparing
moment().isBefore(moment("2025-06-01"))
moment().isAfter(moment("2025-01-01"))
moment().isBetween("2025-01-01", "2025-12-31")
moment().isValid()
moment.max(moment(), moment("2025-01-01"))
moment.min(moment(), moment("2025-01-01"))

// Formatting
moment().format("YYYY-MM-DD")         // "2025-03-17"
moment().format("MMM D, YYYY")        // "Mar 17, 2025"
moment().fromNow()                     // "3 days ago"
moment().toNow()                       // "in 3 days"
moment().valueOf()                     // Unix ms (useful for HubSpot)
moment().quarter()                     // 1-4
moment().isoWeek()                     // 1-52
moment().dayOfYear()                   // 1-365
moment.duration(30, "days").humanize() // "a month"

// Manipulating
moment().startOf("month")
moment().endOf("quarter")
moment().add(30, "days")
moment().subtract(1, "year")
```

### JSON Patterns

```javascript
JSON.parse({{API Response Column}})?.data?.email

// Stringify with key filter
JSON.stringify(obj, ["name", "email"])

// Stringify with formatting (useful for debugging)
JSON.stringify(obj, null, 2)

// Safe parse when column might be string or object
(typeof {{Column}} === "string" ? JSON.parse({{Column}}) : {{Column}})?.myField
```

### URL Parsing

```javascript
new URL({{Website}})?.hostname
new URL({{URL Column}})?.pathname
new URL({{URL Column}})?.searchParams?.get("utm_source")

// Domain extraction (strip www.)
new URL({{Website}} || "https://placeholder.com")?.hostname?.replace("www.", "")
```

---

## Common Formula Patterns

### Ternary — Simple Conditional
```javascript
{{Employee Count}} >= 500 ? "Enterprise" : "SMB"
```

### Ternary — Multi-Level (Nested If/Else)
```javascript
{{Employee Count}} >= 5000 ? "Enterprise" :
{{Employee Count}} >= 500 ? "Mid-Market" :
{{Employee Count}} >= 50 ? "SMB" :
"Startup"
```

### Scoring (Additive with Number() Safety)
```javascript
Number({{CRM Platforms}}?.includes("HubSpot") ? 3 : 0) +
Number({{Employee Count}} >= 500 ? 3 : {{Employee Count}} >= 150 ? 2 : {{Employee Count}} >= 50 ? 1 : 0) +
Number({{Sales Team Size}} >= 200 ? 3 : {{Sales Team Size}} >= 50 ? 2 : {{Sales Team Size}} >= 10 ? 1 : 0) +
Number({{Sales Engagement Platforms}} ? 2 : 0) +
Number({{CEO Joined in last 12 months}} === true ? 2 : 0)
```

### Gated Composite Score (Only Score Specific Cohorts)
```javascript
{{Brand Deals Cohort}} ? (
  Number({{Traffic_Score}} || 0) +
  Number({{YT_Score}} || 0) +
  Number({{BrandServices_Score}} || 0)
) : null
```

### Array Filtering and Mapping
```javascript
({{Enrich person (2)}}?.experience || [])
  ?.filter(exp => exp?.is_current && exp?.company_domain)
  ?.map(exp => exp?.company_domain)
```

### Array to Comma-Separated String
```javascript
(_.uniq(
  ({{Enrich person (2)}}?.current_experience || [])
    ?.filter(exp => exp?.is_current && exp?.company_domain)
    ?.map(exp => exp?.company_domain)
) || []).join(", ")
```

### Global String Replacement (No Regex)
```javascript
({{Tags}} || "").split(",").join(";")     // replace all commas with semicolons
({{Raw Value}} || "").split('"').join("") // strip all quotes
({{Input}} || "").split(" ").join("")     // remove all spaces
```

> **Note:** `.split().join()` is preferred over `.replace(/pattern/g, ...)` for Clay compatibility. If you must use regex, always include the `g` flag: `.replace(/\*\*/g, "")`.

### Bracket Notation (Property Names with Spaces)
```javascript
{{Creator Services Synthesis}}?.["Channel Strategy / Management / Product Adoption"]?.services_provided
```

Use bracket notation for:
- Any Claygent output whose keys are human-readable phrases
- Any provider key that is long, ambiguous, or contains non-identifier characters
- Keys from AI output like `?.["Security Breach"]`, `?.["Top 3 Priorities"]`

### String Matching
```javascript
{{CRM Platforms}}?.includes("HubSpot")
{{CRM Platforms}}?.match(/Sales Cloud.*Service Cloud|Service Cloud.*Sales Cloud/)
{{Company Name}}?.toLowerCase()?.includes("salesforce")
```

### Array Membership Check (.some())
```javascript
({{Enrich LinkedIn}}?.experience || []).some(exp =>
  exp?.company?.toLowerCase()?.includes("salesforce") ||
  exp?.company?.toLowerCase()?.includes("tableau")
)
```

### JSON Stringification (Nested Object → String)
```javascript
JSON.stringify(
  ({{Enrich person}}?.experience || [])
    ?.map(exp => ({
      company: exp?.company || null,
      title: exp?.title || null,
      start_date: exp?.start_date || null
    }))
)
```

### Safe Deep Access with Lodash
```javascript
_.get(JSON.parse({{API Response}}), "data.results[0].score", 0)
```

### Country/Region-Based Scoring Lookup
```javascript
{{Primary Country}} == "United States" ? (
  {{Monthly Website Traffic}} >= 8452 ? 5 :
  {{Monthly Website Traffic}} >= 297 ? 3 : 1
) :
{{Primary Country}} == "United Kingdom" ? (
  {{Monthly Website Traffic}} >= 2159 ? 5 :
  {{Monthly Website Traffic}} >= 190 ? 3 : 1
) : null
```

### Date Comparison (Sorted Newest-First)
```javascript
{{Notion Query}}?.results?.length > 0 ?
  ((new Date() - new Date(
    {{Notion Query}}?.results
      ?.sort((a, b) => new Date(b?.properties?.["Date Created"]?.date?.start) - new Date(a?.properties?.["Date Created"]?.date?.start))
      ?.[0]?.properties?.["Date Created"]?.date?.start
  )) / (1000 * 60 * 60 * 24) > 30) :
  true
```

### String-Stored JSON (Parse Before Access)
```javascript
(typeof {{My Column}} === "string" ? JSON.parse({{My Column}}) : {{My Column}})?.myField
```

### Lookup Column Processing (Cross-Table Join)
```javascript
({{Lookup Opportunities}}?.records || [])
  .filter(p => p?.["Opportunity ID"])
  .map(p => ({
    email: p?.Email,
    opportunityId: p?.["Opportunity ID"]
  }))
```

### Merging Two Lookup Columns (Deduplicated)
```javascript
[].concat({{Domain Fuzzy Lookup}}?.records || [])
  .concat({{Name Fuzzy Lookup}}?.records || [])
  .filter((r, i, arr) => arr.findIndex(a => a?.Id === r?.Id) === i)
```

### Row Indexing with findIndex
```javascript
(_.findIndex({{Lookup Multiple Rows}}?.records,
  r => r?.["LinkedIn Profile"]?.toLowerCase() === {{LinkedIn Profile}}?.toLowerCase()
) + 1) || 0
```

### Enrichment Status Waterfall
```javascript
{{Webhook}}?.MailingCountry && {{Webhook}}?.Manual_Mailing_Address__c ? "DID NOT RUN" :
({{Enrich Person Enrichment Status}} || "")?.toLowerCase()?.includes("not found") ? "NOT FOUND" :
{{Parsed Location}}?.country ? "SUCCESS" :
(Clay?.getCellStatus?.({{Enrich person}})?.toLowerCase()?.includes("error")) ? "ERROR" :
"NOT FOUND"
```

### Wrapping Values for Audiences Updates
```javascript
[{ "Marketing Notes": !{{IN -Marketing_Notes_C}}
  ? ({{Sales Intelligence Brief}}?.Summary || "")
  : (({{Sales Intelligence Brief}}?.Summary || "") + "\n\n" + ({{IN -Marketing_Notes_C}} || ""))
}]
```

### Enrichment Source Tracking String
```javascript
_.compact([
  {{Phone Source}} && ("Mobile(" + {{Phone Source}} + ")"),
  {{Email Source}} && ("Email(" + {{Email Source}} + ")"),
  {{LinkedIn Source}} && ("LinkedIn(" + {{LinkedIn Source}} + ")")
]).length > 0
  ? "Clay AI Sourced_" + _.compact([
      {{Phone Source}} && ("Mobile(" + {{Phone Source}} + ")"),
      {{Email Source}} && ("Email(" + {{Email Source}} + ")"),
      {{LinkedIn Source}} && ("LinkedIn(" + {{LinkedIn Source}} + ")")
    ]).join(",")
  : ""
```

### International Name Normalization
```javascript
_.deburr({{Full Name}} || "")
```

### Defensive Date with Moment
```javascript
moment({{Last Activity}}).isValid() ? moment({{Last Activity}}).fromNow() : "No activity"
```

### Extracting and Formatting Nested Data
```javascript
{{AA Meeting Status}}?.currentMeetings
  ?.map(m => m?.meetingName + "\n" + m?.day + " at " + m?.time + " — " + m?.meetingType)
  ?.join("\n\n") || ""
```

### JSON Round-Tripping Through Audiences
```javascript
// 1. Stringify for storage
[{ enrichPersonData: JSON.stringify({{Enrich Person}}), identifier: true }]

// 2. Access after Filter List of Objects
{{Stringify JSON}}?.filteredArray?.["0"]?.enrichPersonData

// 3. Re-materialize after Lookup
[{ enrichPersonData: JSON.parse({{Lookup}}?.records?.[0]?.fields?.["Field Name"]), identifier: true }]
```

---

## Advanced Formula Patterns

### Alphabet Expansion Array
Generates iteration objects for character-by-character scraping:
```javascript
"0123456789abcdefghijklmnopqrstuvwxyz".split("").map(c => ({ "search-term": c, data: {{Source Column}} }))
```

### Cross-Reference Join (.find())
Match records between two enrichment outputs by URL or key:
```javascript
{{Source A}}?.items?.map(item => ({
  url: item?.url,
  matchedData: ({{Source B}}?.results || []).find(r => r?.url?.split('?')[0] === item?.url?.split('?')[0])?.description || ""
}))
```

### Multi-Level Filter with Regex + Cross-Reference
```javascript
({{Classification}}?.responses?.filter(r => r?.codes?.some(c => /\d/.test(c || ""))) || []).map(item => ({
  url: item.url,
  codes: item.codes,
  title: ({{Search Results}}?.tasks?.[0]?.result?.[0]?.items || []).find(i => i?.url === item?.url)?.title || ""
}))
```

### Cascading .includes() Classification
String pattern matching for status mapping:
```javascript
{{Validation}}?.result?.toLowerCase()?.includes("catch_all") ? "Valid, Catch-All"
  : {{Validation}}?.result?.toLowerCase()?.includes("ok") ? "Valid"
  : {{Validation}}?.result?.toLowerCase()?.includes("invalid") ? "Invalid"
  : ""
```

### Multi-Condition Waterfall Gate with Phone Validation
```javascript
!{{Is Mobile Valid}} && {{Enriched Line Type}}?.toLowerCase() !== "mobile" && {{Is Phone Valid}} ? {{Normalize Number}}?.number?.international : ""
```

### Domain Exclusion with Static Array
```javascript
["linkedin.com","facebook.com","twitter.com","instagram.com","youtube.com","tiktok.com","github.com"].includes(DOMAIN({{Website}})) ? "" : {{Website}}
```

### URL Parsing with try/catch (IIFE Exception)
`new URL()` throws on invalid input — one of the rare cases where an IIFE is acceptable:
```javascript
(() => { try { const u = new URL({{URL}}); return u.hostname; } catch(e) { return ""; } })()
```

### Weighted Additive Scoring
```javascript
({{Employee Count}} > 1000 ? 25 : {{Employee Count}} > 500 ? 15 : {{Employee Count}} > 100 ? 10 : 0)
+ ({{Funding Stage}} === "Series C" ? 20 : {{Funding Stage}} === "Series B" ? 15 : 0)
+ ({{Has AI}} ? 15 : 0)
```

### Date-Based Recency Scoring with Moment
```javascript
moment({{Last Activity}}).isValid()
  ? (moment().diff(moment({{Last Activity}}), 'days') < 30 ? 20
    : moment().diff(moment({{Last Activity}}), 'days') < 90 ? 10
    : 0)
  : 0
```

### Audiences JSON Round-Trip (IIFE for try/catch)
Data stored in Audiences arrives back as a stringified JSON string — always parse:
```javascript
(() => { try { return JSON.parse({{Audiences Lookup}}?.records?.[0]?.fields?.["Data"]); } catch(e) { return null; } })()
```

### Variable Binding via `[value].flatMap(v => ...)`

Clay forbids `const` / `let` / `var` / IIFE in formulas, but many complex expressions need to compute a value once and reference it multiple times (e.g., a large haystack built from 15 fields that 13 classification rules all need to search). Inlining the expression 13 times bloats the formula to thousands of characters and makes it unmaintainable.

The trick: wrap the value in a single-element array and use `.flatMap(v => ...)` to bind it inside the callback:

```javascript
[
  // Expression computed ONCE
  _.compact(_.flatten([[{{Field A}}], [{{Field B}}], [{{Field C}}]])).join(" ").toLowerCase()
]
  ?.flatMap(haystack => [
    ["Vendor A", ["needle1", "needle2", "needle3"]],
    ["Vendor B", ["needle4", "needle5"]],
    ["Vendor C", ["needle6"]]
  ]?.map(r => ({
    vendor: r?.[0],
    matched: (r?.[1] || [])?.filter(n => haystack?.includes(n))   // `haystack` bound from outer
  })))
  ?.filter(r => r?.matched?.length > 0)
  ?.sort((a, b) => (b?.matched?.length || 0) - (a?.matched?.length || 0))
  ?.[0] || { vendor: "", matched: [] }
```

**Why this works:** `[value].flatMap(v => callback)` invokes the callback once with `v = value`, then flattens the array-of-arrays the callback returns into a flat array. Inside the callback, `v` behaves exactly like a `const`. The outer `[v]` wrapper is a functional idiom, not a real array operation.

**When to reach for it:** any time you'd otherwise copy-paste an expensive sub-expression 3+ times. Common real-world use case: detection/classification formulas where one haystack feeds multiple rule checks.

**Alternative:** split into two columns (one computes the value, another consumes it). Simpler but bloats the table with an extra column per bound variable. The `[v].flatMap()` pattern keeps everything in one formula.

### Classification Override Using AI's Own Evidence

When an LLM classification column returns both a structured `pms`/`category`/`vendor` field AND unstructured `evidence`/`reasoning`/`stepsTaken` fields, you can post-process the AI's evidence against a deterministic rule set to catch misclassifications. This is the single highest-ROI formula pattern for any AI classification pipeline.

```javascript
[
  ((({{AI Classification}}?.evidence || "") + " " +
    ({{AI Classification}}?.reasoning || "") + " " +
    ({{AI Classification}}?.portalUrl || "") + " " +
    (({{AI Classification}}?.stepsTaken || [])?.join(" ")))?.toLowerCase() || "")
]
  ?.flatMap(hay => [
    ["Yardi", ["rentcafe","securecafe","securecafenet","yardi.com"]],
    ["RealPage", ["activebuilding","loftliving","onesite.realpage","propertyware","realpage.com"]],
    ["Entrata", ["resident.entrata","entrata.com"]]
  ]?.map(r => ({
    pms: r?.[0],
    hits: (r?.[1] || [])?.filter(n => hay?.includes(n))?.length || 0
  })))
  ?.filter(r => r?.hits > 0)
  ?.sort((a, b) => (b?.hits || 0) - (a?.hits || 0))
  ?.slice(0, 1)
  ?.map(r => ({
    classification: r?.pms,
    original: {{AI Classification}}?.pms,
    wasCorrection: r?.pms !== {{AI Classification}}?.pms,
    hits: r?.hits
  }))
  ?.[0] || {
    classification: {{AI Classification}}?.pms || "",
    original: {{AI Classification}}?.pms || "",
    wasCorrection: false,
    hits: 0
  }
```

**Why it's bulletproof:** the formula uses the AI's own writeup as evidence against its own label. If the AI wrote "redirects to securecafenet.com, which is RentCafe (RealPage)" but the controlled vocabulary says RentCafe → Yardi, the formula overrides the model's classification. LLMs can be confidently wrong on product-name associations (especially similar-sounding competitors — RentCafe/RealPage, LoftLiving/LoftApartments, etc.). This pattern catches it deterministically.

**The `wasCorrection` flag is valuable for observability** — after a few hundred rows you see how often and in which direction the AI misclassifies. Use that signal to decide whether to swap models or harden the prompt.

### Set Operations with Lodash
Compare arrays from different providers:
```javascript
_.intersection(
  ({{Provider 1}}?.technologies || []).map(t => t?.toLowerCase()),
  ({{Provider 2}}?.technologies || []).map(t => t?.toLowerCase())
)
```

### Base64 Auth Header
```javascript
"Basic " + btoa({{API Key}} + ":" + {{API Secret}})
```

### People Array to Readable Text
```javascript
array.map(p => [p?.name, p?.title, p?.current_experience?.[0]?.start_date, p?.url].join("\n")).join("\n\n")
```

### Company Age from Founded Year with OR Fallback
```javascript
new Date().getFullYear() - ({{primary_founded}} || {{backup_founded}})
```

### Count Items in Comma-Separated AI Output
```javascript
{{field}}?.split(',')?.length
```

### Moment.js Relative Date Window Anchor
```javascript
moment({{sourceField}}?.['Created At'])?.subtract(2, 'years')?.format('MM-DD-YYYY')
```

---

## Edge Cases and Unusual Patterns

### Dual-Key camelCase/snake_case Fallback for Provider Output Fields
Multiple enrichment providers return the same fields inconsistently. Guard both forms:
```javascript
({{result}}?.street_address) || {{result}}?.streetAddress
({{result}}?.postal_code) || {{result}}?.postalCode
```

### Currency String Normalization
Funding amounts often come as strings like `'1.2B'` or `'500M'`. Clean with split/join:
```javascript
// Extract numeric part (avoid regex .replace for Clay compatibility):
{{field}}?.split('B')?.[0] || {{field}}?.split('M')?.[0]
// Then divide by 1000 for thousands: {{raw_field}} ? {{raw_field}}/1000 : ''
```

### Detecting `'null'` String vs Actual null
Some providers serialize missing values as the string `"null"`:
```javascript
{{field}} === 'null'          // catches serialized string "null"
{{field}} === null            // catches true null

// Combined — common in production:
{{boolField}} === true && {{phoneField}} === 'null'
```

### Waterfall Chaining with `||` Across Provider Result Objects
```javascript
{{hg_result}}?.employee_count || {{pdl_result}}?.employee_count || {{pubrio_result}}?.data?.company_size || {{rr_result}}?.num_employees
```

### Hierarchy Array: Find by Type Using join + includes
```javascript
({{companyHierarchy}} || []).find(i => i?.hierarchyType?.join(',')?.toLowerCase()?.includes('input'))
```

### Array map+join Pattern for Run Conditions
To test whether a structured result contains meaningful data (not just a non-null object):
```javascript
!({{f}} && {{f}}?.products.map(product => product.product_name).join(", "))
```
`.join()` on an empty array returns `""` (falsy), a populated array returns a non-empty string (truthy).

### "Not Found" Sentinel Filtering for AI/Claygent Output Fields
Claygent/use-ai steps frequently return `"not found"`, `"Not Found"`, `"none"`, `"N/A"` instead of null:
```javascript
// Standard per-field guard:
{{field}}?.toLowerCase()?.includes("not found") ? "" : {{field}}

// With fallback to second source:
({{source1}}?.industry?.toLowerCase()?.includes("not found") ? "" : {{source1}}?.industry) || {{source2}}?.industry

// Gate condition variants:
!{{field}}?.toLowerCase()?.includes("not found")
{{field}}?.toLowerCase() !== "n/a"
{{field}}?.toLowerCase() !== "none"
```

Always use `.toLowerCase()?.includes()` — case variations exist. Apply per-field, not once at the object level.

### Normalize Provider Fields That Return Either Array or Scalar String
Some providers return a field as an array in some responses and a plain string in others (e.g., jurisdiction, industry, tags):
```javascript
({{Step}}?.field?.join(",")) || {{Step}}?.field
```
`?.join(",")` returns `undefined` if the value is a string (strings don't have a `join` method in this context), so the `||` fallback returns the raw scalar. Avoids an explicit `Array.isArray()` branch.

---

## Gating on Non-Empty Arrays

### Array-Field Existence Check via Inline Map
Checking `!({{col}} && {{col}}?.products)` passes even when `products` is an empty array — an empty array is truthy. To correctly gate on whether a provider returned useful array data, process the array inline:
```javascript
!({{col}} && {{col}}?.products.map(product => product.product_name).join(", "))
```
A non-empty join produces a truthy string; an empty array produces `""` (falsy). This single expression simultaneously validates: the response object exists, the array field exists, and the array contains at least one element.

Use this pattern anywhere a provider returns results as an array inside a response object — tech stack, job openings, product lists, etc.

*Source: Thryv POC — gate for successive Find Technology Stack waterfall steps*

### JSON.stringify for Reliable Empty-Array Detection
`!!{{col}}?.entities` is unreliable — empty arrays `[]` are truthy. The reliable three-part check:
```javascript
!{{col}} || !{{col}}?.entities || !JSON.stringify({{col}}?.entities)
```
This handles: column not yet run, field absent, and field present but empty array. `JSON.stringify([])` produces the string `"[]"` (truthy), but the negation of the full condition correctly identifies the empty-array case.

*Source: 'Find Account Hierarchy (Claygent)' run condition*

---

## Undocumented Behavior: Shared State Within a Run Batch

`_.uniqueId()` returns `"1"`, `"2"`, `"3"`, etc. on successive calls. Because Clay evaluates formula columns in batch, each row's call increments the counter — giving each row a unique sequential number within that run.

**Practical applications:**
- Assign unique promo codes from a code list by row position
- Generate sequential identifiers within a table run

**Caveats:**
- Counter resets between separate table runs
- Starting number may not always be 1
- Behavior depends on batch evaluation order, which is not guaranteed to be top-to-bottom

*Source: Judah, osman, #solutions-se, Mar 2025*

---

## Related

- [[formulas/syntax|Formula Syntax]] — The 8 critical syntax rules, anti-patterns, and run condition basics
- [[debugging/provider-failures|Provider Failure Modes & Advanced Debugging]] — Forward-reference bugs, missing optional chaining, warning explosions
- [[debugging/playbook|Debugging Playbook]] — Step-by-step diagnosis for formula errors and waterfall issues
- [[enrichment/waterfalls|Waterfall Patterns]] — Cumulative exclusion gates and waterfall construction
- [[audiences/index|Audiences]] — JSON round-trip pattern for cross-table data storage
