/**
 * Generates human-readable Markdown summaries of Clay table schemas.
 */

function buildFieldMap(fields) {
  const map = {};
  for (const f of fields || []) {
    if (f.id && f.name) map[f.id] = f.name;
  }
  return map;
}

function resolveFieldRefs(text, fieldMap) {
  if (!text || !fieldMap) return text;
  return text.replace(/\{\{(f_[a-zA-Z0-9_]+)\}\}/g, (match, id) => {
    return fieldMap[id] ? `{{${fieldMap[id]}}}` : match;
  });
}

export function generateTableSummary(schema) {
  const lines = [];
  const fieldMap = buildFieldMap(schema.fields);

  lines.push(`# Table: ${schema.tableName}`);
  lines.push('');
  lines.push('| Property | Value |');
  lines.push('|----------|-------|');
  lines.push(`| Table ID | \`${schema.tableId}\` |`);
  lines.push(`| View ID  | \`${schema.viewId}\` |`);
  lines.push(`| Fields   | ${schema.fieldCount} |`);
  lines.push(`| Rows     | ${schema.rowCount ?? 'Unknown'} |`);
  lines.push('');

  if (schema.views && schema.views.length > 1) {
    lines.push('## Views');
    lines.push('');
    schema.views.forEach(v => {
      const active = v.id === schema.viewId ? ' *(active)*' : '';
      lines.push(`- **${v.name}** \`${v.id}\`${active}`);
    });
    lines.push('');
  }

  const sources   = schema.fields.filter(f => f.type === 'source');
  const inputs    = schema.fields.filter(f => f.type === 'text' || f.type === 'basic');
  const formulas  = schema.fields.filter(f => f.type === 'formula');
  const actions   = schema.fields.filter(f => f.type === 'action');
  const others    = schema.fields.filter(f => !['source','text','basic','formula','action'].includes(f.type));

  lines.push('## Column Breakdown');
  lines.push('');
  lines.push('| Type | Count |');
  lines.push('|------|-------|');
  if (sources.length)  lines.push(`| Sources (data sources) | ${sources.length} |`);
  if (inputs.length)   lines.push(`| Input (text/basic) | ${inputs.length} |`);
  if (formulas.length) lines.push(`| Formulas | ${formulas.length} |`);
  if (actions.length)  lines.push(`| Action (enrichments) | ${actions.length} |`);
  if (others.length)   lines.push(`| Other | ${others.length} |`);
  lines.push('');

  lines.push('## All Columns (in order)');
  lines.push('');
  schema.fields.forEach((f, i) => {
    let detail = '';
    if (f.type === 'formula' && f.typeSettings?.formulaText) {
      const resolved = resolveFieldRefs(f.typeSettings.formulaText, fieldMap);
      const preview = resolved.substring(0, 100);
      const truncated = resolved.length > 100 ? '...' : '';
      detail = `\n   > \`${preview}${truncated}\``;
    }
    if (f.type === 'action') {
      const key = f.typeSettings?.actionKey || 'unknown';
      const runCond = f.typeSettings?.conditionalRunFormulaText;
      detail = `\n   > Action: \`${key}\``;
      if (runCond) {
        const resolvedCond = resolveFieldRefs(runCond, fieldMap);
        detail += `\n   > Run if: \`${resolvedCond.substring(0, 120)}${resolvedCond.length > 120 ? '...' : ''}\``;
      }
    }
    if (f.type === 'source' && f.sourceDetails?.length) {
      const names = f.sourceDetails.map(s => s.name || s.type).join(', ');
      detail = `\n   > Sources: ${names}`;
    }
    lines.push(`${String(i + 1).padStart(2, ' ')}. **${f.name}** \`(${f.type})\`${detail}`);
  });
  lines.push('');

  if (actions.length > 0) {
    lines.push('## Enrichment Actions Detail');
    lines.push('');
    actions.forEach(a => {
      lines.push(`### ${a.name}`);
      lines.push(`- **Action Key:** \`${a.typeSettings?.actionKey || 'unknown'}\``);
      if (a.typeSettings?.inputsBinding?.length) {
        lines.push('- **Inputs:**');
        a.typeSettings.inputsBinding.forEach(ib => {
          const resolvedVal = resolveFieldRefs(ib.formulaText, fieldMap);
          lines.push(`  - \`${ib.name}\` = \`${resolvedVal}\``);
        });
      }
      if (a.typeSettings?.conditionalRunFormulaText) {
        const resolvedCond = resolveFieldRefs(a.typeSettings.conditionalRunFormulaText, fieldMap);
        lines.push(`- **Run Condition:** \`${resolvedCond}\``);
      }
      if (a.typeSettings?.authAccountId) {
        lines.push(`- **Auth Account:** \`${a.typeSettings.authAccountId}\``);
      }
      if (a.pricing?.credits) {
        const c = a.pricing.credits;
        const parts = Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(', ');
        lines.push(`- **Credit Cost (per run):** ${parts}`);
        const post = a.pricing.postPricingChange2026?.credits;
        if (post && JSON.stringify(post) !== JSON.stringify(c)) {
          const postParts = Object.entries(post).map(([k, v]) => `${k}: ${v}`).join(', ');
          lines.push(`- **Credit Cost (post-2026 pricing):** ${postParts}`);
        }
      }
      const outputType = a.typeSettings?.dataTypeSettings?.type || 'json';
      lines.push(`- **Output Type:** \`${outputType}\``);
      lines.push('');
    });
  }

  if (formulas.length > 0) {
    lines.push('## Formula Columns Detail');
    lines.push('');
    formulas.forEach(f => {
      lines.push(`### ${f.name}`);
      if (f.typeSettings?.formulaText) {
        lines.push('- **Formula:**');
        lines.push('  ```javascript');
        lines.push(`  ${resolveFieldRefs(f.typeSettings.formulaText, fieldMap)}`);
        lines.push('  ```');
      }
      const outType = f.typeSettings?.dataTypeSettings?.type || f.typeSettings?.formulaType || 'text';
      lines.push(`- **Output Type:** \`${outType}\``);
      lines.push('');
    });
  }

  return lines.join('\n');
}

export function generateErrorSummary(statusData) {
  if (!statusData || Object.keys(statusData).length === 0) return 'No status data available.';

  const lines = [];
  lines.push('## Cell Status Breakdown');
  lines.push('');
  lines.push('| Column | SUCCESS | ERROR | HAS_NOT_RUN | QUEUED | Fill% | Notes |');
  lines.push('|--------|---------|-------|-------------|--------|-------|-------|');

  const cols = Object.values(statusData);

  cols.sort((a, b) => {
    if (a.likelyBroken && !b.likelyBroken) return -1;
    if (!a.likelyBroken && b.likelyBroken) return 1;
    return a.fillPct - b.fillPct;
  });

  for (const col of cols) {
    const notes = [];
    if (col.likelyBroken)         notes.push('BROKEN — 0 successes');
    else if (col.runConditionGated) notes.push('run condition gate');
    else if (col.topError && col.error > 0) notes.push(col.topError.substring(0, 50));

    lines.push(
      `| ${col.name} | ${col.success} | ${col.error} | ${col.hasNotRun} | ${col.queued} | ${col.fillPct}% | ${notes.join('; ')} |`
    );
  }

  lines.push('');

  const broken = cols.filter(c => c.likelyBroken && !c.runConditionGated);
  if (broken.length > 0) {
    lines.push('### Columns with 0 successes (likely broken)');
    lines.push('');
    for (const col of broken) {
      const topErrors = Object.entries(col.errors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([msg, count]) => `\`${msg}\` (${count}x)`)
        .join(', ');
      lines.push(`- **${col.name}** — ${topErrors || 'no error details'}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
