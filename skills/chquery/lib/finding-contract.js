import { canonicalBranchScope } from "./branch-scope.js";

export const ANALYSIS_REVISION = "safe-findings-1";
export const RULE_REVISION = "4";
export const WORKLOAD_INTENT_REVISION = 1;

export function evidenceScope(nodes = [], setting = null, kind = setting ? "setting" : "node") {
  return { kind, nodeIds: nodes.map(node => node.nodeId), nodes: nodes.map(node => ({ nodeId: node.nodeId, nodeType: node["Node Type"], table: node.table ? `${node.table.database}.${node.table.name}` : null })), setting };
}

const checks = {
  cross_join: ["join-inputs", "Rows reaching both inputs after filtering/aggregation are large and the Cartesian product is required by this join.", "One input has at most one row, or a selective join predicate prevents multiplication."],
  large_join_right_side: ["join-inputs", "Substantial rows still reach the right input after aggregation/filtering.", "The right subtree reduces to a small or scalar result before the join."],
  join_algorithm_unspecified: ["plan", "An exact plan or approved execution trace identifies a resource tradeoff for the chosen algorithm.", "The reported algorithm suits the actual input shape; no algorithm change is justified."],
  full_table_scan: ["indexes", "The complete index evidence retains most granules and the intended query could exclude some.", "Other index stages prune the read, or reading the whole range is intentional."],
  poor_selectivity: ["indexes", "A predicate aligned with the leading key could exclude more granules while preserving results.", "The required result covers most of the table or other pruning stages already reduce the read."],
  skipping_index_unused: ["indexes", "A matching filter and index distribution could exclude more granules.", "The required data spans all granules or the index cannot exclude them for this predicate."],
  multiple_distinct: ["column-lineage", "Nested logical DISTINCTs retain identical columns and no intervening operation can reintroduce duplicates.", "The stages use different columns or intervening operations introduce duplicates."],
  unbounded_sort: ["operator-rows", "The actual aggregate/result set reaching the sort is large and only top results are needed.", "The sorted set is small or the complete ordered result is required."],
  union_distinct: ["sql", "Duplicate elimination across these inputs is unnecessary for the intended result.", "The result requires deduplication or the DISTINCT belongs to a different logical operation."],
  late_filter: ["column-lineage", "The predicate references only one input and can move below the stage without changing results.", "The predicate depends on joined or aggregated values or changes semantics when moved."],
  high_fanout: ["sql", "Branches repeat equivalent work that could be shared without changing results.", "Branches compute distinct required results or sharing them would change semantics."],
  complex_join: ["join-inputs", "Several large inputs reach the join and an equivalent simpler join order reduces intermediate work.", "Inputs are small or the current join structure is necessary."],
  array_join_explosion: ["array-lengths", "Representative array lengths and source rows imply substantial expansion.", "Arrays are short/empty or the expanded output is required and small."],
  prewhere_not_applied: ["syntax", "The filter is selective on a few columns and an equivalent PREWHERE avoids reading other columns early.", "The filter is not selective or the optimizer already applies equivalent early filtering."]
};

export function describeFinding(item, nodes) {
  const scope = evidenceScope(nodes.filter(node => item.nodeIds.includes(node.nodeId)), item.settingEvidence?.setting || null, item.queryLevel ? "query" : item.settingEvidence ? "setting" : "node");
  const classification = item.classification || (["setting_changed_relevant", "default_moved_since_version", "cloud_self_hosted_advice_hidden"].includes(item.id) ? "observation" : "hypothesis");
  const [kind, supporting, weakening] = checks[item.id] || ["settings", "A controlled, separately authorized comparison with the intended settings supports the stated workload tradeoff.", "The setting is irrelevant to the active execution path or a comparable test shows no benefit."];
  const basis = {
    indexes: "Reported index evidence supports checking scan pruning and predicate intent before operator tuning.",
    "join-inputs": "Join-input sizes remain uncertain; checking them comes before a join rewrite or algorithm change.",
    "operator-rows": "The sort's input size and ordering requirements must justify any attempt to bound it.",
    "column-lineage": "Plan structure suggests a possible rewrite, but column lineage must establish that it preserves results.",
    "array-lengths": "The expansion mechanism is visible, but array lengths must establish its size.",
    syntax: "The supplied syntax supports checking early filtering; savings remain a hypothesis.",
    settings: "Reported settings provide context for an explicitly authorized workload check, not proof of a query problem.",
    sql: "Inspect logical query requirements before changing this structural pattern.",
    plan: "The selected execution algorithm needs evidence before its resource tradeoffs can guide tuning."
  }[kind];
  const impactConfidence = classification === "observation" ? null : ["full_table_scan", "poor_selectivity", "skipping_index_unused"].includes(item.id) && item.confidence === "high" ? "medium" : "low";
  const findingPath = item.findingPath || nodes.filter(node => item.nodeIds.includes(node.nodeId)).map(node =>
    node.sourcePath || node.nodeId.replace(/^node-0(?:\.|$)/, "root"));
  const occurrenceId = JSON.stringify([item.id, RULE_REVISION, scope.kind, findingPath, scope.setting, item.settingEvidence?.changed_in_version || null]);
  return { ...item, ruleRevision: RULE_REVISION, occurrenceId, evidenceScope: scope, findingPath, classification,
    observation: { source: item.queryLevel ? "sql" : item.sqlSpan ? "sql-and-plan" : item.settingEvidence ? "settings" : "plan", scope, evidence: item.evidence, ...(item.sqlSpan ? { sqlSpan: item.sqlSpan } : {}) },
    impactConfidence,
    requiredEvidence: classification === "observation" ? [] : [{ kind, scope: kind === "join-inputs" || kind === "operator-rows" ? "operator" : scope.kind, reason: item.recommendation }],
    confirmationCheck: classification === "observation" ? null : { supporting, weakening, limitation: "Query-wide runtime metrics alone cannot confirm an operator-level cause. New experiments require separate authorization." },
    priorityReason: classification === "observation" ? "Structural/context observation, outside the actionable queue."
      : `${basis} ${item.severity} urgency, ${impactConfidence} impact confidence. One place to start, not a measured bottleneck.`,
    eligible: classification === "hypothesis"
  };
}

export function sortFindings(findings) {
  const rank = value => ({ high: 0, medium: 1, low: 2 }[value] ?? 3);
  const absolute = (a, b) => ["estimatedBytes", "estimatedRows", "selectedGranules", "selectedParts"]
    .map(field => (b.absoluteImpact?.[field] ?? -1) - (a.absoluteImpact?.[field] ?? -1)).find(difference => difference) || 0;
  return [...findings].sort((a, b) => Number(a.classification === "observation") - Number(b.classification === "observation") || rank(a.severity) - rank(b.severity) || rank(a.impactConfidence) - rank(b.impactConfidence) || absolute(a, b) || a.id.localeCompare(b.id) || (a.occurrenceId || "").localeCompare(b.occurrenceId || ""));
}

export function selectCandidates(findings, dispositions = {}) {
  return sortFindings(findings).filter(item => item.eligible && !dispositions[item.occurrenceId]);
}

function preconditionKey(item) {
  return JSON.stringify(item.semanticPreconditions || item.requiredEvidence?.map(entry => entry.kind) || []);
}

export function groupFindings(findings = []) {
  const groups = new Map();
  for (const item of sortFindings(findings)) {
    const key = JSON.stringify([item.id, item.classification, preconditionKey(item)]);
    if (!groups.has(key)) groups.set(key, { groupId: key, ruleId: item.id, classification: item.classification, checkKind: item.requiredEvidence?.[0]?.kind || "observation", severity: item.severity, findings: [] });
    groups.get(key).findings.push(item);
  }
  return [...groups.values()].map(group => ({ ...group, count: group.findings.length,
    message: group.findings[0].message, why: group.findings[0].why, recommendation: group.findings[0].recommendation,
    priorityReason: group.findings[0].priorityReason, representative: group.findings[0],
    occurrenceIds: group.findings.map(item => item.occurrenceId),
    occurrences: group.findings.map(item => ({ occurrenceId: item.occurrenceId, path: item.findingPath, nodeIds: item.nodeIds, evidenceScope: item.evidenceScope, message: item.message }))
  }));
}

export function selectCandidateGroups(findings, dispositions = {}, { limit = 3 } = {}) {
  const groups = groupFindings(selectCandidates(findings, dispositions));
  const selected = [];
  for (const group of groups) {
    if (selected.length >= limit) break;
    if (!selected.some(item => item.checkKind === group.checkKind)) selected.push(group);
  }
  for (const group of groups) {
    if (selected.length >= limit) break;
    if (!selected.includes(group)) selected.push(group);
  }
  return selected;
}

export function saveWorkloadIntent({ kind, statement, evidenceRef, branchScope, contractRevision, attestedAt = new Date().toISOString() } = {}) {
  if (![kind, statement, evidenceRef, contractRevision].every(value => typeof value === "string" && value.trim()) || evidenceRef.length > 4096)
    throw new TypeError("Saved workload intent requires nonblank string kind, statement, bounded evidence reference and contract revision, plus structured branch scope.");
  canonicalBranchScope(branchScope);
  return { version: WORKLOAD_INTENT_REVISION, kind, statement, evidenceRef, branchScope, contractRevision, attestedAt,
    state: "attested", stateReason: "Explicitly saved user attestation; assess it against the current evidence before use.",
    limitation: "User-attested workload intent is not proof of business semantics, low cost, or global finding resolution." };
}

export function assessWorkloadIntent(record, { evidenceRef, branchScope, contractRevision } = {}) {
  if (!record || record.version !== WORKLOAD_INTENT_REVISION) return { ...record, state: "stale", stateReason: "Intent contract revision is unsupported; reconfirm intent." };
  const changes = [];
  if (record.evidenceRef !== evidenceRef) changes.push("evidence revision");
  if (canonicalBranchScope(record.branchScope) !== canonicalBranchScope(branchScope)) changes.push("branch scope");
  if (record.contractRevision !== contractRevision) changes.push("evidence contract");
  return changes.length ? { ...record, state: "stale", stateReason: `${changes.join(", ")} changed; reconfirm intent.` }
    : { ...record, state: "current", stateReason: "Intent matches this canonical evidence reference, branch, and contract; it remains user-attested context only." };
}

// Review state is deliberately separate from evidence and deterministic analysis.
export function createInvestigationReview() {
  let identity;
  let reviewRevision = 0;
  let dispositions = {};
  return {
    publish(bundle) {
      const next = JSON.stringify([bundle.sql, bundle.explain, bundle.runtime, bundle.settings, bundle.clickhouse, bundle.schema]);
      if (next !== identity) { dispositions = {}; reviewRevision += 1; }
      identity = next;
    },
    set(occurrenceId, status) {
      if (!["intentional", "not-relevant", "open"].includes(status)) throw new TypeError("Unknown review disposition");
      if (status === "open") delete dispositions[occurrenceId];
      else dispositions[occurrenceId] = status;
    },
    setGroup(group, status) {
      if (!group?.occurrenceIds?.length) throw new TypeError("A finding group with occurrences is required");
      if (status === "open") throw new TypeError("Use restoreGroup to open every occurrence; group undo restores prior dispositions.");
      const previous = Object.fromEntries(group.occurrenceIds.map(occurrenceId => [occurrenceId, dispositions[occurrenceId] || "open"]));
      for (const occurrenceId of group.occurrenceIds) this.set(occurrenceId, status);
      return { version: 1, reviewRevision, applied: status, occurrenceIds: [...group.occurrenceIds], previous };
    },
    undoGroup(change) {
      if (change?.version !== 1 || change.reviewRevision !== reviewRevision || !Array.isArray(change.occurrenceIds) || !change.previous ||
        change.occurrenceIds.some(occurrenceId => dispositions[occurrenceId] !== change.applied)) throw new TypeError("Unknown or stale group disposition change");
      for (const occurrenceId of change.occurrenceIds) this.set(occurrenceId, change.previous[occurrenceId] || "open");
    },
    restoreGroup(group) {
      if (!group?.occurrenceIds?.length) throw new TypeError("A finding group with occurrences is required");
      for (const occurrenceId of group.occurrenceIds) this.set(occurrenceId, "open");
    },
    snapshot() { return { ...dispositions }; },
    clear() { identity = undefined; dispositions = {}; reviewRevision += 1; }
  };
}
