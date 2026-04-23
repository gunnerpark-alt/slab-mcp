/**
 * Schema analysis engine.
 * Runs on in-memory schema data to surface issues, dependencies, and insights.
 */

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

function buildDependencyGraph(schema) {
  const graph = {};
  const reverseGraph = {};

  for (const field of schema.fields) {
    graph[field.name] = [];

    const settingsStr = JSON.stringify(field.typeSettings || {});

    for (const match of settingsStr.matchAll(/\{\{(f_[a-zA-Z0-9_]+)\}\}/g)) {
      const ref = schema.fields.find(f => f.id === match[1]);
      if (ref && ref.name !== field.name) {
        graph[field.name].push(ref.name);
        if (!reverseGraph[ref.name]) reverseGraph[ref.name] = [];
        if (!reverseGraph[ref.name].includes(field.name)) {
          reverseGraph[ref.name].push(field.name);
        }
      }
    }

    for (const match of settingsStr.matchAll(/\{\{@([^}]+)\}\}/g)) {
      const refName = match[1];
      if (!refName.startsWith('source:') && refName !== field.name) {
        graph[field.name].push(refName);
        if (!reverseGraph[refName]) reverseGraph[refName] = [];
        if (!reverseGraph[refName].includes(field.name)) {
          reverseGraph[refName].push(field.name);
        }
      }
    }

    graph[field.name] = [...new Set(graph[field.name])];
  }

  return { graph, reverseGraph };
}

// ---------------------------------------------------------------------------
// Formula syntax validator
// ---------------------------------------------------------------------------

function validateFormulaSyntax(field) {
  const issues = [];
  const formula = field.typeSettings?.formulaText
    || (typeof field.typeSettings === 'string' ? field.typeSettings : null);
  if (!formula) return issues;

  const col = field.name;

  if (formula.includes('`')) {
    issues.push({ severity: 'error', column: col,
      message: 'Template literals (backticks) are not supported. Use + concatenation.' });
  }

  if (/\breturn\b/.test(formula)) {
    issues.push({ severity: 'error', column: col,
      message: 'return statements are not allowed — formulas must be pure expressions.' });
  }

  if (/\(\s*\(\s*\)\s*=>/.test(formula) || /\(\s*function\s*\(/.test(formula)) {
    issues.push({ severity: 'error', column: col,
      message: 'IIFEs / function wrappers are not supported. Use pure expressions with ternaries.' });
  }

  if (/\.replace\s*\(\s*\//.test(formula)) {
    issues.push({ severity: 'warning', column: col,
      message: '.replace() with regex is unreliable. Use .split("x").join("y") instead.' });
  }

  if (formula.includes('.replaceAll(')) {
    issues.push({ severity: 'error', column: col,
      message: '.replaceAll() is not available. Use .split("x").join("y").' });
  }

  if (/\b(const|let|var)\b/.test(formula)) {
    issues.push({ severity: 'error', column: col,
      message: 'Variable declarations (const/let/var) are not supported at the top level.' });
  }

  if (formula.includes('Object.assign')) {
    issues.push({ severity: 'warning', column: col,
      message: 'Object.assign is unreliable on enrichment objects. Use explicit field mapping.' });
  }

  if (/\{\.\.\.{{/.test(formula)) {
    issues.push({ severity: 'warning', column: col,
      message: 'Object spread on column references is unreliable. Use explicit field mapping.' });
  }

  const propertyAccesses = [...formula.matchAll(/\}\}(\.[a-zA-Z])/g)];
  if (propertyAccesses.length > 0) {
    issues.push({ severity: 'warning', column: col,
      message: 'Direct property access after column ref without ?. — may throw if null. Consider optional chaining.' });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Run condition analyzer
// ---------------------------------------------------------------------------

function analyzeRunConditions(schema) {
  const issues = [];

  for (const field of schema.fields) {
    const runCondition = field.typeSettings?.conditionalRunFormulaText;
    if (!runCondition) continue;

    const fieldIndex = schema.fields.findIndex(f => f.id === field.id);

    for (const match of runCondition.matchAll(/\{\{(f_[a-zA-Z0-9_]+)\}\}/g)) {
      const refField = schema.fields.find(f => f.id === match[1]);
      if (!refField) {
        issues.push({ severity: 'error', column: field.name,
          message: `Run condition references non-existent field ID: ${match[1]}` });
      } else {
        const refIndex = schema.fields.findIndex(f => f.id === refField.id);
        if (refIndex > fieldIndex) {
          issues.push({ severity: 'warning', column: field.name,
            message: `Run condition references "${refField.name}" which appears AFTER this column — may not have data yet.` });
        }
      }
    }

    const syntaxIssues = validateFormulaSyntax({
      name: field.name,
      typeSettings: { formulaText: runCondition }
    });
    syntaxIssues.forEach(i => issues.push({ ...i, message: `[Run Condition] ${i.message}` }));
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Enrichment flow mapper
// ---------------------------------------------------------------------------

const PROVIDER_MAP = {
  'clearbit': 'Clearbit', 'apollo': 'Apollo', 'pdl': 'People Data Labs',
  'people-data-labs': 'People Data Labs', 'hunter': 'Hunter', 'snov': 'Snov.io',
  'lusha': 'Lusha', 'zoominfo': 'ZoomInfo', 'pitchbook': 'PitchBook',
  'crunchbase': 'Crunchbase', 'hg-insights': 'HG Insights', 'leadmagic': 'LeadMagic',
  'datagma': 'Datagma', 'owler': 'Owler', 'smarte': 'SMARTe', 'brandfetch': 'Brandfetch',
  'claygent': 'Claygent', 'openai': 'OpenAI / Use AI', 'anthropic': 'Anthropic / Use AI',
  'google': 'Google', 'semrush': 'SEMrush', 'similarweb': 'SimilarWeb',
  'builtwith': 'BuiltWith', 'http-api': 'HTTP API', 'salesforce': 'Salesforce',
  'hubspot': 'HubSpot', 'dun-and-bradstreet': 'D&B', 'dnb': 'D&B',
  'exellius': 'Exellius', 'reverse-contact': 'Reverse Contact', 'clearout': 'Clearout',
  'mixrank': 'Mixrank', 'champify': 'Champify', 'livedata': 'LiveData',
  'findymail': 'Findymail', 'normalize-url': 'Normalize URL', 'use-ai': 'Use AI',
  'marketo': 'Marketo', 'outreach': 'Outreach', 'salesloft': 'Salesloft',
  'smartlead': 'Smartlead', 'bytemine': 'Bytemine', 'pubrio': 'Pubrio'
};

function extractProviderName(actionKey) {
  const key = (actionKey || '').toLowerCase();
  for (const [pattern, name] of Object.entries(PROVIDER_MAP)) {
    if (key.includes(pattern)) return name;
  }
  return actionKey || 'Unknown';
}

function mapEnrichmentFlow(schema) {
  const actions = schema.fields.filter(f => f.type === 'action');
  const waterfallGroups = {};
  const enrichments = [];

  for (const action of actions) {
    const actionKey = action.typeSettings?.actionKey || '';
    const inputs = action.typeSettings?.inputsBinding || [];
    const runCondition = action.typeSettings?.conditionalRunFormulaText || null;

    enrichments.push({
      name: action.name,
      fieldId: action.id,
      actionKey,
      provider: extractProviderName(actionKey),
      inputs: inputs.map(i => ({ param: i.name, value: i.formulaText })),
      runCondition,
      hasAuth: !!action.typeSettings?.authAccountId,
      outputType: action.typeSettings?.dataTypeSettings?.type || 'json'
    });

    const baseName = action.name
      .replace(/\s*#?\d+\s*$/, '')
      .replace(/\s*\([^)]+\)\s*$/, '')
      .trim();
    if (!waterfallGroups[baseName]) waterfallGroups[baseName] = [];
    waterfallGroups[baseName].push(action.name);
  }

  const waterfalls = Object.entries(waterfallGroups)
    .filter(([, group]) => group.length > 1)
    .map(([baseName, columns]) => ({ baseName, columns, count: columns.length }));

  return { enrichments, waterfalls };
}

// ---------------------------------------------------------------------------
// Full analysis runner
// ---------------------------------------------------------------------------

export function runFullAnalysis(schema) {
  const { graph, reverseGraph } = buildDependencyGraph(schema);

  const formulaIssues = [];
  for (const field of schema.fields) {
    if (field.type === 'formula') {
      formulaIssues.push(...validateFormulaSyntax(field));
    }
  }

  const runConditionIssues = analyzeRunConditions(schema);
  const enrichmentFlow = mapEnrichmentFlow(schema);

  const dependencyIssues = [];
  for (const [fieldName, deps] of Object.entries(graph)) {
    for (const dep of deps) {
      const exists = schema.fields.find(f => f.name === dep);
      if (!exists) {
        dependencyIssues.push({
          severity: 'error',
          column: fieldName,
          message: `References column "${dep}" which does not exist in this table.`
        });
      }
    }
  }

  const allIssues = [...formulaIssues, ...runConditionIssues, ...dependencyIssues];

  return {
    summary: {
      totalFields: schema.fields.length,
      formulaCount: schema.fields.filter(f => f.type === 'formula').length,
      actionCount: schema.fields.filter(f => f.type === 'action').length,
      sourceCount: schema.fields.filter(f => f.type === 'source').length,
      issueCount: allIssues.length,
      errorCount: allIssues.filter(i => i.severity === 'error').length,
      warningCount: allIssues.filter(i => i.severity === 'warning').length,
      waterfallCount: enrichmentFlow.waterfalls.length
    },
    issues: allIssues,
    dependencyGraph: graph,
    reverseDependencyGraph: reverseGraph,
    enrichmentFlow
  };
}
