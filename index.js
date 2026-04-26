#!/usr/bin/env node

/**
 * slab-mcp — MCP server for analyzing Clay tables.
 *
 * Tools:
 *   sync_table     — Fetch a Clay table's schema + recursively-synced subroutines
 *   sync_workbook  — Discover all tables in a workbook and fetch their schemas
 *   get_rows       — List display values from the CSV export (cheap)
 *   get_record     — Fetch one row's full nested JSON (expensive)
 *   find_record    — Substring-match across columns + auto-fetch on a unique hit
 *   get_errors     — Per-column status counts (success / error / has-not-run / queued)
 *   read_kb        — Read a Clay platform reference doc
 *
 * Design: tools return structured JSON. Interpretation, classification,
 * and prose-shaping happen in prompt context — not on the script side.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { getTableSchema, listRows, getRecord, getWorkbookTables, exportTableToCsv, fetchCsv, getRowsPage } from './src/clay-api.js';
import { analyzeRowStatuses, formatRecord, parseCsv, searchCsvRows } from './src/row-utils.js';

// ---------------------------------------------------------------------------
// In-memory caches (lifetime: MCP server process)
// ---------------------------------------------------------------------------

const schemaCache = new Map(); // tableId -> schema
const rowsCache   = new Map(); // tableId -> { headers, csvRows, totalRows, rowIdsByIndex, syncedAt }

function parseClayUrl(url) {
  if (!url) throw new Error('No URL provided. Pass a Clay table or workbook URL.');
  const workbookMatch = url.match(/workbooks\/(wb_[a-zA-Z0-9]+)/);
  const tableMatch    = url.match(/tables\/(t_[a-zA-Z0-9]+)/);
  const viewMatch     = url.match(/views\/(gv_[a-zA-Z0-9]+)/);
  return {
    workbookId: workbookMatch?.[1] || null,
    tableId:    tableMatch?.[1]    || null,
    viewId:     viewMatch?.[1]     || null
  };
}

function getSchema(tableId) {
  const schema = schemaCache.get(tableId);
  if (!schema) {
    throw new Error(
      `Table ${tableId} has not been synced yet. Call sync_table with the table URL first.`
    );
  }
  return schema;
}

function buildColumnMap(schema) {
  const map = {};
  for (const f of schema.fields) {
    map[f.id] = f.name;
  }
  return map;
}

/**
 * Detect columns that invoke another table as a function (Clay's "subroutine").
 * Returns [{ columnName, subroutineTableId, sourceId }, ...].
 * The subroutine's tableId is embedded as a string literal in inputsBinding.
 */
function detectSubroutineCalls(schema) {
  const calls = [];
  for (const f of schema.fields || []) {
    if (f.type !== 'action') continue;
    if (f.typeSettings?.actionKey !== 'execute-subroutine') continue;

    const binding = f.typeSettings.inputsBinding || [];
    const tableIdEntry = binding.find(b => b.name === 'tableId');
    const sourceIdEntry = binding.find(b => b.name === 'sourceId');

    const subroutineTableId = tableIdEntry?.formulaText?.replace(/^"|"$/g, '') || null;
    const sourceId = sourceIdEntry?.formulaText?.replace(/^"|"$/g, '') || null;

    if (subroutineTableId && /^t_[a-zA-Z0-9]+$/.test(subroutineTableId)) {
      calls.push({ columnName: f.name, subroutineTableId, sourceId });
    }
  }
  return calls;
}

/**
 * Fetch a table's schema and recursively pull in any subroutines it invokes.
 * Bounded by maxDepth and maxTotal to prevent runaway fetches.
 * Populates schemaCache for every table touched.
 */
async function syncTableRecursive(tableId, viewId, {
  maxDepth = 3,
  maxTotal = 20
} = {}) {
  const visited = new Set();
  const subroutines = [];
  let rootSchema = null;

  async function visit(id, view, depth, invokedBy) {
    if (visited.has(id)) return;
    if (visited.size >= maxTotal) return;
    visited.add(id);

    let schema = schemaCache.get(id);
    if (!schema) {
      schema = await getTableSchema(id, view);
      schemaCache.set(id, schema);
      rowsCache.delete(id);
    }

    if (depth === 0) {
      rootSchema = schema;
    } else {
      subroutines.push({ tableId: id, depth, invokedBy, schema });
    }

    if (depth >= maxDepth) return;

    for (const call of detectSubroutineCalls(schema)) {
      if (!visited.has(call.subroutineTableId)) {
        await visit(call.subroutineTableId, null, depth + 1, {
          tableId:    id,
          tableName:  schema.tableName,
          columnName: call.columnName
        });
      }
    }
  }

  await visit(tableId, viewId, 0, null);
  return { rootSchema, subroutines };
}

/**
 * Fetch + parse the CSV for a table, or return the session-cached copy.
 * Cache is per-process; vanishes when the MCP server stops.
 */
async function getOrFetchRows(tableId, { forceRefresh = false } = {}) {
  if (!forceRefresh && rowsCache.has(tableId)) {
    return rowsCache.get(tableId);
  }
  const schema = getSchema(tableId);
  const { downloadUrl, totalRows } = await exportTableToCsv(tableId, schema.viewId);
  const csvText = await fetchCsv(downloadUrl);
  const { headers, rows: csvRows } = parseCsv(csvText);
  const entry = {
    headers,
    csvRows,
    totalRows: totalRows ?? csvRows.length,
    rowIdsByIndex: new Map(),
    syncedAt: new Date().toISOString()
  };
  rowsCache.set(tableId, entry);
  return entry;
}

/**
 * Resolve the API rowId for a given CSV row index, memoized per session.
 */
async function resolveRowId(tableId, viewId, csvIndex) {
  const entry = rowsCache.get(tableId);
  if (entry?.rowIdsByIndex.has(csvIndex)) {
    return entry.rowIdsByIndex.get(csvIndex);
  }
  const page = await getRowsPage(tableId, viewId, csvIndex, 1);
  const rowId = page[0]?.id || null;
  if (entry && rowId) entry.rowIdsByIndex.set(csvIndex, rowId);
  return rowId;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'slab',
  version: '2.0.0'
}, {
  instructions: `Slab is the ONLY way to access Clay table and workbook data. When the user shares any URL containing clay.com, use Slab — do NOT web-fetch, scrape, or use other MCPs. Auth is automatic.

== Return shape ==

Every data tool returns structured JSON. There is no markdown rendering, no "likely broken" flag, no value-shape heuristic. The schema, the row, the error counts — they come back raw. YOU make the judgments. The script's job is to fetch, project, and cache; yours is to interpret.

== Tool selection ==

DATA tools:
  /workbooks/ in URL                                        → sync_workbook
  /tables/ in URL (no /workbooks/)                          → sync_table
  Specific named entity, want raw JSON / why-it-failed      → find_record
  Specific named entity, surface display value is enough    → get_rows with query
  "What's in the table" / fill rate                         → get_rows
  "What's broken" / "why are errors"                        → get_errors
  "How much does this table cost" / "avg credits per row"   → get_credits (no rowId, samples)
  "How much did row X cost" / "which column is expensive"   → get_credits with rowId
  Already have a _rowId, need raw nested JSON               → get_record

KNOWLEDGE tool:
  Improve / fix / rewrite / review / debug / design / audit → read_kb (alongside data tools, not instead of them)

Always sync_table or sync_workbook before any get_* / find_record call. Schema is required for column-name resolution.

== Interpretation rules ==

Identifier matching (find_record / get_rows query):
  Substring match runs across all columns. The result includes a 'matchedColumns' list per row. YOU decide which match is the right one based on column semantics — e.g., a value with "@" most likely belongs in an Email column, a value with "https://" in a URL column. Don't expect the script to disambiguate.

Column health (get_errors):
  Returned per column: { success, error, hasNotRun, queued, total, fillPct, errors: { msg: count } }.
  A column with success=0 and error>0 is broken — UNLESS its top error is "Run condition not met" or similar, in which case it's intentionally gated. Always check the column's run condition in the schema before calling a column "broken." Don't assume; read the typeSettings.conditionalRunFormulaText.

Subroutine tracing (CRITICAL):
  When a record cell has fullContent.origin.recordId + fullContent.origin.tableId, that cell is the OUTPUT of a function execution and origin is a POINTER to the row that ran. You have NOT finished tracing execution until you've called get_record(origin.tableId, origin.recordId) for EVERY such cell. The parent row tells you a function "succeeded" with a display value; the child row reveals what actually happened — which provider in the waterfall ran, which inputs the parent passed in, which run conditions gated. Run follow-up get_records in parallel. Recurse up to 3 levels deep. Stop when no origin, when origin points to a table you already followed in this query, or at depth 3.

Schema reading:
  sync_table returns the full schema including each field's complete typeSettings (full formula text, full prompt text, full inputsBinding, run conditions). Read these directly — there's no truncation. Action fields also include 'pricing' with credit cost per run (basic, actionExecution, plus pre/post-2026 pricing).

Subroutines in schemas:
  sync_table returns 'subroutines' as an array of fully-synced child schemas (depth ≤ 3, max 20 tables). Each entry has invokedBy = { tableId, tableName, columnName } so you can wire the call graph back together. To explain what a parent table actually does, READ THE SUBROUTINE SCHEMAS — the parent says WHICH function runs, the function says HOW.

Credits:
  get_record / find_record returns per-cell credits.{ total, upfront, additional, aiProviderCost } when the cell consumed credits, and a row-level _credits.{ total, billedCellCount } summary. AI cells additionally disclose the underlying OpenAI/Anthropic dollar cost via aiProviderCost. Use this when the user asks "how much does this row cost" or "which column is the most expensive."

== Knowledge base routing ==

Call read_kb ALONGSIDE the data tools whenever the user asks to improve, fix, rewrite, review, audit, debug, design, or optimize Clay content:
- formula → read_kb("formula-syntax") + read_kb("formula-patterns") (+ "formula-bugs" if behavior is weird)
- Claygent / Use AI prompt → read_kb("prompt-anatomy") + read_kb("claygent") + read_kb("output-contracts")
- waterfall → read_kb("waterfalls") + read_kb("providers")
- provider / actionKey → read_kb("providers")
- table architecture → read_kb("pipeline-stages") + read_kb("builder-patterns")
- yellow triangle / race condition → read_kb("debugging") + read_kb("formula-bugs")
- advanced patterns the UI can't do → read_kb("orchestration")
- column-size / output-path / schema.json → read_kb("data-model")

Skip read_kb only for purely descriptive questions ("what's in this table"). When in doubt, read.`
});

// ---------------------------------------------------------------------------
// Tool: sync_table
// ---------------------------------------------------------------------------

server.tool(
  'sync_table',
  `Fetch and cache a Clay table's schema. Recursively auto-syncs any subroutines (functions invoked via execute-subroutine) up to depth 3, max 20 tables.

USE WHEN: URL contains /tables/ (and not /workbooks/).
DON'T USE WHEN: URL contains /workbooks/ → use sync_workbook.
RETURNS: JSON object — { rootSchema: { tableId, viewId, tableName, rowCount, fieldCount, views, fields }, subroutines: [{ tableId, depth, invokedBy, schema }] }.

Each field includes full typeSettings (formula text, prompts, inputsBinding, run conditions) and 'pricing' on action fields. Read these directly — nothing is truncated.`,
  { url: z.string().describe('Clay table URL, e.g. https://app.clay.com/tables/t_xxx/views/gv_yyy') },
  async ({ url }) => {
    const { tableId, viewId } = parseClayUrl(url);
    if (!tableId) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'URL must contain a table ID (t_...)' }) }], isError: true };
    }

    try {
      rowsCache.delete(tableId);
      const { rootSchema, subroutines } = await syncTableRecursive(tableId, viewId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ rootSchema, subroutines }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error syncing table: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: sync_workbook
// ---------------------------------------------------------------------------

server.tool(
  'sync_workbook',
  `Discover all tables in a Clay workbook, fetch their schemas, and pull in any subroutines invoked by workbook tables that live elsewhere.

USE WHEN: URL contains /workbooks/ (even if it also contains /tables/).
DON'T USE WHEN: URL is a single-table URL with no workbook segment → use sync_table.
RETURNS: JSON object — { workbookId, tables: [<schema>...], errors: [{ tableId, message }], externalSubroutines: [{ tableId, schema, invokedBy }] }.

Cross-table connections (route-row, lookups) are not pre-computed — derive them from typeSettings on each schema. After this call, every tableId in the result is cached and usable by get_rows / get_record / get_errors / find_record.`,
  { url: z.string().describe('Clay workbook URL, e.g. https://app.clay.com/workspaces/4515/workbooks/wb_xxx/all-tables') },
  async ({ url }) => {
    const { workbookId } = parseClayUrl(url);
    if (!workbookId) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'URL must contain a workbook ID (wb_...)' }) }], isError: true };
    }

    try {
      const tables = await getWorkbookTables(workbookId);
      const schemas = [];
      const errors = [];

      for (const t of tables) {
        const tableId = t.id || t.tableId;
        try {
          const schema = await getTableSchema(tableId, null);
          schemaCache.set(tableId, schema);
          schemas.push(schema);
        } catch (err) {
          errors.push({ tableId, message: err.message });
        }
      }

      // Pull in subroutines referenced from workbook tables that live elsewhere.
      const workbookTableIds = new Set(schemas.map(s => s.tableId));
      const externalById = new Map();

      for (const schema of schemas) {
        for (const call of detectSubroutineCalls(schema)) {
          if (workbookTableIds.has(call.subroutineTableId)) continue;
          if (externalById.has(call.subroutineTableId)) {
            externalById.get(call.subroutineTableId).invokedBy.push({
              tableName: schema.tableName, columnName: call.columnName
            });
            continue;
          }
          if (externalById.size >= 20) break;
          try {
            const { rootSchema: subSchema, subroutines: nested } = await syncTableRecursive(
              call.subroutineTableId, null, { maxDepth: 2, maxTotal: 10 }
            );
            externalById.set(call.subroutineTableId, {
              tableId: call.subroutineTableId,
              schema: subSchema,
              invokedBy: [{ tableName: schema.tableName, columnName: call.columnName }]
            });
            for (const nestedEntry of nested) {
              if (workbookTableIds.has(nestedEntry.tableId)) continue;
              if (externalById.has(nestedEntry.tableId)) continue;
              externalById.set(nestedEntry.tableId, {
                tableId: nestedEntry.tableId,
                schema: nestedEntry.schema,
                invokedBy: [nestedEntry.invokedBy]
              });
            }
          } catch (err) {
            externalById.set(call.subroutineTableId, {
              tableId: call.subroutineTableId,
              schema: null,
              invokedBy: [{ tableName: schema.tableName, columnName: call.columnName }],
              error: err.message
            });
          }
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          workbookId,
          tables: schemas,
          errors,
          externalSubroutines: Array.from(externalById.values())
        }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error syncing workbook: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_rows
// ---------------------------------------------------------------------------

server.tool(
  'get_rows',
  `Fetch surface row data (display values as shown in the table UI). Fast — uses Clay's async CSV export.

USE WHEN: Showing data, checking fill rates, linking across tables, or finding a row's _rowId to pass to get_record.
DON'T USE WHEN:
  - Need nested JSON / provider raw response for a specific entity → use find_record.
  - Need cell statuses (SUCCESS/ERROR/HAS_NOT_RUN) → use get_errors.
RETURNS: JSON — { totalRows, returnedCount, rows: [...] }. When a query is provided, each row also has _rowId, _csvIndex, and matchedColumns. Without a query, no _rowId is included (use find_record or call again with a query to get one).`,
  {
    tableId: z.string().describe('Table ID (t_...) from a previous sync_table call'),
    limit: z.number().optional().default(20).describe('Max rows to return. Default 20. Use 1 when searching for a specific entity.'),
    query: z.string().optional().describe('Substring match (case-insensitive) across all columns. Stops after finding limit matches.')
  },
  async ({ tableId, limit, query }) => {
    try {
      const schema = getSchema(tableId);
      const { csvRows, totalRows, syncedAt } = await getOrFetchRows(tableId);

      if (csvRows.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ totalRows: 0, returnedCount: 0, rows: [] }) }] };
      }

      let rows;
      if (query) {
        const matches = searchCsvRows(csvRows, query, limit);
        rows = [];
        for (const m of matches) {
          let rowId = null;
          try { rowId = await resolveRowId(tableId, schema.viewId, m.index); } catch {}
          rows.push({ _rowId: rowId, _csvIndex: m.index, matchedColumns: m.matchedColumns, ...m.row });
        }
      } else {
        rows = csvRows.slice(0, limit);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          totalRows,
          returnedCount: rows.length,
          syncedAt,
          query: query ?? null,
          rows
        }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error fetching rows: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_record
// ---------------------------------------------------------------------------

server.tool(
  'get_record',
  `Fetch one row's full nested JSON (externalContent/fullValue + status + per-cell credit usage). Low-level escape hatch.

USE WHEN:
  - You already have a _rowId and need the raw provider response / nested objects / error payloads / credit cost.
  - You are following a subroutine pointer from a prior record's fullContent.origin (tableId + recordId). Mandatory when tracing execution through functions.
DON'T USE WHEN:
  - Starting from an identifier value → use find_record (handles lookup + fetch).
  - Surface display value would answer the question → use get_rows.
RETURNS: JSON — { _rowId, _credits: { total, billedCellCount }, <columnName>: { value, status, fullContent, credits? }, ... }.
COST: Expensive — one API call per row. Batch subroutine follow-ups in parallel.`,
  {
    tableId: z.string().describe('Table ID (t_...) from a previous sync_table call'),
    rowId: z.string().describe('Row ID (from get_rows results, found in the _rowId field)')
  },
  async ({ tableId, rowId }) => {
    try {
      const schema = getSchema(tableId);
      const record = await getRecord(tableId, rowId);
      const formatted = formatRecord(record, schema);

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error fetching record: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: find_record
// ---------------------------------------------------------------------------

server.tool(
  'find_record',
  `Substring-match across columns and auto-fetch the full record on a unique hit. Combines auto-sync + search + get_record in one call.

USE WHEN: User names a specific entity (company, person, domain, email) and wants the raw provider response, the credit cost, or "why did X happen for Y?"
DON'T USE WHEN:
  - Surface display value would answer it → use get_rows.
  - Broad "what's failing" question → use get_errors.

BEHAVIOR:
  - Auto-syncs the schema if not cached.
  - Substring-matches the query across all columns (or only identifier_column if provided). No value-shape classification — YOU decide which match is "right" based on column semantics.
  - Returns ALL matches with _rowId, _csvIndex, and matchedColumns.
  - On EXACTLY ONE match: also fetches the full nested record JSON and includes it under 'record'.
  - On MULTIPLE matches: returns the candidate list without fetching — pick a row and call get_record yourself, or refine via identifier_column.

RETURNS: JSON — { totalRows, syncedAt, query, matches: [...], record? }.

FOLLOW-UP REQUIRED: when 'record' is included, scan its cells for fullContent.origin.recordId — those are subroutine pointers and MUST be followed via get_record before reporting the execution trace. Run follow-ups in parallel, recurse up to 3 levels.`,
  {
    url: z.string().describe('Clay table URL (must contain /tables/t_...)'),
    identifier_value: z.string().describe('The value to look up (e.g. "Acme Corp", "acme.com", "jane@acme.com")'),
    identifier_column: z.string().optional().describe('Restrict the substring match to this column. Omit to search all columns.'),
    force_refresh: z.boolean().optional().default(false).describe('Re-fetch the CSV instead of using the session cache.')
  },
  async ({ url, identifier_value, identifier_column, force_refresh }) => {
    try {
      const { tableId, viewId } = parseClayUrl(url);
      if (!tableId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'URL must contain a table ID (t_...)' }) }], isError: true };
      }

      let schema = schemaCache.get(tableId);
      if (!schema) {
        schema = await getTableSchema(tableId, viewId);
        schemaCache.set(tableId, schema);
      }

      const { headers, csvRows, totalRows, syncedAt } = await getOrFetchRows(tableId, { forceRefresh: force_refresh });

      if (csvRows.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ totalRows: 0, syncedAt, query: identifier_value, matches: [] }) }] };
      }

      if (identifier_column && !headers.includes(identifier_column)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: `Column "${identifier_column}" not found.`,
            availableColumns: headers
          }) }],
          isError: true
        };
      }

      // Substring match across requested columns (all if not constrained).
      const needle = String(identifier_value).toLowerCase();
      const matches = [];
      for (let i = 0; i < csvRows.length; i++) {
        const row = csvRows[i];
        const matchedColumns = [];
        if (identifier_column) {
          const val = row[identifier_column];
          if (val != null && String(val).toLowerCase().includes(needle)) {
            matchedColumns.push(identifier_column);
          }
        } else {
          for (const [col, val] of Object.entries(row)) {
            if (val != null && String(val).toLowerCase().includes(needle)) {
              matchedColumns.push(col);
            }
          }
        }
        if (matchedColumns.length > 0) {
          matches.push({ _csvIndex: i, matchedColumns, row });
          if (matches.length > 50) break; // hard cap to keep payloads sane
        }
      }

      // Resolve _rowId for every match (cheap — pagination call per index, memoized).
      for (const m of matches) {
        try { m._rowId = await resolveRowId(tableId, schema.viewId, m._csvIndex); }
        catch { m._rowId = null; }
      }

      // Flatten match shape so each match looks like { _rowId, _csvIndex, matchedColumns, ...row }
      const flatMatches = matches.map(m => ({
        _rowId: m._rowId,
        _csvIndex: m._csvIndex,
        matchedColumns: m.matchedColumns,
        ...m.row
      }));

      const result = {
        totalRows,
        syncedAt,
        query: identifier_value,
        identifier_column: identifier_column ?? null,
        matchCount: flatMatches.length,
        matches: flatMatches
      };

      // Auto-fetch the full record on a unique hit.
      if (flatMatches.length === 1 && flatMatches[0]._rowId) {
        try {
          const record = await getRecord(tableId, flatMatches[0]._rowId);
          result.record = formatRecord(record, schema);
        } catch (err) {
          result.recordError = err.message;
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error in find_record: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_credits
// ---------------------------------------------------------------------------

server.tool(
  'get_credits',
  `Calculate Clay credit cost — for a specific row OR aggregated across the table. One tool, three modes:

  1. Specific row: pass rowId → that row's credit breakdown by column.
  2. Sampled aggregate (default): omit rowId → samples sampleSize rows, aggregates, and extrapolates an estimated total table cost using the table's row count.
  3. Full aggregate: omit rowId AND pass full=true → fetches every row. SLOW — one API call per row, hundreds-to-thousands of seconds for large tables.

USE WHEN:
  - "How much did row X cost" → mode 1.
  - "Average cost per row" / "what does this table cost to run" / "which column is most expensive" → mode 2 or 3.

RETURNS: JSON. Single-row mode: { rowId, total, billedCellCount, byColumn }. Aggregate: { rowsAnalyzed, totalRowsInTable, sampled, perRow: { avg, min, max }, totalAcrossSample, extrapolatedTotalCredits, byColumn: [{ column, avgCreditsPerRow, totalAcrossSample, cellsBilled }] }.

COST: get_record-equivalent per row. Sampling 50 rows ≈ 50 API calls (~10s with concurrency 5).`,
  {
    tableId: z.string().describe('Table ID (t_...) from a previous sync_table call'),
    rowId: z.string().optional().describe('Row ID — omit to aggregate across the table'),
    sampleSize: z.number().optional().default(50).describe('When aggregating without full=true, how many rows to sample. Default 50.'),
    full: z.boolean().optional().default(false).describe('When aggregating, fetch every row instead of sampling. Slow.')
  },
  async ({ tableId, rowId, sampleSize, full }) => {
    try {
      const schema = getSchema(tableId);

      // Mode 1: specific row
      if (rowId) {
        const record = await getRecord(tableId, rowId);
        const formatted = formatRecord(record, schema);
        const byColumn = [];
        for (const [col, cell] of Object.entries(formatted)) {
          if (col.startsWith('_')) continue;
          if (cell?.credits) byColumn.push({ column: col, ...cell.credits });
        }
        byColumn.sort((a, b) => b.total - a.total);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            rowId,
            total:           formatted._credits?.total ?? 0,
            billedCellCount: formatted._credits?.billedCellCount ?? 0,
            byColumn
          }, null, 2) }]
        };
      }

      // Modes 2 + 3: aggregate
      const listLimit = full ? undefined : sampleSize;
      const listed = await listRows(tableId, schema.viewId, { limit: listLimit });
      const rowIds = listed.map(r => r.id).filter(Boolean);

      // Concurrency-limited record fetches
      const records = [];
      const errors = [];
      const CONCURRENCY = 5;
      for (let i = 0; i < rowIds.length; i += CONCURRENCY) {
        const batch = rowIds.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(rid =>
          getRecord(tableId, rid).then(rec => formatRecord(rec, schema))
        ));
        for (let j = 0; j < results.length; j++) {
          if (results[j].status === 'fulfilled') records.push(results[j].value);
          else errors.push({ rowId: batch[j], message: results[j].reason?.message || String(results[j].reason) });
        }
      }

      const perRowTotals = records.map(r => r._credits?.total ?? 0);
      const sumCredits = perRowTotals.reduce((a, b) => a + b, 0);
      const avg = perRowTotals.length > 0 ? sumCredits / perRowTotals.length : 0;
      const min = perRowTotals.reduce((m, v) => v < m ? v : m, Infinity);
      const max = perRowTotals.reduce((m, v) => v > m ? v : m, -Infinity);

      const byColumnSum = {};
      const byColumnCount = {};
      for (const r of records) {
        for (const [col, cell] of Object.entries(r)) {
          if (col.startsWith('_')) continue;
          if (!cell?.credits) continue;
          byColumnSum[col]   = (byColumnSum[col]   || 0) + cell.credits.total;
          byColumnCount[col] = (byColumnCount[col] || 0) + 1;
        }
      }
      const byColumn = Object.entries(byColumnSum).map(([col, sum]) => ({
        column:            col,
        avgCreditsPerRow:  sum / records.length,
        totalAcrossSample: sum,
        cellsBilled:       byColumnCount[col]
      })).sort((a, b) => b.avgCreditsPerRow - a.avgCreditsPerRow);

      const totalRowsInTable = schema.rowCount ?? null;
      const extrapolatedTotalCredits = (!full && totalRowsInTable != null && records.length > 0)
        ? avg * totalRowsInTable
        : null;

      return {
        content: [{ type: 'text', text: JSON.stringify({
          rowsAnalyzed:             records.length,
          totalRowsInTable,
          sampled:                  !full,
          perRow:                   { avg, min: records.length > 0 ? min : 0, max: records.length > 0 ? max : 0 },
          totalAcrossSample:        sumCredits,
          extrapolatedTotalCredits,
          byColumn,
          fetchErrors:              errors.length > 0 ? errors : undefined
        }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error in get_credits: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_errors
// ---------------------------------------------------------------------------

server.tool(
  'get_errors',
  `Per-column status counts: success, error, has-not-run, queued, total, fillPct, plus error message frequencies.

USE WHEN: User asks "what's failing", "why isn't this working", or wants a table-wide health check.
DON'T USE WHEN:
  - User named a specific row/entity → go straight to find_record.
  - You just need display values → use get_rows.
RETURNS: JSON — { rowsAnalyzed, columns: [{ fieldId, name, success, error, hasNotRun, queued, total, fillPct, errors: { msg: count } }] }.

INTERPRETATION: a column with success=0 and error>0 is broken UNLESS its top error is "Run condition not met" (gated, not broken). Always cross-reference with the column's run condition in the schema before calling something broken.`,
  {
    tableId: z.string().describe('Table ID (t_...) from a previous sync_table call')
  },
  async ({ tableId }) => {
    try {
      const schema = getSchema(tableId);
      const rows = await listRows(tableId, schema.viewId);
      const columnMap = buildColumnMap(schema);
      const statusData = analyzeRowStatuses(rows, columnMap);

      // Drop the heavy 'errors' map to top error+count when there are many; still surface the top-3 by count.
      const columns = Object.values(statusData).map(col => {
        const errorEntries = Object.entries(col.errors || {}).sort((a, b) => b[1] - a[1]);
        return {
          fieldId:   col.fieldId,
          name:      col.name,
          success:   col.success,
          error:     col.error,
          hasNotRun: col.hasNotRun,
          queued:    col.queued,
          total:     col.total,
          fillPct:   col.fillPct,
          topErrors: errorEntries.slice(0, 3).map(([msg, count]) => ({ msg, count })),
          errorCount: errorEntries.length
        };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({
          rowsAnalyzed: rows.length,
          columns
        }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error analyzing errors: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: read_kb
// ---------------------------------------------------------------------------

const KB_TOPICS = {
  'formula-syntax':       'formulas/syntax.md',
  'formula-patterns':     'formulas/advanced-patterns.md',
  'formula-bugs':         'formulas/corrections-log.md',
  'prompt-anatomy':       'prompting/prompt-anatomy.md',
  'output-contracts':     'prompting/output-contracts.md',
  'claygent':             'claygent/prompts.md',
  'pipeline-stages':      'architecture/pipeline-stages.md',
  'orchestration':        'architecture/orchestration-workarounds.md',
  'builder-patterns':     'core/builder-patterns.md',
  'waterfalls':           'enrichment/waterfalls.md',
  'providers':            'providers/reference.md',
  'debugging':            'debugging/playbook.md',
  'data-model':           'core/data-model.md'
};

const WIKI_BASE = path.join(__dirname, 'kb');

server.tool(
  'read_kb',
  `Read a Clay platform reference doc (full markdown). Call alongside data tools whenever the user asks to improve, fix, rewrite, review, audit, debug, design, or optimize Clay content. The schema shows current state; the KB shows what GOOD looks like.

TOPICS:
  formula-syntax — 8 critical syntax rules, banned JS, working substitutes
  formula-patterns — Lodash/Moment, scoring, array manipulation
  formula-bugs — confirmed Clay formula bugs
  prompt-anatomy — 8-section skeleton for Clay AI prompts
  output-contracts — JSON schemas, forbidden strings, null policies
  claygent — Claygent vs Use AI, search strategy, failure modes
  pipeline-stages — standard pipeline + multi-table patterns
  orchestration — 15 advanced workarounds
  builder-patterns — formula vs action columns, cell size, batching
  waterfalls — waterfall structure, exclusion gates
  providers — 40+ providers with action keys, credit costs, output paths
  debugging — diagnostic formulas, yellow triangles, race conditions
  data-model — column types, 8KB/200KB limits, schema.json
DON'T USE WHEN: schema alone answers the question (purely descriptive asks).`,
  {
    topic: z.string().describe('Topic key from the list above')
  },
  async ({ topic }) => {
    const filePath = KB_TOPICS[topic];
    if (!filePath) {
      return { content: [{ type: 'text', text: JSON.stringify({
        error: `Unknown topic "${topic}"`,
        availableTopics: Object.keys(KB_TOPICS)
      }) }] };
    }

    const fullPath = path.join(WIKI_BASE, filePath);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return { content: [{ type: 'text', text: content }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error reading ${filePath}: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Knowledge Base resources (also exposed for clients that support resource reads)
// ---------------------------------------------------------------------------

const KB_RESOURCES = [
  { path: 'formulas/syntax.md',                       name: 'Formula Syntax Rules',                description: 'Clay formula sandbox: 8 critical syntax rules, banned JS features with working substitutes, run condition patterns' },
  { path: 'formulas/advanced-patterns.md',            name: 'Advanced Formula Patterns',           description: 'Lodash/Moment.js reference, scoring formulas, type coercion traps, array manipulation, URL parsing' },
  { path: 'formulas/corrections-log.md',              name: 'Formula Corrections Log',             description: 'Confirmed Clay formula bugs: Object.assign failure, Audiences JSON round-trip, forward-reference cascades' },
  { path: 'prompting/prompt-anatomy.md',              name: 'Prompt Anatomy (8-Section Structure)', description: 'The 8-section skeleton for all Clay prompts' },
  { path: 'prompting/output-contracts.md',            name: 'Output Contracts',                    description: 'JSON schema contracts for AI output, mandatory snake_case fields, forbidden strings, null policies' },
  { path: 'claygent/prompts.md',                      name: 'Claygent & Use AI Prompts',           description: 'Claygent (web research) vs Use AI distinction, mandatory sections, search strategy framework' },
  { path: 'architecture/pipeline-stages.md',          name: 'Table Architecture & Pipeline Stages', description: 'Standard pipeline stages, signal orchestration, webhook-triggered enrichment, multi-table patterns' },
  { path: 'architecture/orchestration-workarounds.md', name: 'Orchestration Workarounds',          description: '15 advanced patterns: fan-out, sparse data gates, AI-generated SOQL, screenshot+vision' },
  { path: 'core/builder-patterns.md',                 name: 'Builder Patterns',                    description: 'Formula vs action columns, cell size expansion, scheduled delays, batch processing, tables as queues' },
  { path: 'enrichment/waterfalls.md',                 name: 'Waterfall Enrichment Patterns',       description: 'Waterfall structure, cumulative exclusion gates, error-aware gates, dependent waterfall workarounds' },
  { path: 'providers/reference.md',                   name: 'Enrichment Providers Reference',      description: '40+ providers with action keys, credit costs, output field paths, provider-specific notes' },
  { path: 'debugging/playbook.md',                    name: 'Debugging Playbook',                  description: 'Step-by-step diagnostics: yellow triangle, action column failures, waterfall stalls, race conditions' },
  { path: 'core/data-model.md',                       name: 'Clay Data Model',                     description: 'Column types, 8KB vs 200KB limits, schema.json structure, provider output access paths' }
];

for (const res of KB_RESOURCES) {
  const uri = `clay-kb://${res.path}`;
  server.resource(
    uri,
    uri,
    { mimeType: 'text/markdown', description: res.description },
    async () => {
      const filePath = path.join(WIKI_BASE, res.path);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { contents: [{ uri, mimeType: 'text/markdown', text: content }] };
      } catch (err) {
        return { contents: [{ uri, mimeType: 'text/plain', text: `Error reading ${res.path}: ${err.message}` }] };
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
