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
 * Cell statuses where Clay attached an upfrontCreditUsage price tag but
 * does NOT actually bill the credits. The cell payload still carries the
 * action's nominal cost; we zero it out for billing math and preserve the
 * original sum as `wouldBeCredits` (with `notBilledReason` describing why).
 *
 * Confirmed not-billed:
 *   SUCCESS_NO_DATA              — provider returned empty result
 *   ERROR_RUN_CONDITION_NOT_MET  — gate didn't pass, column never executed
 *   ERROR_BAD_REQUEST            — request rejected before the provider
 *                                  was called (no upstream charge possible)
 */
const NOT_BILLED_STATUSES = new Set([
  'SUCCESS_NO_DATA',
  'ERROR_RUN_CONDITION_NOT_MET',
  'ERROR_BAD_REQUEST'
]);

/**
 * Cell statuses indicating the cell actually fired against a provider —
 * either the call succeeded, returned no data, errored at the provider
 * level, or was rejected as a bad request after attempting. These are
 * the cells that count as "this column ran on this row" for trigger-rate
 * accounting.
 *
 * Excludes ERROR_RUN_CONDITION_NOT_MET, HAS_NOT_RUN, QUEUED — those cells
 * were prepared (price tag attached) but did not execute. Counting them
 * as "ran" is what produced the original 100%-trigger artifact for
 * gated waterfall columns like Enrich Person.
 */
const EXECUTED_STATUSES = new Set([
  'SUCCESS',
  'SUCCESS_NO_DATA',
  'ERROR',
  'ERROR_BAD_REQUEST'
]);

const NOT_BILLED_REASON = {
  SUCCESS_NO_DATA:             'no-data',
  ERROR_RUN_CONDITION_NOT_MET: 'gated',
  ERROR_BAD_REQUEST:           'bad-request'
};

/**
 * Format a full record (from getRecord) with named columns and fullContent.
 * Includes per-cell credit usage from externalContent.upfrontCreditUsage /
 * additionalCreditUsage / hiddenValue.costDetails, and a _credits roll-up.
 *
 * Billing rules applied here:
 *   - Statuses in NOT_BILLED_STATUSES (no-data, gated, bad-request) carry
 *     a price tag but Clay does not bill them. We zero `upfront` and
 *     `additional` for billing math but preserve the original sum as
 *     `wouldBeCredits` with `notBilledReason` describing why. This is the
 *     fix for the "100% trigger rate on Enrich Person" bug — gated cells
 *     no longer get counted as billed or as having "ran".
 *   - aiProviderCost is NOT covered by the not-billed rule — LLM tokens
 *     were spent regardless of whether the action returned data, so the
 *     AI $ cost is reported as-is. The numeric form is exposed as
 *     aiProviderCostUsd; the raw Clay-formatted string lives on
 *     aiProviderCost.
 *   - Bare ERROR cells are billed as-is (Clay may have charged if the
 *     provider responded), but the cell is flagged with
 *     `billingAmbiguous: true` so callers can decide whether to re-bucket
 *     them.
 *
 * Each cell's credits object also carries `executed: bool` so the
 * aggregate roll-up in get_credits can compute trigger rate accurately
 * (cells where the column actually ran, not just cells that have a price
 * tag attached).
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
  let cellsExecuted    = 0; // cells where status indicates the column ran
  let cellsWithPriceTag = 0; // cells with credit metadata attached, billed or not

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
      const notBilled         = NOT_BILLED_STATUSES.has(status);
      const didExecute        = EXECUTED_STATUSES.has(status);
      const wouldBeUpfront    = upfront ?? 0;
      const wouldBeAdditional = additional ?? 0;
      const billedUpfront     = notBilled ? 0 : (upfront ?? 0);
      const billedAdditional  = notBilled ? 0 : (additional ?? 0);
      const cellTotal         = billedUpfront + billedAdditional;
      const cellAiCostUsd     = parseDollarCost(aiCost);

      out.credits = {
        total:             cellTotal,
        upfront:           notBilled ? 0 : upfront,
        additional:        notBilled ? 0 : additional,
        aiProviderCost:    aiCost,
        aiProviderCostUsd: cellAiCostUsd,
        executed:          didExecute
      };
      if (notBilled) {
        out.credits.wouldBeCredits   = wouldBeUpfront + wouldBeAdditional;
        out.credits.notBilledReason  = NOT_BILLED_REASON[status] || 'unknown';
        totalWouldBe += wouldBeUpfront + wouldBeAdditional;
      } else if (status === 'ERROR') {
        // Provider responded but with an error — Clay's billing behavior
        // here is ambiguous (sometimes charged, sometimes not depending on
        // where the failure occurred). Surface so the caller can decide.
        out.credits.billingAmbiguous = true;
      }

      totalCredits     += cellTotal;
      totalAiCostUsd   += cellAiCostUsd;
      cellsWithPriceTag += 1;
      if (didExecute) cellsExecuted += 1;
      if (cellTotal > 0 || cellAiCostUsd > 0) cellsBilled += 1;
    }

    formatted[name] = out;
  }

  if (cellsWithPriceTag > 0) {
    formatted._credits = {
      total:             totalCredits,
      aiProviderCostUsd: totalAiCostUsd,
      billedCellCount:   cellsBilled,
      ranCellCount:      cellsExecuted,
      pricedCellCount:   cellsWithPriceTag,
      ...(totalWouldBe > 0 ? { wouldBeCreditsNotBilled: totalWouldBe } : {})
    };
  }

  return formatted;
}
