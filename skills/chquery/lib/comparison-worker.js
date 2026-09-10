import { assertComparisonEvidence, parseComparisonEvidence, stableStringify, COMPARISON_LIMITS } from './comparison-artifact.js';
import { compareBundles, comparisonBriefInput, readBundleMeasurements } from './comparison.js';
import { prepareComparison, exportComparisonSource } from './comparison-report.js';
import { checkReportJsonSize } from './comparison-budget.js';
import { loadShareLink } from './stored-share.js';
import { briefFromComparison } from './report.js';
import { textPage as pageText } from './text-page.js';

let pair, report, prepared, confirmed = false, analysis;
const clip = value => String(value ?? 'Unknown').slice(0, 240);
const description = value => value == null ? 'Unknown' : Array.isArray(value) ? `${value.length} supplied records` : typeof value === 'object' ? 'Supplied structured evidence' : clip(value);
function summarize(value = report) {
  const brief = briefFromComparison(comparisonBriefInput(value));
  return {
    brief,
    comparability: value.comparability.status,
    dimensions: value.comparability.dimensions.map(item => ({ ...item, baseline: description(item.baseline), candidate: description(item.candidate) })),
    sql: value.sql.literalEquality,
    settings: value.settings.length,
    structure: { matches: value.structure.matches.length, baselineUnmatched: value.structure.baselineUnmatched.length, candidateUnmatched: value.structure.candidateUnmatched.length },
    findings: Object.fromEntries(['introduced', 'resolved', 'changed', 'persisting', 'not-assessable'].map(state => [state, value.findings.filter(item => item.state === state).length])),
    sides: Object.fromEntries(['baseline', 'candidate'].map(role => {
      const side = value.sides[role];
      return [role, { label: clip(side.label), runtime: { status: side.coverage.runtime.status, scope: side.coverage.runtime.scope },
        selectionReason: side.measurements.selectionReason,
        groups: side.measurements.groups.map((group, index) => ({ index, label: `${group.count} observations · ${clip(group.provenance.protocol_ref || 'unknown protocol')} · ${group.provenance.cache || 'unknown cache'}`, selected: group.key === side.measurements.selectedGroup })) }];
    }))
  };
}
function inspect({ section, recordPage = 0, textPage = 0 }) {
  let value, records = false;
  const role = section.startsWith('candidate-') ? 'candidate' : 'baseline';
  if (section.endsWith('-sql')) value = pair[role].bundle.sql;
  else if (section === 'sql-change') value = report.sql.change;
  else if (section === 'settings' || section === 'findings' || section === 'claims') { value = report[section]; records = true; }
  else if (section === 'fidelity') { value = [...Object.entries(report.fidelity.sides).map(([role, detail]) => ({ role, ...detail })), ...report.fidelity.differences]; records = true; }
  else if (section === 'branches') { value = report.structure.branches; records = true; }
  else if (section === 'structure') {
    value = [...report.structure.matches.map(item => ({ kind: 'matched', ...item })), ...report.structure.baselineUnmatched.map(item => ({ kind: 'baseline-unmatched', ...item })), ...report.structure.candidateUnmatched.map(item => ({ kind: 'candidate-unmatched', ...item }))]; records = true;
  } else if (section === 'comparability') { value = report.comparability.dimensions; records = true; }
  else if (section.endsWith('-measurements')) { value = report.sides[role].measurements.samples; records = true; }
  else if (section.endsWith('-nodes')) {
    value = [];
    const stack = pair[role].bundle.explain.plan
      .map((wrapper, index) => ({ node: wrapper.Plan, path: `explain.plan[${index}].Plan` }))
      .reverse();
    while (stack.length) {
      const { node, path } = stack.pop();
      const { Plans, ...fields } = node;
      value.push({ role, path, childCount: Plans?.length || 0, fields });
      for (let i = (Plans?.length || 0) - 1; i >= 0; i--) stack.push({ node: Plans[i], path: `${path}.Plans[${i}]` });
    }
    records = true;
  } else throw new Error('Unknown evidence view.');
  const recordPages = records ? Math.max(1, Math.ceil(value.length / 10)) : 1;
  recordPage = Math.max(0, Math.min(recordPage, recordPages - 1));
  if (records) value = value.slice(recordPage * 10, (recordPage + 1) * 10);
  const cards = records ? value.map(item => {
    if (section === 'claims') return { title: `${clip(item.authorClaim.statement)} · ${item.assessment}`, lines: [item.reason, `Check: ${item.checkType}`, `Scope: ${description(item.structuralScope)}`, `Missing evidence: ${item.missingEvidence.join('; ') || 'none'}`] };
    if (section === 'fidelity') return { title: `${item.role || item.name} · ${item.status}`, lines: item.role ? [`Descriptions: ${item.describedNodes}/${item.totalNodes}`, `Collection profile: ${description(item.collectionProfile)}`, `Source relation: ${description(item.sourceRelation)}`, ...item.gaps] : [`Baseline: ${description(item.baseline)}`, `Candidate: ${description(item.candidate)}`] };
    if (section === 'branches') return { title: `${item.role} · ${item.status}`, lines: [item.statement, item.basis, `Types: ${item.types.join(' → ')}`, `Nodes: ${item.nodeIds.join(', ')}`] };
    if (section === 'findings') return { title: `${item.ruleId} · ${item.state}`, lines: [item.reason,
      ...['baseline', 'candidate'].flatMap(side => item[side] ? [`${side}: ${clip(item[side].message)}`, `Classification: ${item[side].classification}; impact confidence: ${item[side].impactConfidence}`, `Priority: ${clip(item[side].priorityReason)}`] : [`${side}: no matched finding`])] };
    if (section === 'settings') return { title: `${clip(item.name)} · ${item.status}`, lines: [`Baseline: ${item.baseline.map(record => description(record.value)).join(', ')}`, `Candidate: ${item.candidate.map(record => description(record.value)).join(', ')}`, item.limitation] };
    if (section.endsWith('-nodes')) return { title: `${clip(item.fields['Node Type'])} · ${item.childCount} children`, lines: [clip(item.fields.Description), item.path, 'Node fields only; descendants have their own entries.'] };
    if (section.endsWith('-measurements')) return { title: `Observation ${item.index + 1}${item.id ? ` · ${clip(item.id)}` : ''}`, lines: [item.excluded ? `Excluded: ${item.exclusionReasons.map(clip).join('; ')}` : 'Eligible observation; selected group determines aggregation.', `Scope: ${item.provenance.values.scope || 'unknown'}`, ...Object.entries(item.metrics).map(([name, metric]) => `${name}: ${metric.value ?? 'Unavailable'} (${metric.state})${metric.value === null ? ` · ${metric.reason}` : ''}`)] };
    if (section === 'comparability') return { title: `${item.name} · ${item.status}`, lines: [`Baseline: ${description(item.baseline)}`, `Candidate: ${description(item.candidate)}`] };
    return { title: item.kind, lines: [item.basis || item.reason, item.nodeId || `${item.baseline} → ${item.candidate}`, `${item.changes?.length ?? 0} supplied field changes; no per-operator timing implied.`] };
  }) : [];
  if (typeof value !== 'string') checkReportJsonSize(value);
  return { ...pageText(typeof value === 'string' ? value : stableStringify(value, 2), textPage), recordPage, recordPages, cards };
}

self.onmessage = async ({ data: { id, action, ...data } }) => {
  try {
    let result;
    if (action === 'import') {
      if (data.link !== undefined) result = assertComparisonEvidence(await loadShareLink(data.link));
      else if (data.artifact !== undefined) result = assertComparisonEvidence(data.artifact, { pair: true });
      else {
        if (data.file.size > (data.kind === 'pair' ? COMPARISON_LIMITS.totalBytes : COMPARISON_LIMITS.bundleBytes)) throw new Error('File exceeds the allowed evidence size.');
        result = parseComparisonEvidence(await data.file.text());
      }
      if (data.kind === 'pair' ? result.chquery_comparison !== 1 : result.chquery !== 1) throw new Error(data.kind === 'pair' ? 'Choose a complete comparison with both runs.' : 'Choose a single analysis for this slot, not a complete comparison.');
    } else if (action === 'analyze' || action === 'source') {
      pair = assertComparisonEvidence(data.pair, { pair: true });
      if (action === 'source') result = new Blob([exportComparisonSource(pair).json], { type: 'application/json' });
      else {
        const [catalog, concerns] = await Promise.all(['settings-catalog', 'settings-concerns'].map(async name => {
          const response = await fetch(`../data/${name}.json`);
          if (!response.ok) throw new Error('Settings knowledge could not load. Retry comparison.');
          return response.json();
        }));
        const sampleGroups = {};
        for (const role of ['baseline', 'candidate']) {
          const selection = data.groups?.[role];
          if (selection !== undefined) sampleGroups[role] = readBundleMeasurements(pair[role].bundle).groups[selection]?.key ?? 'invalid-selection';
        }
        analysis = { catalog, concerns, sampleGroups };
        report = compareBundles(pair, analysis);
        prepared = null; confirmed = false;
        result = summarize();
      }
    } else if (action === 'inspect') result = inspect(data);
    else if (action === 'prepare') {
      prepared = null; confirmed = false;
      prepared = prepareComparison(pair, { ...data.options, analysis });
      result = { warning: prepared.preparation.warning, transformation: prepared.preparation.transformation, omissionCount: prepared.preparation.omissions.length,
        privacy: prepared.preparation.privacy, privacyReview: prepared.privacyReview,
        view: summarize(prepared.report),
        bytes: Object.fromEntries(['json', 'reportJson', 'markdown'].map(key => [key, new Blob([prepared[key]]).size])) };
    } else if (action === 'preview') {
      if (!prepared || !['json', 'reportJson', 'markdown'].includes(data.format)) throw new Error('Prepare a fresh review first.');
      result = pageText(prepared[data.format], data.page);
    } else if (action === 'confirm') { confirmed = Boolean(prepared && data.confirmed); result = confirmed; }
    else if (action === 'export') {
      if (!prepared || !confirmed || !['json', 'reportJson', 'markdown'].includes(data.format)) throw new Error('Review and confirm the current outgoing files first.');
      result = new Blob([prepared[data.format]], { type: data.format === 'markdown' ? 'text/plain' : 'application/json' });
    } else throw new Error('Unknown comparison operation.');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: { message: error.message, code: error.code, format: error.format, limitBytes: error.limitBytes,
      paths: error.paths, repair: error.repair,
      details: error.errors?.slice(0, 3).map(item => `${clip(item.path)}: ${clip(item.message)}`).join(' ') } });
  }
};
