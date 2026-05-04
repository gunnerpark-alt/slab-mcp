#!/usr/bin/env node

/**
 * slab-mcp — MCP server for analyzing Clay tables.
 *
 * Tools:
 *   sync_table     — Fetch a Clay table's schema + recursively-synced subroutines
 *   sync_workbook  — Discover all tables in a workbook and fetch their schemas
 *   get_rows       — List or search display values; accepts tableId or url; cheap
 *   export_csv     — Export all rows as flat display values; pass columns= to project wide tables
 *   find_rows      — Bulk membership check: given N values + a column, returns _rowId per match
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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { getTableSchema, listRows, getRecord, getWorkbookTables, getAllRecords, searchRecords, exportTableToCsv, fetchCsv, RECORDS_API_CAP } from './src/clay-api.js';
import { analyzeRowStatuses, formatRecord } from './src/row-utils.js';

// ---------------------------------------------------------------------------
// In-memory caches (lifetime: MCP server process)
// ---------------------------------------------------------------------------

const schemaCache = new Map(); // tableId -> schema

// Subroutine-table mean cost cache, keyed by tableId. Used as a fallback
// when a parent row's subroutine call points to a function row that's been
// pruned (404). Without this fallback, get_credits silently undercounts —
// every unreachable call contributes 0 credits to the rollup.
// Values are Promises during in-flight fetch (concurrency-safe) and
// resolved means once computed: { meanCredits, meanAiCostUsd, sampleSize }.
const subroutineFallbackCache = new Map();

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
 * Sample N rows from a subroutine table and compute its mean per-row cost.
 * Cached per tableId for the lifetime of the MCP process. Used as the
 * fallback estimate when a parent row's subroutine call points to a
 * function row that has been pruned (404) — without this, those calls
 * silently contribute 0 to the parent's rollup and total cost is
 * undercounted by the entire subroutine population.
 *
 * The estimate fully rolls up the subroutine's own subroutines (it calls
 * rollupCredits with the same maxDepth), so AI cost and nested function
 * cost from the subroutine population are reflected in the mean.
 *
 * Returns: { meanCredits, meanAiCostUsd, sampleSize, fetchErrors }.
 */
async function estimateSubroutineMean(tableId, sampleSize, maxDepth) {
  if (subroutineFallbackCache.has(tableId)) {
    return subroutineFallbackCache.get(tableId);
  }
  const promise = (async () => {
    let schema = schemaCache.get(tableId);
    if (!schema) {
      try {
        schema = await getTableSchema(tableId, null);
        schemaCache.set(tableId, schema);
      } catch (err) {
        return { meanCredits: 0, meanAiCostUsd: 0, sampleSize: 0, error: err.message };
      }
    }

    let listed;
    try {
      listed = await listRows(tableId, schema.viewId, { limit: sampleSize });
    } catch (err) {
      return { meanCredits: 0, meanAiCostUsd: 0, sampleSize: 0, error: err.message };
    }
    const rowIds = (listed || []).map(r => r.id).filter(Boolean);
    if (rowIds.length === 0) {
      return { meanCredits: 0, meanAiCostUsd: 0, sampleSize: 0 };
    }

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
    const meanCredits   = n > 0 ? rollups.reduce((s, r) => s + (r.total || 0), 0) / n : 0;
    const meanAiCostUsd = n > 0 ? rollups.reduce((s, r) => s + (r.totalAiCostUsd || 0), 0) / n : 0;

    return {
      meanCredits,
      meanAiCostUsd,
      sampleSize:  n,
      fetchErrors: fetchErrors.length > 0 ? fetchErrors : undefined
    };
  })();
  subroutineFallbackCache.set(tableId, promise);
  return promise;
}

/**
 * Recursively roll up credit cost for a row, following execute-subroutine
 * cells to their function-row counterparts. The parent row's subroutine
 * cell carries no credit data — actual cost lives on the function row that
 * ran. Capped by maxDepth (subroutines + nested subroutines + ...).
 *
 * AI provider cost (USD) is tracked alongside Clay credits at every level.
 * When a function row is unreachable (404 — pruned), the rollup falls back
 * to the subroutine table's per-row mean so cost isn't silently zeroed.
 *
 * Returns:
 *   {
 *     rowId, tableId, status,
 *     direct, directAiCostUsd,                    // this row's own cells
 *     viaSubroutines, viaSubroutinesAiCostUsd,    // sum from function rows this row invoked
 *     total, totalAiCostUsd,                      // direct + viaSubroutines
 *     billedCellCount, ranCellCount,
 *     byColumn,         // direct columns
 *     subroutineDetail  // per-call breakdown w/ status + AI cost
 *   }
 *
 * Status values: 'ok' (fetched), '404' (function row deleted, no fallback applied),
 * '404-estimated' (function row deleted, mean used), 'error', 'cycle', 'depth'.
 */
async function rollupCredits(tableId, rowId, depth, maxDepth, visited) {
  const visitKey = `${tableId}:${rowId}`;
  const empty = {
    rowId, tableId,
    direct: 0, directAiCostUsd: 0,
    viaSubroutines: 0, viaSubroutinesAiCostUsd: 0,
    total: 0, totalAiCostUsd: 0,
    billedCellCount: 0, ranCellCount: 0,
    byColumn: [], subroutineDetail: []
  };

  if (visited.has(visitKey)) {
    return { ...empty, status: 'cycle' };
  }
  visited.add(visitKey);

  let schema, subroutineFields;
  try {
    ({ schema, subroutineFields } = await getSubroutineFields(tableId));
  } catch (err) {
    return { ...empty, status: 'schema-error', errorMessage: err.message };
  }

  let record;
  try {
    record = await getRecord(tableId, rowId);
  } catch (err) {
    const is404 = err.message.includes('404') || err.message.includes('not found');
    return { ...empty, status: is404 ? '404' : 'error', errorMessage: err.message };
  }

  const formatted = formatRecord(record, schema);
  const direct           = formatted._credits?.total ?? 0;
  const directAiCostUsd  = formatted._credits?.aiProviderCostUsd ?? 0;
  const billedCellCount  = formatted._credits?.billedCellCount ?? 0;
  const ranCellCount     = formatted._credits?.ranCellCount ?? 0;

  const byColumn = [];
  for (const [col, cell] of Object.entries(formatted)) {
    if (col.startsWith('_')) continue;
    if (cell?.credits) byColumn.push({ column: col, ...cell.credits });
  }
  byColumn.sort((a, b) =>
    ((b.total || 0) + (b.aiProviderCostUsd || 0)) - ((a.total || 0) + (a.aiProviderCostUsd || 0))
  );

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
  let viaSubroutinesAiCostUsd = 0;
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
        direct:          0, directAiCostUsd: 0,
        viaSubroutines:  0, viaSubroutinesAiCostUsd: 0,
        total:           0, totalAiCostUsd: 0
      });
    }
  } else {
    const results = await Promise.allSettled(subroutineCalls.map(call =>
      rollupCredits(call.origin.tableId, call.origin.recordId, depth + 1, maxDepth, visited)
    ));
    // Collect calls that resolved to '404' so we can apply the fallback
    // estimator concurrently — one estimate per unreachable subroutine
    // table, regardless of how many parent calls hit it.
    const unreachableByTable = new Map();
    for (let i = 0; i < subroutineCalls.length; i++) {
      const call = subroutineCalls[i];
      const r = results[i];
      if (r.status === 'fulfilled' && r.value.status === '404') {
        if (!unreachableByTable.has(call.origin.tableId)) {
          unreachableByTable.set(call.origin.tableId, []);
        }
        unreachableByTable.get(call.origin.tableId).push(i);
      }
    }
    let fallbackByTable = new Map();
    if (unreachableByTable.size > 0) {
      const tableIds = Array.from(unreachableByTable.keys());
      const estimates = await Promise.all(tableIds.map(tid =>
        estimateSubroutineMean(tid, 10, Math.max(0, maxDepth - depth - 1))
      ));
      for (let i = 0; i < tableIds.length; i++) {
        fallbackByTable.set(tableIds[i], estimates[i]);
      }
    }

    for (let i = 0; i < subroutineCalls.length; i++) {
      const call = subroutineCalls[i];
      const r = results[i];
      if (r.status === 'fulfilled') {
        const v = r.value;
        if (v.status === '404') {
          const fb = fallbackByTable.get(call.origin.tableId);
          if (fb && fb.sampleSize > 0) {
            subroutineDetail.push({
              column:          call.columnName,
              functionTableId: call.origin.tableId,
              functionRowId:   call.origin.recordId,
              status:          '404-estimated',
              direct:          fb.meanCredits,
              directAiCostUsd: fb.meanAiCostUsd,
              viaSubroutines:  0,
              viaSubroutinesAiCostUsd: 0,
              total:           fb.meanCredits,
              totalAiCostUsd:  fb.meanAiCostUsd,
              estimatedFromSample: fb.sampleSize,
              ...(v.errorMessage ? { errorMessage: v.errorMessage } : {})
            });
            viaSubroutines           += fb.meanCredits;
            viaSubroutinesAiCostUsd  += fb.meanAiCostUsd;
            continue;
          }
          // Fallback didn't yield a usable estimate — fall through to the
          // un-estimated 404 path below.
        }
        subroutineDetail.push({
          column:          call.columnName,
          functionTableId: call.origin.tableId,
          functionRowId:   call.origin.recordId,
          status:          v.status,
          direct:          v.direct,
          directAiCostUsd: v.directAiCostUsd,
          viaSubroutines:  v.viaSubroutines,
          viaSubroutinesAiCostUsd: v.viaSubroutinesAiCostUsd,
          total:           v.total,
          totalAiCostUsd:  v.totalAiCostUsd,
          ...(v.errorMessage ? { errorMessage: v.errorMessage } : {})
        });
        viaSubroutines           += v.total          || 0;
        viaSubroutinesAiCostUsd  += v.totalAiCostUsd || 0;
      } else {
        subroutineDetail.push({
          column:          call.columnName,
          functionTableId: call.origin.tableId,
          functionRowId:   call.origin.recordId,
          status:          'error',
          errorMessage:    r.reason?.message || String(r.reason),
          direct:          0, directAiCostUsd: 0,
          viaSubroutines:  0, viaSubroutinesAiCostUsd: 0,
          total:           0, totalAiCostUsd: 0
        });
      }
    }
  }

  return {
    rowId,
    tableId,
    status: 'ok',
    direct,
    directAiCostUsd,
    viaSubroutines,
    viaSubroutinesAiCostUsd,
    total:          direct          + viaSubroutines,
    totalAiCostUsd: directAiCostUsd + viaSubroutinesAiCostUsd,
    billedCellCount,
    ranCellCount,
    byColumn,
    subroutineDetail
  };
}

// ---------------------------------------------------------------------------
// CSV parser (handles quoted fields and embedded newlines)
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let i = 0;
  const n = text.length;

  function parseField() {
    if (i < n && text[i] === '"') {
      i++;
      let field = '';
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; }
          else { i++; break; }
        } else {
          field += text[i++];
        }
      }
      return field;
    }
    let field = '';
    while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
      field += text[i++];
    }
    return field;
  }

  function parseRow() {
    const fields = [];
    while (true) {
      fields.push(parseField());
      if (i >= n || text[i] === '\n' || text[i] === '\r') {
        if (i < n && text[i] === '\r') i++;
        if (i < n && text[i] === '\n') i++;
        break;
      }
      i++; // skip comma
    }
    return fields;
  }

  while (i < n) {
    const row = parseRow();
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0];
  const dataRows = rows.slice(1).map(values => {
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = values[j] ?? null;
    return obj;
  });
  return { headers, rows: dataRows };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
//
// Wrapped in a factory so HTTP mode can instantiate a fresh server + transport
// per request (the SDK's stateless streamable-HTTP pattern requires this — a
// shared transport's `_initialized` flag and stream map get polluted across
// requests). Module-level caches (schemaCache, subroutineFallbackCache) live
// outside this function and are shared across all instances, so per-request
// instantiation doesn't lose warm Clay schema state.

function createServer() {
const server = new McpServer({
  name: 'slab',
  version: '4.7.0'
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
  User gives a list of IDs / emails / values to check       → find_rows ALWAYS — never export_csv for this, even with columns=; large tables will still blow the budget; find_rows is server-side and never hits the limit
  All rows needed for analysis, surface values sufficient   → export_csv with columns= (project to only the columns you need)
  "What's broken" / "why are errors"                        → get_errors
  "Debug" / "investigate" a specific row or failing column  → get_errors to find a failing _rowId, then get_record on it, then follow every subroutine origin pointer (debugging without nested JSON is guessing)
  "How much does this table cost" / "avg credits per row"   → get_credits (no rowId, samples)
  "How much did row X cost" / "which column is expensive"   → get_credits with rowId
  Already have a _rowId, need raw nested JSON               → get_record

find_rows vs export_csv vs get_rows:

  Pattern: "here is a list of values — which rows have them?"
  → find_rows, ALWAYS. Not export_csv. Not get_rows in a loop.
    find_rows downloads the table server-side, does the set intersection in Node, and returns only
    { matches: [{value, _rowId, ...}], not_found: [] }. The raw table data never crosses the MCP
    transport, so table size is irrelevant. export_csv with columns= will still fail on tables with
    thousands of rows even if you ask for 2 columns.

  Pattern: "show me / analyse the actual data across all rows"
  → export_csv with columns= listing only the columns you need. Keeps response small.

  Pattern: "find this one specific entity"
  → get_rows with query. One server-side search call, no export needed.

  Pattern: "why did this row fail / what did the AI return / trace subroutine"
  → get_rows or find_rows to get _rowId, then get_record. Surface views hide nested data.

get_rows accepts either tableId (from a prior sync_table) or url (auto-syncs the schema if not cached). Either is fine — pick whichever the user gave you.

== Saved views ==

Clay tables have multiple views. By default get_rows / get_errors use whichever view sync_table picked (auto-promotes "All rows" if it exists, otherwise uses the URL's view, otherwise the table's default). To switch views without re-syncing, pass the optional 'view' parameter — it accepts a viewId (gv_*) or a view name ("All rows", "Errored rows", "Default view", etc.). Available views are in rootSchema.views from sync_table.

When the user wants to drill into errors, calling get_errors with view="Errored rows" (when that view exists) is much faster and more focused than scanning the whole table — it only counts statuses across already-failing rows. Same pattern for "Fully enriched rows" or any custom filtered view the table builder created.

== Cost rule of thumb ==

get_rows is cheap — a query is one server-side search call plus one record fetch per match (capped by limit), no-query is a single paginated read. get_record is expensive (one API call per row, returns full nested JSON). Default to get_rows. Only escalate to get_record when a display value can't answer the question — debugging, tracing why an enrichment failed, getting the raw provider response, or seeing per-cell credit cost. The escalation from search → fetch is your call; there's no auto-fetch.

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
  get_record returns per-cell credits.{ total, upfront, additional, aiProviderCost, aiProviderCostUsd } when the cell consumed credits, and a row-level _credits.{ total, aiProviderCostUsd, billedCellCount, ranCellCount } summary. AI cells disclose the underlying OpenAI/Anthropic dollar cost both as the raw Clay-formatted string (aiProviderCost, e.g. "$0.28572") and as a parsed number for math (aiProviderCostUsd).

  SUCCESS_NO_DATA cells are auto-zeroed for Clay credits — Clay doesn't bill when a provider returns no data, but the price tag is still in the payload. The original sum is preserved as credits.wouldBeCredits with noData:true so analytics like "this column would have cost X if every call returned data" remain available. AI provider cost is NOT zeroed because tokens are spent regardless of whether data came back.

  CRITICAL — subroutine cost is billed separately: when a parent row has an execute-subroutine cell, that cell's credits=null and the parent's _credits.total UNDERCOUNTS the row's true cost. The actual function-call cost (credits + AI $) is billed on the function row reachable via fullContent.origin.{tableId,recordId}. get_record alone won't show this — it returns just the parent's direct cells.

  Use get_credits for true row cost. It recursively follows origin pointers to function rows and returns { direct, directAiCostUsd, viaSubroutines, viaSubroutinesAiCostUsd, total, totalAiCostUsd }, plus subroutineDetail per subroutine column. When a function row is unreachable (pruned/404), the rollup falls back to the subroutine table's per-row mean (sampled once and cached) so cost isn't silently zeroed. Default depth 2 covers parent → function → one nested level. Aggregate mode also splits direct columns from subroutine columns in the rollup, and exposes triggerRatePct + cellsRan + cellsBilled per column so you can distinguish "5 credits × every row" from "10 credits × half the rows".

  When a row's full nested JSON would blow the context window (HubSpot/SFDC Lookup columns commonly inflate get_record to 100–300KB), pass slim:true to drop fullContent, or columns=[...] to project to specific fields. Both keep credits/aiProviderCostUsd intact.

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
  `Fetch surface row data (display values as shown in the table UI). Fast — uses Clay's records API directly: server-side search for queries, paginated read for samples.

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

RETURNS: JSON — { totalRows, returnedCount, view, query, identifierColumn, rows: [...] }. Every row includes _rowId. When query is provided, rows also include matchedColumns (every column whose cell matched the substring).

QUERY VS NO-QUERY ARE DIFFERENT PATHS:
  - With query: hits Clay's server-side search endpoint (POST /views/{viewId}/search), then fetches each unique matching record in parallel for display values. Works on tables of any size (no 20k row cap). Server caps at 1000 matching cells per call, which dedupes down further by recordId — broad substrings ("@", common domains) may saturate the cap and miss matches.
  - Without query: pulls the first 'limit' rows from /records (capped at 20k by the API). Each row already includes its _rowId.

ESCALATION TO NESTED: when query returns exactly one match and the user wants the why/how (raw provider response, error payload, credit detail, subroutine origin pointers), follow up with get_record(tableId, rowId). The escalation is your call — there's no auto-fetch.`,
  {
    tableId: z.string().optional().describe('Table ID (t_...) from a previous sync_table call. Either tableId or url is required.'),
    url:     z.string().optional().describe('Clay table URL (must contain /tables/t_...). Auto-syncs the schema if not already cached. Either tableId or url is required.'),
    view:    z.string().optional().describe('View id (gv_*) or view name ("All rows", "Errored rows", etc.) to query. Default: the view picked at sync time.'),
    query:   z.string().optional().describe('Substring match (case-insensitive). Server-side search across every cell. Returns up to limit unique matching records.'),
    identifier_column: z.string().optional().describe('Restrict the substring match to this column. Requires query. Omit to search all columns.'),
    limit:   z.number().optional().default(20).describe('Max rows to return. Default 20. Use 1 when searching for a specific entity.')
  },
  async ({ tableId, url, view, query, identifier_column, limit }) => {
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

      const apiRows = await getAllRecords(tableId, viewId, { limit });
      const rows = apiRows.map(r => {
        const display = { _rowId: r.id };
        for (const [fid, cell] of Object.entries(r.cells || {})) {
          const name = columnMap[fid];
          if (name) display[name] = cell.value ?? null;
        }
        return display;
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({
          totalRows:        schema.rowCount ?? null,
          returnedCount:    rows.length,
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
// Tool: export_csv
// ---------------------------------------------------------------------------

server.tool(
  'export_csv',
  `Export all rows in a view as flat display values. Use for bulk operations where surface values are sufficient — membership checks, full-table scans, coverage analysis, or comparing a list of IDs against the table.

USE WHEN:
  - You need all (or most) rows AND you will reason over the actual data values (e.g. summarising domains, showing sample rows, analysing patterns across the full dataset)
  - Display values visible in the Clay UI are enough — you do NOT need nested JSON, cell statuses, credit costs, or subroutine pointers
  - Use the columns= parameter to project down to only the columns you need — this is the only way to make large tables fit

DON'T USE WHEN:
  - You have a list of IDs / emails / values and want to know which ones exist in the table → use find_rows. Do NOT use export_csv for this — even with columns=, a table with thousands of rows will blow the response budget. find_rows does the intersection server-side and only returns matches + not_found.
  - Searching for a single specific entity → get_rows with query is faster
  - You need to debug a failing row → get_errors + get_record
  - You need to optimize or review a Claygent/AI prompt → get_record on 1-3 rows first (surface values just say "Response")
  - You need to trace data flow across subroutine calls → get_record
  - You need per-cell credit costs → get_credits
  - The question can be answered from schema alone → sync_table

COST: async — kicks off a Clay export job, polls until done (~1-5s for small tables, up to 5 min for very large), downloads the result once. One network round-trip regardless of table size. For small tables (under a few hundred rows), get_rows without a query may be faster.

VIEW SELECTION: same rules as get_rows. Pass 'view' by id (gv_*) or name to scope to a filtered view (e.g. "Errored rows").

RETURNS: { totalRows, returnedCount, truncated, view, columns, rows: [{ <colName>: <displayValue>, ... }] }
  - totalRows: count reported by the export job
  - truncated: true if the parsed result was cut to fit the MCP response budget (~900KB); a warning explains how many rows were dropped`,
  {
    tableId: z.string().optional().describe('Table ID (t_...) from a prior sync_table call. Either tableId or url is required.'),
    url:     z.string().optional().describe('Clay table URL — auto-syncs the schema if not cached. Either tableId or url is required.'),
    view:    z.string().optional().describe('View id (gv_*) or view name ("All rows", "Errored rows", etc.). Default: the view picked at sync time.'),
    columns: z.array(z.string()).optional().describe('Allowlist of column names to include in each row. Omit to return all columns. Use this to reduce response size on wide tables — e.g. ["Account ID", "Final Account ID", "Domain"] instead of all 50 columns.')
  },
  async ({ tableId, url, view, columns }) => {
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

      const { downloadUrl, totalRows } = await exportTableToCsv(tableId, viewId);
      const csvText = await fetchCsv(downloadUrl);
      let { headers, rows } = parseCsv(csvText);

      // Column projection — filter before size estimation
      if (columns && columns.length > 0) {
        const keep = new Set(columns);
        headers = headers.filter(h => keep.has(h));
        rows = rows.map(r => {
          const projected = {};
          for (const h of headers) projected[h] = r[h] ?? null;
          return projected;
        });
      }

      // Truncate to fit MCP response budget
      let truncated = false;
      let returnedRows = rows;
      const sizeEstimate = JSON.stringify({ headers, rows }).length;
      if (sizeEstimate > MCP_RESPONSE_MAX_BYTES) {
        const ratio = MCP_RESPONSE_MAX_BYTES / sizeEstimate;
        const safeCount = Math.floor(rows.length * ratio * 0.9);
        returnedRows = rows.slice(0, safeCount);
        truncated = true;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          totalRows:    totalRows ?? rows.length,
          returnedCount: returnedRows.length,
          truncated:    truncated || undefined,
          truncatedWarning: truncated
            ? `Result was cut from ${rows.length} to ${returnedRows.length} rows to fit the MCP response budget. Pass 'columns' to project down to the columns you need, or use find_rows for a membership check.`
            : undefined,
          view:    viewId,
          columns: headers,
          rows:    returnedRows
        }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error exporting CSV: ${err.message}` }) }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: find_rows
// ---------------------------------------------------------------------------

server.tool(
  'find_rows',
  `Check which values from a list exist in a specific column, and return the _rowId for every match so you can call get_record on them.

USE WHEN:
  - You have a list of IDs, emails, domains, or any values and need to know which ones have a corresponding row in the table
  - You need the _rowId for matched rows so you can follow up with get_record for deeper debugging
  - The table is too wide for export_csv to fit in the response budget — find_rows processes everything server-side and only returns the filtered result

DON'T USE WHEN:
  - Searching for a single value → get_rows with query is simpler
  - You need the actual data for all rows (not just matches) → export_csv with columns projection
  - You need nested JSON on matched rows right now → use find_rows to get _rowIds, then get_record in parallel

HOW IT WORKS: Downloads all rows via the records API, does the set intersection server-side, returns only the result. The raw table data never crosses the MCP transport — only matched rows come back.

RETURNS:
  {
    column,           // column that was searched
    searched,         // total values you passed in (including dupes)
    uniqueSearched,   // deduplicated count
    matchedCount,     // rows found
    notFoundCount,    // values with no matching row
    totalRowsScanned, // how many rows the table had
    matches: [{ value, _rowId, ...return_columns }],
    not_found: [value, ...]
  }

  _rowId on each match is the row ID you pass to get_record(tableId, _rowId) to pull full nested JSON.`,
  {
    tableId:        z.string().optional().describe('Table ID (t_...) from a prior sync_table call. Either tableId or url is required.'),
    url:            z.string().optional().describe('Clay table URL — auto-syncs the schema if not cached. Either tableId or url is required.'),
    view:           z.string().optional().describe('View id (gv_*) or view name. Default: the view picked at sync time.'),
    column:         z.string().describe('Column name to match against. Must be an exact column name as it appears in the table.'),
    values:         z.array(z.string()).describe('List of values to look for. Matching is exact and case-sensitive. Duplicates are deduped automatically.'),
    return_columns: z.array(z.string()).optional().describe('Extra columns to include on each matched row alongside _rowId. Useful for quick context without a separate get_record call — e.g. ["Domain", "Final Account ID", "Create Account?"].')
  },
  async ({ tableId, url, view, column, values, return_columns }) => {
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

      // Build fieldId maps
      const fieldIdByName = {};
      const columnMap = {};
      for (const f of schema.fields) {
        fieldIdByName[f.name] = f.id;
        columnMap[f.id] = f.name;
      }

      const targetFieldId = fieldIdByName[column];
      if (!targetFieldId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: `Column "${column}" not found.`,
            availableColumns: schema.fields.map(f => f.name)
          }) }],
          isError: true
        };
      }

      // Validate return_columns early
      const extraFieldIds = [];
      if (return_columns && return_columns.length > 0) {
        for (const col of return_columns) {
          const fid = fieldIdByName[col];
          if (!fid) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                error: `return_columns: column "${col}" not found.`,
                availableColumns: schema.fields.map(f => f.name)
              }) }],
              isError: true
            };
          }
          extraFieldIds.push({ col, fid });
        }
      }

      // Dedupe the search values
      const uniqueValues = [...new Set(values.map(String))];
      const valueSet = new Set(uniqueValues);

      // Fetch all rows server-side — _rowId lives on record.id
      const records = await getAllRecords(tableId, viewId);

      const matches = [];
      const foundValues = new Set();

      for (const record of records) {
        const cells = record.cells || {};
        const cellValue = cells[targetFieldId]?.value;
        if (cellValue == null) continue;
        const strValue = String(cellValue);
        if (!valueSet.has(strValue)) continue;

        const match = { value: strValue, _rowId: record.id };
        for (const { col, fid } of extraFieldIds) {
          match[col] = cells[fid]?.value ?? null;
        }
        matches.push(match);
        foundValues.add(strValue);
      }

      const not_found = uniqueValues.filter(v => !foundValues.has(v));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          column,
          searched:         values.length,
          uniqueSearched:   uniqueValues.length,
          matchedCount:     matches.length,
          notFoundCount:    not_found.length,
          totalRowsScanned: records.length,
          matches,
          not_found
        }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Error in find_rows: ${err.message}` }) }], isError: true };
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

PROJECTION (use these to keep the response small — full records can be 100–300 KB on tables with HubSpot/SFDC Lookup columns):
  - columns: array of column names to return. _rowId and _credits are always included. Use this when you only care about a subset (e.g. AI cost on specific Use AI / Claygent columns).
  - slim: when true, drops fullContent from every cell — keeps value, status, and credits. Cuts payload size by 80–95% when you only need credit cost / status / display values, not the raw provider responses.

RETURNS: JSON — { _rowId, _credits: { total, aiProviderCostUsd, billedCellCount, ranCellCount }, <columnName>: { value, status, fullContent?, credits? }, ... }. credits per cell now exposes aiProviderCostUsd (numeric USD) alongside the raw aiProviderCost string.
COST: Expensive — one API call per row. Batch subroutine follow-ups in parallel.`,
  {
    tableId: z.string().describe('Table ID (t_...) from a previous sync_table call'),
    rowId:   z.string().describe('Row ID (from get_rows results, found in the _rowId field)'),
    columns: z.array(z.string()).optional().describe('Allowlist of column names to include. _rowId and _credits are always returned. Omit to return all columns.'),
    slim:    z.boolean().optional().default(false).describe('Drop fullContent from every cell to shrink the payload. Default false. Use when you only need value/status/credits.')
  },
  async ({ tableId, rowId, columns, slim }) => {
    try {
      const schema = getSchema(tableId);
      const record = await getRecord(tableId, rowId);
      const formatted = formatRecord(record, schema);

      let projected = formatted;
      if (columns && columns.length > 0) {
        const keep = new Set(columns);
        const out = { _rowId: formatted._rowId };
        if (formatted._credits) out._credits = formatted._credits;
        for (const col of columns) {
          if (col in formatted) out[col] = formatted[col];
        }
        projected = out;
      }

      if (slim) {
        for (const [k, v] of Object.entries(projected)) {
          if (k.startsWith('_')) continue;
          if (v && typeof v === 'object' && 'fullContent' in v) {
            const { fullContent, ...rest } = v;
            projected[k] = rest;
          }
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(projected, null, 2) }]
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
  `Calculate full per-row cost — Clay credits AND AI provider $ — for a specific row OR aggregated across the table. One tool, three modes:

  1. Specific row: pass rowId → that row's credit + AI breakdown by column, INCLUDING the cost of any function (execute-subroutine) calls it triggered.
  2. Sampled aggregate (default): omit rowId → samples sampleSize rows, aggregates, and extrapolates an estimated total table cost (credits + AI $) using the table's row count.
  3. Full aggregate: omit rowId AND pass full=true → fetches every row. SLOW — one API call per row, more if rows trigger functions.

WHAT'S COVERED:
  - Clay credits (upfront + additional). Cells with statuses that carry a price tag but are not billed get zeroed out: SUCCESS_NO_DATA (provider returned empty), ERROR_RUN_CONDITION_NOT_MET (gate didn't pass — column never executed), ERROR_BAD_REQUEST (request rejected before reaching provider). The original sum is preserved per-cell as wouldBeCredits with a notBilledReason describing why ('no-data' / 'gated' / 'bad-request'), and aggregated as wouldBeCreditsAcrossSample on each byColumn entry.
  - Bare ERROR cells (provider responded with an error) are included in billed totals but flagged with billingAmbiguous: true, since Clay's billing behavior depends on where the failure occurred.
  - AI provider cost ($USD) from Use AI / Claygent columns, sourced from each cell's hiddenValue.costDetails.totalCostToAIProvider. Reported as aiCostUsd / aiProviderCostUsd everywhere alongside Clay credits. AI cost is NOT zeroed by status — LLM tokens are spent regardless of downstream status.
  - Subroutine cost is BILLED ON THE FUNCTION ROW, not the parent. The parent's execute-subroutine cell has credits=null. This tool follows fullContent.origin pointers and rolls function-row cost (credits AND AI $) into the parent's total.
  - When a function row is unreachable (404 — pruned), the rollup falls back to the subroutine table's per-row mean (sampled and cached). subroutineDetail entries get status='404-estimated' so estimated calls are visible. Without this fallback, get_credits silently undercounts when subroutines have been garbage-collected.

USE WHEN:
  - "How much did row X cost" / "what's the AI bill on this row" → mode 1.
  - "Average cost per row" / "what does this table cost to run" / "which column is most expensive" → mode 2 or 3.

RETURNS: JSON.
  Single-row: {
    rowId, status,
    direct, directAiCostUsd,
    viaSubroutines, viaSubroutinesAiCostUsd,
    total, totalAiCostUsd,
    billedCellCount, ranCellCount,
    byColumn, subroutineDetail: [{ column, functionTableId, functionRowId, status, direct, directAiCostUsd, viaSubroutines, viaSubroutinesAiCostUsd, total, totalAiCostUsd, estimatedFromSample? }]
  }
  Aggregate: {
    rowsAnalyzed, totalRowsInTable, sampled, subroutineDepth,
    perRow: { avg, avgDirect, avgViaSubroutines, avgAiCostUsd, avgDirectAiCostUsd, avgViaSubroutinesAiCostUsd, min, max, minAiCostUsd, maxAiCostUsd },
    totalAcrossSample: { direct, viaSubroutines, total, directAiCostUsd, viaSubroutinesAiCostUsd, totalAiCostUsd },
    extrapolatedTotalCredits, extrapolatedTotalAiCostUsd,
    byColumn:           [{ column, avgCreditsPerRow, avgAiCostUsdPerRow, totalCreditsAcrossSample, totalAiCostUsdAcrossSample, cellsRan, cellsPriced, cellsBilled, triggerRatePct, wouldBeCreditsAcrossSample?, cellsAmbiguous? }],
    bySubroutineColumn: [{ column, avgCreditsPerRow, avgAiCostUsdPerRow, totalCreditsAcrossSample, totalAiCostUsdAcrossSample, callsTriggered, callsReached, callsEstimated, callsUnreachable, callsDepthCapped, callsErrored, triggerRatePct }],
    varianceHint?, subroutineCoverageHint?
  }

INTERPRETING byColumn:
  - avgCreditsPerRow is the mean across ALL sampled rows, NOT the per-call cost. A column that fires on 30% of rows at 10 credits each will show avgCreditsPerRow≈3. Use triggerRatePct (cellsRan / rowsAnalyzed) to see how often the column actually runs. Use cellsBilled to see how often it was actually charged (cellsRan minus no-data passes).
  - varianceHint fires when max/avg is large on a small sample — your avg is probably averaging over two populations (fully-firing rows and gated-out rows). Increase sampleSize for a tighter point estimate.
  - subroutineCoverageHint fires when subroutine calls were 404 AND the fallback estimator couldn't sample the function table. Reported via-subroutine cost is undercounted in that case.

COST: 1 + N API calls per row analyzed (N = number of subroutine cells, recursive). Sampling 50 rows on a table with 2 subroutine columns at depth 2 ≈ 250 API calls. The unreachable-fallback adds up to 10 extra calls per unreachable subroutine table (one-time, cached for the rest of the run).`,
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

      // Clay credits
      const sumDirect = rollups.reduce((s, r) => s + (r.direct || 0), 0);
      const sumVia    = rollups.reduce((s, r) => s + (r.viaSubroutines || 0), 0);
      const sumTotal  = rollups.reduce((s, r) => s + (r.total || 0), 0);
      const avg       = n > 0 ? sumTotal / n : 0;
      const avgDirect = n > 0 ? sumDirect / n : 0;
      const avgVia    = n > 0 ? sumVia / n : 0;

      // AI provider cost (USD)
      const sumDirectAi = rollups.reduce((s, r) => s + (r.directAiCostUsd || 0), 0);
      const sumViaAi    = rollups.reduce((s, r) => s + (r.viaSubroutinesAiCostUsd || 0), 0);
      const sumTotalAi  = rollups.reduce((s, r) => s + (r.totalAiCostUsd || 0), 0);
      const avgAi       = n > 0 ? sumTotalAi / n : 0;
      const avgDirectAi = n > 0 ? sumDirectAi / n : 0;
      const avgViaAi    = n > 0 ? sumViaAi / n : 0;

      const totals = rollups.map(r => r.total || 0);
      const aiTotals = rollups.map(r => r.totalAiCostUsd || 0);
      const min      = totals.reduce((m, v) => v < m ? v : m, Infinity);
      const max      = totals.reduce((m, v) => v > m ? v : m, -Infinity);
      const minAi    = aiTotals.reduce((m, v) => v < m ? v : m, Infinity);
      const maxAi    = aiTotals.reduce((m, v) => v > m ? v : m, -Infinity);

      // Direct columns aggregated across the sample.
      //
      // cellsRan        = cells where the column actually executed (status
      //                   was SUCCESS / SUCCESS_NO_DATA / ERROR /
      //                   ERROR_BAD_REQUEST). This is the trigger rate
      //                   number — "does this column run on every row".
      // cellsPriced     = cells with externalContent.upfrontCreditUsage
      //                   data attached, billed or not. The difference
      //                   cellsPriced − cellsRan is cells where Clay
      //                   prepared the price tag but the cell never
      //                   executed (gated by run condition). Useful for
      //                   spotting waterfall providers that are mostly
      //                   skipped despite having a price tag at every row.
      // cellsBilled     = cells actually charged (Clay credits > 0 OR
      //                   AI tokens > 0). Excludes no-data / gated /
      //                   bad-request cells which carry a price tag but
      //                   are not billed.
      // triggerRatePct  = cellsRan / n. Use this, not the old "did this
      //                   cell appear in byColumn" metric — gated cells
      //                   have a price tag and used to inflate this.
      const byColumnAggregate = new Map();
      for (const r of rollups) {
        for (const c of r.byColumn) {
          if (!byColumnAggregate.has(c.column)) {
            byColumnAggregate.set(c.column, {
              sumCredits: 0, sumAiCostUsd: 0,
              sumWouldBeCredits: 0,
              cellsRan: 0, cellsPriced: 0, cellsBilled: 0,
              cellsAmbiguous: 0
            });
          }
          const agg = byColumnAggregate.get(c.column);
          agg.sumCredits        += c.total || 0;
          agg.sumAiCostUsd      += c.aiProviderCostUsd || 0;
          agg.sumWouldBeCredits += c.wouldBeCredits || 0;
          agg.cellsPriced       += 1;
          if (c.executed)            agg.cellsRan       += 1;
          if (c.billingAmbiguous)    agg.cellsAmbiguous += 1;
          if ((c.total || 0) > 0 || (c.aiProviderCostUsd || 0) > 0) agg.cellsBilled += 1;
        }
      }
      const byColumn = Array.from(byColumnAggregate.entries()).map(([col, agg]) => ({
        column:                     col,
        avgCreditsPerRow:           agg.sumCredits / n,
        avgAiCostUsdPerRow:         agg.sumAiCostUsd / n,
        totalCreditsAcrossSample:   agg.sumCredits,
        totalAiCostUsdAcrossSample: agg.sumAiCostUsd,
        cellsRan:                   agg.cellsRan,
        cellsPriced:                agg.cellsPriced,
        cellsBilled:                agg.cellsBilled,
        triggerRatePct:             Math.round((agg.cellsRan / n) * 1000) / 10,
        ...(agg.sumWouldBeCredits > 0 ? {
          wouldBeCreditsAcrossSample: agg.sumWouldBeCredits
        } : {}),
        ...(agg.cellsAmbiguous > 0 ? {
          cellsAmbiguous:           agg.cellsAmbiguous,
          ambiguousNote:            'These cells have status=ERROR with a price tag. Clay billing is ambiguous — included in totals but flagged.'
        } : {})
      })).sort((a, b) =>
        ((b.avgCreditsPerRow + b.avgAiCostUsdPerRow * 100) -
         (a.avgCreditsPerRow + a.avgAiCostUsdPerRow * 100))
      );

      // Subroutine columns aggregated separately so the user can see
      // "this column triggers a function that costs ~X credits per call".
      // 404-estimated calls have already had their cost folded into
      // r.viaSubroutines via the rollupCredits fallback path; we just
      // surface the count separately so the user knows how many calls
      // were estimated vs directly read.
      const subroutineAggregate = new Map();
      for (const r of rollups) {
        for (const s of r.subroutineDetail || []) {
          if (!subroutineAggregate.has(s.column)) {
            subroutineAggregate.set(s.column, {
              sumCredits: 0, sumAiCostUsd: 0,
              callsTriggered: 0, callsReached: 0,
              callsUnreachable: 0, callsEstimated: 0,
              callsDepthCapped: 0, callsErrored: 0
            });
          }
          const agg = subroutineAggregate.get(s.column);
          agg.sumCredits     += s.total || 0;
          agg.sumAiCostUsd   += s.totalAiCostUsd || 0;
          agg.callsTriggered += 1;
          if (s.status === 'ok')                  agg.callsReached     += 1;
          else if (s.status === '404-estimated')  agg.callsEstimated   += 1;
          else if (s.status === '404')            agg.callsUnreachable += 1;
          else if (s.status === 'depth')          agg.callsDepthCapped += 1;
          else if (s.status === 'cycle')          { /* ignored — already counted upstream */ }
          else                                    agg.callsErrored     += 1;
        }
      }
      const bySubroutineColumn = Array.from(subroutineAggregate.entries()).map(([col, agg]) => ({
        column:                     col,
        avgCreditsPerRow:           agg.sumCredits / n,
        avgAiCostUsdPerRow:         agg.sumAiCostUsd / n,
        totalCreditsAcrossSample:   agg.sumCredits,
        totalAiCostUsdAcrossSample: agg.sumAiCostUsd,
        callsTriggered:             agg.callsTriggered,
        callsReached:               agg.callsReached,
        callsEstimated:             agg.callsEstimated,
        callsUnreachable:           agg.callsUnreachable,
        callsDepthCapped:           agg.callsDepthCapped,
        callsErrored:               agg.callsErrored,
        triggerRatePct:             Math.round((agg.callsTriggered / n) * 1000) / 10
      })).sort((a, b) =>
        ((b.avgCreditsPerRow + b.avgAiCostUsdPerRow * 100) -
         (a.avgCreditsPerRow + a.avgAiCostUsdPerRow * 100))
      );

      const totalRowsInTable = schema.rowCount ?? null;
      const extrapolatedTotalCredits = (!full && totalRowsInTable != null && n > 0)
        ? avg * totalRowsInTable
        : null;
      const extrapolatedTotalAiCostUsd = (!full && totalRowsInTable != null && n > 0)
        ? avgAi * totalRowsInTable
        : null;

      // Variance hint — a small sample with a max well above the mean
      // means the per-row cost is bimodal (some rows fire the full
      // waterfall, others get gated out). Surface this so the user knows
      // whether the avg is a confident point estimate or a fuzzy mean
      // hiding two populations.
      const spreadFactor = avg > 0 ? max / avg : 0;
      const varianceHint = (n < 50 && spreadFactor >= 5)
        ? `High variance: max=${max.toFixed(1)} is ${spreadFactor.toFixed(1)}× the avg of ${avg.toFixed(1)}. Per-row cost is likely bimodal (fully-firing vs gated-out rows). Increase sampleSize for a tighter estimate, or inspect min/max rows individually.`
        : null;

      // Subroutine-coverage hint — the previous undercount issue. If many
      // calls were unreachable AND no fallback applied, the user should know
      // their reported total is below true cost.
      const unreachableNoFallback = bySubroutineColumn.reduce((s, c) => s + c.callsUnreachable, 0);
      const subroutineCoverageHint = unreachableNoFallback > 0
        ? `${unreachableNoFallback} subroutine call(s) pointed to function rows that could not be read AND the fallback estimator did not yield a usable mean. Reported via-subroutine cost is undercounted by an unknown amount.`
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
            avgViaSubroutines:          avgVia,
            avgAiCostUsd:               avgAi,
            avgDirectAiCostUsd:         avgDirectAi,
            avgViaSubroutinesAiCostUsd: avgViaAi,
            min:                        n > 0 ? min   : 0,
            max:                        n > 0 ? max   : 0,
            minAiCostUsd:               n > 0 ? minAi : 0,
            maxAiCostUsd:               n > 0 ? maxAi : 0
          },
          totalAcrossSample: {
            direct:                  sumDirect,
            viaSubroutines:          sumVia,
            total:                   sumTotal,
            directAiCostUsd:         sumDirectAi,
            viaSubroutinesAiCostUsd: sumViaAi,
            totalAiCostUsd:          sumTotalAi
          },
          extrapolatedTotalCredits,
          extrapolatedTotalAiCostUsd,
          byColumn,
          bySubroutineColumn,
          varianceHint:           varianceHint           || undefined,
          subroutineCoverageHint: subroutineCoverageHint || undefined,
          fetchErrors:            fetchErrors.length > 0 ? fetchErrors : undefined
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

return server;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transportMode = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();

if (transportMode === 'http') {
  // Remote HTTP mode for hosted deployments (Render, Fly, etc.).
  // Per-request server + transport per the SDK's stateless streamable-HTTP
  // pattern (see node_modules/.../examples/server/simpleStatelessStreamableHttp.js).
  // Module-level caches survive across requests since they live outside createServer().
  const { default: express } = await import('express');

  const bearer = process.env.MCP_BEARER_TOKEN;
  if (!bearer || bearer.length < 16) {
    console.error('FATAL: MCP_BEARER_TOKEN env var required (min 16 chars) when MCP_TRANSPORT=http');
    process.exit(1);
  }
  if (!process.env.CLAY_API_KEY) {
    console.error('FATAL: CLAY_API_KEY env var required when MCP_TRANSPORT=http');
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  const requireBearer = (req, res, next) => {
    const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided !== bearer) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };

  const handleMcp = async (req, res) => {
    const requestServer = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await requestServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        requestServer.close();
      });
    } catch (err) {
      console.error('MCP request error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
      transport.close();
      requestServer.close();
    }
  };

  app.post('/mcp', requireBearer, handleMcp);
  // GET and DELETE are not used in stateless mode; reject with 405.
  app.get('/mcp', requireBearer, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    });
  });
  app.delete('/mcp', requireBearer, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    });
  });

  const port = parseInt(process.env.PORT || '8080', 10);
  app.listen(port, () => {
    console.error(`slab-mcp listening on :${port} (http mode)`);
  });
} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
