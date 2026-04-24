#!/usr/bin/env node

/**
 * slab-mcp — MCP server for analyzing Clay tables.
 *
 * Tools:
 *   sync_table     — Fetch a Clay table's schema by URL
 *   sync_workbook  — Discover all tables in a workbook and fetch their schemas
 *   get_rows       — List rows with display values + statuses
 *   get_record     — Fetch one row's full enrichment JSON
 *   get_errors     — Status breakdown per column
 *   analyze_table  — Schema analysis (formulas, dependencies, run conditions)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { getTableSchema, listRows, getRecord, getWorkbookTables, exportTableToCsv, fetchCsv, getRowsPage } from './src/clay-api.js';
import { analyzeRowStatuses, formatRowsForDisplay, formatRecord, parseCsv, searchCsvRows } from './src/row-utils.js';
import { generateTableSummary, generateErrorSummary } from './src/summary-generator.js';

// ---------------------------------------------------------------------------
// In-memory schema cache (lives for the duration of the MCP server process)
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
 * Detect columns that invoke a Clay function (internally: "subroutine").
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
 * Fetch a table's schema and recursively fetch any subroutines it invokes.
 * Bounded by maxDepth and maxTotal to prevent runaway fetches.
 * Populates schemaCache for every table touched.
 * Returns { rootSchema, subroutines: Map<tableId, { schema, depth, invokedBy }> }.
 */
async function syncTableRecursive(tableId, viewId, {
  maxDepth = 3,
  maxTotal = 20
} = {}) {
  const visited = new Set();
  const subroutines = new Map(); // tableId -> { schema, depth, invokedBy }
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
      subroutines.set(id, { schema, depth, invokedBy });
    }

    if (depth >= maxDepth) return;

    for (const call of detectSubroutineCalls(schema)) {
      if (!visited.has(call.subroutineTableId)) {
        await visit(call.subroutineTableId, null, depth + 1, { tableId: id, tableName: schema.tableName, columnName: call.columnName });
      }
    }
  }

  await visit(tableId, viewId, 0, null);
  return { rootSchema, subroutines };
}

/**
 * Render a Markdown section listing subroutines invoked by a root table.
 * Safe to call with an empty Map — returns an empty string.
 */
function renderSubroutinesSection(rootSchema, subroutines) {
  if (!subroutines || subroutines.size === 0) return '';

  const rootCalls = detectSubroutineCalls(rootSchema);
  if (rootCalls.length === 0 && subroutines.size === 0) return '';

  const lines = [];
  lines.push('');
  lines.push('## Functions (subroutines) invoked by this table');
  lines.push('');
  lines.push('This table calls other Clay tables as functions via `execute-subroutine`. Their schemas have been auto-synced and cached — you can reference them directly, or call get_rows/find_record/get_errors on their tableIds.');
  lines.push('');

  // Direct calls from the root
  for (const call of rootCalls) {
    const entry = subroutines.get(call.subroutineTableId);
    const sub = entry?.schema;
    const name = sub?.tableName || '(not fetched — depth/total cap reached)';
    const fieldCount = sub?.fieldCount ?? '?';
    const rowCount = sub?.rowCount ?? '?';
    lines.push(`- **${call.columnName}** → \`${call.subroutineTableId}\` — **${name}** (${fieldCount} fields, ${rowCount} rows)`);

    // Nested subroutines this one calls
    if (sub) {
      const nested = detectSubroutineCalls(sub);
      for (const n of nested) {
        const nestedEntry = subroutines.get(n.subroutineTableId);
        const nestedName = nestedEntry?.schema?.tableName || '(not fetched — depth/total cap reached)';
        lines.push(`    - ${n.columnName} → \`${n.subroutineTableId}\` — ${nestedName}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Fetch + parse the CSV for a table, or return the session-cached copy.
 * Cache is per-process only; it vanishes when the MCP server stops.
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
    rowIdsByIndex: new Map(), // CSV index -> rowId (populated lazily)
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

/**
 * Classify an identifier value so we can prioritize which columns to search.
 */
function classifyIdentifier(value) {
  const v = String(value).trim().toLowerCase();
  if (v.includes('@')) return 'email';
  if (/^https?:\/\//.test(v)) return 'url';
  if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(v)) return 'domain';
  return 'text';
}

/**
 * Rank CSV columns by affinity with the identifier value, based on column-name patterns.
 * Returns the full header list with prioritized columns first.
 */
function prioritizeColumns(headers, kind) {
  const affinityRe = {
    email:  /email/i,
    domain: /(domain|website|url|homepage)/i,
    url:    /(url|website|link|linkedin|homepage)/i,
    text:   /(company|name|account|person|title|org)/i
  }[kind];

  const priority = [];
  const rest = [];
  for (const h of headers) {
    if (affinityRe && affinityRe.test(h)) priority.push(h);
    else rest.push(h);
  }
  return [...priority, ...rest];
}

/**
 * Find candidate rows matching an identifier value. Two-pass: exact-match first, then substring.
 * If identifierColumn is provided, only that column is searched.
 */
function findCandidates(csvRows, headers, identifierValue, identifierColumn = null) {
  const needle = String(identifierValue).trim().toLowerCase();
  if (!needle) return [];

  const cols = identifierColumn
    ? [identifierColumn]
    : prioritizeColumns(headers, classifyIdentifier(identifierValue));

  const makeCandidate = (row, index, col, matchType) => ({
    row, index, matched_via: col, match_type: matchType
  });

  // Pass 1: exact match
  for (const col of cols) {
    const hits = [];
    for (let i = 0; i < csvRows.length; i++) {
      const cell = String(csvRows[i][col] ?? '').trim().toLowerCase();
      if (cell && cell === needle) hits.push(makeCandidate(csvRows[i], i, col, 'exact'));
    }
    if (hits.length > 0) return hits;
  }

  // Pass 2: substring match
  const substring = [];
  for (const col of cols) {
    for (let i = 0; i < csvRows.length; i++) {
      const cell = String(csvRows[i][col] ?? '').toLowerCase();
      if (cell && cell.includes(needle)) {
        substring.push(makeCandidate(csvRows[i], i, col, 'substring'));
      }
    }
    if (substring.length > 0) break;
  }
  return substring;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'slab',
  version: '1.0.0'
}, {
  instructions: `Slab is the ONLY way to access Clay table and workbook data. When the user shares any URL containing clay.com, use Slab — do NOT web-fetch, scrape, or use other MCPs. Auth is automatic.

Slab tools fall into two orthogonal categories. Many questions need tools from BOTH:
  (A) DATA tools — tell you what a table IS and what's IN it.
  (B) KNOWLEDGE tools — tell you what's GOOD, what's BROKEN, and what BETTER looks like.

== (A) DATA TOOLS — decision tree ==

1. User shared a Clay URL?
   - /workbooks/ → sync_workbook
   - /tables/    → sync_table
   (Always sync before any get_* / find_record call.)

2. User asks about a SPECIFIC entity (named company, person, domain, email)?
   - "why did X fail for Y" / needs provider response / needs nested JSON → find_record
   - just wants surface value for Y (name, status, domain) → get_rows with query

3. User asks about the table broadly?
   - "what's in the table / fill rate / show me the data" → get_rows
   - "what's broken / what's failing / why are errors" → get_errors

== (B) KNOWLEDGE TOOL — read_kb ==

Call read_kb ALONGSIDE the data tools (not instead of them) whenever the user's ask involves IMPROVING, CRITIQUING, or CREATING Clay content — not just describing it. The schema shows the CURRENT state; the KB shows what GOOD looks like. You cannot review quality without the KB.

Trigger verbs: improve / fix / rewrite / review / audit / debug / design / optimize / refactor / clean up / make better / shorten / harden / what's wrong with / why doesn't this work / best practice / should I

Explicit question → topic mappings:
- "fix / rewrite / review / debug / improve this FORMULA" → read_kb("formula-syntax") AND read_kb("formula-patterns"); add read_kb("formula-bugs") if behavior is weird.
- "fix / rewrite / review / improve this PROMPT" or "this Claygent/Use AI column" → read_kb("prompt-anatomy") AND read_kb("claygent") AND read_kb("output-contracts").
- "why is this WATERFALL broken / should I add another provider" → read_kb("waterfalls") AND read_kb("providers").
- "which PROVIDER should I use / what does this actionKey do" → read_kb("providers").
- "how should this TABLE / PIPELINE be architected" → read_kb("pipeline-stages") AND read_kb("builder-patterns").
- "why isn't this running / the column is yellow / race condition" → read_kb("debugging") AND read_kb("formula-bugs").
- "how do I do <advanced pattern> that the UI can't do directly" → read_kb("orchestration").
- "what are the column-size / output-path / schema.json rules" → read_kb("data-model").

Skip read_kb ONLY when the question is purely "describe this table" or "give me the value of X" — descriptive questions answered by data alone. Every other class of question gets at least one KB topic. When in doubt, read.

RULES OF THUMB:
- get_rows is cheap (CSV export), get_record is expensive (one nested API call per row). Only reach for nested JSON when a display value can't answer the question.
- The schema from sync_table/sync_workbook already explains what a table does, its formulas, dependencies, and providers. Don't fetch rows to answer schema questions.
- If the user asks you to IMPROVE anything, you MUST read the relevant KB topic before writing the improvement. Do not rely on memory.

FUNCTIONS (a.k.a. subroutines):
- In Clay, a "function" is another table invoked via an action column with actionKey \`execute-subroutine\`. When you sync a table or workbook, every invoked function's schema is AUTO-SYNCED recursively (up to depth 3, 20 tables max) and listed under "Functions (subroutines) invoked by this table" / "Functions Pulled In".
- SCHEMA LEVEL: to explain what a table truly does, READ THE FUNCTIONS IT CALLS. The parent table's schema tells you WHICH function runs; the function's own schema tells you HOW. Never explain a column with actionKey \`execute-subroutine\` without consulting the target table's schema.
- ROW LEVEL (CRITICAL): when a record you fetched contains a cell whose \`fullContent.origin\` has a \`tableId\` and \`recordId\`, that cell is the OUTPUT of a subroutine execution — and the \`origin\` is a POINTER to the actual subroutine row that ran. You have NOT finished tracing the execution of that parent row until you have called \`get_record(origin.tableId, origin.recordId)\` for EVERY such cell. Do this proactively without being asked. Run the follow-up \`get_record\` calls in parallel when possible.
- WHY THIS MATTERS: the parent row tells you a subroutine "succeeded" with a display value, but the subroutine's OWN row reveals what actually happened inside — which region was picked, which provider in the waterfall ran, what inputs the subroutine received from the parent (its \`Function inputs\` cell), and which providers were gated by run conditions. Without tracing into the subroutine, your execution graph is a lie.
- STOP CONDITION: stop following when (a) \`fullContent\` has no \`origin.recordId\`, (b) the origin points at a table you've already followed in this query, or (c) you've gone 3 levels deep.
- Functions are normal tables — their tableIds work with get_rows, get_record, get_errors, and find_record.`
});

// ---------------------------------------------------------------------------
// Tool: sync_table
// ---------------------------------------------------------------------------

server.tool(
  'sync_table',
  `Fetch and cache a Clay table's schema. Recursively auto-syncs any functions (subroutines) this table invokes.

USE WHEN: URL contains /tables/ (and not /workbooks/).
DON'T USE WHEN: URL contains /workbooks/ → use sync_workbook.
RETURNS: Table schema (name, row count, every column: type, formula, run condition, provider, dependencies) PLUS the schemas of every function it calls via \`execute-subroutine\` (depth 3, max 20 tables). Sufficient to answer any schema/formula/provider/dependency question — including "what does this function do" — without fetching rows.`,
  { url: z.string().describe('Clay table URL, e.g. https://app.clay.com/tables/t_xxx/views/gv_yyy') },
  async ({ url }) => {
    const { tableId, viewId } = parseClayUrl(url);
    if (!tableId) {
      return { content: [{ type: 'text', text: 'Error: URL must contain a table ID (t_...)' }] };
    }

    try {
      rowsCache.delete(tableId); // force-stale rows if schema is being re-synced
      const { rootSchema, subroutines } = await syncTableRecursive(tableId, viewId);

      const summary = generateTableSummary(rootSchema);
      const subroutineSection = renderSubroutinesSection(rootSchema, subroutines);

      return {
        content: [{ type: 'text', text: summary + subroutineSection }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error syncing table: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: sync_workbook
// ---------------------------------------------------------------------------

server.tool(
  'sync_workbook',
  `Discover all tables in a Clay workbook and cache their schemas.

USE WHEN: URL contains /workbooks/ (even if it also contains /tables/).
DON'T USE WHEN: URL is a single-table URL with no workbook segment → use sync_table.
RETURNS: Every table (name, row count, column types, providers) plus cross-table connections (route-row, lookups). After this, all tableIds are cached and usable by get_rows / get_record / get_errors / find_record.`,
  { url: z.string().describe('Clay workbook URL, e.g. https://app.clay.com/workspaces/4515/workbooks/wb_xxx/all-tables') },
  async ({ url }) => {
    const { workbookId } = parseClayUrl(url);
    if (!workbookId) {
      return { content: [{ type: 'text', text: 'Error: URL must contain a workbook ID (wb_...)' }] };
    }

    try {
      const tables = await getWorkbookTables(workbookId);

      const lines = [];
      lines.push(`# Workbook: ${workbookId}`);
      lines.push(`\nFound **${tables.length}** table(s).\n`);

      // Fetch schema for each table
      const schemas = [];
      for (const t of tables) {
        const tableId = t.id || t.tableId;
        const tableName = t.name || t.tableName || tableId;
        try {
          const schema = await getTableSchema(tableId, null);
          schemaCache.set(tableId, schema);
          schemas.push(schema);

          const sources  = schema.fields.filter(f => f.type === 'source');
          const inputs   = schema.fields.filter(f => f.type === 'text' || f.type === 'basic');
          const formulas = schema.fields.filter(f => f.type === 'formula');
          const actions  = schema.fields.filter(f => f.type === 'action');

          lines.push(`---`);
          lines.push(`## ${schema.tableName}`);
          lines.push(`- **Table ID:** \`${tableId}\``);
          lines.push(`- **Rows:** ${schema.rowCount ?? 'Unknown'}`);
          lines.push(`- **Fields:** ${schema.fieldCount}`);

          const typeParts = [];
          if (sources.length)  typeParts.push(`${sources.length} sources`);
          if (inputs.length)   typeParts.push(`${inputs.length} inputs`);
          if (formulas.length) typeParts.push(`${formulas.length} formulas`);
          if (actions.length)  typeParts.push(`${actions.length} actions`);
          if (typeParts.length) lines.push(`- **Column types:** ${typeParts.join(', ')}`);

          lines.push(`- **Columns:** ${schema.fields.map(f => f.name).join(', ')}`);

          // Show enrichment providers
          const providers = actions.map(a => {
            const key = a.typeSettings?.actionKey || 'unknown';
            return `${a.name} (\`${key}\`)`;
          });
          if (providers.length) lines.push(`- **Enrichments:** ${providers.join(', ')}`);

          // Show route-row connections to other tables
          const routes = actions.filter(a => a.typeSettings?.actionKey === 'route-row');
          for (const r of routes) {
            const targetId = r.typeSettings?.inputsBinding?.find(i => i.name === 'tableId')?.formulaText?.replace(/"/g, '');
            if (targetId) {
              lines.push(`- **Routes data to:** \`${targetId}\``);
            }
          }

          // Show execute-subroutine (Clay function) calls
          const subCalls = detectSubroutineCalls(schema);
          for (const call of subCalls) {
            lines.push(`- **Calls function:** \`${call.subroutineTableId}\` (via \`${call.columnName}\`)`);
          }

          lines.push('');
        } catch (err) {
          lines.push(`---`);
          lines.push(`## ${tableName}`);
          lines.push(`- **Table ID:** \`${tableId}\``);
          lines.push(`- **Error:** ${err.message}`);
          lines.push('');
        }
      }

      // Cross-table connections summary
      const connections = [];
      for (const schema of schemas) {
        for (const field of schema.fields) {
          if (field.typeSettings?.actionKey === 'route-row') {
            const targetId = field.typeSettings?.inputsBinding?.find(i => i.name === 'tableId')?.formulaText?.replace(/"/g, '');
            if (targetId) {
              const targetSchema = schemas.find(s => s.tableId === targetId);
              connections.push({
                from: schema.tableName,
                to: targetSchema?.tableName || targetId,
                via: field.name
              });
            }
          }
          if (field.type === 'lookup' || field.typeSettings?.sourceTableId) {
            const srcTableId = field.typeSettings?.sourceTableId;
            if (srcTableId) {
              const srcSchema = schemas.find(s => s.tableId === srcTableId);
              connections.push({
                from: schema.tableName,
                to: srcSchema?.tableName || srcTableId,
                via: `${field.name} (lookup)`
              });
            }
          }
        }
      }

      if (connections.length > 0) {
        lines.push('---');
        lines.push('## Cross-Table Connections');
        lines.push('');
        for (const c of connections) {
          lines.push(`- **${c.from}** → **${c.to}** via \`${c.via}\``);
        }
      }

      // Pull in any subroutines invoked by workbook tables that live OUTSIDE the workbook.
      // Tables inside the workbook are already cached; we only need to fetch unknown ones.
      const workbookTableIds = new Set(schemas.map(s => s.tableId));
      const externalSubroutines = new Map(); // tableId -> { schema, invokedBy: [{tableName, columnName}] }
      const externalFetchQueue = [];
      for (const schema of schemas) {
        for (const call of detectSubroutineCalls(schema)) {
          if (!workbookTableIds.has(call.subroutineTableId)) {
            externalFetchQueue.push({
              subId: call.subroutineTableId,
              invokedBy: { tableName: schema.tableName, columnName: call.columnName }
            });
          }
        }
      }

      const MAX_EXTERNAL = 20;
      for (const { subId, invokedBy } of externalFetchQueue) {
        if (externalSubroutines.size >= MAX_EXTERNAL) break;
        if (externalSubroutines.has(subId)) {
          externalSubroutines.get(subId).invokedBy.push(invokedBy);
          continue;
        }
        try {
          const { rootSchema: subSchema, subroutines: nested } = await syncTableRecursive(subId, null, { maxDepth: 2, maxTotal: 10 });
          externalSubroutines.set(subId, { schema: subSchema, invokedBy: [invokedBy] });
          for (const [nestedId, nestedEntry] of nested) {
            if (!workbookTableIds.has(nestedId) && !externalSubroutines.has(nestedId)) {
              externalSubroutines.set(nestedId, { schema: nestedEntry.schema, invokedBy: [{ tableName: nestedEntry.invokedBy?.tableName, columnName: nestedEntry.invokedBy?.columnName }] });
            }
          }
        } catch (err) {
          externalSubroutines.set(subId, { schema: null, invokedBy: [invokedBy], error: err.message });
        }
      }

      if (externalSubroutines.size > 0) {
        lines.push('---');
        lines.push('## Functions Pulled In (outside this workbook)');
        lines.push('');
        lines.push('These tables are invoked as functions (`execute-subroutine`) by tables in this workbook but live elsewhere. Their schemas have been synced and cached.');
        lines.push('');
        for (const [subId, entry] of externalSubroutines) {
          const name = entry.schema?.tableName || '(fetch failed)';
          const fieldCount = entry.schema?.fieldCount ?? '?';
          const invokers = entry.invokedBy.map(i => `${i.tableName} → ${i.columnName}`).join('; ');
          const errNote = entry.error ? ` — error: ${entry.error}` : '';
          lines.push(`- **${name}** \`${subId}\` (${fieldCount} fields) — invoked by ${invokers}${errNote}`);
        }
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error syncing workbook: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_rows
// ---------------------------------------------------------------------------

server.tool(
  'get_rows',
  `Fetch SURFACE row data (display values as shown in the table UI). Fast — uses Clay's async CSV export.

USE WHEN: Showing data, checking fill rates, linking across tables, or finding a row's _rowId to pass to get_record.
DON'T USE WHEN:
  - Need nested JSON / provider raw response for a specific entity → use find_record (combines this + get_record).
  - Need cell statuses (SUCCESS/ERROR/HAS_NOT_RUN) → use get_errors.
RETURNS: Display values only, plus _rowId on searched matches. No statuses, no nested JSON.
TIP: When searching, set limit=1 if you just need the rowId.`,
  {
    tableId: z.string().describe('Table ID (t_...) from a previous sync_table call'),
    limit: z.number().optional().default(20).describe('Max rows to return. Default 20. Use 1 when searching for a specific entity.'),
    query: z.string().optional().describe('Text to search for across all column values (case-insensitive). Stops after finding limit matches.')
  },
  async ({ tableId, limit, query }) => {
    try {
      const schema = getSchema(tableId);
      const { csvRows, totalRows } = await getOrFetchRows(tableId);

      if (csvRows.length === 0) {
        return { content: [{ type: 'text', text: 'No rows found in this table.' }] };
      }

      let resultRows;
      let header;

      if (query) {
        const matches = searchCsvRows(csvRows, query, limit);
        if (matches.length === 0) {
          return { content: [{ type: 'text', text: `No rows found matching "${query}".` }] };
        }

        const withIds = [];
        for (const match of matches) {
          try {
            const rowId = await resolveRowId(tableId, schema.viewId, match.index);
            withIds.push({ _rowId: rowId, _csvIndex: match.index, ...match.row });
          } catch {
            withIds.push({ _rowId: null, _csvIndex: match.index, ...match.row });
          }
        }

        resultRows = withIds;
        header = `Found ${matches.length} row(s) matching "${query}" (${totalRows} total rows in table):`;
      } else {
        resultRows = csvRows.slice(0, limit);
        header = `Showing ${resultRows.length} of ${totalRows} row(s):`;
      }

      return {
        content: [{ type: 'text', text: `${header}\n\n${JSON.stringify(resultRows, null, 2)}` }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching rows: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_record
// ---------------------------------------------------------------------------

server.tool(
  'get_record',
  `Fetch one row's FULL nested JSON (externalContent/fullValue + status for every cell). Low-level escape hatch.

USE WHEN:
  - You already have a _rowId and need the raw provider response / nested objects / error payloads.
  - You are FOLLOWING A SUBROUTINE POINTER from a prior record's \`fullContent.origin\` (tableId + recordId). This is mandatory when tracing execution through functions — don't stop at the parent row.
DON'T USE WHEN:
  - Starting from an identifier value (company name, domain, email) → use find_record instead; it handles lookup + fetch in one step.
  - Surface display value would answer the question → use get_rows (cheap).
COST: Expensive — one API call per row. Batch subroutine follow-ups by running them in parallel.`,
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
      return { content: [{ type: 'text', text: `Error fetching record: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: find_record
// ---------------------------------------------------------------------------

server.tool(
  'find_record',
  `Look up a row by identifier VALUE and return its full nested JSON. Combines sync + get_rows + get_record in one call.

USE WHEN: User names a specific entity (company, person, domain, email) and wants to know why something happened for it, or wants the raw provider response / nested fields.
DON'T USE WHEN:
  - User just wants a surface value (name, domain, status) → use get_rows (cheaper).
  - User asks broadly "what's failing across the table" → use get_errors.
BEHAVIOR:
  - Auto-detects identifier column by value shape (email / domain / url / text) unless identifier_column is provided.
  - Rows are cached for the session after the first call; pass force_refresh=true to re-fetch.
  - On EXACTLY ONE match: returns the full nested record JSON.
  - On MULTIPLE matches: returns the candidate list (no record fetch) — ask the user to disambiguate or pass identifier_column.
  - On ZERO matches: returns the matched_via columns that were searched.

FOLLOW-UP REQUIRED: the returned record may contain cells whose \`fullContent.origin\` has a \`tableId\` + \`recordId\` — those are subroutine-execution pointers. You MUST follow each one with \`get_record(origin.tableId, origin.recordId)\` before reporting the execution trace. The parent row alone is not the full story; the subroutine row reveals what actually happened inside. Run the follow-ups in parallel and recurse up to 3 levels deep.`,
  {
    url: z.string().describe('Clay table URL (must contain /tables/t_...)'),
    identifier_value: z.string().describe('The value to look up (e.g. "Acme Corp", "acme.com", "jane@acme.com")'),
    identifier_column: z.string().optional().describe('Exact column name to search. Omit to auto-detect from value shape.'),
    force_refresh: z.boolean().optional().default(false).describe('Re-fetch the CSV instead of using the session cache.')
  },
  async ({ url, identifier_value, identifier_column, force_refresh }) => {
    try {
      const { tableId, viewId } = parseClayUrl(url);
      if (!tableId) {
        return { content: [{ type: 'text', text: 'Error: URL must contain a table ID (t_...)' }], isError: true };
      }

      // Auto-sync schema if caller hasn't yet
      let schema = schemaCache.get(tableId);
      if (!schema) {
        schema = await getTableSchema(tableId, viewId);
        schemaCache.set(tableId, schema);
      }

      const { headers, csvRows, totalRows, syncedAt } = await getOrFetchRows(tableId, { forceRefresh: force_refresh });

      if (csvRows.length === 0) {
        return { content: [{ type: 'text', text: 'No rows in this table.' }] };
      }

      if (identifier_column && !headers.includes(identifier_column)) {
        return {
          content: [{ type: 'text', text: `Column "${identifier_column}" not found. Available columns: ${headers.join(', ')}` }],
          isError: true
        };
      }

      const candidates = findCandidates(csvRows, headers, identifier_value, identifier_column || null);
      const searchedCols = identifier_column
        ? [identifier_column]
        : prioritizeColumns(headers, classifyIdentifier(identifier_value)).slice(0, 6);

      if (candidates.length === 0) {
        return {
          content: [{ type: 'text', text:
            `No rows found matching "${identifier_value}".\n` +
            `Searched columns (in priority order): ${searchedCols.join(', ')}\n` +
            `Table has ${totalRows} rows. Synced at ${syncedAt}.\n` +
            `Try passing identifier_column explicitly, or use get_rows with a broader query.`
          }]
        };
      }

      if (candidates.length > 1) {
        const preview = candidates.slice(0, 10).map(c => ({
          _csvIndex: c.index,
          matched_via: c.matched_via,
          match_type: c.match_type,
          ...c.row
        }));
        return {
          content: [{ type: 'text', text:
            `Found ${candidates.length} candidate(s) matching "${identifier_value}" — disambiguate and call find_record again with identifier_column set, or call get_record with a _rowId from get_rows.\n\n` +
            JSON.stringify(preview, null, 2)
          }]
        };
      }

      // Exactly one match — resolve rowId and fetch full record
      const [match] = candidates;
      const rowId = await resolveRowId(tableId, schema.viewId, match.index);
      if (!rowId) {
        return {
          content: [{ type: 'text', text: `Matched row at CSV index ${match.index} (via "${match.matched_via}") but could not resolve its rowId.` }],
          isError: true
        };
      }

      const record = await getRecord(tableId, rowId);
      const formatted = formatRecord(record, schema);

      return {
        content: [{ type: 'text', text:
          `Matched 1 row via "${match.matched_via}" (${match.match_type}). Synced at ${syncedAt}.\n\n` +
          JSON.stringify(formatted, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error in find_record: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_errors
// ---------------------------------------------------------------------------

server.tool(
  'get_errors',
  `Column-level status breakdown: success / error / has-not-run / queued counts, top error message, fill rate, and likely-broken flags.

USE WHEN: User asks broadly "what's failing", "why isn't this working", or wants a table-wide health check.
DON'T USE WHEN:
  - User named a specific row/entity → go straight to find_record.
  - You just need display values → use get_rows (cheaper).
RETURNS: Per-column statuses + top error messages (status data NOT in CSV export; this hits the paginated API, so it's slower than get_rows).
TYPICAL FLOW: get_errors → read schema to understand WHY a column fails → find_record on a concrete erroring row for the raw provider error.`,
  {
    tableId: z.string().describe('Table ID (t_...) from a previous sync_table call')
  },
  async ({ tableId }) => {
    try {
      const schema = getSchema(tableId);

      const rows = await listRows(tableId, schema.viewId);
      const columnMap = buildColumnMap(schema);
      const statusData = analyzeRowStatuses(rows, columnMap);
      const summary = generateErrorSummary(statusData);

      return {
        content: [{ type: 'text', text: `Analyzed ${rows.length} rows across ${Object.keys(statusData).length} columns.\n\n${summary}` }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error analyzing errors: ${err.message}` }], isError: true };
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

server.tool(
  'read_kb',
  `Read a Clay platform reference doc (full markdown). Call this ALONGSIDE sync_table / get_rows / get_errors whenever the user asks you to improve, fix, rewrite, review, audit, debug, design, or optimize something in a Clay table. The schema shows CURRENT state; the KB shows what GOOD looks like — you need both.

TRIGGER VERBS: improve / fix / rewrite / review / audit / debug / design / optimize / refactor / "make better" / "what's wrong with" / "best practice" / "should I"

USE WHEN: Need Clay platform knowledge the table schema can't provide:
  - formula-syntax — fixing/writing formulas (8 syntax rules, banned JS, substitutes)
  - formula-patterns — Lodash/Moment, scoring, array manipulation
  - formula-bugs — confirmed Clay formula bugs (Object.assign, forward-reference cascades)
  - prompt-anatomy — 8-section skeleton for Clay AI prompts
  - output-contracts — JSON schemas, forbidden strings, null policies
  - claygent — Claygent vs Use AI, search strategy, failure modes
  - pipeline-stages — standard pipeline + multi-table patterns
  - orchestration — 15 advanced workarounds (fan-out, sparse gates, AI-generated SOQL)
  - builder-patterns — formula vs action columns, cell size, batching, tables as queues
  - waterfalls — waterfall structure, cumulative exclusion gates, email/phone/domain
  - providers — 40+ providers (action keys, credit costs, output paths, gotchas)
  - debugging — diagnostic formulas, yellow triangles, waterfall stalls, race conditions
  - data-model — column types, 8KB/200KB limits, schema.json, output access paths
DON'T USE WHEN: Schema alone answers the question. Most table-specific questions do NOT need read_kb.`,
  {
    topic: z.string().describe('Topic key from the list above (e.g. "formula-syntax", "waterfalls", "providers")')
  },
  async ({ topic }) => {
    const filePath = KB_TOPICS[topic];
    if (!filePath) {
      const available = Object.keys(KB_TOPICS).join(', ');
      return { content: [{ type: 'text', text: `Unknown topic "${topic}". Available: ${available}` }] };
    }

    const fullPath = path.join(WIKI_BASE, filePath);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return { content: [{ type: 'text', text: content }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error reading ${filePath}: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Knowledge Base Resources (also exposed as MCP resources for clients that support them)
// ---------------------------------------------------------------------------

// Knowledge base lives inside the repo so the MCP is self-contained —
// no external symlink or separate install required.
const WIKI_BASE = path.join(__dirname, 'kb');

const KB_RESOURCES = [
  {
    path: 'formulas/syntax.md',
    name: 'Formula Syntax Rules',
    description: 'Clay formula sandbox: 8 critical syntax rules, banned JS features with working substitutes, run condition patterns, anti-pattern quick reference'
  },
  {
    path: 'formulas/advanced-patterns.md',
    name: 'Advanced Formula Patterns',
    description: 'Lodash/Moment.js reference, scoring formulas, type coercion traps, array manipulation, URL parsing, complex real-world formula examples'
  },
  {
    path: 'formulas/corrections-log.md',
    name: 'Formula Corrections Log',
    description: 'Confirmed Clay formula bugs: Object.assign failure, Audiences JSON round-trip, forward-reference cascades, provider-specific output path gotchas'
  },
  {
    path: 'prompting/prompt-anatomy.md',
    name: 'Prompt Anatomy (8-Section Structure)',
    description: 'The 8-section skeleton for all Clay prompts: Input Definition, Input Data, Strategy, Edge Cases, DO NOT/ALWAYS, Examples, QA Checklist, Output Format'
  },
  {
    path: 'prompting/output-contracts.md',
    name: 'Output Contracts',
    description: 'JSON schema contracts for AI output: mandatory snake_case fields, forbidden strings list (N/A, Unknown), null vs empty string policies, confidence enums'
  },
  {
    path: 'claygent/prompts.md',
    name: 'Claygent & Use AI Prompts',
    description: 'Claygent (web research) vs Use AI (no internet) distinction, 12 mandatory sections for web research, 10 for content manipulation, search strategy framework'
  },
  {
    path: 'architecture/pipeline-stages.md',
    name: 'Table Architecture & Pipeline Stages',
    description: 'Standard pipeline stages (input → identity → enrichment → score → export), signal orchestration, webhook-triggered enrichment, multi-table patterns'
  },
  {
    path: 'architecture/orchestration-workarounds.md',
    name: 'Orchestration Workarounds',
    description: '15 advanced patterns: multiple Find People merge, sparse data gates, AI-generated SOQL, fan-out distribution, exclude_if_true master gate, screenshot+vision'
  },
  {
    path: 'core/builder-patterns.md',
    name: 'Builder Patterns',
    description: 'Core mental model: formula vs action columns, Filter List of Objects as container, cell size expansion, scheduled delays, batch processing, tables as queues'
  },
  {
    path: 'enrichment/waterfalls.md',
    name: 'Waterfall Enrichment Patterns',
    description: 'Waterfall structure, cumulative exclusion gates, error-aware gates, email/phone/domain/LinkedIn waterfall types, dependent waterfall workarounds'
  },
  {
    path: 'providers/reference.md',
    name: 'Enrichment Providers Reference',
    description: '40+ providers with action keys, credit costs, output field paths, and provider-specific notes (Cognism two-step, Dropcontact .data.email, Harmonic LinkedIn input)'
  },
  {
    path: 'debugging/playbook.md',
    name: 'Debugging Playbook',
    description: 'Step-by-step diagnostics: yellow triangle formulas, action column failures, waterfall not progressing, forward-reference bugs, race conditions, copy-paste diagnostic formulas'
  },
  {
    path: 'core/data-model.md',
    name: 'Clay Data Model',
    description: 'Column types (text/formula/action/source), 8KB vs 200KB limits, schema.json structure, column reference syntax, provider output field access paths'
  }
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
