import { assertComparisonEvidence, isRecord, METRIC_NAMES, readProvenance, stableStringify } from "./comparison-artifact.js";
import { evaluateMetric, isSyntheticPlanRoot, parseEstimate, parseExplainPlan } from "./parser.js";
import { buildEvidenceCoverage, buildPlanModel, flattenPlan } from "./model.js";
import { evaluateFindings } from "./findings.js";

export const COMPARISON_REVISION = "comparison-1";
const roles = ["baseline", "candidate"];
const protocolFields = ["source", "scope", "status", "association", "data_ref", "environment_ref", "cache", "protocol_ref", "settings_coverage"];
const ref = (role, path, nodeId = null) => ({ role, path, ...(nodeId ? { nodeId } : {}) });
const sourcePath = value => {
  if (typeof value !== "string" && value?.sourcePath) return value.sourcePath;
  const nodeId = typeof value === "string" ? value : value.nodeId;
  return `$[0].Plan${nodeId.slice(6).split(".").slice(1).map(index => `.Plans[${index}]`).join("")}`;
};
const equal = (a, b) => stableStringify(a ?? null) === stableStringify(b ?? null);
const redacted = bundle => Boolean(bundle.redaction || /<(?:str|num)_\d+>/.test(bundle.sql));

/** Read one validated bundle without assigning comparison roles. */
export function readBundleMeasurements(bundle, { selectedGroup } = {}) {
  assertComparisonEvidence(bundle);
  if (bundle.chquery !== 1) throw new TypeError("Expected a bare v1 bundle.");
  const runtime = bundle.runtime || {};
  const hasSamples = Object.hasOwn(runtime, "samples");
  const inputs = hasSamples ? runtime.samples : METRIC_NAMES.some(name => Object.hasOwn(runtime.query_log || {}, name)) ? [{ metrics: runtime.query_log }] : [];
  const ids = new Map();
  for (const sample of inputs) if (sample.id) ids.set(sample.id, (ids.get(sample.id) || 0) + 1);
  const samples = inputs.map((sample, index) => {
    // An explicit unsupported override must not inherit trusted-looking common
    // context. Partial v1 overrides can invalidate individual inherited fields.
    const common = runtime.provenance;
    const raw = sample.provenance === undefined ? common
      : isRecord(sample.provenance) && sample.provenance.version === 1
        ? { ...(isRecord(common) && common.version === 1 ? common : {}), ...sample.provenance } : sample.provenance;
    const provenance = readProvenance(raw);
    const reasons = [];
    if (sample.id && ids.get(sample.id) > 1) reasons.push("Duplicate explicit sample id; all occurrences excluded.");
    if (sample.excluded) reasons.push(sample.exclusion_reason || "Explicitly excluded.");
    if (sample.warmup) reasons.push("Declared warmup.");
    if (provenance.values.status === "failed") reasons.push("Failed run.");
    const protocol = Object.fromEntries(protocolFields.map(key => [key, provenance.values[key] ?? null]));
    const key = stableStringify(protocol);
    return {
      ...(sample.id ? { id: sample.id } : {}), index,
      evidence: { path: hasSamples ? `runtime.samples[${index}]` : "runtime.query_log" },
      metrics: Object.fromEntries(METRIC_NAMES.map(name => [name, evaluateMetric(sample.metrics[name])])),
      provenance, group: key, excluded: reasons.length > 0, exclusionReasons: reasons
    };
  });
  const grouped = new Map();
  for (const sample of samples.filter(sample => !sample.excluded)) {
    if (!grouped.has(sample.group)) grouped.set(sample.group, []);
    grouped.get(sample.group).push(sample);
  }
  const groups = [...grouped].map(([key, group]) => ({
    key, count: group.length, provenance: group[0].provenance.values,
    protocolKnown: protocolFields.every(field => group[0].provenance.values[field] !== undefined) &&
      group[0].provenance.values.status === "successful" && group[0].provenance.values.cache !== "mixed"
  })).sort((a, b) => a.key.localeCompare(b.key));
  let selection = selectedGroup;
  if (selection === undefined && groups.length === 1 && (groups[0].protocolKnown || groups[0].count === 1)) selection = groups[0].key;
  const group = groups.find(item => item.key === selection);
  const included = group ? grouped.get(group.key) : [];
  const selectionReason = group ? (group.protocolKnown ? "Supplied protocol group (unverified)." : "Descriptive observations; protocol unknown.")
    : groups.length ? "Select a protocol group explicitly before aggregating mixed or repeated unknown-protocol samples." : "No eligible observations.";
  const summaries = Object.fromEntries(METRIC_NAMES.map(name => {
    const values = included.map(sample => sample.metrics[name].value).filter(value => value !== null).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = !values.length ? null : values.length % 2 ? values[middle] : values[middle - 1] + (values[middle] - values[middle - 1]) / 2;
    return [name, { value: median, min: values[0] ?? null, max: values.at(-1) ?? null, valid: values.length, selected: included.length, total: samples.length }];
  }));
  return { source: hasSamples ? "samples" : "query_log", samples, groups, selectedGroup: group?.key ?? null,
    selectedProvenance: group?.provenance ?? {}, selectionReason, summaries };
}

/** Replace only runtime coverage with the selected observations, without
 * mutating coverage or measurements. Pass the same selection options as above.
 */
export function withMeasurementCoverage(coverage, measurements, { selectedGroup } = {}) {
  const scope = measurements.selectedProvenance.scope || "unknown";
  if (measurements.source !== "samples" && !measurements.samples.some(sample => sample.excluded) && selectedGroup === undefined) {
    return { ...coverage, runtime: { ...coverage.runtime, scope } };
  }
  const metrics = METRIC_NAMES.map(name => ({ name, value: measurements.summaries[name].value,
    evidence: measurements.summaries[name].valid ? "known" : "missing", reason: measurements.selectionReason }));
  const available = metrics.filter(item => item.value !== null).map(item => item.name);
  return { ...coverage, runtime: { ...coverage.runtime, metrics, available, missing: METRIC_NAMES.filter(name => !available.includes(name)),
    status: available.length === METRIC_NAMES.length ? "available" : available.length ? "partial" : "missing",
    scope, source: "selected-observation-summary" } };
}

function dimension(name, baseline, candidate) {
  const unknown = baseline === null || baseline === undefined || baseline === "" || candidate === null || candidate === undefined || candidate === "";
  return { name, baseline: baseline ?? null, candidate: candidate ?? null,
    status: unknown ? "unknown" : equal(baseline, candidate) ? "consistent" : "different" };
}

function compareMetrics(sides, dimensions) {
  const a = sides.baseline.measurements, b = sides.candidate.measurements;
  const incompatible = dimensions.some(item => ["source", "scope"].includes(item.name) && item.status === "different");
  const uncertainty = dimensions.some(item => item.status === "unknown");
  const confounded = dimensions.some(item => item.status === "different");
  return METRIC_NAMES.map(name => {
    const baseline = a.summaries[name], candidate = b.summaries[name];
    const available = baseline.value !== null && candidate.value !== null;
    const absolute = !available || incompatible ? null : candidate.value - baseline.value;
    const rawPercent = absolute === null || baseline.value === 0 ? null : absolute / baseline.value * 100;
    const percent = Number.isFinite(rawPercent) ? rawPercent : null;
    return { name, unit: name === "query_duration_ms" ? "ms" : name.endsWith("bytes") || name === "memory_usage" ? "bytes" : "rows",
      baseline, candidate, absolute, percent,
      reason: incompatible ? "Incompatible metric sources or scopes; delta unavailable."
        : !available ? "Measurement or selected sample group unavailable on one or both sides."
        : baseline.value === 0 ? "Baseline is zero; percentage unavailable."
        : rawPercent !== null && percent === null ? "Percentage exceeds numeric range." : "Candidate minus baseline; descriptive only.",
      interpretation: confounded ? "confounded" : uncertainty ? "comparability-unknown" : "supplied-context-consistent",
      repeatability: baseline.valid < 2 || candidate.valid < 2 ? "Repeatability unknown; fewer than two measurements on at least one side." : "Descriptive sample summaries do not prove repeatable improvement.",
      performanceDirection: name === "result_rows" ? "correctness-signal-only" : "no-winner",
      evidence: [ref("baseline", `runtime.${a.source}`), ref("candidate", `runtime.${b.source}`)] };
  });
}

/** Bounded linear text diff: keep common prefix/suffix and expose the exact
 * replaced block. No quadratic LCS or normalization of SQL meaning. */
export function compareSql(baseline, candidate, obscured = false) {
  const a = baseline.split("\n"), b = candidate.split("\n");
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  return { baseline, candidate, textEqual: baseline === candidate, literalEquality: obscured ? "unknown-redacted" : baseline === candidate ? "equal-text" : "different-text",
    semanticEquality: "unknown", change: { startLine: start + 1, baseline: a.slice(start, a.length - end), candidate: b.slice(start, b.length - end) },
    evidence: [ref("baseline", "sql"), ref("candidate", "sql")] };
}

function compareSettings(a, b, obscured) {
  const collect = bundle => {
    const map = new Map();
    for (const item of bundle.settings?.changed || []) map.set(item.name, [...(map.get(item.name) || []), item]);
    return map;
  };
  const left = collect(a), right = collect(b);
  return [...new Set([...left.keys(), ...right.keys()])].sort().map(name => {
    const baseline = left.get(name) || [], candidate = right.get(name) || [];
    return { name, baseline, candidate, status: obscured ? "unknown-redacted" : baseline.length > 1 || candidate.length > 1 ? "ambiguous"
      : !baseline.length || !candidate.length || baseline[0].value === undefined || candidate[0].value === undefined ? "not-supplied"
      : equal(baseline[0].value, candidate[0].value) ? "unchanged" : "changed",
      limitation: "Absence from changed settings is not a captured default. Values describe supplied context, not proven execution settings.",
      evidence: roles.map(role => ref(role, "settings.changed")) };
  });
}

function structure(plan) {
  const nodes = flattenPlan(plan);
  const counts = Object.create(null);
  const signatures = new Map();
  const parents = new Map();
  function visit(node, parent = null) {
    if (parent) parents.set(node.nodeId, parent.nodeId);
    const leaves = node.table ? [`${node.table.database}.${node.table.name}`] : (node.children || []).flatMap(child => visit(child, node));
    const type = node["Node Type"];
    counts[type] = (Object.hasOwn(counts, type) ? counts[type] : 0) + 1;
    const key = stableStringify([type, node.table || null, [...leaves].sort()]);
    signatures.set(node.nodeId, key);
    return leaves;
  }
  for (const root of isSyntheticPlanRoot(plan) ? plan.children : [plan]) visit(root);
  return { nodes, counts, signatures, parents, sourcePaths: new Map(nodes.map(node => [node.nodeId, sourcePath(node)])) };
}

const derivedNodeFields = new Set(["Plans", "children", "nodeId", "name", "kind", "table", "index", "stats", "ownRows", "hasAmbiguousEstimate", "heatLevel", "flowRows", "flowHeatLevel", "granules", "totalLeafGranules", "sourcePath", "raw"]);
function suppliedProperties(node) {
  const source = node.raw || node;
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && !derivedNodeFields.has(key) && key !== "Node Type"));
}

function propertyChanges(baseline, candidate) {
  const left = suppliedProperties(baseline), right = suppliedProperties(candidate);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().map(field => {
    const supplied = Object.hasOwn(left, field) && Object.hasOwn(right, field);
    return { field, baseline: left[field] ?? null, candidate: right[field] ?? null,
      status: !supplied ? "unknown" : equal(left[field], right[field]) ? "consistent" : "different" };
  });
}

function unmatchedChains(side, unmatchedIds, mapping, role) {
  const unmatched = new Set(unmatchedIds);
  const byId = new Map(side.nodes.map(node => [node.nodeId, node]));
  const roots = side.nodes.filter(node => unmatched.has(node.nodeId) && !unmatched.has(side.parents.get(node.nodeId)));
  return roots.map(root => {
    const nodeIds = [], types = [];
    const visit = node => {
      if (!unmatched.has(node.nodeId)) return;
      nodeIds.push(node.nodeId); types.push(node["Node Type"]);
      (node.children || []).forEach(visit);
    };
    visit(root);
    const parentNodeId = side.parents.get(root.nodeId) || null;
    const correspondingAnchorNodeId = parentNodeId ? mapping.get(parentNodeId) || null : null;
    return { role, nodeIds, sourcePaths: nodeIds.map(nodeId => side.sourcePaths.get(nodeId)), types, anchorNodeId: parentNodeId, anchorPath: side.sourcePaths.get(parentNodeId) || null,
      correspondingAnchorNodeId, correspondingAnchorPath: correspondingAnchorNodeId ? side.otherSourcePaths?.get(correspondingAnchorNodeId) || null : null,
      status: correspondingAnchorNodeId ? (role === "baseline" ? "not-found-in-corresponding-candidate-branch" : "present-only-in-corresponding-candidate-branch") : "correspondence-not-assessable",
      statement: correspondingAnchorNodeId
        ? role === "baseline" ? "Chain present in baseline; not found in the corresponding candidate branch." : "Chain present in candidate; not found in the corresponding baseline branch."
        : "Chain is unmatched, but no unique corresponding branch anchor is available.",
      basis: correspondingAnchorNodeId ? "Parent branch anchors correspond by the unique structural heuristic; the chain itself is unmatched." : "No unique matched parent anchor.",
      evidence: nodeIds.map(nodeId => ref(role, side.sourcePaths.get(nodeId), nodeId)),
      properties: nodeIds.map(nodeId => ({ nodeId, values: suppliedProperties(byId.get(nodeId)) })) };
  });
}

function compareStructure(a, b) {
  const left = structure(a), right = structure(b);
  const group = side => {
    const map = new Map();
    for (const node of side.nodes) {
      const key = side.signatures.get(node.nodeId);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(node);
    }
    return map;
  };
  const ga = group(left), gb = group(right), matches = [], forward = new Map();
  for (const [key, nodes] of ga) {
    if (nodes.length !== 1 || gb.get(key)?.length !== 1) continue;
    const baseline = nodes[0], candidate = gb.get(key)[0];
    if (baseline["Node Type"] === "ReadFromMergeTree" && (!baseline.table || !candidate.table)) continue;
    forward.set(baseline.nodeId, candidate.nodeId);
    const properties = propertyChanges(baseline, candidate);
    matches.push({ baseline: baseline.nodeId, candidate: candidate.nodeId, basis: "Unique operator/table/descendant-table anchor; heuristic correspondence.",
      baselineEvidence: ref("baseline", left.sourcePaths.get(baseline.nodeId), baseline.nodeId),
      candidateEvidence: ref("candidate", right.sourcePaths.get(candidate.nodeId), candidate.nodeId),
      changes: [
        ...properties.filter(item => item.status !== "consistent")
      ], properties });
  }
  const reverse = new Map([...forward].map(([a, b]) => [b, a]));
  left.otherSourcePaths = right.sourcePaths; right.otherSourcePaths = left.sourcePaths;
  const unmatched = (side, mapping, other) => side.nodes.filter(node => !mapping.has(node.nodeId)).map(node => ({ nodeId: node.nodeId, type: node["Node Type"],
    reason: (other.get(side.signatures.get(node.nodeId))?.length || 0) > 0 ? "Ambiguous repeated structural anchor." : "No corresponding anchor; removal/addition not inferred from path IDs." }));
  const baselineUnmatched = unmatched(left, forward, gb), candidateUnmatched = unmatched(right, reverse, ga);
  const branches = [
    ...unmatchedChains(left, baselineUnmatched.map(item => item.nodeId), forward, "baseline"),
    ...unmatchedChains(right, candidateUnmatched.map(item => item.nodeId), reverse, "candidate")
  ];
  return { result: { matches, baselineUnmatched, candidateUnmatched, branches,
    operators: [...new Set([...Object.keys(left.counts), ...Object.keys(right.counts)])].sort().map(type => ({ type, baseline: left.counts[type] || 0, candidate: right.counts[type] || 0 })),
    limitation: "Correspondence is heuristic. Counts and structure are not operator output rows or measured time. Unmatched chains may reflect relocation, fusion, naming changes or missing evidence; they are not semantic-removal claims." }, forward, reverse, left, right };
}

function fidelity(bundle, plan) {
  const nodes = flattenPlan(plan);
  const described = nodes.filter(node => typeof node.Description === "string" && node.Description.trim()).length;
  const sourceRelation = bundle.query_source?.relationship ?? null;
  const receipt = bundle.collection?.receipt ?? null;
  const changedSettings = Array.isArray(bundle.settings?.changed) ? bundle.settings.changed : null;
  const settingsCollectionState = receipt?.optionalEvidence?.settings ?? null;
  const settingsCoverage = changedSettings
    ? { status: "partial", suppliedRecords: changedSettings.length, collectionState: settingsCollectionState,
        profileExpectation: bundle.collection?.profile?.evidence?.settings ?? null, effectiveEquality: "unknown",
        limitation: "Supplied records are a changed-settings subset, not a complete capture of effective settings." }
    : { status: "missing", suppliedRecords: null, collectionState: settingsCollectionState,
        profileExpectation: bundle.collection?.profile?.evidence?.settings ?? null, effectiveEquality: "unknown",
        limitation: "No changed-settings subset was supplied; effective settings are unknown." };
  const gaps = [];
  if (described < nodes.length) gaps.push(`${nodes.length - described} of ${nodes.length} operators have no supplied description.`);
  if (!bundle.clickhouse?.version) gaps.push("ClickHouse version not supplied.");
  if (!Array.isArray(bundle.schema)) gaps.push("Schema not supplied.");
  gaps.push(settingsCoverage.status === "missing"
    ? "Settings evidence is missing; effective settings are unknown."
    : `${settingsCoverage.suppliedRecords} changed setting record${settingsCoverage.suppliedRecords === 1 ? "" : "s"} supplied; this is partial coverage, not effective-setting equality.`);
  if (!sourceRelation) gaps.push("Source-to-compiled association not supplied.");
  if (!receipt) gaps.push("Safe collection receipt not supplied.");
  return { status: gaps.length ? "partial" : "supplied", collectionProfile: bundle.collection?.profile?.name ?? null,
    sourceRelation, receipt, settingsCoverage, describedNodes: described, totalNodes: nodes.length, gaps,
    limitation: "Syntactic presence does not prove collection completeness. A source association is supplied context, not source-byte identity." };
}

function evidenceForClaim(claim) {
  return Array.isArray(claim.evidence) ? structuredClone(claim.evidence) : [];
}

function assessClaims(claims, matching, metrics, correctnessResult) {
  const baselineNodes = new Map(matching.left.nodes.map(node => [matching.left.sourcePaths.get(node.nodeId), node]));
  const candidateNodes = new Map(matching.right.nodes.map(node => [matching.right.sourcePaths.get(node.nodeId), node]));
  const baselineById = new Map(matching.left.nodes.map(node => [node.nodeId, node]));
  const missing = (authorClaim, missingEvidence, reason) => ({ authorClaim, checkType: authorClaim.check_type, assessment: "Not assessable",
    evidence: evidenceForClaim(authorClaim), missingEvidence, reason });
  return claims.map(authorClaim => {
    const scope = authorClaim.scope || {}, suppliedEvidence = evidenceForClaim(authorClaim);
    if (!suppliedEvidence.length) return missing(authorClaim, ["At least one explicit evidence reference."], "The author claim has no scoped evidence reference.");
    if (authorClaim.check_type === "measurement-delta") {
      const metric = metrics.find(item => item.name === scope.metric);
      if (!metric || metric.percent === null) return missing(authorClaim, ["Comparable selected measurements for the scoped metric."], metric?.reason || "Unknown metric scope.");
      const actual = metric.percent === 0 ? "unchanged" : metric.percent < 0 ? "decrease" : "increase";
      const expected = scope.direction;
      if (!["decrease", "increase", "unchanged"].includes(expected)) return missing(authorClaim, ["A direction of decrease, increase or unchanged."], "The expected measurement direction is missing or unsupported.");
      const agrees = actual === expected && (scope.percent === undefined || (typeof scope.percent === "number" && Math.abs(metric.percent - scope.percent) <= (scope.tolerance ?? 0)));
      return { authorClaim, checkType: authorClaim.check_type, assessment: agrees ? "Supported" : "Contradicted", structuralScope: null,
        evidence: [...suppliedEvidence, ...metric.evidence], missingEvidence: [],
        reason: agrees ? "The selected comparable observations support the scoped descriptive delta; they do not establish causality or repeatability."
          : "The selected comparable observations positively conflict with the claimed direction or percentage; they do not establish causality." };
    }
    if (authorClaim.check_type === "external-correctness") {
      const expected = scope.expected;
      if (!["equivalent", "different"].includes(expected) || !["external-check-passed", "external-check-failed"].includes(correctnessResult.status)) {
        return missing(authorClaim, ["A scoped external correctness result and expected equivalent/different outcome."], "CH Query cannot infer correctness from SQL, plans, counts or runtime measurements.");
      }
      const agrees = (expected === "equivalent") === (correctnessResult.status === "external-check-passed");
      return { authorClaim, checkType: authorClaim.check_type, assessment: agrees ? "Supported" : "Contradicted", structuralScope: scope.description || null,
        evidence: suppliedEvidence, missingEvidence: [], reason: `${agrees ? "The" : "A conflicting"} imported external check assertion addresses this scope; CH Query did not independently verify it.` };
    }
    const chain = Array.isArray(scope.baseline_chain) ? scope.baseline_chain : [];
    const baselineAnchor = baselineNodes.get(scope.baseline_anchor?.path), candidateAnchor = candidateNodes.get(scope.candidate_anchor?.path);
    const signaturesMatch = chain.every(item => {
      const node = baselineNodes.get(item.path);
      return node && node["Node Type"] === item.operator_type && equal(item.properties || {}, Object.fromEntries(Object.entries(suppliedProperties(node)).filter(([key]) => Object.hasOwn(item.properties || {}, key))));
    });
    if (!chain.length || !signaturesMatch || !baselineAnchor || !candidateAnchor ||
        baselineAnchor["Node Type"] !== scope.baseline_anchor.operator_type || candidateAnchor["Node Type"] !== scope.candidate_anchor.operator_type) {
      return missing(authorClaim, ["Existing canonical source paths, ordered operator types/properties and both branch anchors."], "The canonical scope or chain signature does not resolve in the supplied plans.");
    }
    if (matching.forward.get(baselineAnchor.nodeId) !== candidateAnchor.nodeId) {
      return missing(authorClaim, ["Unique heuristic correspondence between the nominated branch anchors."], "A user-selected anchor is asserted context, not identity proof.");
    }
    const ids = chain.map(item => baselineNodes.get(item.path).nodeId), idSet = new Set(ids);
    const contiguous = ids.every(id => idSet.has(matching.left.parents.get(id)) || matching.left.parents.get(id) === baselineAnchor.nodeId);
    if (!contiguous) return missing(authorClaim, ["A contiguous chain below the baseline anchor."], "The nominated baseline nodes do not form one scoped chain.");
    const mapped = ids.map(id => matching.forward.get(id));
    if (mapped.every(Boolean)) {
      const mappedSet = new Set(mapped);
      const candidateContiguous = mapped.every(id => matching.right.parents.get(id) === candidateAnchor.nodeId || mappedSet.has(matching.right.parents.get(id)));
      if (candidateContiguous) return { authorClaim, checkType: authorClaim.check_type, assessment: "Contradicted",
        structuralScope: { baselineAnchor: scope.baseline_anchor, candidateAnchor: scope.candidate_anchor, baselineChain: chain,
          candidatePaths: mapped.map(id => matching.right.sourcePaths.get(id)) },
        evidence: suppliedEvidence, missingEvidence: [], reason: "Positive heuristic correspondence finds the scoped chain in the nominated candidate branch." };
    }
    const types = ids.map(id => baselineById.get(id)["Node Type"]);
    const possibleRelocation = matching.right.nodes.some(node => types.includes(node["Node Type"]));
    const candidateProperties = stableStringify(matching.right.nodes.map(suppliedProperties)).toLowerCase();
    const possibleFusion = types.some(type => candidateProperties.includes(String(type).toLowerCase()));
    const candidateBranch = matching.right.nodes.filter(node => matching.right.sourcePaths.get(node.nodeId).startsWith(`${scope.candidate_anchor.path}.Plans[`));
    const unmatchedCandidate = new Set(matching.result.candidateUnmatched.map(item => item.nodeId));
    const descriptionPoor = [...ids.map(id => baselineById.get(id)), candidateAnchor, ...candidateBranch].some(node => typeof node.Description !== "string" || !node.Description.trim());
    if (mapped.some(Boolean) || possibleRelocation || possibleFusion || candidateBranch.some(node => unmatchedCandidate.has(node.nodeId)) || descriptionPoor) {
      return missing(authorClaim, ["Unambiguous described branch evidence excluding relocation, fusion or naming changes."],
        "Some scoped evidence is matched, description-poor, or candidate operators/properties indicate relocation, fusion or a naming change.");
    }
    return { authorClaim, checkType: authorClaim.check_type, assessment: "Supported",
      structuralScope: { baselineAnchor: scope.baseline_anchor, candidateAnchor: scope.candidate_anchor, baselineChain: chain },
      evidence: [...suppliedEvidence, ...ids.map(id => ref("baseline", matching.left.sourcePaths.get(id), id))], missingEvidence: [],
      reason: "Chain present in baseline; not found in the corresponding candidate branch. This is scoped structural support, not proof of semantic removal or causal speedup." };
  });
}

function scopeKey(scope, mapping) {
  if (!scope) return null;
  const nodes = scope.nodeIds || [];
  const mapped = mapping ? nodes.map(id => mapping.get(id)) : nodes;
  if (mapped.some(id => id === undefined)) return null;
  return stableStringify([scope.kind, [...mapped].sort(), scope.setting || null]);
}

function compareFindingTransitions(a, b, matching) {
  const transitions = [], used = new Set();
  const ruleScopeKey = (item, mapping) => {
    const scope = scopeKey(item.evidenceScope, mapping);
    return scope === null ? null : stableStringify([item.ruleId || item.id, item.ruleRevision, scope]);
  };
  const index = items => {
    const map = new Map();
    for (const item of items) {
      const key = ruleScopeKey(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return map;
  };
  const candidateFindings = index(b.findings);
  const baselineEvaluations = index(a.evaluations), candidateEvaluations = index(b.evaluations);
  const negative = (finding, own, other, mapping) => {
    const key = ruleScopeKey(finding, mapping);
    if (key === null) return false;
    const positive = own.get(ruleScopeKey(finding)) || [];
    if (!positive.length || positive.some(item => item.status !== "evaluated")) return false;
    const evaluations = other.get(key) || [];
    return evaluations.length > 0 && evaluations.every(item => item.status === "evaluated" && item.findingIds.length === 0);
  };
  const details = finding => ({ classification: finding.classification, severity: finding.severity, impactConfidence: finding.impactConfidence,
    evidence: finding.evidence, requiredEvidence: finding.requiredEvidence, priorityReason: finding.priorityReason });
  for (const baseline of a.findings) {
    const key = ruleScopeKey(baseline, matching.forward);
    const candidates = key === null ? [] : candidateFindings.get(key) || [];
    const candidate = candidates.length === 1 && !used.has(candidates[0].occurrenceId) ? candidates[0] : null;
    if (candidate) used.add(candidate.occurrenceId);
    const state = candidate ? equal(details(baseline), details(candidate)) ? "persisting" : "changed" : negative(baseline, baselineEvaluations, candidateEvaluations, matching.forward) ? "resolved" : "not-assessable";
    transitions.push({ ruleId: baseline.id, state, baseline, candidate,
      reason: candidate ? "Same rule on a heuristically matched evidence scope; retain both claims."
        : state === "resolved" ? "Matched scope has an evaluated negative detection; this is not proof of a runtime fix."
          : "Candidate scope or negative rule coverage is unavailable; absence does not establish resolution." });
  }
  for (const candidate of b.findings.filter(item => !used.has(item.occurrenceId))) {
    const state = negative(candidate, candidateEvaluations, baselineEvaluations, matching.reverse) ? "introduced" : "not-assessable";
    transitions.push({ ruleId: candidate.id, state, baseline: null, candidate,
      reason: state === "introduced" ? "Matched baseline scope has an evaluated negative detection."
        : "Present only in candidate; baseline scope or negative rule coverage is unavailable." });
  }
  return transitions;
}

function correctness(context) {
  const input = context?.correctness;
  const allowed = ["unknown", "user-attested", "external-check-passed", "external-check-failed"];
  const status = isRecord(input) && allowed.includes(input.status) ? input.status : "unknown";
  return { status, ...Object.fromEntries(["method", "scope", "checked_at"].filter(key => typeof input?.[key] === "string").map(key => [key, input[key]])),
    limitation: "Imported assertions are not independently verified. Equal SQL, plans or result row counts do not prove semantic correctness.",
    favorableConclusionAllowed: false };
}

/** Settings knowledge is an explicit shared context, used for both sides.
 * No I/O, clock, global review state, or mutation of the source pair. */
export function compareBundles(pair, { catalog = {}, concerns = {}, sampleGroups = {} } = {}) {
  assertComparisonEvidence(pair, { pair: true });
  const sides = {};
  for (const role of roles) {
    const bundle = pair[role].bundle;
    const estimates = parseEstimate(bundle.explain.estimate || []);
    const plan = buildPlanModel(parseExplainPlan(bundle.explain.plan), estimates);
    const options = { selectedGroup: sampleGroups[role] };
    const neutral = readBundleMeasurements(bundle, options);
    const coverage = withMeasurementCoverage(buildEvidenceCoverage(plan, estimates, bundle), neutral, options);
    const measurements = { ...neutral, samples: neutral.samples.map(sample => ({ ...sample, evidence: ref(role, sample.evidence.path) })) };
    sides[role] = { plan, coverage,
      ...evaluateFindings(plan, { sql: bundle.sql, syntax: bundle.explain.syntax, bundle, settings: bundle.settings, clickhouse: bundle.clickhouse, schema: bundle.schema, catalog, concerns }),
      measurements };
  }
  const a = pair.baseline.bundle, b = pair.candidate.bundle;
  const dimensions = [
    ...protocolFields.map(name => dimension(name, sides.baseline.measurements.selectedProvenance[name], sides.candidate.measurements.selectedProvenance[name])),
    dimension("clickhouse_version", a.clickhouse?.version, b.clickhouse?.version),
    dimension("deployment", a.clickhouse?.cloud_mode, b.clickhouse?.cloud_mode),
    dimension("schema", a.schema, b.schema), dimension("supplied_settings", a.settings?.changed, b.settings?.changed)
  ];
  const matching = compareStructure(sides.baseline.plan, sides.candidate.plan);
  const metrics = compareMetrics(sides, dimensions), correctnessResult = correctness(pair.context);
  const fidelities = Object.fromEntries(roles.map(role => [role, fidelity(pair[role].bundle, sides[role].plan)]));
  return { version: 1, comparisonRevision: COMPARISON_REVISION, analysisRevision: sides.baseline.analysisRevision,
    name: pair.name || "", question: pair.question || "", labels: Object.fromEntries(roles.map(role => [role, pair[role].label || role])),
    settingsKnowledge: { catalogSource: catalog.generated_from ? structuredClone(catalog.generated_from) : null, concerns: Object.keys(concerns).length ? "caller-supplied; no independent revision supplied" : "not-supplied" },
    hypothesis: pair.context?.hypothesis || "", correctness: correctnessResult,
    comparability: { dimensions, status: dimensions.some(item => item.status === "different") ? "different" : dimensions.some(item => item.status === "unknown") ? "unknown" : "supplied-context-consistent",
      limitation: "Agreement of supplied context is not independent verification, causal attribution or proof of improvement." },
    sql: compareSql(a.sql, b.sql, redacted(a) || redacted(b)), settings: compareSettings(a, b, redacted(a) || redacted(b)),
    structure: matching.result, metrics, fidelity: { sides: fidelities,
      differences: [dimension("collection_profile", fidelities.baseline.collectionProfile, fidelities.candidate.collectionProfile),
        dimension("source_relation", fidelities.baseline.sourceRelation, fidelities.candidate.sourceRelation),
        dimension("description_coverage", `${fidelities.baseline.describedNodes}/${fidelities.baseline.totalNodes}`, `${fidelities.candidate.describedNodes}/${fidelities.candidate.totalNodes}`),
        dimension("settings_evidence_coverage", fidelities.baseline.settingsCoverage.status, fidelities.candidate.settingsCoverage.status),
        dimension("settings_collection_state", fidelities.baseline.settingsCoverage.collectionState, fidelities.candidate.settingsCoverage.collectionState)],
      limitation: "Fidelity gaps limit only conclusions that depend on the missing evidence; independently supported observations remain available." },
    claims: assessClaims(pair.context?.claims || [], matching, metrics, correctnessResult),
    findings: compareFindingTransitions(sides.baseline, sides.candidate, matching),
    sides: Object.fromEntries(roles.map(role => [role, { label: pair[role].label || role, coverage: sides[role].coverage,
      measurements: sides[role].measurements, evaluations: sides[role].evaluations, tableEstimates: sides[role].plan.tableEstimates }])),
    limitations: ["No automatic execution or result verification.", "Single observations do not prove improvement; repeats require representative controlled conditions.",
      "Scan estimates are table-wide and remain separate from query-wide measurements; repeated reads have unknown allocation.",
      "Missing findings or review dispositions are not fixes. Unmatched scopes remain not assessable.",
      "Independent redaction cannot establish equal literals. Reports may retain identifiers and unsupported sensitive fields."] };
}

/** Stable pair input for concise browser/CLI briefs. This selects no checks and
 * drops no report evidence; callers retain the full compareBundles result for
 * drill-down and apply their own bounded presentation policy.
 */
export function comparisonBriefInput(report) {
  if (!isRecord(report) || report.version !== 1 || report.comparisonRevision !== COMPARISON_REVISION) throw new TypeError("Expected a current CH Query comparison report.");
  return {
    name: report.name, question: report.question, labels: structuredClone(report.labels),
    claims: structuredClone(report.claims), branches: structuredClone(report.structure.branches),
    fidelity: structuredClone(report.fidelity), metrics: structuredClone(report.metrics),
    correctness: structuredClone(report.correctness), hypothesis: report.hypothesis,
    limitations: structuredClone(report.limitations)
  };
}
