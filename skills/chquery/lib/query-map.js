import { isJoinNode } from './model.js';
import { parseEstimateCount } from './parser.js';
import { measurementFor } from './analyze.js';

const TYPE_GROUPS = {
  union: /union/i,
  aggregate: /aggregat/i,
  sort: /sort|window/i,
  filter: /filter|distinct/i
};

function nodeType(node) {
  return typeof node?.["Node Type"] === "string" && node["Node Type"].trim()
    ? node["Node Type"].trim()
    : "Unknown";
}

/** Only presentation/preparation operators may share a stage with a substantive operation. */
export function isPreparation(node) {
  return /^(Expression|Projection)$/.test(nodeType(node));
}

function humanize(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function operatorDetail(types) {
  const counts = new Map();
  for (const type of types) counts.set(type, (counts.get(type) || 0) + 1);
  return [...counts].map(([type, count]) => `${humanize(type)}${count > 1 ? ` × ${count}` : ""}`).join(" · ");
}

function tableOf(node) {
  if (node?.table?.name) return { database: node.table.database || null, name: node.table.name };
  if (nodeType(node) !== "ReadFromMergeTree") return null;
  const match = String(node.Description || "").match(/(?:^|\s)([\w-]+)\.([\w-]+)(?:\s|$)/);
  return match ? { database: match[1], name: match[2] } : null;
}

/** Summarize one root-to-leaf unary stage without making performance inferences. */
export function summarizeStage(members) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new TypeError("summarizeStage requires at least one plan node");
  }

  const types = members.map(nodeType);
  const only = members[0];
  const isLeaf = members.length === 1 && (!only.children || only.children.length === 0);
  const table = isLeaf ? tableOf(only) : null;

  let kind = "transform";
  if (members.some(isJoinNode)) kind = "join";
  else if (types.some(type => TYPE_GROUPS.union.test(type))) kind = "union";
  else if (types.some(type => TYPE_GROUPS.aggregate.test(type))) kind = "aggregate";
  else if (types.some(type => /window/i.test(type))) kind = "window";
  else if (types.some(type => /sort/i.test(type))) kind = "sort";
  else if (types.some(type => /distinct/i.test(type))) kind = "distinct";
  else if (types.some(type => /filter/i.test(type))) kind = "filter";
  else if (types.some(type => /limit|offset/i.test(type))) kind = "limit";
  else if (types.some(type => /^(?:result|output)$/i.test(type))) kind = "result";

  // Operator identity takes precedence when a minimal fixture omits child links.
  if (isLeaf && kind === "transform") {
    const title = table?.name || only.Description || humanize(types[0]);
    const detail = table?.database
      ? `Database ${table.database} · ${operatorDetail(types)}`
      : operatorDetail(types);
    return { kind: "source", title, detail };
  }

  const titles = {
    join: "Join",
    union: "Union",
    aggregate: "Aggregate",
    sort: "Order rows",
    window: 'Window',
    distinct: 'Deduplicate',
    limit: 'Limit rows',
    filter: "Filter",
    result: "Produce result",
    transform: members.some(member => !isPreparation(member))
      ? humanize(nodeType(members.find(member => !isPreparation(member))))
      : types.length === 1 ? humanize(types[0]) : "Prepare rows"
  };
  return { kind, title: titles[kind], detail: operatorDetail(types) };
}

const CHECK_LABELS = {
  full_table_scan: 'Check primary-key pruning',
  poor_selectivity: 'Check granules retained',
  skipping_index_unused: 'Check skip-index pruning',
  join_algorithm_unspecified: 'Check join algorithm evidence',
  large_join_right_side: 'Check right-side input size',
  cross_join: 'Check Cartesian join inputs',
  late_filter: 'Check filter placement',
  unbounded_sort: 'Check sort input and limit',
  high_fanout: 'Check repeated branch work',
  complex_join: 'Check join inputs and order',
  multiple_distinct: 'Check repeated deduplication',
  union_distinct: 'Check deduplication intent',
  array_join_explosion: 'Check array expansion',
  prewhere_not_applied: 'Check early filtering'
};

export function getMapCheckLabel(finding) {
  return CHECK_LABELS[finding.id] || `Check: ${finding.message}`;
}

/** UI wording only: never infer a full read from a missing or partially pruned stage. */
export function findingObservation(finding, node) {
  if (finding.id !== 'full_table_scan' || !node) return finding.message;
  const primary = node.Indexes?.find(index => index.Type === 'PrimaryKey');
  const total = parseEstimateCount(primary?.['Initial Granules']);
  const kept = parseEstimateCount(primary?.['Selected Granules']);
  if (!total || kept === null) return finding.message;
  const table = node.table?.name || node.Description || 'Table';
  const full = kept === total && node.Indexes.every(index =>
    parseEstimateCount(index['Initial Granules']) === total &&
    parseEstimateCount(index['Selected Granules']) === total);
  return full
    ? `${table} is read in full: ${kept.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} granules`
    : `${table}: primary-key stage retains ${kept.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} granules`;
}

// Read action fields from this operator only. Never infer them from query SQL
// or preparation steps folded around it; those may describe different work.
export function getStageEvidence(members) {
  const node = members.find(member => !isPreparation(member)) || members[0];
  const kind = summarizeStage(members).kind;
  const lines = [];
  const text = value => typeof value === 'string' ? value.trim() : '';
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null;
  const add = (label, value) => { if (text(value)) lines.push(`${label}: ${value}`); };
  const keys = (label, value, empty) => {
    const list = strings(value);
    if (list) add(label, list.length ? list.join(', ') : empty);
  };
  const order = value => {
    if (!Array.isArray(value) || !value.length || !value.every(item =>
      item && text(item.Column) && typeof item.Ascending === 'boolean')) return;
    add('Order', value.map(item => `${item.Column} ${item.Ascending ? 'ASC' : 'DESC'}${item['With Fill'] === true ? ' WITH FILL' : ''}`).join(', '));
  };
  if (kind === 'source') {
    lines.push(Number.isFinite(node.ownRows)
      ? `Est. scan rows: ${node.ownRows.toLocaleString('en-US')}`
      : node.hasAmbiguousEstimate ? 'Per-read estimate unknown' : 'Scan estimate unavailable');
    for (const index of node.Indexes || []) {
      const initial = parseEstimateCount(index['Initial Granules']);
      const selected = parseEstimateCount(index['Selected Granules']);
      if (initial !== null && selected !== null && selected <= initial) {
        lines.push(`${index.Type || 'Index'}: ${selected.toLocaleString('en-US')}/${initial.toLocaleString('en-US')} granules kept`);
      }
      keys(`${index.Type || 'Index'} keys`, index.Keys);
    }
  } else if (kind === 'join') {
    add('Join', [node.Type, node.Strictness].map(text).filter(Boolean).join(' '));
    add('On', node.Clauses);
    add('Algorithm', node.Algorithm);
    add('Residual filter', node['Residual filter']);
  } else if (kind === 'aggregate') {
    keys('Group by', node.Keys, 'none (global aggregate)');
    if (Array.isArray(node.Aggregates)) keys('Aggregates', node.Aggregates.map(item => item?.Name));
  } else if (kind === 'filter') {
    add('Filter column', node['Filter Column']);
  } else if (kind === 'sort') {
    order(node['Result Sort Description'] ?? node['Sort Description']);
  } else if (kind === 'window') {
    keys('Partition by', node['Partition By'], 'none');
    order(node['Sort Description']);
    keys('Functions', node.Functions);
  } else if (kind === 'distinct') {
    keys('Distinct columns', node.Columns);
  }
  if (kind === 'limit' || kind === 'sort') {
    const limit = parseEstimateCount(node.Limit);
    if (limit !== null) lines.push(`Limit: ${limit.toLocaleString('en-US')}`);
  }
  if (!lines.length) {
    add('Plan', node.Description);
    if (!lines.length) lines.push('Operator details not supplied');
  }
  const measured = measurementFor(node);
  if (measured) lines.unshift(`Measured rows: ${measured.input.label} → ${measured.output.label}`, ...measured.times);
  return lines;
}
