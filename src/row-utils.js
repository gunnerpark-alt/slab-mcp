/**
 * Pure data-processing utilities for row data.
 * No API calls — these work on in-memory row arrays.
 */

/**
 * Status breakdown per column from raw API rows.
 */
export function analyzeRowStatuses(rows, columnMap) {
  const columns = {};

  for (const row of rows) {
    for (const [fieldId, cell] of Object.entries(row.cells || {})) {
      if (!columns[fieldId]) {
        columns[fieldId] = {
          fieldId,
          name:       columnMap[fieldId] || fieldId,
          success:    0,
          error:      0,
          hasNotRun:  0,
          queued:     0,
          errors:     {}
        };
      }

      const col    = columns[fieldId];
      const status = cell.metadata?.status || (cell.value != null ? 'SUCCESS' : 'HAS_NOT_RUN');

      if      (status === 'SUCCESS')     col.success++;
      else if (status === 'ERROR') {
        col.error++;
        const msg = cell.metadata?.error?.message || cell.error?.message || 'unknown error';
        col.errors[msg] = (col.errors[msg] || 0) + 1;
      }
      else if (status === 'HAS_NOT_RUN') col.hasNotRun++;
      else if (status === 'QUEUED')      col.queued++;
    }
  }

  for (const col of Object.values(columns)) {
    const total   = col.success + col.error + col.hasNotRun + col.queued;
    col.total     = total;
    col.fillPct   = total > 0 ? Math.round((col.success / total) * 100) : 0;

    const errorMsgs = Object.entries(col.errors);
    col.topError    = errorMsgs.length > 0
      ? errorMsgs.sort((a, b) => b[1] - a[1])[0][0]
      : null;

    col.likelyBroken = col.error > 0 && col.success === 0 && col.hasNotRun === 0 && col.queued === 0;
    col.runConditionGated = col.topError === 'Run condition not met' && col.success === 0;
  }

  return columns;
}

/**
 * Build a name map from field ID to field name, and format rows for display.
 */
export function formatRowsForDisplay(rows, schema) {
  const columnMap = {};
  for (const f of schema.fields) {
    columnMap[f.id] = f.name;
  }

  return rows.map(row => {
    const formatted = { _rowId: row.id };
    for (const [fieldId, cell] of Object.entries(row.cells || {})) {
      if (fieldId === 'f_created_at' || fieldId === 'f_updated_at') continue;
      const name = columnMap[fieldId] || fieldId;
      formatted[name] = {
        value:  cell.value ?? null,
        status: cell.metadata?.status || null
      };
    }
    return formatted;
  });
}

/**
 * Parse CSV text into an array of row objects with named keys.
 * Handles quoted fields with commas and newlines.
 */
export function parseCsv(csvText) {
  const lines = csvText.split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };

  function parseLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current);
    return values;
  }

  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? '';
    });
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Search parsed CSV rows for a text match. Returns matching rows with their line index.
 */
export function searchCsvRows(rows, query, limit) {
  const searchLower = query.toLowerCase();
  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const match = Object.values(row).some(val =>
      val != null && String(val).toLowerCase().includes(searchLower)
    );
    if (match) {
      matches.push({ index: i, row });
      if (limit && matches.length >= limit) break;
    }
  }
  return matches;
}

/**
 * Format a full record (from getRecord) with named columns and fullContent.
 * Includes per-cell credit usage from externalContent.upfrontCreditUsage /
 * additionalCreditUsage / hiddenValue.costDetails, and a _credits roll-up.
 */
export function formatRecord(record, schema) {
  const columnMap = {};
  for (const f of schema.fields) {
    columnMap[f.id] = f.name;
  }

  let totalCredits = 0;
  let cellsWithCredits = 0;

  const formatted = { _rowId: record.id };
  for (const [fieldId, cell] of Object.entries(record.cells || {})) {
    if (fieldId === 'f_created_at' || fieldId === 'f_updated_at') continue;
    const name = columnMap[fieldId] || fieldId;

    const ext        = cell.externalContent || {};
    const upfront    = ext.upfrontCreditUsage?.totalCost ?? null;
    const additional = ext.additionalCreditUsage?.totalCost ?? null;
    const aiCost     = ext.hiddenValue?.costDetails?.totalCostToAIProvider ?? null;

    const out = {
      value:       cell.value ?? null,
      status:      cell.metadata?.status || null,
      fullContent: ext.fullValue ?? null
    };

    if (upfront != null || additional != null || aiCost != null) {
      const cellTotal = (upfront ?? 0) + (additional ?? 0);
      out.credits = {
        total:          cellTotal,
        upfront:        upfront,
        additional:     additional,
        aiProviderCost: aiCost
      };
      totalCredits     += cellTotal;
      cellsWithCredits += 1;
    }

    formatted[name] = out;
  }

  if (cellsWithCredits > 0) {
    formatted._credits = {
      total:           totalCredits,
      billedCellCount: cellsWithCredits
    };
  }

  return formatted;
}
