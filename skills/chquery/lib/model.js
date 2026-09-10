import { evaluateMetric, inheritPlanAnalysis, isSyntheticPlanRoot, parseEstimateCount } from "./parser.js";
import { parseTableReference } from "./identifiers.js";

export function flattenPlan(node, nodes = []) {
  if (!isSyntheticPlanRoot(node)) nodes.push(node);
  for (const child of node.children || []) flattenPlan(child, nodes);
  return nodes;
}

export function isJoinNode(node) {
  const type = node["Node Type"] || "";
  return /join/i.test(type) && type !== "JoinLazyColumnsStep";
}

export function getNodeKind(node) {
  const type = node["Node Type"] || "Unknown";
  if (type === "ReadFromMergeTree") return "Table scan";
  if (isJoinNode(node)) return "Join";
  if (/sort/i.test(type)) return "Sort";
  if (/aggregat/i.test(type)) return "Aggregation";
  return "Plan node";
}

export function getTableReference(node) {
  if (node["Node Type"] !== "ReadFromMergeTree") return null;
  return parseTableReference(node.Description);
}

export function getIndexDetails(node) {
  const index = node.Indexes?.find(item => Number(item["Initial Granules"]) > 0
    && item["Selected Granules"] != null && Number.isFinite(Number(item["Selected Granules"])));
  if (!index) return null;
  return {
    type: index.Type || "Unknown",
    keys: index.Keys || [],
    condition: index.Condition,
    selectedGranules: index["Selected Granules"] || 0,
    initialGranules: index["Initial Granules"] || 0,
    selectivity: (index["Selected Granules"] || 0) / (index["Initial Granules"] || 1)
  };
}

export function getHeatLevel(node) {
  const index = getIndexDetails(node);
  if (!index) return 0;
  const selectivity = index.selectivity;
  if (selectivity >= .85) return 5;
  if (selectivity >= .65) return 4;
  if (selectivity >= .4) return 3;
  if (selectivity >= .2) return 2;
  return 1;
}

function getEstimateStats(table, estimates) {
  if (!table) return null;
  const estimate = estimates[`${table.database}.${table.name}`];
  if (!estimate) return null;
  const rows = parseEstimateCount(estimate.rows);
  const parts = parseEstimateCount(estimate.parts);
  const marks = parseEstimateCount(estimate.marks);
  return {
    rows,
    parts,
    marks,
    rowsPerMark: rows !== null && marks > 0 ? Math.round(rows / marks) : null,
    rowsPerPart: rows !== null && parts > 0 ? Math.round(rows / parts) : null
  };
}

export function buildPlanModel(plan, estimates = {}) {
  const readCounts = new Map();
  for (const node of flattenPlan(plan)) {
    const table = getTableReference(node);
    if (table) {
      const key = `${table.database}.${table.name}`;
      readCounts.set(key, (readCounts.get(key) || 0) + 1);
    }
  }
  // EXPLAIN ESTIMATE identifies tables, not individual reads of those tables.
  const tableEstimates = [...readCounts].filter(([table]) => estimates[table]).map(([table, readCount]) => ({
    table,
    rows: parseEstimateCount(estimates[table].rows),
    parts: parseEstimateCount(estimates[table].parts),
    marks: parseEstimateCount(estimates[table].marks),
    readCount,
    allocation: readCount > 1 ? "ambiguous" : "single-read"
  }));

  function build(node, path) {
    if (isSyntheticPlanRoot(node)) {
      return inheritPlanAnalysis(node, {
        ...node,
        children: node.children.map((child, childIndex) => build(child, `${path}.${childIndex}`)),
        tableEstimates,
        hasAmbiguousEstimate: false,
        heatLevel: 0,
        flowRows: null,
        flowHeatLevel: 0
      });
    }
    const table = getTableReference(node);
    const index = getIndexDetails(node);
    const tableKey = table && `${table.database}.${table.name}`;
    const ambiguous = Boolean(table && estimates[tableKey] && readCounts.get(tableKey) > 1);
    const stats = ambiguous ? null : getEstimateStats(table, estimates);
    const children = node.children?.map((child, childIndex) => build(child, `${path}.${childIndex}`));
    const ownRows = stats ? stats.rows : null;
    const childRows = (children || []).map(child => child.flowRows);
    const heatLevel = getHeatLevel(node);

    return {
      ...node,
      ...(children ? { children } : {}),
      nodeId: `node-${path}`,
      kind: getNodeKind(node),
      table,
      index,
      stats,
      ownRows,
      hasAmbiguousEstimate: ambiguous || (children || []).some(child => child.hasAmbiguousEstimate),
      heatLevel,
      flowRows: Number.isFinite(ownRows)
        ? ownRows
        : childRows.length && childRows.every(Number.isFinite) ? childRows.reduce((sum, rows) => sum + rows, 0) : null,
      flowHeatLevel: Math.max(heatLevel, ...(children || []).map(child => child.flowHeatLevel || 0))
    };
  }

  const built = build(plan, "0");
  return inheritPlanAnalysis(built, { ...built, tableEstimates });
}

export function buildCostModel(plan, runtime = {}) {
  const rows = flattenPlan(plan).map(node => ({
    nodeId: node.nodeId,
    name: node["Node Type"] || "Unknown",
    table: node.table ? `${node.table.database}.${node.table.name}` : null,
    rows: Number.isFinite(node.ownRows) ? node.ownRows : Number.isFinite(node.flowRows) ? node.flowRows : null,
    evidence: Number.isFinite(node.ownRows) ? "known" : Number.isFinite(node.flowRows) ? "inferred" : node.hasAmbiguousEstimate ? "ambiguous" : "missing",
    heatLevel: node.flowHeatLevel || node.heatLevel || 0
  })).sort((left, right) => (right.rows ?? -1) - (left.rows ?? -1));
  const queryLog = runtime?.query_log || {};
  const metrics = ["read_rows", "read_bytes", "result_rows", "memory_usage", "query_duration_ms"].map(name => {
    const metric = evaluateMetric(queryLog[name]);
    return { name, ...metric, evidence: metric.value !== null ? "known" : "missing" };
  });
  return { rows, metrics, tableEstimates: plan.tableEstimates || [] };
}

export function buildEvidenceCoverage(plan, estimates = {}, bundle = {}) {
  const allReads = flattenPlan(plan).filter(node => node["Node Type"] === "ReadFromMergeTree");
  const reads = allReads.filter(node => node.table);
  const tables = [...new Set(reads.map(node => `${node.table.database}.${node.table.name}`))];
  const records = Object.keys(estimates);
  const matched = records.filter(table => tables.includes(table));
  const ambiguous = (plan.tableEstimates || []).filter(item => item.allocation === "ambiguous").map(item => item.table);
  const usable = matched.filter(table => ["rows", "parts", "marks"].some(field => parseEstimateCount(estimates[table][field]) !== null));
  const metrics = buildCostModel(plan, bundle.runtime).metrics;
  const available = metrics.filter(metric => metric.value !== null).map(metric => metric.name);
  const scanLabel = !records.length ? "Scan estimates not supplied"
    : !matched.length ? "Scan estimates supplied · no matching tables"
    : `Scan estimates supplied · ${matched.length} of ${tables.length} tables${ambiguous.length ? " · per-read split unknown" : ""}${usable.length < matched.length ? " · some counts unavailable" : ""}`;
  return {
    plan: { status: "parsed", nodeCount: flattenPlan(plan).length },
    scans: { status: !records.length ? "missing" : usable.length < tables.length || ambiguous.length || !matched.length || allReads.length !== reads.length ? "partial" : "available", label: scanLabel, supplied: records.length, matched: matched.length, totalTables: tables.length, ...(allReads.length === reads.length ? {} : { totalReads: allReads.length, namedReads: reads.length, anonymousReads: allReads.length - reads.length }), usableTables: usable.length, unmatched: records.filter(table => !tables.includes(table)), ambiguousTables: ambiguous, unattributedReads: allReads.filter(node => node.ownRows === null).length },
    runtime: { status: !available.length ? "missing" : available.length < metrics.length ? "partial" : "available", available, missing: metrics.filter(metric => metric.value === null).map(metric => metric.name), total: metrics.length, metrics, scope: "query-wide", limitation: "Run correspondence is unverified; these metrics do not measure individual operators." },
    server: { version: bundle.clickhouse?.version || null, cloudMode: bundle.clickhouse?.cloud_mode ?? null },
    settings: { status: Array.isArray(bundle.settings?.changed) ? "supplied" : "missing", coverage: Array.isArray(bundle.settings?.changed) ? "changed-only" : "unknown", count: bundle.settings?.changed?.length ?? null },
    optional: { syntax: Boolean(bundle.explain?.syntax?.trim()), pipeline: Boolean(bundle.explain?.pipeline?.trim()), schema: Array.isArray(bundle.schema) }
  };
}

export function buildIndexReads(plan, schema = [], findings = []) {
  const schemas = new Map(schema.map(table => [`${table.database}.${table.table || table.name}`, table]));
  const suggestionIds = new Set(["poor_selectivity", "full_table_scan", "skipping_index_unused"]);
  return flattenPlan(plan).filter(node => node["Node Type"] === "ReadFromMergeTree").map(node => {
    const reference = node.table ? `${node.table.database}.${node.table.name}` : node.Description || "Unknown table";
    const indexes = node.Indexes || [];
    const primary = indexes.find(index => index.Type === "PrimaryKey");
    const relevant = findings.find(finding => suggestionIds.has(finding.id) && finding.nodeIds?.includes(node.nodeId));
    return {
      nodeId: node.nodeId,
      table: reference,
      engine: schemas.get(reference)?.engine || null,
      primary: primary ? { keys: primary.Keys || [], condition: primary.Condition || null } : null,
      skipping: indexes.filter(index => String(index.Type || "").toLowerCase() === "skip").map(index => ({
        type: index.Type || null,
        name: index.Name || null,
        condition: index.Condition || null,
        selectedGranules: index["Selected Granules"] ?? null,
        initialGranules: index["Initial Granules"] ?? null
      })),
      selectedGranules: primary?.["Selected Granules"] ?? null,
      initialGranules: primary?.["Initial Granules"] ?? null,
      selectedParts: primary?.["Selected Parts"] ?? null,
      initialParts: primary?.["Initial Parts"] ?? null,
      suggestion: relevant ? { id: relevant.id, text: relevant.recommendation } : null
    };
  });
}

export function computePlanStats(plan) {
  const nodes = flattenPlan(plan);
  const tableNodes = nodes.filter(node => node["Node Type"] === "ReadFromMergeTree");
  return {
    totalNodes: nodes.length,
    joinNodes: nodes.filter(isJoinNode).length,
    totalTables: tableNodes.length,
    totalGranules: tableNodes.reduce((sum, node) => {
      return sum + (node.Indexes?.[0]?.["Selected Granules"] || 0);
    }, 0)
  };
}
