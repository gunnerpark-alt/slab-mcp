/**
 * Clay internal API client.
 * Calls https://api.clay.com/v3/ — the same API the Clay frontend uses.
 */

import { getInternalApiHeaders } from './auth.js';

const BASE = 'https://api.clay.com/v3';

async function clayRequest(endpoint) {
  const headers = getInternalApiHeaders();
  const res = await fetch(`${BASE}${endpoint}`, { headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`Clay API ${res.status} on ${endpoint}: ${body.message || res.statusText}`);
  }

  return res.json();
}

async function clayPost(endpoint, body = {}) {
  const headers = { ...getInternalApiHeaders(), 'Content-Type': 'application/json' };
  const res = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`Clay API ${res.status} on POST ${endpoint}: ${errBody.message || res.statusText}`);
  }

  return res.json();
}

/**
 * Fetch table schema: field definitions, formulas, run conditions, source details, views.
 */
export async function getTableSchema(tableId, viewId) {
  const tableData = await clayRequest(`/tables/${tableId}`);
  const table     = tableData.table || tableData;
  const fields    = table.fields || tableData.fields || [];
  const gridViews = table.gridViews || tableData.gridViews || table.views || tableData.views || [];

  const activeView     = gridViews.find(v => v.id === viewId);
  const viewFieldOrder = activeView?.fieldOrder || [];

  const orderedFieldIds = viewFieldOrder.length > 0
    ? viewFieldOrder
    : fields.map(f => f.id);

  const orderedFields = [];
  for (const fieldId of orderedFieldIds) {
    if (fieldId === 'f_created_at' || fieldId === 'f_updated_at') continue;
    const field = fields.find(f => f.id === fieldId);
    if (!field) continue;
    orderedFields.push({
      id:           field.id,
      name:         field.name,
      type:         field.type,
      typeSettings: field.typeSettings || null,
      pricing:      field.actionDefinition?.pricing || null
    });
  }

  // Enrich source columns with provider details
  const sourceColumns = orderedFields.filter(f => f.type === 'source');
  await Promise.all(sourceColumns.map(async field => {
    const sourceIds = field.typeSettings?.sourceIds || [];
    if (sourceIds.length === 0) return;
    try {
      field.sourceDetails = await Promise.all(
        sourceIds.map(sid => clayRequest(`/sources/${sid}`))
      );
    } catch {}
  }));

  const defaultViewId = table.defaultViewId || table.defaultGridViewId
    || tableData.defaultViewId || tableData.defaultGridViewId
    || gridViews[0]?.id || null;

  const allRowsView = gridViews.find(v =>
    v.name && v.name.toLowerCase().replace(/[\s_\-]/g, '') === 'allrows'
  );
  const bestViewId = allRowsView?.id || viewId || defaultViewId;

  return {
    capturedAt:  new Date().toISOString(),
    tableId,
    viewId:      bestViewId,
    tableName:   table.name || tableData.name || tableId,
    rowCount:    table.rowCount || table.recordCount || tableData.rowCount || tableData.recordCount || null,
    fieldCount:  orderedFields.length,
    views:       gridViews.map(v => ({ id: v.id, name: v.name })),
    fields:      orderedFields,
    fieldOrder:  orderedFieldIds.filter(id => id !== 'f_created_at' && id !== 'f_updated_at')
  };
}

/**
 * Get the default view ID for a table.
 */
export async function getDefaultViewId(tableId) {
  const tableData = await clayRequest(`/tables/${tableId}`);
  const table     = tableData.table || tableData;
  const views     = table.gridViews || table.views || tableData.gridViews || tableData.views || [];
  return table.defaultViewId || table.defaultGridViewId
    || tableData.defaultViewId || tableData.defaultGridViewId
    || views[0]?.id || null;
}

/**
 * Server-side cap on a single /records fetch. Clay's records endpoint
 * silently ignores every pagination parameter we tried (offset, cursor,
 * after, page, etc.) and returns at most this many rows per call. Tables
 * larger than the cap cannot be exhaustively read through this client.
 */
export const RECORDS_API_CAP = 20000;

/**
 * Fetch rows for a view in one shot — display values, statuses, rowIds.
 * Caps at RECORDS_API_CAP because no pagination scheme works on this
 * endpoint. Caller is responsible for knowing whether the table fits.
 */
export async function getAllRecords(tableId, viewId, { limit = RECORDS_API_CAP } = {}) {
  if (!viewId) viewId = await getDefaultViewId(tableId);
  if (!viewId) throw new Error('No view ID — pass one in the URL or ensure the table has a default view');
  const cap = Math.min(limit, RECORDS_API_CAP);
  const data = await clayRequest(`/tables/${tableId}/views/${viewId}/records?limit=${cap}`);
  return data.results || [];
}

/**
 * List rows with display values + statuses.
 * No fullContent — use getRecord() for that.
 *
 * Options:
 *   limit     — max rows to return (default: RECORDS_API_CAP)
 *   query     — text filter (case-insensitive match on display values)
 */
export async function listRows(tableId, viewId, { limit, query } = {}) {
  const fetchLimit = limit ? Math.min(limit, RECORDS_API_CAP) : RECORDS_API_CAP;
  const rows = await getAllRecords(tableId, viewId, { limit: fetchLimit });

  if (!query) return rows;

  const needle = query.toLowerCase();
  const filtered = [];
  for (const row of rows) {
    const cells = row.cells || {};
    const match = Object.values(cells).some(cell => {
      const val = cell.value;
      return val != null && String(val).toLowerCase().includes(needle);
    });
    if (match) {
      filtered.push(row);
      if (limit && filtered.length >= limit) break;
    }
  }
  return filtered;
}

/**
 * Fetch a single record with full enrichment JSON (externalContent).
 */
export async function getRecord(tableId, recordId) {
  return clayRequest(`/tables/${tableId}/records/${recordId}`);
}

/**
 * Server-side substring search across every cell in a view.
 * Mirrors the Clay UI search box: case-insensitive .includes() on display
 * values. Returns one entry per matching cell — { fieldId, recordId } —
 * so the same recordId can repeat across columns. Server caps the
 * response at 1000 cells; an identifier-column lookup almost never hits
 * that, but a broad term against a wide table can.
 */
export async function searchRecords(tableId, viewId, searchTerm) {
  if (!viewId) viewId = await getDefaultViewId(tableId);
  if (!viewId) throw new Error('No view ID — pass one in the URL or ensure the table has a default view');
  const data = await clayPost(`/tables/${tableId}/views/${viewId}/search`, { searchTerm });
  return data.results || [];
}

/**
 * Export a view to CSV via an async job.
 * Returns { downloadUrl, totalRows }.
 * One round-trip regardless of table size — faster than paginated listRows for full-table reads.
 * CSV contains display values only — no cell statuses, credit data, or nested JSON.
 */
export async function exportTableToCsv(tableId, viewId) {
  if (!viewId) viewId = await getDefaultViewId(tableId);
  if (!viewId) throw new Error('No view ID — pass one in the URL or ensure the table has a default view');

  const job = await clayPost(`/tables/${tableId}/views/${viewId}/export`);
  const jobId = job.id;
  if (!jobId) throw new Error('Export job creation failed — no ID in response');

  const pollIntervalMs = 1200;
  const maxWaitMs = 5 * 60 * 1000;
  const startedAt = Date.now();

  while (true) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const status = await clayRequest(`/exports/${jobId}`);

    if (status.status === 'FINISHED') {
      return { downloadUrl: status.downloadUrl, totalRows: status.recordsExportedCount ?? null };
    }
    if (status.status === 'FAILED' || status.status === 'CANCELLED') {
      throw new Error(`Export job ${jobId} ended with status: ${status.status}`);
    }
    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error(`Export job ${jobId} timed out after ${maxWaitMs / 1000}s`);
    }
  }
}

/**
 * Download CSV text from a signed S3 URL returned by exportTableToCsv.
 */
export async function fetchCsv(downloadUrl) {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Failed to download CSV: ${res.status}`);
  return res.text();
}

/**
 * List all tables in a workbook.
 */
export async function getWorkbookTables(workbookId) {
  try {
    const result = await clayRequest(`/workbooks/${workbookId}`);
    const tables = result.tables || result.workbook?.tables || result.data?.tables;
    if (Array.isArray(tables) && tables.length > 0) return tables;
  } catch {}

  const result = await clayRequest(`/workbooks/${workbookId}/tables`);
  const tables = result.tables || result.data || (Array.isArray(result) ? result : null);
  if (Array.isArray(tables) && tables.length > 0) return tables;

  throw new Error(`Could not discover tables for workbook ${workbookId}`);
}
