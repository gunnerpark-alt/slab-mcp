# slab-mcp

**MCP server for analyzing Clay tables** — schema, rows, errors, and enrichment debugging, via the same internal Clay API the frontend uses.

Connects Claude (Desktop, Code, or any MCP client) to Clay. Share any `app.clay.com` URL and Claude can read the schema, pull rows, trace enrichment failures end-to-end through Clay Functions (subroutines), and lean on a 13-topic knowledge base of Clay platform patterns when writing formulas or prompts.

---

## Why slab?

Clay's public API is minimal. Most of the interesting state — schema, formula text, run conditions, cell statuses, provider responses, subroutine pointers — only comes back from the internal `/v3/` API the Clay frontend calls. `slab` wraps that API, adds a session cache, handles cookie-based auth automatically, and exposes the whole thing as MCP tools so an assistant can reason about a table the same way a Clay builder does.

What you can do with it, out of the box:

- **"Explain this table"** — one `sync_table` call returns the whole schema, including every column's formula text, run condition, enrichment provider, and dependencies. Functions the table invokes are auto-synced recursively.
- **"Why did X fail for Company Y?"** — `find_record` locates the row by identifier, pulls the full nested enrichment JSON, and lets the model follow each subroutine's `origin` pointer into the actual child record that ran — so the execution trace isn't guesswork.
- **"What's broken across the table?"** — `get_errors` produces a per-column breakdown (SUCCESS / ERROR / HAS_NOT_RUN / QUEUED), surfaces top error messages, and flags likely-broken columns (0% success).
- **"Help me fix this formula / rewrite this prompt"** — `read_kb` serves 13 Clay-specific reference docs: formula syntax rules, Claygent pre-writing process, output contracts, waterfall patterns, provider gotchas, debugging playbook. The server instructions route improve/fix/rewrite asks to the right topics automatically.

---

## Requirements

- **macOS.** Cookie-reader is Chrome + Keychain specific. Cross-platform auth is on the roadmap.
- **Node ≥ 18.** Uses native `fetch` + ESM.
- **Google Chrome**, logged into Clay in any profile. Cookie is read from Chrome's on-disk SQLite DB on every call.
- **Clay knowledge base** (for `read_kb`) at `~/clay-kb/wiki/`. Ships separately — see [Knowledge base](#knowledge-base).

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

slab exposes six tools. They fall into two orthogonal groups:

**Data tools** — tell you what a table IS and what's IN it:

| Tool | Use when | Returns |
|---|---|---|
| `sync_table` | URL contains `/tables/` (not `/workbooks/`) | Schema (columns, formulas, run conditions, providers, dependencies). Recursively syncs any subroutines the table invokes — up to depth 3, 20 tables max. |
| `sync_workbook` | URL contains `/workbooks/` | Every table in the workbook + cross-table connections (route-row, lookups) + any external subroutines referenced. |
| `get_rows` | Show data, check fill rates, find a row's `_rowId` by search | CSV display values (fast) + `_rowId` on matched rows. No statuses — use `get_errors` for those. |
| `get_record` | You have a `_rowId` and need raw provider JSON, or you're following a subroutine `origin` pointer | Full `externalContent.fullValue` + status for every cell. |
| `find_record` | User named a specific entity (company, domain, email) and wants the why/how | Auto-detects the identifier column by value shape, returns full nested JSON on exact-one match, candidate list on multi-match. Session-cached. |
| `get_errors` | Broad "what's failing" / table-wide health check | Per-column success/error/has-not-run/queued counts, top error messages, likely-broken flags. |

**Knowledge tool** — tells you what GOOD looks like:

| Tool | Use when | Returns |
|---|---|---|
| `read_kb` | User asks to improve / fix / rewrite / review / audit / debug / design / optimize anything in a Clay table | Full markdown of one of 13 Clay platform reference docs (see [Knowledge base](#knowledge-base)). |

### Decision tree (embedded in server instructions)

The MCP server ships a strict decision tree so the model picks the right tool without guessing:

```
1. Clay URL shared?
   /workbooks/ → sync_workbook
   /tables/    → sync_table

2. Specific entity named (company, person, domain, email)?
   Needs nested JSON / provider response → find_record
   Just wants surface value                → get_rows with query

3. Table-wide question?
   "what's in it / fill rate"             → get_rows
   "what's broken / what's failing"       → get_errors

4. Improve / fix / rewrite / review / debug / design?
   → read_kb WITH the data tools (not instead of them)
```

### Subroutine tracing

Clay Functions are tables invoked from a parent column with `actionKey: "execute-subroutine"`. When you fetch a record that contains subroutine cells, each one has `fullContent.origin.tableId` + `fullContent.origin.recordId` — a pointer to the child row that actually ran. The server instructions require following every pointer with `get_record(origin.tableId, origin.recordId)` before calling the execution trace complete. This is what makes "why did X fail for Y?" answers actually accurate instead of surface-level.

---

## Knowledge base

`read_kb` reads markdown files from `~/clay-kb/wiki/`. The 13 topics:

| Topic | What it covers |
|---|---|
| `formula-syntax` | 8 critical Clay formula syntax rules, banned JS features, working substitutes |
| `formula-patterns` | Lodash/Moment reference, scoring, array manipulation, real-world examples |
| `formula-bugs` | Confirmed Clay formula bugs (Object.assign failure, forward-reference cascades) |
| `prompt-anatomy` | The 8-section skeleton for every Clay AI prompt |
| `output-contracts` | JSON schemas, forbidden strings (`N/A`, `Unknown`), null policies, camelCase vs snake_case |
| `claygent` | Claygent vs Use AI, 12-section structure, search strategy, failure modes |
| `pipeline-stages` | Standard pipeline (input → identity → enrichment → score → export), multi-table patterns |
| `orchestration` | 15 advanced workarounds (fan-out, sparse data gates, AI-generated SOQL, screenshot+vision) |
| `builder-patterns` | Formula vs action columns, cell size, batching, tables-as-queues |
| `waterfalls` | Waterfall structure, cumulative exclusion gates, email/phone/domain waterfall types |
| `providers` | 40+ providers with action keys, credit costs, output paths, provider-specific gotchas |
| `debugging` | Diagnostic formulas, yellow triangles, waterfall stalls, race conditions |
| `data-model` | Column types, 8KB/200KB limits, schema.json structure, provider output access paths |

The same content is also exposed as MCP resources (`clay-kb://formulas/syntax.md`, etc.) for clients that support resource reads.

> The KB itself lives in a separate repo. `~/clay-kb/wiki/` is expected to be a symlink to wherever you keep the markdown files.

---

## Typical query patterns

**"Sync this workbook and tell me what it does"**
```
sync_workbook → model reads every table's schema + cross-table connections → explains
```

**"Why did this enrichment fail for Acme Corp?"**
```
find_record(url, "Acme Corp")
  → follows every fullContent.origin.recordId
  → get_record per subroutine (in parallel)
  → model reconstructs the full execution graph
```

**"Help me rewrite the Claygent prompt in column X"**
```
sync_table (schema shows current prompt text)
read_kb("prompt-anatomy")
read_kb("claygent")
read_kb("output-contracts")
  → model returns a rewritten prompt following the 12-section structure
```

**"Which columns are broken across this table?"**
```
get_errors → table-wide status breakdown, flags 0%-success columns
```

**"Fix this formula"**
```
sync_table (shows formula text)
read_kb("formula-syntax")
read_kb("formula-patterns")
  → model returns corrected formula
```

---

## Architecture

```
index.js                 MCP server, tool + instruction definitions
src/clay-api.js          Clay internal API client (api.clay.com/v3)
src/auth.js              Credential resolver (Chrome → ~/.slab/config.json)
src/cookie-reader.js     Decrypts Chrome's on-disk cookie DB via Keychain
src/row-utils.js         CSV parsing, status analysis, record formatting
src/schema-analyzer.js   (retained for future use; not wired into any current tool)
src/summary-generator.js Markdown summary rendering for sync_table / get_errors
```

### Session caches

Both caches live in-process and vanish when the MCP server restarts:

- `schemaCache`: `tableId → schema`. Populated by `sync_table` / `sync_workbook`. Invalidated on re-sync of the same table.
- `rowsCache`: `tableId → { headers, csvRows, totalRows, rowIdsByIndex, syncedAt }`. Populated on first `get_rows` or `find_record` call. Includes a memoized CSV-index → rowId map so repeat lookups skip the paginated API.

### Subroutine recursion

`sync_table` scans for columns where `typeSettings.actionKey === 'execute-subroutine'`, extracts the child `tableId` from `inputsBinding`, and recursively syncs — with cycle detection and configurable caps (default: depth 3, total 20). `sync_workbook` additionally pulls in any subroutine referenced by a workbook table but living outside the workbook.

### Record tracing

`find_record` returns the parent row's full nested JSON. Each `execute-subroutine` output cell carries `fullContent.origin.recordId` + `fullContent.origin.tableId` — the pointer to the subroutine row that actually ran. Callers are instructed (via both the server's top-level instructions and the `get_record` tool description) to follow these pointers to see what happened inside each function call.

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
- **KB symlink is not managed.** `~/clay-kb/wiki/` must be set up out-of-band.

---

## License

MIT.
