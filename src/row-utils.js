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
 * Coerce Clay's AI-provider cost into a number of USD.
 * Clay returns this as a dollar-prefixed string ("$0.28572") on most rows
 * but occasionally as a bare number — handle both.
 */
export function parseDollarCost(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    const cleaned = val.replace(/[$,\s]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Format a full record (from getRecord) with named columns and fullContent.
 * Includes per-cell credit usage from externalContent.upfrontCreditUsage /
 * additionalCreditUsage / hiddenValue.costDetails, and a _credits roll-up.
 *
 * Billing rules applied here:
 *   - SUCCESS_NO_DATA → Clay does NOT bill credits even though the cell
 *     payload still carries the action's price tag in upfrontCreditUsage.
 *     We zero out 'upfront' and 'additional' for billing math but preserve
 *     the original sum as 'wouldBeCredits' (with noData: true) so callers
 *     can still see what the column would have cost if data had returned.
 *   - aiProviderCost is NOT covered by the no-data rule — LLM tokens were
 *     spent regardless of whether the action returned data, so the AI $
 *     cost is reported as-is. The numeric form is exposed as
 *     aiProviderCostUsd; the raw Clay-formatted string lives on
 *     aiProviderCost.
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

  let totalCredits     = 0;
  let totalAiCostUsd   = 0;
  let totalWouldBe     = 0;
  let cellsBilled      = 0; // cells where billed total > 0 OR aiCost > 0
  let cellsRan         = 0; // cells with any credit metadata attached

  const formatted = { _rowId: record.id };
  for (const [fieldId, cell] of Object.entries(record.cells || {})) {
    if (fieldId === 'f_created_at' || fieldId === 'f_updated_at') continue;
    const name = columnMap[fieldId] || fieldId;

    const ext        = cell.externalContent || {};
    const upfront    = ext.upfrontCreditUsage?.totalCost ?? null;
    const additional = ext.additionalCreditUsage?.totalCost ?? null;
    const aiCost     = ext.hiddenValue?.costDetails?.totalCostToAIProvider ?? null;
    const status     = cell.metadata?.status || null;

    const out = {
      value:       cell.value ?? null,
      status,
      fullContent: ext.fullValue ?? null
    };

    if (upfront != null || additional != null || aiCost != null) {
      const noData            = status === 'SUCCESS_NO_DATA';
      const wouldBeUpfront    = upfront ?? 0;
      const wouldBeAdditional = additional ?? 0;
      const billedUpfront     = noData ? 0 : (upfront ?? 0);
      const billedAdditional  = noData ? 0 : (additional ?? 0);
      const cellTotal         = billedUpfront + billedAdditional;
      const cellAiCostUsd     = parseDollarCost(aiCost);

      out.credits = {
        total:             cellTotal,
        upfront:           noData ? 0 : upfront,
        additional:        noData ? 0 : additional,
        aiProviderCost:    aiCost,
        aiProviderCostUsd: cellAiCostUsd
      };
      if (noData) {
        out.credits.wouldBeCredits = wouldBeUpfront + wouldBeAdditional;
        out.credits.noData         = true;
        totalWouldBe += wouldBeUpfront + wouldBeAdditional;
      }

      totalCredits   += cellTotal;
      totalAiCostUsd += cellAiCostUsd;
      cellsRan       += 1;
      if (cellTotal > 0 || cellAiCostUsd > 0) cellsBilled += 1;
    }

    formatted[name] = out;
  }

  if (cellsRan > 0) {
    formatted._credits = {
      total:             totalCredits,
      aiProviderCostUsd: totalAiCostUsd,
      billedCellCount:   cellsBilled,
      ranCellCount:      cellsRan,
      ...(totalWouldBe > 0 ? { wouldBeCreditsFromNoData: totalWouldBe } : {})
    };
  }

  return formatted;
}
