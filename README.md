# slab-mcp

**MCP server for analyzing Clay tables** — schema, rows, errors, credit cost, and enrichment debugging, via the same internal Clay API the frontend uses.

Connects Claude (Desktop, Code, or any MCP client) to Clay. Share any `app.clay.com` URL and Claude can read the schema, pull rows, trace enrichment failures end-to-end through Clay Functions (subroutines), and see exactly how many credits each cell consumed. Two installable Claude Code skills (`write-clay-formula`, `write-claygent-prompt`) cover the writing workflows.

---

## What you get

- **Read any Clay table or workbook** — schema, formulas (full text, no truncation), run conditions, providers, dependencies, recursive function calls.
- **Trace why an enrichment failed** — find a row by name, get the raw provider response, follow each subroutine pointer into the child row that actually ran, recurse up to 3 levels.
- **See per-row credit cost** — every cell's basic credits, action-execution credits, post-2026 pricing, and underlying OpenAI/Anthropic dollar cost for AI columns. Roll-up total per row.
- **Spot what's broken across a table** — per-column status counts (success / error / has-not-run / queued), error message frequencies, fill rate.
- **Write or fix formulas and Claygent prompts** — two installable Claude Code skills (`write-clay-formula`, `write-claygent-prompt`) walk the workflow: gather inputs, pick the mode, apply the section structure and casing conventions, validate against the production-bug checklist.

---

## Why does this exist?

Clay's public API is minimal. Most of the interesting state — schema, formula text, run conditions, cell statuses, provider responses, **credit cost per cell**, subroutine pointers — only comes back from the internal `/v3/` API the Clay frontend calls. `slab` wraps that API, adds session caches, handles cookie-based auth automatically, and exposes the whole thing as MCP tools.

A core design choice: **slab returns structured JSON, not pre-digested prose**. Earlier versions rendered markdown summaries, classified identifier values by shape, and flagged columns as "likely broken" inside the script. That's all gone. The current shape is: fetch → project to a token-cheap form → return raw JSON. Interpretation, classification, and judgment happen in the LLM. The script's job is fetching, projecting, and caching — not deciding.

---

## Requirements

- **macOS.** Cookie-reader is Chrome + Keychain specific. Cross-platform auth is on the roadmap.
- **Node ≥ 18.** Uses native `fetch` + ESM.
- **Google Chrome**, logged into Clay in any profile. Cookie is read from Chrome's on-disk SQLite DB on every call.

---

## Installation

```bash
git clone https://github.com/<you>/slab-mcp.git
cd slab-mcp
npm install
```

That's it for the server. Next step is auth + wiring into your MCP client.

---

## Authentication

slab reads your Clay session cookie automatically from Chrome. No config needed in the happy path.

### How it works

1. On every API call, slab opens Chrome's on-disk cookie DB (read-only, copied to a temp file so Chrome keeps its lock).
2. It fetches the **Chrome Safe Storage** key from the macOS Keychain to decrypt `v10`/`v11` AES-CBC cookie values.
3. Every `clay.com` / `clay.run` cookie is reassembled and sent as the `Cookie:` header.

The first call after install will trigger a macOS keychain prompt (`security` wants to access "Chrome Safe Storage"). Allow it once and you're set.

### Manual fallback

If Chrome isn't available or keychain access is denied, create `~/.slab/config.json`:

```json
{ "sessionCookie": "claysession=...; csrf=...; ..." }
```

Grab the full cookie header from DevTools → Application → Cookies → `app.clay.com`. You'll need to refresh it whenever Clay rotates the session (typically every few weeks).

> **API key auth is on the roadmap** but not yet implemented — the internal `/v3/` API slab uses doesn't accept API keys today.

---

## Configuration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "slab": {
      "command": "node",
      "args": ["/absolute/path/to/slab-mcp/index.js"]
    }
  }
}
```

Quit and relaunch Claude Desktop. Verify in **Settings → Developer** that `slab` shows as connected.

### Claude Code

Add to `~/.claude.json` (user-level) or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "slab": {
      "command": "node",
      "args": ["/absolute/path/to/slab-mcp/index.js"]
    }
  }
}
```

Then in Claude Code run `/mcp` and reconnect `slab`.

### Any other MCP client

slab is a standard stdio MCP server. Anything that speaks MCP can run it:

```bash
node /absolute/path/to/slab-mcp/index.js
```

---

## Tools

slab exposes six data tools — what a table IS and what's IN it. Builder workflows (writing formulas, writing Claygent prompts) live in [skills](#skills) instead.

| Tool | Use when | Returns |
|---|---|---|
| `sync_table` | URL contains `/tables/` (not `/workbooks/`) | `{ rootSchema, subroutines }`. Schema includes every field's full `typeSettings` (formula text, prompts, run conditions, full inputsBinding) and `pricing` on action fields (basic credits, actionExecution, pre/post-2026 pricing). Recursively syncs invoked functions to depth 3, max 20 tables. |
| `sync_workbook` | URL contains `/workbooks/` | `{ workbookId, tables, externalSubroutines, errors }`. Every table in the workbook plus any function it calls that lives elsewhere. Cross-table connections are not pre-computed — derive from `typeSettings`. |
| `get_rows` | Show data, check fill rates, find a row's `_rowId` by query, look up an entity by name / domain / email, switch to a saved view without re-syncing | `{ totalRows, returnedCount, view, rows }`. Accepts either `tableId` (from a prior sync_table) or `url` (auto-syncs). With `query`, each row has `_rowId`, `_csvIndex`, and `matchedColumns`; pass `identifier_column` to scope the search to one column. Pass `view` (viewId `gv_*` or view name like "All rows" / "Errored rows") to query a different saved view than the one picked at sync time. |
| `get_record` | You have a `_rowId` and need raw provider JSON, credit cost, or you're following a subroutine `origin` pointer | `{ _rowId, _credits, <columnName>: { value, status, fullContent, credits? } }`. |
| `get_credits` | "How much did row X cost" / "average credit cost per row" / "which column is most expensive" | One tool, three modes. With `rowId`: that row's per-column breakdown, **including the cost of any function (execute-subroutine) calls it triggered** — recursively follows `origin` pointers to function rows since parent cells don't carry subroutine cost. Without `rowId`: samples N rows (default 50), aggregates, splits direct columns from subroutine columns, and extrapolates a total table cost. Pass `full: true` to scan every row, or `subroutine_depth: 0` to skip recursion (parent-only cost, will undercount). |
| `get_errors` | Broad "what's failing" / health check | `{ rowsAnalyzed, view, columns: [{ success, error, hasNotRun, queued, total, fillPct, topErrors }] }`. Counts only — Claude derives "broken" vs "gated by run condition" from the schema. Pass `view="Errored rows"` (or any saved view) to scope the count; on a table with that view, this is much faster than counting across the whole table. |

The MCP server's `instructions` field carries the full decision tree (which tool when, the cost rule of thumb between cheap CSV reads and expensive nested fetches, how to follow subroutine pointers, how to interpret credit fields) — Claude sees it on every conversation that uses any slab tool.

---

## Architecture

slab's job is to bridge Clay's internal API to an LLM. The architecture follows from one constraint and one bet:

**The constraint:** Clay's `/v3/` API responses are huge. A single 19-column table's schema is hundreds of KB of action definitions, output schemas, and UI strings. Returning them raw would 5–10x token cost before Claude reads anything.

**The bet:** every other piece of judgment — what counts as "broken," whether a value is an email or a domain, how to format an explanation — is better done by the LLM than by JavaScript heuristics. Scripts are fast and deterministic but rigid; the moment Clay reworks an error string or adds a new identifier shape, a heuristic silently misclassifies. The LLM weighs context.

Together those two ideas produce slab's shape: **scripts handle what the LLM can't do cheaply (auth, polling, pagination, caching, projecting away noise); the LLM handles everything else**.

### Layers

```
index.js                 MCP server, tool definitions, decision-tree instructions
src/clay-api.js          Clay internal API client — endpoint helpers + schema projection
src/auth.js              Credential resolver (Chrome → ~/.slab/config.json fallback)
src/cookie-reader.js     Decrypts Chrome's on-disk cookie DB via macOS Keychain
src/row-utils.js         CSV parsing, status counting, record projection (token-cheap shape)
skills/                  Installable Claude Code skills — write-clay-formula, write-claygent-prompt
```

Four things are worth understanding deeper because they're what makes slab actually useful for "explain this table" / "why did X fail" questions, beyond just listing endpoints:

### 1. Schema sync is recursive (functions get pulled in automatically)

In Clay, a "function" is another table invoked from a parent column with `actionKey: "execute-subroutine"`. The parent's schema tells you WHICH function runs; the function's own schema tells you HOW. Without the function's schema, any explanation of the parent is incomplete.

`sync_table` follows every `execute-subroutine` reference and syncs the target table too, recursively, up to depth 3 with a 20-table cap. `sync_workbook` does the same and additionally pulls in any function referenced by a workbook table that lives outside the workbook. Every fetched schema goes into the in-memory cache, so subsequent `get_rows` / `get_record` / `get_errors` calls on those tableIds work without a fresh sync.

The result: one call brings back the entire call graph the parent table participates in.

### 2. Row lookup is a CSV bulk read + lazy rowId resolution

Locating a row by value (`get_rows` with a query) is a three-step lookup, not a database index.

**Bulk read once.** The first call on a table triggers Clay's async CSV export, polls until the download URL is ready, parses the CSV, and caches it in `rowsCache[tableId]` for the lifetime of the server. Subsequent searches on the same table skip the network entirely.

**In-memory substring scan.** Every search is a linear pass over the cached CSV — case-insensitive substring match. By default it scans every column; pass `identifier_column` to restrict to one. The result is a list of matches with the CSV index and a `matchedColumns` array per hit. No inverted index, no fuzzy/regex matching. ~1K rows × 20 columns is ~20K cell comparisons (sub-millisecond); for very large tables the CSV download itself is the bottleneck, not the scan.

**Bulk rowId resolution.** The CSV is display values only — no API `_rowId`. So when slab needs a rowId for a match, it pulls the full `/records?limit=20000` window once per `(tableId, viewId)` and indexes into the resulting array — CSV row order matches API row order 1:1, so `csvIndex` is also the API index. The fetch promise is memoized in `rowsCache.rowIdsPromise` so concurrent matches share one round-trip.

The reason it's bulk, not per-match: Clay's `/records` endpoint silently ignores every pagination param we tested (`offset`, `cursor`, `after`, `page`, ...) and returns the same first 20k rows regardless. The earlier per-match `?offset=<csvIndex>` lookup therefore always returned API row 0 — every CSV match resolved to the same wrong `_rowId`. Bulk-fetch sidesteps the broken pagination entirely.

**Cap.** Tables larger than 20k rows can still be CSV-searched, but matches beyond row 20k come back with `_rowId: null` and the response carries a `rowIdsTruncated` note. CSV export remains the only path to *full* coverage on tables of that size.

A search like `"acme"` will often hit multiple columns simultaneously — Name, URL, parent company. Each match's `matchedColumns` array is what Claude uses to pick the right hit. There's no script-side priority hierarchy.

### 3. Record tracing follows subroutine pointers down through execution

When a record's cell contains `fullContent.origin = { tableId, recordId }`, that cell is the OUTPUT of a function execution and `origin` is a POINTER to the row that actually ran. The parent row tells you the function "succeeded" with a display value; the child row reveals what happened inside — which provider in the waterfall ran, which inputs the parent passed in, which run conditions gated.

The MCP server's instructions require Claude to follow every `origin` pointer with `get_record(origin.tableId, origin.recordId)` before calling an execution trace complete, recursing up to 3 levels deep. Without that, "why did X fail for Y?" answers are surface-level guesses. With it, you get the full execution graph.

This is the highest-leverage thing slab does. It's also the easiest part to get wrong if you skip the follow-up calls — which is why it's spelled out in both the server instructions and the `get_record` tool description.

### 4. Credit cost rides along on every record fetch

Every action cell in a Clay record carries credit data in `externalContent`:

- `upfrontCreditUsage.totalCost` — basic credits charged for the run.
- `additionalCreditUsage.totalCost` — credits charged after the run completed (e.g., long-running providers).
- `hiddenValue.costDetails.totalCostToAIProvider` — for AI columns, the underlying OpenAI / Anthropic dollar cost.

The schema-level pricing (`field.actionDefinition.pricing.credits`) tells you what a column COSTS per run; the record-level usage tells you what a row ACTUALLY COST. Both are exposed:

- `sync_table` returns each action field's `pricing` (current credits + post-2026 pricing).
- `get_record` returns per-cell `credits.{ total, upfront, additional, aiProviderCost }` and a row-level `_credits.{ total, billedCellCount }` roll-up.
- `get_credits` rolls credit data up across rows in one call — pass a `rowId` for one row's breakdown, or omit it to sample N rows (default 50) and extrapolate a total table cost. Pass `full: true` to scan every row.

**Subroutine cost is billed separately** — and `get_credits` follows it. When a parent row has an `execute-subroutine` cell (a column that invokes another table as a function), that cell's `credits` is `null`. The actual function-call credits are billed on the *function row* that ran, reachable via `fullContent.origin.{tableId, recordId}`. `get_record` alone shows only the parent's direct cost, which can drastically undercount the true per-row spend on tables that use functions heavily. `get_credits` recursively follows the origin pointers and returns `{ direct, viaSubroutines, total }` plus per-subroutine-column detail. Default recursion depth is 2 (parent → function → one nested level); pass `subroutine_depth: 0` to disable. Aggregate mode splits the rollup into `byColumn` (direct cells) and `bySubroutineColumn` (function calls), so it's clear which Clay column triggers the most function-driven spend.

This makes "how much does this row cost" / "what's our average credit spend per row" / "which column is most expensive" / "did this AI call burn $ I didn't expect" answerable without the user opening the Clay UI.

### Saved views

Clay tables expose multiple saved views — typical examples: "Default view," "All rows," "Errored rows," and any custom filtered view the table builder created. Each view returns a different row set (server-side filtered) and potentially a different ordering.

`sync_table` lists every available view in `rootSchema.views: [{ id, name }]` and picks one as the active default. The picker prefers an "All rows" view if it exists, otherwise the URL's view, otherwise the table's first view. That choice is the default for `get_rows` and `get_errors` after sync.

To query a different view without re-syncing, pass the optional `view` parameter to either tool. It accepts a viewId (`gv_*`) or a view name (case- and whitespace-tolerant — `"Errored rows"`, `"errored_rows"`, `"ERRORED ROWS"` all match the same view). The most common power move: `get_errors` with `view="Errored rows"` is much faster and more focused than scanning the whole table — it only counts statuses across already-failing rows. Same pattern works for any custom filter view (`"Fully enriched rows"`, `"Tier 1 accounts only"`, etc.).

The `rowsCache` is keyed per `(tableId, viewId)` because views are different row sets — switching views doesn't re-fetch the original view's data, and switching back later hits the cache.

### Session caches

Both caches live in-process and vanish when the MCP server restarts. Pass `force_refresh: true` to `get_rows` to discard the rows cache for one tableId; re-syncing a table also invalidates its cached rows.

- `schemaCache`: `tableId → schema`. Populated by `sync_table` / `sync_workbook`, and lazily by `get_rows` when called with a `url` instead of a `tableId`.
- `rowsCache`: `tableId → Map<viewId, { headers, csvRows, totalRows, rowIdsPromise, syncedAt }>`. Populated on first `get_rows` call. Keyed per-view because different saved views return different row sets and orderings — the index → rowId mapping has to be per-view too. `rowIdsPromise` lazy-loads the bulk `/records` fetch on first need and is shared across concurrent matches. See [Row lookup](#2-row-lookup-is-a-csv-bulk-read--lazy-rowid-resolution) above for how the CSV/rowId split works.

---

## Skills

slab ships two installable Claude Code skills under [`skills/`](skills/). They're separate from the MCP server — the MCP gives Claude *data tools*; the skills give Claude *builder workflows*.

| Skill | Triggers on | What it does |
|---|---|---|
| [`write-clay-formula`](skills/write-clay-formula/SKILL.md) | "write / fix / debug / review a Clay formula" | Walks the formula-generation workflow: gather inputs → check sandbox traps → write → validate. Encodes the 10 critical syntax rules (no `return`, no template literals, optional chaining everywhere, lookup `.records` / filter `.filteredArray` wrappers, `Number()` for scoring), 30 worked patterns, and the confirmed production bugs (Object.assign on enrichment objects, Audiences round-trip, waterfall context-change). |
| [`write-claygent-prompt`](skills/write-claygent-prompt/SKILL.md) | "write / fix / review a Claygent or Use AI prompt" | Picks the mode first — web research (12 mandatory sections, internet access) vs content manipulation (10 sections, no internet). Encodes the section structure, casing conventions (snake_case inputs, camelCase outputs, ALL CAPS filler variables), forbidden-strings list, the empty-string null policy with 3+ reinforcement, anti-hallucination guardrails, and the model + action-key cost ladder. |

### Why skills, not knowledge-base docs

Earlier versions of slab shipped a `kb/` directory with reference markdown for formulas, prompts, providers, debugging, etc. — pulled in via a `read_kb` MCP tool. That's gone. The skills replace it.

Reference docs let Claude *look things up after it's already chosen what to do*. Skills shape the *order of operations* before any choice is made — they're a workflow with an embedded constraint set, not a cookbook. For "write a Clay formula" or "write a Claygent prompt," the workflow is the leverage. Reference material that doesn't change the order Claude does things in is mostly bulk Claude already knows from training.

### Installing the skills

The skills are Claude Code-specific. Claude Desktop and direct API users don't get this scaffolding; they fall back on the MCP server's `instructions` field for tool selection only.

For per-user install:

```bash
mkdir -p ~/.claude/skills
cp -r skills/write-clay-formula     ~/.claude/skills/
cp -r skills/write-claygent-prompt  ~/.claude/skills/
```

Or symlink so updates from `git pull` propagate without re-copying:

```bash
ln -s "$(pwd)/skills/write-clay-formula"    ~/.claude/skills/write-clay-formula
ln -s "$(pwd)/skills/write-claygent-prompt" ~/.claude/skills/write-claygent-prompt
```

For project-scoped install, drop them under `.claude/skills/` in the project root instead.

Verify with `/skills` in Claude Code.

### Editing the skills

Edit the SKILL.md file directly. Skills are loaded fresh on each invocation — no build step, no MCP reconnect needed. PRs welcome.

---

## Typical query patterns

**"Sync this workbook and tell me what it does"**
```
sync_workbook → Claude reads every table's schema + cross-table connections → explains
```

**"Why did this enrichment fail for Acme Corp?"**
```
get_rows(url, query="Acme Corp")
  → Claude scans matches, picks the right hit by matchedColumns
get_record(tableId, rowId)
  → record arrives with all subroutine origin pointers
get_record per origin (in parallel)
  → Claude reconstructs the full execution graph
```

**"How much did row X cost in credits?"**
```
get_rows(url, query="X", limit=1)
  → match comes back with _rowId
get_record(tableId, rowId)
  → record._credits.total = 10.9 across 6 billed cells
  → per-cell breakdown shows which column was most expensive
  → AI cells additionally disclose the OpenAI dollar cost
```

**"How much does this whole table cost to run, on average per row?"**
```
get_credits(tableId)                  # samples 50 rows, extrapolates
  → perRow.avg, perRow.min, perRow.max
  → byColumn ranked by avgCreditsPerRow (which enrichments dominate)
  → extrapolatedTotalCredits = avg × schema.rowCount
```

**"Help me rewrite the Claygent prompt in column X"**
```
sync_table (schema shows current prompt text in full)
  → write-claygent-prompt skill auto-triggers
  → skill picks mode (web research vs content manipulation)
  → skill walks the 12- or 10-section workflow
  → returns a rewritten prompt with proper casing, null policy, examples
```

**"Fix this formula"**
```
sync_table (schema shows current formula text)
  → write-clay-formula skill auto-triggers
  → skill checks sandbox traps, optional-chaining, lookup column wrapping
  → returns a corrected formula with the 10 syntax rules satisfied
```

**"Which columns are broken across this table?"**
```
get_errors → per-column status counts
sync_table → cross-reference with each column's run condition
  → Claude separates "broken" from "intentionally gated"
```

---

## Development

```bash
npm start                # run the server directly (stdio)
node --check index.js    # syntax check

# Manual probes against a real Clay session — not real tests, just scratch scripts:
node test.js
node test-export.js
node test-workbook.js
```

There's no test suite yet. Contributions welcome.

---

## Roadmap / known limitations

- **macOS only.** `cookie-reader.js` uses Chrome's on-disk DB + Keychain. Linux/Windows support would mean a per-browser-per-OS cookie reader per platform.
- **Cookie auth only.** API key support is desired but the internal `/v3/` API slab uses doesn't accept keys today.
- **No persistent cache.** Every server restart rehydrates from Clay. For large workbooks this is a few seconds of re-sync.
- **No test suite.** `test*.js` files are manual probes, not assertions.

---

## License

MIT.
