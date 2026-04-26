/**
 * Pure data-processing utilities for row data.
 * No API calls — these work on in-memory row arrays.
 *
 * Design note: this module only does work the LLM cannot reasonably do
 * itself within a context budget — counting cell statuses across thousands
 * of rows, projecting cell payloads to a token-cheap shape. Anything
 * that's pure judgment (which column is "likely broken", whether a value
 * is an email vs domain, how to format markdown) lives in prompt context,
 * not here.
 */

/**
 * Status counts per column from raw API rows.
 * Returns counts only — no judgment flags. The LLM decides what
 * "likely broken" or "run-condition gated" means based on context.
 */
export function analyzeRowStatuses(rows, columnMap) {
  const columns = {};

  for (const row of rows) {
    for (const [fieldId, cell] of Object.entries(row.cells || {})) {
      if (!columns[fieldId]) {
        columns[fieldId] = {
          fieldId,
          name:      columnMap[fieldId] || fieldId,
          success:   0,
          error:     0,
          hasNotRun: 0,
          queued:    0,
          errors:    {}
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
    col.total   = col.success + col.error + col.hasNotRun + col.queued;
    col.fillPct = col.total > 0 ? Math.round((col.success / col.total) * 100) : 0;
  }

  return columns;
}

/**
 * Format a full record (from getRecord) with named columns and fullContent.
 * Includes per-cell credit usage from externalContent.upfrontCreditUsage /
 * additionalCreditUsage / hiddenValue.costDetails, and a _credits roll-up.
 *
 * This projection drops noise (full action-definition copy, retry history,
 * UI strings) that would inflate token cost ~10x without adding judgment
 * value. Kept on the script side because token economics, not prose.
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
