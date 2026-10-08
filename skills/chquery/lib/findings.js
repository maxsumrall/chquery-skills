import { analyzeSettings } from "./settings.js";
import { flattenPlan, isJoinNode } from "./model.js";
import { inspectSqlFilterPushdown, inspectSqlJoins } from "./sql-evidence.js";
import { parseEstimateCount } from "./parser.js";
import { ANALYSIS_REVISION, RULE_REVISION, describeFinding, evidenceScope, selectCandidates, sortFindings } from "./finding-contract.js";

let settingsKnowledge;

export function configureSettingsKnowledge(catalog, concerns) {
  settingsKnowledge = { catalog, concerns };
}

function finding(node, id, severity, message, recommendation, {
  confidence = "high",
  evidence = [],
  nodeIds = [node.nodeId],
  why,
  semanticPreconditions,
  absoluteImpact
} = {}) {
  if (!why) throw new Error(`Finding ${id} must explain why it matters`);
  return {
    id,
    severity,
    confidence,
    evidence: [
      ["Plan node", node["Node Type"] || "Unknown"],
      ...(node.Description ? [["Description", node.Description]] : []),
      ...evidence
    ],
    nodeIds,
    type: id,
    message,
    why,
    recommendation,
    ...(semanticPreconditions ? { semanticPreconditions } : {}),
    ...(absoluteImpact ? { absoluteImpact } : {}),
    nodeId: nodeIds[0]
  };
}

function granuleRatio(index) {
  const selected = parseEstimateCount(index?.["Selected Granules"]);
  const initial = parseEstimateCount(index?.["Initial Granules"]);
  return initial > 0 && selected !== null && selected <= initial ? selected / initial : null;
}

function granuleEvidence(index) {
  const selected = Number(index?.["Selected Granules"]);
  const initial = Number(index?.["Initial Granules"]);
  const ratio = granuleRatio(index);
  return Number.isFinite(selected) && Number.isFinite(initial)
    ? `${selected.toLocaleString()} / ${initial.toLocaleString()}${ratio === null ? "" : ` (${(ratio * 100).toFixed(1)}%)`}`
    : "Not reported";
}

function countEvidence(node, index) {
  const fields = [
    ["Estimated rows", node.stats?.rows], ["Estimated parts", node.stats?.parts],
    ["Estimated bytes", node.stats?.bytes], ["Selected parts", parseEstimateCount(index?.["Selected Parts"])],
    ["Selected granules", parseEstimateCount(index?.["Selected Granules"])]
  ];
  return fields.filter(([, value]) => value !== null && value !== undefined).map(([label, value]) => [label, Number(value).toLocaleString()]);
}

function scanIsMaterial(node, index) {
  const rows = node.stats?.rows;
  const bytes = node.stats?.bytes;
  const granules = parseEstimateCount(index?.["Selected Granules"]);
  const parts = parseEstimateCount(index?.["Selected Parts"]);
  return (rows !== null && rows >= 1_000_000) || (bytes !== null && bytes >= 128 * 1024 * 1024) || (granules !== null && granules >= 1024) || (parts !== null && parts >= 16);
}

function scanImpact(node, index) {
  return {
    estimatedRows: node.stats?.rows ?? null,
    estimatedBytes: node.stats?.bytes ?? null,
    selectedParts: parseEstimateCount(index?.["Selected Parts"]),
    selectedGranules: parseEstimateCount(index?.["Selected Granules"])
  };
}

function usablePruning(indexes) {
  return indexes.filter(index => granuleRatio(index) !== null);
}

function mergeTreeFindings(node) {
  if (node["Node Type"] !== "ReadFromMergeTree") return [];

  const indexes = node.Indexes || [];
  const primaryKey = indexes.find(index => index.Type === "PrimaryKey");
  const condition = String(primaryKey?.Condition || "").trim();
  const noPrimaryKeyCondition = !primaryKey || !condition || condition.toLowerCase() === "true";
  const findings = [];
  const pruning = usablePruning(indexes);
  const otherStagePrunes = pruning.some(index => index !== primaryKey && granuleRatio(index) < 0.7);
  const impactStage = primaryKey || pruning[0];
  const material = scanIsMaterial(node, impactStage);

  if (noPrimaryKeyCondition) {
    findings.push(finding(
      node,
      "full_table_scan",
      condition ? "medium" : "low",
      condition ? `No primary-key condition limits the scan of ${node.Description || "this table"}` : `Primary-key condition evidence is missing for ${node.Description || "this table"}`,
      condition ? otherStagePrunes
        ? "A separate reported pruning stage excludes granules; inspect stage order and absolute read evidence before proposing a primary-key predicate."
        : "Add a predicate aligned with the leading primary-key columns, or verify that reading the full table is intentional."
        : "Inspect complete index evidence before concluding that this is a full scan.",
      {
        confidence: condition ? "high" : "low",
        why: condition
          ? `The primary-key condition is ${condition || "not reported"}, so this sparse-primary-index stage excludes no granules${granuleRatio(primaryKey) === 1 ? ` (${Number(primaryKey["Initial Granules"]).toLocaleString()} retained at this stage)` : ""}. Other reported stages are listed separately and may prune further.`
          : "No primary-key index entry is reported, so this plan provides no evidence that ClickHouse can exclude granules before reading the table.",
        absoluteImpact: scanImpact(node, impactStage),
        evidence: [
          ["Table", node.Description || "Unknown"],
          ["Primary-key condition", primaryKey ? condition || "Not reported" : "No PrimaryKey index entry"],
          ...(primaryKey ? [["Primary-key granules", granuleEvidence(primaryKey)]] : []),
          ...countEvidence(node, impactStage),
          ["Usable pruning stages", pruning.length ? pruning.map(index => `${index.Type || "Unknown"}: ${granuleEvidence(index)}`).join("; ") : "None reported"]
        ]
      }
    ));
    if (!condition || !material || otherStagePrunes) findings.at(-1).classification = "observation";
  } else {
    const selectivity = granuleRatio(primaryKey);
    if (selectivity !== null && selectivity > 0.7) {
      const keys = primaryKey.Keys || [];
      findings.push(finding(
        node,
        "poor_selectivity",
        "medium",
        `The primary-key stage retains ${(selectivity * 100).toFixed(1)}% of granules on ${node.Description || "this table"}`,
        otherStagePrunes
          ? "A separate reported pruning stage excludes granules; inspect stage order and absolute read evidence before proposing a primary-key rewrite."
          : `Refine predicates on the primary-key order${keys.length ? `, starting with ${keys.join(", ")}` : ""}.`,
        {
          why: `The primary-key condition retained ${Number(primaryKey["Selected Granules"]).toLocaleString()} of ${Number(primaryKey["Initial Granules"]).toLocaleString()} granules, so this stage alone skipped little. Other reported stages are listed separately; these counts do not establish final rows read.`,
          absoluteImpact: scanImpact(node, impactStage),
          evidence: [
            ["Primary-key keys", keys.length ? keys.join(", ") : "Not reported"],
            ["Primary-key condition", condition],
            ["Primary-key granules", granuleEvidence(primaryKey)],
            ...countEvidence(node, impactStage),
            ["Usable pruning stages", pruning.map(index => `${index.Type || "Unknown"}: ${granuleEvidence(index)}`).join("; ")]
          ]
        }
      ));
      if (!material || otherStagePrunes) findings.at(-1).classification = "observation";
    }
  }

  const unusedSkippingIndexes = indexes.filter(index =>
    String(index.Type || "").toLowerCase() === "skip" &&
    granuleRatio(index) === 1
  );
  if (unusedSkippingIndexes.length) {
    findings.push(finding(
      node,
      "skipping_index_unused",
      "medium",
      `${unusedSkippingIndexes.length === 1 ? "A skipping index is" : "Skipping indexes are"} present but select no fewer granules`,
      "Check that the filter expression matches the index expression and that its data distribution can exclude granules.",
      {
        why: `A data-skipping index avoids reads only when it can prove that granules contain no matching values; ${unusedSkippingIndexes.length === 1 ? "this index kept every granule" : `all ${unusedSkippingIndexes.length} indexes kept every granule`}.`,
        absoluteImpact: scanImpact(node, impactStage),
        evidence: unusedSkippingIndexes.flatMap(index => [
          ["Index", [index.Type, index.Name].filter(Boolean).join(" · ")],
          ["Index condition", index.Condition || "Not reported"],
          ["Index granules", granuleEvidence(index)]
        ])
      }
    ));
    if (!material) findings.at(-1).classification = "observation";
  }

  return findings;
}

function joinFindings(node, ancestors, context) {
  if (!isJoinNode(node) || /array/i.test(node["Node Type"])) return [];
  const findings = [];
  const childrenCount = (node.children || []).length;
  const rightRows = node.children?.[1]?.flowRows;
  const description = node.Description || "";
  const sqlJoin = context.sqlJoins.length === 1 && context.joinNodes.length === 1 ? context.sqlJoins[0] : null;
  const crossJoinEvidence = sqlJoin?.cross ? sqlJoin.shape : /\bcross\b/i.test(description) ? description : null;
  let rightStage = node.children?.[1];
  while (rightStage?.["Node Type"] === "Expression" && rightStage.children?.length === 1) rightStage = rightStage.children[0];
  const scalar = sqlJoin?.cross && sqlJoin.scalar && rightStage?.["Node Type"] === "Aggregating";

  if (childrenCount > 2) {
    findings.push(finding(
      node,
      "complex_join",
      "medium",
      `Complex join pattern detected with ${childrenCount} inputs`,
      "Consider breaking down complex joins into simpler steps or using materialized views.",
      { why: `This join combines ${childrenCount} inputs in one stage. Each additional input must be read and joined, increasing the intermediate work and making join order more consequential.` }
    ));
  }

  if (crossJoinEvidence) {
    findings.push(finding(
      node,
      "cross_join",
      "low",
      scalar ? "This constant-true join has a scalar MIN right input" : "A Cartesian join shape is present; its expansion is unknown",
      scalar ? "Keep the scalar join if it expresses the intended timestamp boundary; inspect aggregate scan work separately." : "Inspect rows reaching both join inputs after filtering and aggregation before changing the join condition.",
      {
        confidence: scalar ? "medium" : "high",
        why: scalar ? "The supplied SQL's outer MIN has no GROUP BY and returns at most one row, even though its source CTE may group rows. The sole plan join has aggregation on the right. This supported SQL shape cannot multiply baseline rows; SQL/plan correspondence remains unverified and computing MIN may still require scan work."
          : "A Cartesian join pairs left and right rows, but the plan does not establish the sizes reaching this join. Scan estimates do not establish those input sizes after filtering or aggregation. This is not proof of expensive expansion.",
        evidence: [
          ["Join shape", crossJoinEvidence],
          ["Right output bound", scalar ? "At most one row from outer global MIN (SQL inference)" : "Unknown"],
          ...(sqlJoin ? [["SQL offsets", `${sqlJoin.start}:${sqlJoin.end}`]] : [])
        ]
      }
    ));
    const cross = findings.at(-1);
    cross.classification = scalar ? "observation" : "hypothesis";
    cross.sqlSpan = sqlJoin ? { start: sqlJoin.start, end: sqlJoin.end } : null;
  }

  if (Number.isFinite(rightRows) && rightRows >= 1_000_000) {
    findings.push(finding(
      node,
      "large_join_right_side",
      "low",
      `The join's right-side scans are estimated to read ${rightRows.toLocaleString()} rows`,
      "Measure rows reaching the join after filtering or aggregation before deciding whether to reduce the right input or change the join algorithm.",
      {
        why: `EXPLAIN ESTIMATE attributes ${rightRows.toLocaleString()} scan rows to the right subtree. Filters and aggregations can reduce that input before the join, so these are not estimated build rows or proof of memory pressure.`,
        evidence: [
          ["Right-side estimated scan rows", rightRows.toLocaleString()],
          ["Right-side source", node.children[1].table ? `${node.children[1].table.database}.${node.children[1].table.name}` : "Derived subtree"]
        ]
      }
    ));
  }

  const algorithmReported = /\b(hash|grace_hash|partial_merge|full_sorting_merge|direct|parallel_hash)\b/i.test(description);
  if (!algorithmReported) {
    findings.push(finding(
      node,
      "join_algorithm_unspecified",
      "low",
      "Weak signal: the evidence does not identify the join algorithm",
      "Confirm join_algorithm before assuming how the right side will be built or spilled.",
      {
        confidence: "low",
        why: "ClickHouse join algorithms make different memory, sorting, and spill tradeoffs. This plan node does not identify its selected algorithm. SQL hints and session settings are not used to establish a per-node algorithm, so this evidence cannot establish how this join will consume resources.",
        evidence: [
          ["Plan description", description || "No algorithm reported"],
          ["SQL hints and session settings", "Not used to establish this node's algorithm"]
        ]
      }
    ));
  }

  return findings;
}

function distinctFindings(node, ancestors) {
  if (node["Node Type"] !== "Distinct") return [];
  const distinctBranches = current => (current.children || []).filter(child => containsNode(child, /^Distinct$/));
  const lastBranch = ancestors.findLastIndex(ancestor => distinctBranches(ancestor).length > 1);
  if (ancestors.slice(lastBranch + 1).some(ancestor => ancestor["Node Type"] === "Distinct")) return [];
  const stages = [];
  let current = node;
  while (current) {
    if (current["Node Type"] === "Distinct") stages.push(current);
    const branches = distinctBranches(current);
    current = branches.length === 1 ? branches[0] : null;
  }
  // A preliminary/final pair implements one DISTINCT, not duplicate SQL work.
  const finalStages = stages.filter(stage => !/preliminary\s+distinct/i.test(stage.Description || ""));
  return finalStages.length > 1 ? [finding(
    node,
    "multiple_distinct",
    "medium",
    `Multiple non-preliminary DISTINCT stages (${finalStages.length}) occur in one nested chain`,
    "Inspect the logical DISTINCT operations and intervening columns before considering a rewrite; this plan alone does not prove any stage is redundant.",
    {
      confidence: "low",
      why: `This chain contains ${finalStages.length} non-preliminary DISTINCT stages. Preliminary stages are part of physical execution, and intervening operations may change columns or introduce duplicates; stage count alone cannot establish removable work.`,
      evidence: [
        ["DISTINCT stages", String(stages.length)],
        ...stages.map((stage, index) => [`Stage ${index + 1}`, stage.Description || "No description reported"])
      ],
      nodeIds: stages.map(stage => stage.nodeId)
    }
  )] : [];
}

function containsNode(node, pattern) {
  if (pattern.test(node["Node Type"] || "")) return true;
  return (node.children || []).some(child => containsNode(child, pattern));
}

function sortingFindings(node, ancestors) {
  if (node["Node Type"] !== "Sorting") return [];
  const windowIndex = ancestors.findLastIndex(ancestor => ancestor["Node Type"] === "Window");
  const window = ancestors[windowIndex];
  const windowScope = window && ancestors.slice(windowIndex + 1).every(ancestor => ancestor["Node Type"] === "Expression");
  if (windowScope) {
    const item = finding(node, "window_ordering", "low", "A sort supplies required ordering to a Window stage",
      "Keep this ordering unless an equivalence check establishes that the Window can consume an already compatible order.", {
        why: "Window functions require their declared partition/order sequence. A LIMIT would bound output, not preserve complete-history Window results, so no LIMIT rewrite is suggested.",
        evidence: [["Window path", window.nodeId], ["Sort purpose", node.Description || "Window input ordering"]],
        nodeIds: [node.nodeId, window.nodeId]
      });
    item.classification = "observation";
    return [item];
  }
  if (window) return [];
  const limitIndex = ancestors.findLastIndex(ancestor => ancestor["Node Type"] === "Limit");
  const hasLimit = limitIndex >= 0 && ancestors.slice(limitIndex + 1).every(ancestor => ancestor["Node Type"] === "Expression");
  if (hasLimit) return [];

  const afterAggregate = (node.children || []).some(child => containsNode(child, /aggregat/i));
  return [finding(
    node,
    "unbounded_sort",
    afterAggregate ? "medium" : "low",
    afterAggregate ? "Sorting after aggregation without LIMIT can retain the full result set" : "Sorting without LIMIT detected",
    "Establish the result scope, required ordering, and actual rows reaching this sort before considering a bounded top-N rewrite.",
    {
      why: afterAggregate
        ? "Without LIMIT, sorting memory is proportional to the complete aggregate output, and rows cannot be emitted in final order until that result has been sorted."
        : "Without LIMIT, sorting memory is proportional to the complete intermediate input rather than a bounded top-N set.",
      evidence: [
        ["LIMIT above sort", "Not present"],
        ["Aggregate below sort", afterAggregate ? "Yes" : "No"]
      ],
      semanticPreconditions: ["bounded output is part of the query contract", "LIMIT applies at this exact result scope", "complete ordered output is not required"]
    }
  )].map(item => { item.classification = "observation"; return item; });
}

function unionFindings(node) {
  if (node["Node Type"] !== "Union") return [];
  const hasDistinctDescendant = (node.children || []).some(child => containsNode(child, /^Distinct$/));
  return hasDistinctDescendant ? [finding(
    node,
    "union_distinct",
    "low",
    "UNION DISTINCT operation detected",
    "Use UNION ALL when duplicate rows are acceptable.",
    {
      why: `UNION reads and merges all ${(node.children || []).length} inputs, and DISTINCT must then compare rows to retain only unique results. UNION ALL can stream the inputs without that duplicate-elimination stage.`,
      evidence: [["Union inputs", String((node.children || []).length)]]
    }
  )] : [];
}

function lateFilterFindings(node, ancestors, context) {
  if (node["Node Type"] !== "Filter" || /having/i.test(node.Description || "")) return [];
  let blockedStage = node.children?.[0];
  let interveningExpressions = 0;
  while (blockedStage?.["Node Type"] === "Expression" && blockedStage.children?.length === 1) {
    blockedStage = blockedStage.children[0];
    interveningExpressions += 1;
  }
  if (!blockedStage || (!isJoinNode(blockedStage) && !/aggregat/i.test(blockedStage["Node Type"] || ""))) blockedStage = null;
  if (!blockedStage) return [];
  const dependency = context.filterNodes === 1 && context.filterJoinScopes === 1 && context.joinNodes.length === 1
    ? context.filterPushdown
    : { status: "unknown", reason: "The plan does not establish one exact Filter-over-Join scope for this SQL predicate." };
  const item = finding(
    node,
    "late_filter",
    "low",
    `Weak signal: a Filter remains above ${blockedStage["Node Type"]}`,
    dependency.status === "supported" ? "Verify this one-input INNER JOIN predicate at the identified scope, then compare the optimizer plan before changing SQL." : "Keep this as an observation until column dependency and join/aggregation semantics establish an equivalent pushdown.",
    {
      confidence: "low",
      why: dependency.status === "supported"
        ? `A filter above ${blockedStage["Node Type"]} is evaluated after that stage. The supplied SQL establishes one qualified INNER JOIN input dependency, but scope correspondence should still be checked before rewriting it.`
        : `A filter above ${blockedStage["Node Type"]} is evaluated after that stage unless the optimizer can safely push it down. This evidence does not establish a one-input dependency or semantics-preserving rewrite.`,
      evidence: [
        ["Filter position", `${interveningExpressions ? `${interveningExpressions} projection stage(s) above` : "Directly above"} ${blockedStage["Node Type"]}`],
        ["Pushdown evidence", dependency.reason]
      ],
      nodeIds: [node.nodeId, blockedStage.nodeId],
      semanticPreconditions: ["predicate depends on one input", "join null-preservation is unchanged", "aggregation scope is unchanged"]
    }
  );
  if (dependency.status !== "supported" || /aggregat/i.test(blockedStage["Node Type"] || "")) item.classification = "observation";
  return [item];
}

function fanoutFindings(node) {
  const findings = [];
  const inputCount = (node.children || []).length;
  if (inputCount >= 3) {
    findings.push(finding(
      node,
      "high_fanout",
      "medium",
      `This stage merges ${inputCount} input branches`,
      "Check each branch independently and prefer fewer passes when the branches repeat work.",
      {
        why: `ClickHouse must execute all ${inputCount} branches before their streams can be merged. The work is additive, so repeated scans or transformations in separate branches are paid for separately.`,
        evidence: [["Input branches", String(inputCount)]]
      }
    ));
  }
  if (/^array\s*join$/i.test(node["Node Type"] || "")) {
    findings.push(finding(
      node,
      "array_join_explosion",
      "low",
      "Weak signal: ARRAY JOIN can multiply each source row by its array length",
      "Filter rows and arrays before ARRAY JOIN, then inspect actual array lengths before treating this as expensive.",
      {
        confidence: "low",
        why: "ARRAY JOIN unfolds each array into one output row per element and duplicates the other column values. The plan does not report array lengths, so it identifies the multiplication mechanism but not its size.",
        evidence: [
          ["Expansion operator", node.Description || node["Node Type"]],
          ["Expansion factor", "Not reported by EXPLAIN PLAN"]
        ]
      }
    ));
  }
  return findings;
}

function prewhereFindings(node, ancestors, context) {
  if (node["Node Type"] !== "ReadFromMergeTree" || typeof context.syntax !== "string") return [];
  const syntax = context.syntax.trim();
  if (!/\bwhere\b/i.test(syntax) || /\bprewhere\b/i.test(syntax)) return [];

  const nearestBlockingStage = [...ancestors].reverse().find(ancestor =>
    isJoinNode(ancestor) || /aggregat|union/i.test(ancestor["Node Type"] || "")
  );
  const hasNearbyWhere = [...ancestors].reverse()
    .slice(0, nearestBlockingStage ? ancestors.length - ancestors.indexOf(nearestBlockingStage) - 1 : ancestors.length)
    .some(ancestor => /where/i.test(ancestor.Description || ""));
  if (!hasNearbyWhere) return [];

  return [finding(
    node,
    "prewhere_not_applied",
    "low",
    "Weak signal: EXPLAIN SYNTAX keeps a scan-local WHERE instead of PREWHERE",
    "Test PREWHERE for selective columns when reading fewer columns early would reduce I/O.",
    {
      confidence: "low",
      why: "PREWHERE reads and filters predicate columns first, then reads other columns only for surviving granules. Because EXPLAIN SYNTAX leaves this scan-local predicate in WHERE, the plan does not show that early column-level I/O reduction.",
      evidence: [
        ["EXPLAIN SYNTAX", syntax],
        ["PREWHERE", "Not present"]
      ]
    }
  )];
}

const rules = [
  mergeTreeFindings,
  joinFindings,
  distinctFindings,
  sortingFindings,
  unionFindings,
  lateFilterFindings,
  fanoutFindings,
  prewhereFindings
];

export function evaluateFindings(plan, context = {}) {
  const findings = [];
  const nodes = flattenPlan(plan);
  const blockedJoin = node => {
    let stage = node.children?.[0];
    while (stage?.["Node Type"] === "Expression" && stage.children?.length === 1) stage = stage.children[0];
    return isJoinNode(stage) && !/array/i.test(stage["Node Type"] || "");
  };
  const filterNodes = nodes.filter(node => node["Node Type"] === "Filter");
  context = { ...context, sqlJoins: inspectSqlJoins(context.sql), filterPushdown: inspectSqlFilterPushdown(context.sql),
    joinNodes: nodes.filter(node => isJoinNode(node) && !/array/i.test(node["Node Type"])),
    filterNodes: filterNodes.length, filterJoinScopes: filterNodes.filter(blockedJoin).length };

  const factualNodes = new Set(nodes);

  function visit(node, ancestors) {
    const factual = factualNodes.has(node);
    if (factual) for (const rule of rules) findings.push(...rule(node, ancestors, context));
    for (const child of node.children || []) visit(child, factual ? [...ancestors, node] : ancestors);
  }

  visit(plan, []);
  if (context.sqlJoins.some(join => join.cross) && (context.sqlJoins.length !== 1 || context.joinNodes.length !== 1)) {
    const item = finding(plan, "cross_join", "low", "SQL contains a Cartesian join; its plan-node attribution is unknown", "Match the SQL join to its plan inputs before investigating expansion.", {
      confidence: "low", nodeIds: [], why: "Query-level SQL evidence cannot identify which plan join receives these inputs. Input sizes after filtering and aggregation remain unknown.", evidence: [["SQL join count", String(context.sqlJoins.length)], ["Plan join count", String(context.joinNodes.length)]]
    });
    item.queryLevel = true;
    findings.push(item);
  }
  const catalog = context.catalog || settingsKnowledge?.catalog;
  const concerns = context.concerns || settingsKnowledge?.concerns;
  if (catalog && concerns) {
    findings.push(...analyzeSettings({
      version: context.clickhouse?.version,
      cloud_mode: context.clickhouse?.cloud_mode,
      changed: context.settings?.changed,
      schema: context.schema,
      plan,
      catalog,
      concerns
    }).findings);
  }
  const described = findings.map(item => describeFinding(item, nodes));
  const evaluations = evaluateRuleCoverage(nodes, described, context);
  // Catalog absence or changed-only settings cannot establish a negative setting
  // conclusion. Positive scopes remain inspectable, with conservative coverage.
  for (const item of described.filter(item => item.settingEvidence || item.queryLevel)) {
    evaluations.push({ ruleId: item.id, ruleRevision: RULE_REVISION, evidenceScope: item.evidenceScope,
      status: item.queryLevel ? "insufficient-evidence" : "evaluated", reason: item.queryLevel ? "SQL-to-plan attribution is unsupported." : "This supplied setting and catalog produced the stated observation.", findingIds: [item.occurrenceId] });
  }
  for (const ruleId of ["setting_obsolete", "setting_changed_relevant", "default_moved_since_version", "cloud_self_hosted_advice_hidden", "cloud_plan_relevant"]) {
    evaluations.push({ ruleId, ruleRevision: RULE_REVISION, evidenceScope: evidenceScope([], null, "settings"), status: "insufficient-evidence", reason: "No complete per-setting negative evaluation contract; changed-only settings or absent catalog/context cannot prove resolution.", findingIds: [] });
  }
  return { analysisRevision: ANALYSIS_REVISION, findings: sortFindings(described), evaluations, candidates: selectCandidates(described) };
}

export function analyzeFindings(plan, context = {}) {
  return evaluateFindings(plan, context).findings;
}

function evaluateRuleCoverage(nodes, findings, context) {
  const definitions = {
    full_table_scan: node => node["Node Type"] === "ReadFromMergeTree",
    poor_selectivity: node => node["Node Type"] === "ReadFromMergeTree",
    skipping_index_unused: node => node["Node Type"] === "ReadFromMergeTree",
    prewhere_not_applied: node => node["Node Type"] === "ReadFromMergeTree",
    cross_join: node => isJoinNode(node) && !/array/i.test(node["Node Type"]),
    complex_join: node => isJoinNode(node) && !/array/i.test(node["Node Type"]),
    large_join_right_side: node => isJoinNode(node) && !/array/i.test(node["Node Type"]),
    join_algorithm_unspecified: node => isJoinNode(node) && !/array/i.test(node["Node Type"]),
    multiple_distinct: node => node["Node Type"] === "Distinct",
    window_ordering: node => node["Node Type"] === "Sorting",
    unbounded_sort: node => node["Node Type"] === "Sorting",
    union_distinct: node => node["Node Type"] === "Union",
    late_filter: node => node["Node Type"] === "Filter",
    high_fanout: () => true,
    array_join_explosion: node => /^array\s*join$/i.test(node["Node Type"])
  };
  const seen = new Set();
  return Object.entries(definitions).flatMap(([ruleId, applies]) => {
    const applicable = nodes.filter(applies);
    if (!applicable.length) return [{ ruleId, ruleRevision: RULE_REVISION, evidenceScope: evidenceScope([], null, "query"), status: "not-applicable", reason: "The parsed plan contains no operator of this rule's type. This is not a matched-scope resolution.", findingIds: [] }];
    return applicable.map(node => {
    const matches = findings.filter(item => item.id === ruleId && !item.queryLevel && item.nodeIds.includes(node.nodeId));
    let status = "evaluated";
    let reason = "Sufficient structural evidence to evaluate this rule's detection, not its performance impact.";
    const primary = node.Indexes?.find(index => index.Type === "PrimaryKey");
    const unavailable = (ruleId === "full_table_scan" && !primary?.Condition) ||
      (ruleId === "poor_selectivity" && (!primary?.Condition || granuleRatio(primary) === null)) ||
      (ruleId === "skipping_index_unused" && (!Array.isArray(node.Indexes) || node.Indexes.some(index => index.Type === "Skip" && granuleRatio(index) === null))) ||
      (ruleId === "prewhere_not_applied" && !context.syntax?.trim()) ||
      (ruleId === "large_join_right_side" && !Number.isFinite(node.children?.[1]?.flowRows)) ||
      (ruleId === "cross_join" && !/\bcross\b/i.test(node.Description || "") && !(context.sqlJoins.length === 1 && context.joinNodes.length === 1 && context.sqlJoins[0].cross));
    if (status === "evaluated" && unavailable) {
      status = "insufficient-evidence";
      reason = "Required index, syntax, scan attribution, or supported SQL-to-plan join evidence is unavailable; absence is not a negative conclusion.";
    }
    return { ruleId, ruleRevision: RULE_REVISION, evidenceScope: matches[0]?.evidenceScope || evidenceScope([node]), status, reason, findingIds: matches.map(item => item.occurrenceId) };
    });
  }).filter(entry => {
    const key = JSON.stringify([entry.ruleId, entry.evidenceScope]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getNodeSuggestion(node) {
  if (!node) {
    return {
      title: "Waiting for evidence",
      body: "Suggestions appear only after CH Query can point to supporting plan details."
    };
  }
  if (node.index && node.index.selectivity > 0.7) {
    return {
      title: "Reduce scanned granules",
      body: `This scan keeps ${(node.index.selectivity * 100).toFixed(1)}% of granules. Check whether the WHERE clause aligns with primary key order: ${node.index.keys?.join(", ") || "unknown keys"}.`
    };
  }
  if (isJoinNode(node)) {
    return {
      title: "Inspect join shape",
      body: "Confirm the smaller side is appropriate and that join keys are selective before tuning lower-level scans."
    };
  }
  if (/sort/i.test(node["Node Type"])) {
    return {
      title: "Check sort pressure",
      body: "If this sort is high in the plan, look for LIMIT, pre-sorted table order, or aggregation opportunities."
    };
  }
  return {
    title: "Compare scans and findings",
    body: "Follow the least-pruned scan path, then inspect findings on joins and sorts. Pruning and scan estimates do not measure execution time."
  };
}
