---
type: reference
section: providers
tags: [providers, action-keys, credit-cost, output-paths, waterfall]
description: "Quick-reference table of 40+ enrichment providers with action key patterns, primary use, and critical provider-specific notes (e.g., Datagma v3 not base, Cognism two-step, Dropcontact .data.email path)."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Enrichment Providers Reference

Quick reference table, credit costs, and essential provider-specific notes.

---

## Provider Reference Table

| Provider | Action Key Pattern | Primary Use | Notes |
|----------|-------------------|-------------|-------|
| Apollo | `apollo-*` | Person + org data | Good for US/EU, weaker internationally |
| People Data Labs | `pdl-*` | Person + company | Strong international coverage |
| Clearbit | `clearbit-*` | Company enrichment | High quality, high cost |
| HG Insights | `hg-insights-*` | Technographics, headcount | B2B tech companies |
| LeadMagic | `leadmagic-*` | Email finder, company | Good fill rate on work emails |
| Hunter | `hunter-*` | Email finder | Pattern-based, good for generic formats |
| Findymail | `findymail-*` | Email finder | Good for hard-to-find emails |
| Cognism | `cognism-enrich-contact` | Contact search (Enrich step) | Returns record ID; does NOT consume reveal credit |
| Cognism | `cognism-reveal-contact` | Get full contact data (Redeem step) | Consumes credit; returns phone numbers + verified email |
| Datagma | `datagma-enrich-company` | Company enrichment | Input: `data` = domain |
| Datagma | `datagma-enrich-person` | Person enrichment | Input: LinkedIn URL |
| Datagma | `datagma-find-work-email-v3` | Work email | Use `-v3` not base |
| Datagma | `datagma-find-mobile-number` | Mobile phone | Input: `personalLinkedinUrl` |
| Forager | `forager-find-phone-numbers` | Phone numbers | Output: `.phone_numbers[0]`; first in phone waterfall |
| Nymblr | `nymblr-find-mobile` | Mobile phone | Fallback in phone waterfall |
| Nymblr | `nymblr-find-personal-email` | Personal email | Input: work email |
| Contactout | `contactout-find-phone` | Mobile phone | Strong for US mobile numbers |
| Contactout | `contactout-social-url-from-email` | LinkedIn URL from email | Reverse email → LinkedIn |
| SMARTe | `smarte-find-mobile-number` | Mobile phone | Strong US/international mobile |
| Prospeo | `prospeo-find-mobile-number` | Mobile phone | LinkedIn-based |
| Firmable | `firmable-find-mobile-phone` | Mobile phone | Australian-strong |
| Lyne | `lyne-find-mobile-number` | Mobile phone | EU-strong |
| Exellius | `exellius-enrich-mobile-phone` | Mobile phone | Waterfall fallback |
| Wiza | `wiza-find-phone` | Mobile phone | LinkedIn-based |
| Wiza | `wiza-find-linkedin-profile` | LinkedIn profile | Email → LinkedIn reverse |
| Icypeas | `icypeas-find-email-v2` | Work email | Input: `fullname` + `domain` |
| Kitt | `kitt-find-work-email` | Work email | Mid-waterfall email provider |
| Enrow | `enrow-find-work-email` | Work email | Mid-waterfall email provider |
| FullEnrich | `fullenrich-find-work-email` | Work email | Aggregator; checks multiple sources |
| BetterContact | `bettercontact-find-work-email` | Work email | Also does mobile phone |
| BetterContact | `bettercontact-find-mobile-phone` | Mobile phone | Dual email+phone provider |
| Weekday | `weekday-find-phone-number` | Mobile phone | India-strong; gate to Indian rows |
| Pubrio | `pubrio-find-phone-number` | Mobile phone | APAC-strong; gate to APAC rows |
| Surfe | `surfe-find-mobile-phone` | Mobile phone | EU/global mobile |
| Upcell | `upcell-find-mobile-number` | Mobile phone | Waterfall fallback |
| Zeliq | `zeliq-find-phone` | Mobile phone | Waterfall fallback |
| Normalize Phone | `normalize-phone-number` | Phone normalization | Output: `?.number?.["e164"]` for E.164 format |
| Mixrank | `enrich-person-with-mixrank-v2` | Person enrichment | LinkedIn-based; output `.picture_url_orig` |
| Bytemine | `bytemine-enrich-person` | Person enrichment | LinkedIn-based |
| Dropcontact | `dropcontact-find-work-email` | Work email | Also: `dropcontact-enrich-person` |
| Dropcontact | `dropcontact-enrich-person` | Person/email enrichment | Output email: `.data.email` (not `.email`) |
| LiveData | `livedata-find-linkedin-profile` | LinkedIn profile finder | Real-time |
| Champify | `champify-*` | LinkedIn + job changes | Tracks job changes |
| Reverse Contact | `reverse-contact-*` | LinkedIn from email | Reverse email → LinkedIn |
| Aviato | `aviato-find-company-financials` | Company financials | US private companies |
| Aviato | `aviato-find-personal-linkedin` | LinkedIn from email | Reverse lookup |
| PitchBook | `pitchbook-*` | Funding, investors | Enterprise funding data |
| Crunchbase | `crunchbase-*` | Funding, company | Public funding data |
| Harmonic | `harmonic-get-fundraising-data` | Funding events | Takes LinkedIn URL, NOT domain |
| Intellizence | `intellizence-get-fundraising-data` | Funding events | Supplements Crunchbase |
| Intellizence | `intellizence-get-news` | Enterprise news/signals | NOT funding-specific |
| Dealroom | `dealroom-get-fundraising-data` | Funding events | Takes `domain` + `url` (both = domain) |
| Beauhurst | `beauhurst-enrich-company` | UK/Germany company data | Gate to UK/Germany rows only |
| Beauhurst | `beauhurst-find-company-funding` | UK/Germany funding | Gate to UK/DE |
| HitHorizons | `hithorizons-company-firmographics` | EMEA corporate hierarchy | Gate to EMEA cities only |
| HG Insights | `hg-insights-find-company-corporate-structure-v2` | Corporate hierarchy | Always version-pin to `-v2` |
| SimilarWeb | `similarweb-get-traffic-analytics` | Web traffic overview | Input: `url` (not `domain`) |
| SemRush | `semrush-get-traffic-analytics` | Web traffic | Input: `url` (not `domain`) |
| Serpstat | `serpstat-get-website-traffic` | Web traffic | Input: `domain` (not `url`) |
| BuiltWith | `lookup-technology-stack-new` | Tech stack (website scrape) | Use as first in tech waterfall |
| PredictLeads | `predict-leads-get-tech-stack-for-company-v3` | Tech stack (job listings) | Fallback after BuiltWith |
| PredictLeads | `predict-leads-get-job-openings-for-company-v3` | Job openings | Output: `.jobCount` |
| PredictLeads | `predict-leads-get-events-for-company-v3` | Company events/signals | Funding, hiring, product signals |
| Openmart | `find-local-businesses-openmart` | Local business discovery | Outputs `.name`, `.address?.formatted_address`, `.company_domain`; "boost scores" keyword surfaces better records |
| Storeleads | `storeleads-enrich-company-v2` | Retail/store company data | Use v2; first in tech stack waterfall (cheapest) |
| Shopify Check | `check-if-shopify-hosted` | Shopify detection | Returns boolean |
| Oakminer | `oakminer-*` | 10-K / 10-Q analysis | ~5 credits; accepts company name |
| Zenrows | `zenrows-run-scrape` | Web scraping | CSS selector-based |
| Apify | `apify-run-actor` | Advanced web scraping | Runs Apify actors |
| Screen Shot | `screen-shot-get-page` | Website screenshot | Use with chat-gpt-vision |
| GPT Vision | `chat-gpt-vision` | Analyze screenshot | Feeds from screen-shot-get-page |
| D&B | `dun-and-bradstreet-*` | Firmographics, hierarchy, DUNS | Two-step: cleanseMatch → data blocks |
| ZoomInfo | `zoominfo-*` | Person + company enrichment | Enterprise provider |
| Normalize URL | `normalize-url` | URL normalization | `bare` and `bareDomain` modes |
| Salesforce SOQL | `salesforce-soql-*` | CRM lookup | Returns `.records[]` array |
| HubSpot | `hubspot-lookup-object` | HubSpot CRM lookup | Returns `.results?.[0]?.properties?.fieldName` |
| Audiences | `upsert-audiences-record` | Clay Audiences write | Upserts a record |
| HTTP API | `http-api-v2` | Custom API call | Any REST endpoint |
| Google Docs | `google-docs-create-document` | Document output | Creates Google Doc |
| Gong | `gong-add-prospect-to-flow` | Gong sequence | Adds contact to Gong flow |
| Snowflake | `snowflake-lookup-row-v2` | Data warehouse lookup | Queries Snowflake |
| Filter Objects | `filter-list-of-objects` | Array filtering | Use when formula can't hold complex logic |
| Similarity | `compare-similarity-of-strings` | String matching | Fuzzy similarity score |
| Email Parser | `extract-email-components` | Email parsing | Extracts domain, name from email |
| Clearout | `clearout-*` | Phone/email validation | Line type, validity status |
| Snov | `snov-domain-by-company-name` | Domain from company name | Output: `.domain` |
| HG Insights | `hg-insights-find-domain-from-company-name` | Domain from company name | |
| Google | `google-company-to-domain` | Domain from company name | Search-based |
| Domain Finder | `get-domain-from-company-name` | Domain from company name | Generic final fallback |

---

## Approximate Credit Costs

| Cost | Providers |
|------|-----------|
| 0.4 credits | Use AI (basic), Normalize URL |
| 1 credit | LeadMagic, basic Claygent (clay-argon), Clearout validate |
| 2 credits | Datagma, Claygent with web research |
| 3 credits | Brandfetch, complex Claygent |
| 5 credits | People Data Labs |
| 8 credits | Clearbit |
| 9 credits | SMARTe |
| 10 credits | Owler, PitchBook |

---

## Provider-Specific Notes

### Cognism (Two-Step: Enrich → Redeem)

**Critical distinction:** Cognism separates lookup into two operations.

1. **Enrich (Search)** — finds a matching record using name/domain/LinkedIn URL. Returns a record ID. Low cost — no reveal credit consumed.
2. **Redeem (Reveal)** — takes the record ID from Enrich and returns full contact data (phone numbers, verified email). Consumes a credit.

Only call Redeem when Enrich returns a high-confidence match (≥ 80%). Use a conditional column: `IF(cognism_match_confidence >= 80, RUN_REDEEM, SKIP)`.

**Waterfall position:** Primary for UK/Europe/APAC contacts; secondary for US (Apollo first, Cognism fallback).

**Response parsing:**
```javascript
// Prefer Direct dial, fallback to Mobile
data.phoneNumbers.find(p => p.type === "Direct")?.number
  || data.phoneNumbers.find(p => p.type === "Mobile")?.number

// Email
data.emails[0]?.address
data.emails[0]?.verified   // boolean
```

Use the "Response values to return" field in Clay's HTTP API column to extract specific nested values from the response arrays.

---

### Salesforce SOQL
Always returns `{ records: [{ fields: {...} }] }`. Never treat as a flat array.
```javascript
{{Salesforce Lookup}}?.records?.[0]?.fields?.["Field Name"]
({{Salesforce Lookup}}?.records || []).length > 0
```

### HubSpot Lookup
Returns different structure than Salesforce:
```javascript
{{HubSpot Lookup}}?.results?.[0]?.properties?.company
{{HubSpot Lookup}}?.results?.[0]?.properties?.email
// Gate:
!!{{HubSpot Lookup}}?.results?.[0]
```

### Dropcontact
Output email path is `.data.email` — NOT `.email`.
```javascript
// Correct gate:
!({{DropcontactResult}} && {{DropcontactResult}}?.data.email)
```

### Harmonic Funding
Takes LinkedIn URL as `company_identifier`, NOT domain. Output nested under `.data.totalFunding` and `.data.latestFundingAmount`.

### Mixrank Person Enrichment (`enrich-person-with-mixrank-v2`)
Output: `.url`, `.headline`, `.summary`, `.connections`, `.num_followers`, `.location_name`, `.profile_id`, `.country`, `.picture_url_orig` (note `picture_url_orig`, not `picture_url`)

### HG Insights Corporate Structure (`hg-insights-find-company-corporate-structure-v2`)
Always version-pin to `-v2`. Key output: `?.companyHierarchy` (array), `?.["Highest Hierarchy Tier"]` (1 = ultimate parent)

### HitHorizons
EMEA-only; gate to EMEA city names allowlist before calling.

### Normalize URL
- `type="bare"` — returns `.normalizedUrl` for site: search queries
- `type="bareDomain"` — strips path, returns just domain

### PredictLeads — Three Distinct Actions
- `predict-leads-get-tech-stack-for-company-v3` — gate on `?.technologiesFound`
- `predict-leads-get-job-openings-for-company-v3` — gate on `?.jobCount`
- `predict-leads-get-events-for-company-v3` — company events

### Phone/Mobile Waterfall (Standard Ordering)
1. `forager-find-phone-numbers` — output: `.phone_numbers[0]`
2. `nymblr-find-mobile` — if Forager returns nothing
3. `datagma-find-mobile-number` — input: `personalLinkedinUrl`
4. `leadmagic-find-mobile-number` — if all above fail
5. `contactout-find-phone` — final fallback; strong for US mobile

Always validate with `clearout-validate-phone` after each provider (not at the end).

**Regional-specific ordering (enterprise/international):**
- US: Forager → Wiza → Prospeo → SMARTe → ContactOut → LeadMagic → Bytemine → Upcell → Zeliq → BetterContact → Datagma → Surfe
- India: Add `weekday-find-phone-number` — gate to rows where Country = India
- Australia: `firmable-find-mobile-phone` — gate to AU rows
- APAC: `pubrio-find-phone-number` — gate to APAC rows
- Universal final step: `normalize-phone-number` → `?.number?.["e164"]` for E.164 format

**Phone normalization output:**
```javascript
{{Normalize Phone Number}}?.number?.["e164"]   // e.g., "+14155552671"
```

### Work Email Waterfall (Extended Ordering)

Enterprise waterfalls validate every provider inline (not just at the end):

1. `findymail-find-work-email` + `validate-email`
2. `prospeo-find-work-email-v2` + `validate-email`
3. `find-email-v2` + `validate-email`
4. `datagma-find-work-email-v3` + `validate-email`
5. `kitt-find-work-email` + `validate-email`
6. `wiza-find-work-email` + `validate-email` (via `clearout-validate-phone`)
7. `icypeas-find-email-v2` + `validate-email`
8. `enrow-find-work-email` + `validate-email`
9. `leadmagic-find-work-email` + `validate-email`
10. `dropcontact-find-work-email` + `validate-email`
11. `bettercontact-find-work-email` + `validate-email`
12. `fullenrich-find-work-email` + `validate-email`
13. `smarte-find-work-email` + `validate-email`

Each provider has its own validate-email gate before the next provider fires. The final `Work Email` formula picks the first valid result across all providers.

### Domain Resolution Waterfall (Company Name → Domain)
1. `snov-domain-by-company-name` — output: `.domain`
2. `hg-insights-find-domain-from-company-name`
3. `google-company-to-domain`
4. `get-domain-from-company-name` — generic final fallback

### D&B Direct+ (Two-Step Pattern)
1. `cleanseMatch` for DUNS resolution
2. `/v1/data/duns/{dunsNumber}?blockIDs=...` for enrichment
- Confidence branching: High-confidence (>7) and low-confidence (<8) as separate Clay action columns
- Pre-enrichment tip: Run Clay Enrich Company upstream to improve match rates

### Screen Shot + Vision AI
1. `screen-shot-get-page` — inputs: `pageUrl`, `waitFor` (seconds for JS rendering)
2. `chat-gpt-vision` — analyzes the screenshot image

### Oakminer vs Claygent for 10-K Analysis
Both cost ~6 credits. Gate on `?.type?.toLowerCase() === "public company"` — 10-K filings only exist for US public companies.

### SimilarWeb Engagement Metrics (Three Separate Actions)
- `similarweb-get-website-average-visit-duration` — average session duration
- `similarweb-get-website-bounce-rate` — bounce rate percentage
- `similarweb-get-website-pages-per-visit` — pages per session

---

## Related

- [[enrichment/waterfalls|Waterfalls]] — waterfall ordering patterns and cumulative exclusion gates
- [[enrichment/credit-optimization|Credit Optimization]] — credit cost estimation and waterfall ordering by cost-effectiveness
- [[core/data-model|Data Model]] — provider output field access paths and lookup result structures
- [[debugging/playbook|Debugging Playbook]] — diagnosing auth errors and provider-specific failures
