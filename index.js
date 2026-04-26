#!/usr/bin/env node

/**
 * slab-mcp — MCP server for analyzing Clay tables.
 *
 * Tools:
 *   sync_table     — Fetch a Clay table's schema + recursively-synced subroutines
 *   sync_workbook  — Discover all tables in a workbook and fetch their schemas
 *   get_rows       — List or search display values; accepts tableId or url; cheap
 *   get_record     — Fetch one row's full nested JSON (expensive — one call per row)
 *   get_credits    — Credit cost for one row or aggregated across the table
 *   get_errors     — Per-column status counts (success / error / has-not-run / queued)
 *
 * Design: tools return structured JSON. Interpretation, classification,
 * and prose-shaping happen in prompt context — not on the script side.
 *
 * Builder workflows (writing formulas, writing Claygent prompts) live in
 * skills under skills/ — installable separately into the user's Claude Code
 * skill directory. See README "Installing the skills" for setup.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getTableSchema, listRows, getRecord, getWorkbookTables, exportTableToCsv, fetchCsv, searchRecords, RECORDS_API_CAP } from './src/clay-api.js';
import { analyzeRowStatuses, formatRecord, parseCsv } from './src/row-utils.js';

// ---------------------------------------------------------------------------
// In-memory caches (lifetime: MCP server process)
// ---------------------------------------------------------------------------

const schemaCache = new Map(); // tableId -> schema
const rowsCache   = new Map(); // tableId -> Map<viewId, { viewId, headers, csvRows, totalRows, syncedAt }>

// MCP transport caps a single tool result at ~1MB. Leave headroom for protocol overhead.
const MCP_RESPONSE_MAX_BYTES = 900_000;

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
 * Resolve a 'view' parameter to a viewId. Accepts:
 *   - a viewId (gv_*) → returned as-is
 *   - a view name ("All rows", "Errored rows", etc.) → looked up in
 *     schema.views, case-insensitive and whitespace-tolerant
 *   - null / undefined → schema's active viewId (the one picked at sync time)
 *
 * Returns null if the input is set but doesn't match a viewId pattern or
 * any known view name — caller should error with the available view list.
 */
function resolveViewId(schema, viewParam) {
  if (!viewParam) return schema.viewId;
  if (/^gv_[a-zA-Z0-9]+$/.test(viewParam)) return viewParam;
  const normalize = s => String(s || '').toLowerCase().replace(/[\s_\-]/g, '');
  const target = normalize(viewParam);
  const match = (schema.views || []).find(v => normalize(v.name) === target);
  return match?.id || null;
}

/**
 * Fetch + parse the CSV for a table at a specific view, or return the
 * session-cached copy. Cache is per-process and keyed per (tableId, viewId)
 * since different views return different row sets and orderings.
 */
async function getOrFetchRows(tableId, { viewId, forceRefresh = false } = {}) {
  const schema = getSchema(tableId);
  const effectiveViewId = viewId || schema.viewId;

  let viewMap = rowsCache.get(tableId);
  if (!viewMap) {
    viewMap = new Map();
    rowsCache.set(tableId, viewMap);
  }

  if (!forceRefresh && viewMap.has(effectiveViewId)) {
    return viewMap.get(effectiveViewId);
  }

  const { downloadUrl, totalRows } = await exportTableToCsv(tableId, effectiveViewId);
  const csvText = await fetchCsv(downloadUrl);
  const { headers, rows: csvRows } = parseCsv(csvText);
  const entry = {
    viewId: effectiveViewId,
    headers,
    csvRows,
    totalRows: totalRows ?? csvRows.length,
    syncedAt: new Date().toISOString()
  };
  viewMap.set(effectiveViewId, entry);
  return entry;
}

/**
 * Get a table's schema (cached or freshly synced) plus a fieldId → columnName
 * map of every execute-subroutine column. Used by the recursive credit rollup
 * to find function-call cells worth following.
 */
async function getSubroutineFields(tableId) {
  let schema = schemaCache.get(tableId);
  if (!schema) {
    schema = await getTableSchema(tableId, null);
    schemaCache.set(tableId, schema);
  }
  const subroutineFields = {};
  for (const f of schema.fields || []) {
    if (f.typeSettings?.actionKey === 'execute-subroutine') {
      subroutineFields[f.id] = f.name;
    }
  }
  return { schema, subroutineFields };
}

/**
 * Recursively roll up credit cost for a row, following execute-subroutine
 * cells to their function-row counterparts. The parent row's subroutine
 * cell carries no credit data — actual cost lives on the function row that
 * ran. Capped by maxDepth (subroutines + nested subroutines + ...).
 *
 * Returns:
 *   {
 *     rowId, tableId, status,
 *     direct,           // credits charged on this row's own cells
 *     viaSubroutines,   // recursively summed credits on function rows this row invoked
 *     total,            // direct + viaSubroutines
 *     billedCellCount,  // unchanged — cells with any credit data
 *     byColumn,         // direct columns
 *     subroutineDetail  // [{ column, functionTableId, functionRowId, status, direct, viaSubroutines, total }]
 *   }
 *
 * Status values: 'ok' (fetched), '404' (function row deleted), 'error' (other),
 * 'cycle' (already visited in this rollup), 'depth' (max depth reached).
 */
async function rollupCredits(tableId, rowId, depth, maxDepth, visited) {
  const visitKey = `${tableId}:${rowId}`;
  if (visited.has(visitKey)) {
    return { rowId, tableId, status: 'cycle', direct: 0, viaSubroutines: 0, total: 0, billedCellCount: 0, byColumn: [], subroutineDetail: [] };
  }
  visited.add(visitKey);

  let schema, subroutineFields;
  try {
    ({ schema, subroutineFields } = await getSubroutineFields(tableId));
  } catch (err) {
    return { rowId, tableId, status: 'schema-error', errorMessage: err.message, direct: 0, viaSubroutines: 0, total: 0, billedCellCount: 0, byColumn: [], subroutineDetail: [] };
  }

  let record;
  try {
    record = await getRecord(tableId, rowId);
  } catch (err) {
    const is404 = err.message.includes('404') || err.message.includes('not found');
    return { rowId, tableId, status: is404 ? '404' : 'error', errorMessage: err.message, direct: 0, viaSubroutines: 0, total: 0, billedCellCount: 0, byColumn: [], subroutineDetail: [] };
  }

  const formatted = formatRecord(record, schema);
  const direct = formatted._credits?.total ?? 0;
  const billedCellCount = formatted._credits?.billedCellCount ?? 0;

  const byColumn = [];
  for (const [col, cell] of Object.entries(formatted)) {
    if (col.startsWith('_')) continue;
    if (cell?.credits) byColumn.push({ column: col, ...cell.credits });
  }
  byColumn.sort((a, b) => b.total - a.total);

  // Find subroutine cells with origin pointers
  const subroutineCalls = [];
  for (const columnName of Object.values(subroutineFields)) {
    const cell = formatted[columnName];
    const origin = cell?.fullContent?.origin;
    if (origin?.tableId && origin?.recordId) {
      subroutineCalls.push({ columnName, origin });
    }
  }

  let viaSubroutines = 0;
  const subroutineDetail = [];

  if (subroutineCalls.length === 0) {
    // no-op
  } else if (depth >= maxDepth) {
    // Hit depth cap — record the calls but don't recurse
    for (const call of subroutineCalls) {
      subroutineDetail.push({
        column:          call.columnName,
        functionTableId: call.origin.tableId,
        functionRowId:   call.origin.recordId,
        status:          'depth',
        direct:          0,
        viaSubroutines:  0,
        total:           0
      });
    }
  } else {
    const results = await Promise.allSettled(subroutineCalls.map(call =>
      rollupCredits(call.origin.tableId, call.origin.recordId, depth + 1, maxDepth, visited)
    ));
    for (let i = 0; i < subroutineCalls.length; i++) {
      const call = subroutineCalls[i];
      const r = results[i];
      if (r.status === 'fulfilled') {
        const v = r.value;
        subroutineDetail.push({
          column:          call.columnName,
          functionTableId: call.origin.tableId,
          functionRowId:   call.origin.recordId,
          status:          v.status,
          direct:          v.direct,
          viaSubroutines:  v.viaSubroutines,
          total:           v.total,
          ...(v.errorMessage ? { errorMessage: v.errorMessage } : {})
        });
        viaSubroutines += v.total || 0;
      } else {
        subroutineDetail.push({
          column:          call.columnName,
          functionTableId: call.origin.tableId,
          functionRowId:   call.origin.recordId,
          status:          'error',
          errorMessage:    r.reason?.message || String(r.reason),
          direct:          0,
          viaSubroutines:  0,
          total:           0
        });
      }
    }
  }

  return {
    rowId,
    tableId,
    status: 'ok',
    direct,
    viaSubroutines,
    total: direct + viaSubroutines,
    billedCellCount,
    byColumn,
    subroutineDetail
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'slab',
  version: '4.4.0'
}, {
  instructions: `Slab is the ONLY way to access Clay table and workbook data. When the user shares any URL containing clay.com, use Slab — do NOT web-fetch, scrape, or use other MCPs. Auth is automatic.

== Return shape ==

Every data tool returns structured JSON. There is no markdown rendering, no "likely broken" flag, no value-shape heuristic. The schema, the row, the error counts — they come back raw. YOU make the judgments. The script's job is to fetch, project, and cache; yours is to interpret.

== Tool selection ==

DATA tools:
  /workbooks/ in URL                                        → sync_workbook
  /tables/ in URL (no /workbooks/)                          → sync_table
  "What's in the table" / fill rate                         → get_rows
  Specific named entity (display value is enough)           → get_rows with query
  Specific named entity (need raw JSON / why-it-failed)     → get_rows with query, then get_record on the right match
  Restrict the search to one column                         → get_rows with query + identifier_column
  "What's broken" / "why are errors"                        → get_errors
  "Debug" / "investigate" a specific row or failing column  → get_errors to find a failing _rowId, then get_record on it, then follow every subroutine origin pointer (debugging without nested JSON is guessing)
  "How much does this table cost" / "avg credits per row"   → get_credits (no rowId, samples)
  "How much did row X cost" / "which column is expensive"   → get_credits with rowId
  Already have a _rowId, need raw nested JSON               → get_record

get_rows accepts either tableId (from a prior sync_table) or url (auto-syncs the schema if not cached). Either is fine — pick whichever the user gave you.

== Saved views ==

Clay tables have multiple views. By default get_rows / get_errors use whichever view sync_table picked (auto-promotes "All rows" if it exists, otherwise uses the URL's view, otherwise the table's default). To switch views without re-syncing, pass the optional 'view' parameter — it accepts a viewId (gv_*) or a view name ("All rows", "Errored rows", "Default view", etc.). Available views are in rootSchema.views from sync_table.

When the user wants to drill into errors, calling get_errors with view="Errored rows" (when that view exists) is much faster and more focused than scanning the whole table — it only counts statuses across already-failing rows. Same pattern for "Fully enriched rows" or any custom filtered view the table builder created.

== Cost rule of thumb ==

get_rows is cheap (one CSV export per table, then in-process scans). get_record is expensive (one API call per row, returns full nested JSON). Default to get_rows. Only escalate to get_record when a display value can't answer the question — debugging, tracing why an enrichment failed, getting the raw provider response, or seeing per-cell credit cost. Fill rates, surface values, "what's in this table" all live in CSV-land. The escalation from search → fetch is your call; there's no auto-fetch.

Always sync_table or sync_workbook before any get_record / get_credits / get_errors call (get_rows can auto-sync if you pass it a url instead of a tableId). Schema is required for column-name resolution.

== Cases where nested JSON is mandatory (no shortcut) ==

These tasks REQUIRE get_record on a real populated row. Don't try to answer them from schema + surface values alone — surface views show "Response" or truncated strings for action columns, and you'll be confidently wrong about what's actually happening.

  Optimizing / rewriting / reviewing a Claygent or Use AI prompt
  ──────────────────────────────────────────────────────────────
  The prompt template tells you what was asked. The nested output tells you what the model actually returned: stepsTaken (research trail — every site visited, every query tried), reasoning, sources cited, confidence, where the answer actually came from. Common findings only visible in nested output: prompts asking for data that's already available upstream from a cheaper column (waste — e.g. a Mapbox geocode already returns "neighborhood: Upper West Side" but a downstream gpt-5 Claygent is paying 3.9 credits to determine the same thing); prompts the model partially ignores (drift between template and behavior); prompts producing different output shapes across rows (contract drift). Fetch get_record on 1-3 representative rows BEFORE proposing any prompt changes. The write-claygent-prompt skill enforces this as a Step 0 gate.

  Tracing data flow across one or more tables
  ────────────────────────────────────────────
  Surface display values for action columns are placeholders ("Response", truncated strings, summary text). They hide the actual JSON that was passed downstream to the next stage. To trace what flows from column A to column B you need fullContent on a real row. Same for cross-table tracing — every fullContent.origin pointer needs get_record(origin.tableId, origin.recordId) to see what the subroutine actually returned to the parent.

  Auditing why a column behaves a certain way
  ────────────────────────────────────────────
  The stepsTaken array on Claygent outputs is the research audit trail (which sites visited, which queries tried, what evidence was rejected, what lateral pivots the agent made). It's not in surface views, not in the schema, only in externalContent. If the user asks "why did this row get classified this way," that array IS the answer.

== Interpretation rules ==

Identifier matching (get_rows with query):
  Substring match runs across all columns by default; pass identifier_column to scope to one column. Each match has a 'matchedColumns' list. YOU decide which match is the right one based on column semantics — e.g., a value with "@" most likely belongs in an Email column, a value with "https://" in a URL column. Don't expect the script to disambiguate.

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
  get_record returns per-cell credits.{ total, upfront, additional, aiProviderCost } when the cell consumed credits, and a row-level _credits.{ total, billedCellCount } summary. AI cells additionally disclose the underlying OpenAI/Anthropic dollar cost via aiProviderCost.

  CRITICAL — subroutine cost is billed separately: when a parent row has an execute-subroutine cell, that cell's credits=null and the parent's _credits.total UNDERCOUNTS the row's true cost. The actual function-call credits are billed on the function row reachable via fullContent.origin.{tableId,recordId}. get_record alone won't show this — it returns just the parent's direct cells.

  Use get_credits for true row cost. It recursively follows origin pointers to function rows and returns { direct, viaSubroutines, total }, plus subroutineDetail per subroutine column. Default depth 2 covers parent → function → one nested level. Aggregate mode also splits direct columns from subroutine columns in the rollup.

== Builder workflows live in skills, not here ==

When the user asks to WRITE, FIX, or REVIEW a Clay formula or a Claygent / Use AI prompt, the workflow lives in an installable skill (write-clay-formula, write-claygent-prompt) — not in this MCP server. Sync the table for context, then defer to the skill's section structure, casing conventions, and validation rules. If the skill isn't installed, the user can find it under skills/ in the slab-mcp repo.`
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

Cross-table connections (route-row, lookups) are not pre-computed — derive them from typeSettings on each schema. After this call, every tableId in the result is cached and usable by get_rows / get_record / get_credits / get_errors.

MANIFEST FALLBACK: when the full payload would exceed the MCP transport budget (~1MB), the response degrades to manifest mode: { workbookId, mode: "manifest", reason, nextStep, tables: [{ tableId, tableName, rowCount, fieldCount, estimatedBytes }], errors, externalSubroutines: [{ tableId, tableName, fieldCount, estimatedBytes, invokedBy }], oversizedTableIds? }. Every schema was still fetched and is cached server-side, so the follow-up flow is: pick the tables you actually need, call sync_table per URL — those are cache hits, no extra Clay calls. If oversizedTableIds is non-empty, those individual tables are too large for any single response and may also fail sync_table — flag to the user.`,
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

      const externalSubroutines = Array.from(externalById.values());
      const fullJson = JSON.stringify({
        workbookId,
        tables: schemas,
        errors,
        externalSubroutines
      }, null, 2);

      if (fullJson.length <= MCP_RESPONSE_MAX_BYTES) {
        return { content: [{ type: 'text', text: fullJson }] };
      }

      // Manifest fallback: full schemas exceed the MCP response budget.
      // Schemas remain in schemaCache, so subsequent sync_table calls per tableId are cache hits.
      const tableManifest = schemas.map(s => ({
        tableId:        s.tableId,
        tableName:      s.tableName,
        rowCount:       s.rowCount,
        fieldCount:     s.fieldCount,
        estimatedBytes: JSON.stringify(s).length
      }));

      const externalManifest = externalSubroutines.map(e => ({
        tableId:        e.tableId,
        tableName:      e.schema?.tableName ?? null,
        rowCount:       e.schema?.rowCount ?? null,
        fieldCount:     e.schema?.fieldCount ?? null,
        estimatedBytes: e.schema ? JSON.stringify(e.schema).length : 0,
        invokedBy:      e.invokedBy,
        error:          e.error
      }));

      const oversizedTableIds = [...tableManifest, ...externalManifest]
        .filter(t => t.estimatedBytes > MCP_RESPONSE_MAX_BYTES)
        .map(t => t.tableId);

      return {
        content: [{ type: 'text', text: JSON.stringify({
          workbookId,
          mode:          'manifest',
          reason:        `Full payload (${fullJson.length} bytes) exceeds MCP transport budget of ${MCP_RESPONSE_MAX_BYTES} bytes. Schemas were fetched and are cached server-side.`,
          nextStep:      'Call sync_table per table URL (or use the cached tableId via get_rows / get_record / get_credits / get_errors). Cached schemas are returned without an extra Clay round-trip.',
          oversizedTableIds: oversizedTableIds.length ? oversizedTableIds : undefined,
          tables:        tableManifest,
          errors,
          externalSubroutines: externalManifest
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
  `Fetch surface row data (display values as shown in the table UI). Fast — uses Clay's async CSV export, then in-process scans.

ACCEPTS EITHER tableId (from a prior sync_table call) OR url (Clay table URL — auto-syncs the schema if not cached). One is required; if both are passed, tableId wins.

VIEW SELECTION: by default the view picked at sync time is used (auto-promoted to "All rows" if such a view exists, otherwise the URL's view, otherwise the table's default). Pass the optional 'view' parameter to query a different view by id (gv_*) or by name ("All rows", "Errored rows", "Default view", etc.). Available views are listed in rootSchema.views from sync_table.

USE WHEN:
  - "What's in this table" / fill rate / show me the data
  - Find a specific entity by name / domain / email — pass query
  - Restrict the search to one column — pass identifier_column with query
  - Get a row's _rowId so you can follow up with get_record for the full nested JSON
  - Switch to a saved view (e.g. "Errored rows") without re-syncing — pass view
DON'T USE WHEN:
  - You already have a _rowId and need raw provider JSON / credit cost / subroutine pointers → use get_record
  - Cell statuses (SUCCESS/ERROR/HAS_NOT_RUN) across the table → use get_errors

RETURNS: JSON — { totalRows, returnedCount, view, query, identifierColumn, rows: [...] }. When query is provided, each row has _rowId, matchedColumns (every column whose cell matched the substring), and display values for every column. Without a query, rows are display values only and no _rowId is included.

QUERY VS NO-QUERY ARE DIFFERENT PATHS:
  - With query: hits Clay's server-side search endpoint (POST /views/{viewId}/search), then fetches each unique matching record in parallel for display values. Works on tables of any size (no 20k row cap). Server caps at 1000 matching cells per call, which dedupes down further by recordId — broad substrings ("@", common domains) may saturate the cap and miss matches.
  - Without query: pulls Clay's CSV export once, slices the first 'limit' rows. Cached for the session per (tableId, viewId).

ESCALATION TO NESTED: when query returns exactly one match and the user wants the why/how (raw provider response, error payload, credit detail, subroutine origin pointers), follow up with get_record(tableId, rowId). The escalation is your call — there's no auto-fetch.`,
  {
    tableId: z.string().optional().describe('Table ID (t_...) from a previous sync_table call. Either tableId or url is required.'),
    url:     z.string().optional().describe('Clay table URL (must contain /tables/t_...). Auto-syncs the schema if not already cached. Either tableId or url is required.'),
    view:    z.string().optional().describe('View id (gv_*) or view name ("All rows", "Errored rows", etc.) to query. Default: the view picked at sync time.'),
    query:   z.string().optional().describe('Substring match (case-insensitive). Server-side search across every cell. Returns up to limit unique matching records.'),
    identifier_column: z.string().optional().describe('Restrict the substring match to this column. Requires query. Omit to search all columns.'),
    limit:   z.number().optional().default(20).describe('Max rows to return. Default 20. Use 1 when searching for a specific entity.'),
    force_refresh: z.boolean().optional().default(false).describe('Re-fetch the CSV instead of using the session cache (no-query path only).')
  },
  async ({ tableId, url, view, query, identifier_column, limit, force_refresh }) => {
    try {
      if (!tableId && url) {
        const parsed = parseClayUrl(url);
        if (!parsed.tableId) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'URL must contain a table ID (t_...)' }) }], isError: true };
        }
        tableId = parsed.tableId;
        if (!schemaCache.get(tableId)) {
          const schema = await getTableSchema(tableId, parsed.viewId);
          schemaCache.set(tableId, schema);
        }
      }
      if (!tableId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Either tableId or url is required.' }) }], isError: true };
      }

      const schema = getSchema(tableId);
      const viewId = resolveViewId(schema, view);
      if (view && !viewId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: `View "${view}" not found.`,
            availableViews: (schema.views || []).map(v => ({ id: v.id, name: v.name }))
          }) }],
          isError: true
        };
      }

      const columnMap = {};
      const fieldIdByName = {};
      for (const f of schema.fields) {
        columnMap[f.id] = f.name;
        fieldIdByName[f.name] = f.id;
      }

      if (query) {
        let targetFieldId = null;
        if (identifier_column) {
          targetFieldId = fieldIdByName[identifier_column];
          if (!targetFieldId) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                error: `Column "${identifier_column}" not found.`,
                availableColumns: schema.fields.map(f => f.name)
              }) }],
              isError: true
            };
          }
        }

        const hits = await searchRecords(tableId, viewId, query);
        const filtered = targetFieldId ? hits.filter(h => h.fieldId === targetFieldId) : hits;

        const matchedFieldsByRecord = new Map();
        for (const h of filtered) {
          if (!matchedFieldsByRecord.has(h.recordId)) matchedFieldsByRecord.set(h.recordId, new Set());
          matchedFieldsByRecord.get(h.recordId).add(h.fieldId);
        }

        const recordIds = Array.from(matchedFieldsByRecord.keys()).slice(0, limit);

        const fullRecords = [];
        const CONCURRENCY = 5;
        for (let i = 0; i < recordIds.length; i += CONCURRENCY) {
          const batch = recordIds.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(batch.map(rid => getRecord(tableId, rid)));
          fullRecords.push(...results.map(r => r.status === 'fulfilled' ? r.value : null));
        }

        const rows = recordIds.map((rid, idx) => {
          const matchedColumns = Array.from(matchedFieldsByRecord.get(rid))
            .map(fid => columnMap[fid] || fid);
          const rec = fullRecords[idx];
          const display = {};
          if (rec) {
            for (const [fid, cell] of Object.entries(rec.cells || {})) {
              const name = columnMap[fid];
              if (name) display[name] = cell.value ?? null;
            }
          }
          return { _rowId: rid, matchedColumns, ...display };
        });

        const hitCapWarning = filtered.length >= 1000
          ? `Server-side search returned the cap of 1000 matching cells; some records may be missing. Narrow the query or pass identifier_column to scope.`
          : null;

        return {
          content: [{ type: 'text', text: JSON.stringify({
            totalRows:        schema.rowCount ?? null,
            returnedCount:    rows.length,
            uniqueMatches:    matchedFieldsByRecord.size,
            view:             viewId,
            query,
            identifierColumn: identifier_column ?? null,
            searchHitCells:   filtered.length,
            hitCapWarning:    hitCapWarning || undefined,
            rows
          }, null, 2) }]
        };
      }

      const { csvRows, totalRows, syncedAt } = await getOrFetchRows(tableId, { viewId, forceRefresh: force_refresh });

      if (identifier_column && !fieldIdByName[identifier_column]) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: `Column "${identifier_column}" not found.`,
            availableColumns: schema.fields.map(f => f.name)
          }) }],
          isError: true
        };
      }

      const rows = csvRows.slice(0, limit);

      return {
        content: [{ type: 'text', text: JSON.stringify({
          totalRows,
          returnedCount:    rows.length,
          syncedAt,
          view:             viewId,
          query:            null,
          identifierColumn: null,
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
  `Fetch one row's full nested JSON (externalContent/fullValue + status + per-cell credit usage).

USE WHEN:
  - You have a _rowId (from get_rows with a query) and need the raw provider response / nested objects / error payloads / credit cost.
  - You are following a subroutine pointer from a prior record's fullContent.origin (tableId + recordId). Mandatory when tracing execution through functions.
DON'T USE WHEN:
  - Starting from an identifier value → use get_rows with a query first to get the _rowId, then call this on the right match.
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
// Tool: get_credits
// ---------------------------------------------------------------------------

server.tool(
  'get_credits',
  `Calculate Clay credit cost — for a specific row OR aggregated across the table. One tool, three modes:

  1. Specific row: pass rowId → that row's credit breakdown by column, INCLUDING the cost of any function (execute-subroutine) calls it triggered.
  2. Sampled aggregate (default): omit rowId → samples sampleSize rows, aggregates, and extrapolates an estimated total table cost using the table's row count.
  3. Full aggregate: omit rowId AND pass full=true → fetches every row. SLOW — one API call per row, more if rows trigger functions.

CRITICAL: subroutine cost is BILLED ON THE FUNCTION ROW, not on the parent. The parent's execute-subroutine cell has credits=null. Real cost lives on the function row that ran. This tool follows fullContent.origin pointers to the function row(s) and rolls those credits into the parent's total. Without this, parent-only cost is undercounted — sometimes drastically.

USE WHEN:
  - "How much did row X cost" → mode 1.
  - "Average cost per row" / "what does this table cost to run" / "which column is most expensive" → mode 2 or 3.

RETURNS: JSON.
  Single-row: { rowId, status, direct, viaSubroutines, total, billedCellCount, byColumn, subroutineDetail: [{ column, functionTableId, functionRowId, status, direct, viaSubroutines, total }] }
  Aggregate: { rowsAnalyzed, totalRowsInTable, sampled, subroutineDepth, perRow: { avg, avgDirect, avgViaSubroutines, min, max }, totalAcrossSample, extrapolatedTotalCredits, byColumn, bySubroutineColumn: [{ column, avgCreditsPerRow, totalAcrossSample, callsTriggered, callsUnreachable }] }

COST: 1 + N API calls per row analyzed (N = number of subroutine cells, recursive). Sampling 50 rows on a table with 2 subroutine columns at depth 2 ≈ 250 API calls.`,
  {
    tableId: z.string().describe('Table ID (t_...) from a previous sync_table call'),
    rowId: z.string().optional().describe('Row ID — omit to aggregate across the table'),
    sampleSize: z.number().optional().default(50).describe('When aggregating without full=true, how many rows to sample. Default 50.'),
    full: z.boolean().optional().default(false).describe('When aggregating, fetch every row instead of sampling. Slow.'),
    subroutine_depth: z.number().optional().default(2).describe('How many levels deep to follow execute-subroutine origin pointers when rolling up cost. 0 disables (parent-only cost, will undercount). Default 2 (parent → function → nested function). Max 3.')
  },
  async ({ tableId, rowId, sampleSize, full, subroutine_depth }) => {
    try {
      const schema = getSchema(tableId);
      const maxDepth = Math.max(0, Math.min(3, subroutine_depth ?? 2));

      // Mode 1: specific row
      if (rowId) {
        const result = await rollupCredits(tableId, rowId, 0, maxDepth, new Set());
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }

      // Modes 2 + 3: aggregate
      const listLimit = full ? undefined : sampleSize;
      const listed = await listRows(tableId, schema.viewId, { limit: listLimit });
      const rowIds = listed.map(r => r.id).filter(Boolean);

      const rollups = [];
      const fetchErrors = [];
      const CONCURRENCY = 5;
      for (let i = 0; i < rowIds.length; i += CONCURRENCY) {
        const batch = rowIds.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(rid =>
          rollupCredits(tableId, rid, 0, maxDepth, new Set())
        ));
        for (let j = 0; j < results.length; j++) {
          if (results[j].status === 'fulfilled') rollups.push(results[j].value);
          else fetchErrors.push({ rowId: batch[j], message: results[j].reason?.message || String(results[j].reason) });
        }
      }

      const n = rollups.length;
      const sumDirect = rollups.reduce((s, r) => s + (r.direct || 0), 0);
      const sumVia    = rollups.reduce((s, r) => s + (r.viaSubroutines || 0), 0);
      const sumTotal  = rollups.reduce((s, r) => s + (r.total || 0), 0);
      const avg       = n > 0 ? sumTotal / n : 0;
      const avgDirect = n > 0 ? sumDirect / n : 0;
      const avgVia    = n > 0 ? sumVia / n : 0;

      const totals = rollups.map(r => r.total || 0);
      const min = totals.reduce((m, v) => v < m ? v : m, Infinity);
      const max = totals.reduce((m, v) => v > m ? v : m, -Infinity);

      // Direct columns aggregated across the sample
      const byColumnSum = {};
      const byColumnCount = {};
      for (const r of rollups) {
        for (const c of r.byColumn) {
          byColumnSum[c.column]   = (byColumnSum[c.column]   || 0) + (c.total || 0);
          byColumnCount[c.column] = (byColumnCount[c.column] || 0) + 1;
        }
      }
      const byColumn = Object.entries(byColumnSum).map(([col, sum]) => ({
        column:            col,
        avgCreditsPerRow:  sum / n,
        totalAcrossSample: sum,
        cellsBilled:       byColumnCount[col]
      })).sort((a, b) => b.avgCreditsPerRow - a.avgCreditsPerRow);

      // Subroutine columns aggregated separately so the user can see
      // "this column triggers a function that costs ~X credits per call"
      const subSum = {};
      const subCount = {};
      const subUnreachable = {};
      for (const r of rollups) {
        for (const s of r.subroutineDetail || []) {
          subSum[s.column]   = (subSum[s.column]   || 0) + (s.total || 0);
          subCount[s.column] = (subCount[s.column] || 0) + 1;
          if (s.status !== 'ok') subUnreachable[s.column] = (subUnreachable[s.column] || 0) + 1;
        }
      }
      const bySubroutineColumn = Object.entries(subSum).map(([col, sum]) => ({
        column:            col,
        avgCreditsPerRow:  sum / n,
        totalAcrossSample: sum,
        callsTriggered:    subCount[col],
        callsUnreachable:  subUnreachable[col] || 0
      })).sort((a, b) => b.avgCreditsPerRow - a.avgCreditsPerRow);

      const totalRowsInTable = schema.rowCount ?? null;
      const extrapolatedTotalCredits = (!full && totalRowsInTable != null && n > 0)
        ? avg * totalRowsInTable
        : null;

      return {
        content: [{ type: 'text', text: JSON.stringify({
          rowsAnalyzed:     n,
          totalRowsInTable,
          sampled:          !full,
          subroutineDepth:  maxDepth,
          perRow:           {
            avg,
            avgDirect,
            avgViaSubroutines: avgVia,
            min:               n > 0 ? min : 0,
            max:               n > 0 ? max : 0
          },
          totalAcrossSample: { direct: sumDirect, viaSubroutines: sumVia, total: sumTotal },
          extrapolatedTotalCredits,
          byColumn,
          bySubroutineColumn,
          fetchErrors: fetchErrors.length > 0 ? fetchErrors : undefined
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
  - User named a specific row/entity → go straight to get_rows with a query, then get_record on the right match.
  - You just need display values → use get_rows.

VIEW SELECTION: by default uses the view picked at sync time. Pass 'view' to scope to a different view by id (gv_*) or name. POWER MOVE: passing view="Errored rows" (when a Clay table has that saved view) makes get_errors much faster and more focused — it counts statuses only across rows that already have errors, instead of paging the whole table.

RETURNS: JSON — { rowsAnalyzed, view, columns: [{ fieldId, name, success, error, hasNotRun, queued, total, fillPct, topErrors, errorCount }] }.

INTERPRETATION: a column with success=0 and error>0 is broken UNLESS its top error is "Run condition not met" (gated, not broken). Always cross-reference with the column's run condition in the schema before calling something broken.`,
  {
    tableId: z.string().describe('Table ID (t_...) from a previous sync_table call'),
    view:    z.string().optional().describe('View id (gv_*) or view name ("Errored rows", "All rows", etc.) to scope the count. Default: the view picked at sync time.')
  },
  async ({ tableId, view }) => {
    try {
      const schema = getSchema(tableId);
      const viewId = resolveViewId(schema, view);
      if (view && !viewId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: `View "${view}" not found.`,
            availableViews: (schema.views || []).map(v => ({ id: v.id, name: v.name }))
          }) }],
          isError: true
        };
      }

      const rows = await listRows(tableId, viewId);
      const truncated = rows.length >= RECORDS_API_CAP && (schema.rowCount ?? 0) > RECORDS_API_CAP
        ? `View has ${schema.rowCount} rows; analysis covers only the first ${RECORDS_API_CAP} (Clay's records API caps a single read at that size and ignores pagination params). Counts are from a partial sample — use a saved filter view (e.g. "Errored rows") to scope under the cap for full coverage.`
        : null;
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
          view: viewId,
          truncated: truncated || undefined,
          columns
        }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error analyzing errors: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
