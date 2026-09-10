import { readBundleMeasurements, withMeasurementCoverage } from './comparison.js';

// Keep strict comparison validation out of the legacy single-result import
// boundary. Unsupported measurements get a diagnostic, never a legacy fallback.
export function prepareMeasurements(bundle, coverage, options = {}) {
  try {
    const measurements = readBundleMeasurements(bundle, options);
    return { measurements, coverage: withMeasurementCoverage(coverage, measurements, options), diagnostic: null };
  } catch (error) {
    return { measurements: null, diagnostic: `Runtime evidence could not be assessed: ${error.message}`,
      coverage: { ...coverage, runtime: { ...coverage.runtime, status: 'missing', scope: 'unknown', available: [],
        missing: coverage.runtime.metrics.map(metric => metric.name),
        metrics: coverage.runtime.metrics.map(metric => ({ ...metric, value: null, evidence: 'missing' })) } } };
  }
}

export function investigationSummary(analysis, preferredOccurrence) {
  const candidate = analysis.candidates.find(item => item.occurrenceId === preferredOccurrence) || analysis.candidates[0] || null;
  const coverage = analysis.coverage;
  const observations = candidate?.observation?.evidence?.filter(([label]) => !['Plan node', 'Description'].includes(label)).slice(0, 2) || [];
  const runtimeNeeded = candidate?.requiredEvidence?.some(item =>
    (item.kind === 'runtime' && coverage.runtime.missing.length) || coverage.runtime.missing.includes(item.kind));
  const action = !candidate ? { kind: 'map', label: 'Explore map', reason: 'No change suggested. You can inspect the plan or stop here.' }
    : runtimeNeeded ? { kind: 'runtime', label: 'Review runtime evidence', reason: 'A missing measurement blocks this check. Review available measurements before collecting more.' }
    : candidate.nodeIds.length ? { kind: 'inspect', label: 'Inspect evidence', reason: 'Start with the exact evidence before changing the query or settings.' }
    : { kind: 'finding', label: 'Review finding evidence', reason: 'This finding has no exact operator attribution; inspect its supplied context.' };
  return { candidate, observations, action,
    source: candidate?.observation?.source || 'plan',
    fallback: `${coverage.plan.nodeCount} plan steps parsed. ${coverage.scans.label}.`,
    runtimeLabel: `${coverage.runtime.available.length} of ${coverage.runtime.total} fields supplied`,
    scopeLabel: `${coverage.runtime.scope.replaceAll('_', ' ')} scope · run correspondence unverified`,
    noCandidate: analysis.findings?.length
      ? 'No open actionable findings from the supplied evidence. Observations and reviewed findings remain available; this is not a query health verdict.'
      : 'No actionable findings from the supplied evidence. This does not establish that the query is fast or correct.' };
}
