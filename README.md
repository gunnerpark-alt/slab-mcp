# slab-mcp (API-key edition)

**MCP server for analyzing Clay tables** — schema, rows, errors, credit cost, and enrichment debugging, via Clay's public v3 API.

Connects Claude (Desktop, Code, or any MCP client) to Clay. Share any `app.clay.com` URL and Claude can read the schema, pull rows, trace enrichment failures end-to-end through Clay Functions (subroutines), and see exactly how many credits each cell consumed. Two installable Claude Code skills (`write-clay-formula`, `write-claygent-prompt`) cover the writing workflows.

> This is the **API-key branch**. It authenticates with a Clay API key instead of a session cookie — cross-platform (macOS / Linux / Windows), no Chrome dependency. The cookie-based version lives on the `main` branch.

---

## What you get

- **Read any Clay table or workbook** — schema, formulas (full text, no truncation), run conditions, providers, dependencies, recursive function calls.
- **Trace why an enrichment failed** — find a row by name, get the raw provider response, follow each subroutine pointer into the child row that actually ran, recurse up to 3 levels.
- **See per-row credit cost** — every cell's basic credits, action-execution credits, post-2026 pricing, and underlying OpenAI/Anthropic dollar cost for AI columns. Roll-up total per row.
- **Spot what's broken across a table** — per-column status counts (success / error / has-not-run / queued), error message frequencies, fill rate.
- **Write or fix formulas and Claygent prompts** — two installable Claude Code skills (`write-clay-formula`, `write-claygent-prompt`) walk the workflow: gather inputs, pick the mode, apply the section structure and casing conventions, validate against the production-bug checklist.

---

## Why does this exist?

Most of the interesting state in a Clay table — schema, formula text, run conditions, cell statuses, provider responses, **credit cost per cell**, subroutine pointers — comes back from the `/v3/` API. `slab` wraps that API, adds session caches, and exposes the whole thing as MCP tools. This branch uses a Clay API key for auth so the server runs anywhere Node runs, with no browser or Keychain dependency.

A core design choice: **slab returns structured JSON, not pre-digested prose**. Earlier versions rendered markdown summaries, classified identifier values by shape, and flagged columns as "likely broken" inside the script. That's all gone. The current shape is: fetch → project to a token-cheap form → return raw JSON. Interpretation, classification, and judgment happen in the LLM. The script's job is fetching, projecting, and caching — not deciding.

---

## Requirements

- **Node ≥ 18.** Uses native `fetch` + ESM. Runs on macOS, Linux, and Windows.
- **A Clay API key.** Get one from your workspace settings (see [Authentication](#authentication)).

---

## Installation

```bash
git clone -b api-key-auth https://github.com/gunnerpark-alt/slab-mcp.git
cd slab-mcp
npm install
```

That's it for the server. Next step is auth + wiring into your MCP client.

---

## Authentication

slab reads your Clay API key from one of two places, in order:

1. **`CLAY_API_KEY` environment variable** — recommended for MCP clients (Claude Desktop / Code), set via the server's `env` block (see [Configuration](#configuration)).
2. **`~/.slab/config.json`** — fallback for users who'd rather not put the key in shell or client config.

### Step 1 — Get your API key

1. Open Clay in a browser and pick the workspace you want slab to read from.
2. Note the workspace ID — the number in the URL: `app.clay.com/workspaces/<workspace-id>/...`.
3. Visit `https://app.clay.com/workspaces/<workspace-id>/settings/account` and copy the API key.

The key authenticates against the workspaces it has access to — a workspace-level key reads tables in that workspace and any others your account is a member of, subject to Clay's permissioning. It does **not** grant access to workspaces you aren't already in.

### Step 2 — Make the key available to slab

**Option A — via your MCP client config (recommended).** Put the key in the `env` block of the slab server entry (see the [Configuration](#configuration) section below). The key never touches your shell history, the repo, or any file slab creates.

**Option B — `~/.slab/config.json`.** Create the file with mode 600 so only you can read it:

```bash
mkdir -p ~/.slab
cat > ~/.slab/config.json <<'EOF'
{ "apiKey": "<paste-your-key-here>" }
EOF
chmod 600 ~/.slab/config.json
```

This file is outside the repo and is not checked in. Don't put it inside the slab-mcp checkout.

### Don't commit your key

- `~/.slab/config.json` is a per-user file outside the repo — safe by location.
- `.env`, `.env.*`, and `.claude/` are already in `.gitignore` (the second covers Claude Code's local settings, which is where MCP `env` values live).
- Never paste the key into a file inside this repo, into a commit message, or into the `args` array of an MCP server config (use `env` instead).

---

## Configuration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your OS:

```json
{
  "mcpServers": {
    "slab": {
      "command": "node",
      "args": ["/absolute/path/to/slab-mcp/index.js"],
      "env": {
        "CLAY_API_KEY": "<paste-your-key-here>"
      }
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
      "args": ["/absolute/path/to/slab-mcp/index.js"],
      "env": {
        "CLAY_API_KEY": "<paste-your-key-here>"
      }
    }
  }
}
```

If your project uses `.claude/settings.local.json`, you can put the key there instead — that file is gitignored by Claude Code:

```json
{
  "env": {
    "CLAY_API_KEY": "<paste-your-key-here>"
  }
}
```

Then in Claude Code run `/mcp` and reconnect `slab`.

### Any other MCP client

slab is a standard stdio MCP server. Anything that speaks MCP can run it. Make sure `CLAY_API_KEY` is in the environment (or that `~/.slab/config.json` exists):

```bash
CLAY_API_KEY=<your-key> node /absolute/path/to/slab-mcp/index.js
```

---

## Tools

slab exposes six data tools — what a table IS and what's IN it. Builder workflows (writing formulas, writing Claygent prompts) live in [skills](#skills) instead.

| Tool | Use when | Returns |
|---|---|---|
| `sync_table` | URL contains `/tables/` (not `/workbooks/`) | `{ rootSchema, subroutines }`. Schema includes every field's full `typeSettings` (formula text, prompts, run conditions, full inputsBinding) and `pricing` on action fields (basic credits, actionExecution, pre/post-2026 pricing). Recursively syncs invoked functions to depth 3, max 20 tables. |
| `sync_workbook` | URL contains `/workbooks/` | `{ workbookId, tables, externalSubroutines, errors }`. Every table in the workbook plus any function it calls that lives elsewhere. Cross-table connections are not pre-computed — derive from `typeSettings`. |
| `get_rows` | Show data, check fill rates, find a row's `_rowId` by query, look up an entity by name / domain / email, switch to a saved view without re-syncing | `{ totalRows, returnedCount, view, rows }`. Every row carries `_rowId`. Accepts either `tableId` (from a prior sync_table) or `url` (auto-syncs). With `query`, rows also have `matchedColumns` (every column whose cell matched); pass `identifier_column` to scope the search to one column. Pass `view` (viewId `gv_*` or view name like "All rows" / "Errored rows") to query a different saved view than the one picked at sync time. |
| `get_record` | You have a `_rowId` and need raw provider JSON, credit cost, or you're following a subroutine `origin` pointer | `{ _rowId, _credits, <columnName>: { value, status, fullContent, credits? } }`. |
| `get_credits` | "How much did row X cost" / "average credit cost per row" / "which column is most expensive" | One tool, three modes. With `rowId`: that row's per-column breakdown, **including the cost of any function (execute-subroutine) calls it triggered** — recursively follows `origin` pointers to function rows since parent cells don't carry subroutine cost. Without `rowId`: samples N rows (default 50), aggregates, splits direct columns from subroutine columns, and extrapolates a total table cost. Pass `full: true` to scan every row, or `subroutine_depth: 0` to skip recursion (parent-only cost, will undercount). |
| `get_errors` | Broad "what's failing" / health check | `{ rowsAnalyzed, view, columns: [{ success, error, hasNotRun, queued, total, fillPct, topErrors }] }`. Counts only — Claude derives "broken" vs "gated by run condition" from the schema. Pass `view="Errored rows"` (or any saved view) to scope the count; on a table with that view, this is much faster than counting across the whole table. |

The MCP server's `instructions` field carries the full decision tree (which tool when, the cost rule of thumb between cheap surface reads and expensive nested fetches, how to follow subroutine pointers, how to interpret credit fields) — Claude sees it on every conversation that uses any slab tool.

---

## Architecture

slab's job is to bridge Clay's internal API to an LLM. The architecture follows from one constraint and one bet:

**The constraint:** Clay's `/v3/` API responses are huge. A single 19-column table's schema is hundreds of KB of action definitions, output schemas, and UI strings. Returning them raw would 5–10x token cost before Claude reads anything.

**The bet:** every other piece of judgment — what counts as "broken," whether a value is an email or a domain, how to format an explanation — is better done by the LLM than by JavaScript heuristics. Scripts are fast and deterministic but rigid; the moment Clay reworks an error string or adds a new identifier shape, a heuristic silently misclassifies. The LLM weighs context.

Together those two ideas produce slab's shape: **scripts handle what the LLM can't do cheaply (auth, polling, pagination, caching, projecting away noise); the LLM handles everything else**.

### Layers

```
index.js                 MCP server, tool definitions, decision-tree instructions
src/clay-api.js          Clay v3 API client — endpoint helpers + schema projection
src/auth.js              Credential resolver (CLAY_API_KEY env → ~/.slab/config.json fallback)
src/row-utils.js         Status counting, record projection (token-cheap shape)
skills/                  Installable Claude Code skills — write-clay-formula, write-claygent-prompt
```

Four things are worth understanding deeper because they're what makes slab actually useful for "explain this table" / "why did X fail" questions, beyond just listing endpoints:

### 1. Schema sync is recursive (functions get pulled in automatically)

In Clay, a "function" is another table invoked from a parent column with `actionKey: "execute-subroutine"`. The parent's schema tells you WHICH function runs; the function's own schema tells you HOW. Without the function's schema, any explanation of the parent is incomplete.

`sync_table` follows every `execute-subroutine` reference and syncs the target table too, recursively, up to depth 3 with a 20-table cap. `sync_workbook` does the same and additionally pulls in any function referenced by a workbook table that lives outside the workbook. Every fetched schema goes into the in-memory cache, so subsequent `get_rows` / `get_record` / `get_errors` calls on those tableIds work without a fresh sync.

The result: one call brings back the entire call graph the parent table participates in.

### 2. Row lookup splits by mode: server-side search for queries, paginated read for samples

`get_rows` has two paths, both backed by Clay's internal records API — no CSV machinery, no session caching.

**With a query — server-side search.** Slab posts to Clay's internal `POST /tables/{tableId}/views/{viewId}/search` endpoint with `{ searchTerm }`. Clay runs the same case-insensitive substring match its own UI search box uses, returning `{ results: [{ fieldId, recordId }] }` — one entry per matching cell, so the same record can repeat across columns. Slab dedupes by `recordId`, builds a `matchedColumns` list per match, then fetches each unique record in parallel (concurrency 5) to populate display values. One round-trip plus N record fetches, no row-count ceiling. Server caps at 1000 matching cells per response — broad substrings like `"@"` or a common domain may saturate it; slab surfaces a `hitCapWarning` when that happens.

This replaced an earlier paginate-the-whole-CSV approach that on a 100k-row table scanned forever and could fail mid-way. Server-side search returns in seconds for any table size.

**Without a query — direct read.** `GET /records?limit=N` returns the first N rows, each with its own `id` and `cells`. Slab projects `cells.value` to a display dict, attaches `_rowId`, and returns. One API call, no caching needed.

The records endpoint is also what powers `get_errors` and `get_credits` aggregate mode via `listRows`, which fetches up to `RECORDS_API_CAP` (20000) rows in one shot — the records API silently ignores every pagination param we tested (`offset`, `cursor`, `after`, `page`, ...). `get_errors` flags `truncated` in its response when the view exceeds the cap so partial counts aren't read as full coverage.

A search like `"acme"` will often hit multiple columns simultaneously — Name, URL, parent company. Each match's `matchedColumns` list is what Claude uses to pick the right hit. There's no script-side priority hierarchy.

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

### Session caches

The schema cache lives in-process and vanishes when the MCP server restarts.

- `schemaCache`: `tableId → schema`. Populated by `sync_table` / `sync_workbook`, and lazily by `get_rows` when called with a `url` instead of a `tableId`. There is no row cache — both `get_rows` paths hit Clay directly each call.

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

- **Workspace scope follows the API key.** The key authenticates against the workspaces your Clay account already has access to. To read a different workspace, generate a key in that workspace.
- **No persistent cache.** Every server restart rehydrates from Clay. For large workbooks this is a few seconds of re-sync.
- **No test suite.** `test*.js` files are manual probes, not assertions.

---

## License

MIT.
