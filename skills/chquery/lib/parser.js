import { normalizeEvidence } from "./normalizer.js";

const syntheticPlanRoots = new WeakSet();

export function isSyntheticPlanRoot(node) {
  return Boolean(node && typeof node === "object" && syntheticPlanRoots.has(node));
}

export function inheritPlanAnalysis(source, target) {
  if (isSyntheticPlanRoot(source)) syntheticPlanRoots.add(target);
  return target;
}

export function parseExplainPlans(input) {
  const rawData = normalizeEvidence(input, { kind: "plan" }).value;
  let totalLeafGranules = 0;

  function parseNode(node, sourcePath) {
    const label = node["Node Type"] || "Unknown";
    const parsed = {
      ...node,
      raw: node,
      sourcePath,
      name: label,
      "Node Type": label,
      Description: node.Description ?? null,
      granules: node.Indexes?.[0]?.["Selected Granules"] || 1,
    };

    if (Array.isArray(node.Plans)) {
      parsed.children = node.Plans.map((child, index) => parseNode(child, `${sourcePath}.Plans[${index}]`));
    } else {
      delete parsed.children;
      totalLeafGranules += parsed.granules;
    }

    return parsed;
  }

  const plans = rawData.map((wrapper, index) => parseNode(wrapper.Plan, `$[${index}].Plan`));
  for (const plan of plans) plan.totalLeafGranules = totalLeafGranules;
  return plans;
}

export function parseExplainPlan(input) {
  const plans = parseExplainPlans(input);
  if (plans.length === 1) return plans[0];
  const forest = {
    raw: null,
    sourcePath: null,
    name: "PlanForest",
    "Node Type": "PlanForest",
    Description: `${plans.length} supplied plan roots`,
    Plans: plans,
    children: plans,
    roots: plans,
    totalLeafGranules: plans[0]?.totalLeafGranules || 0
  };
  syntheticPlanRoots.add(forest);
  return forest;
}

export function parseEstimateCount(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value.trim()))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

// Shared with sample/comparison readers. Retain numeric-string measurements,
// but reject missing coercions, non-finite values and unsafe integer magnitudes.
export function evaluateMetric(value) {
  if (value === undefined || value === null) return { value: null, state: "missing", reason: "Not supplied" };
  const numeric = typeof value === "number" || (typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()));
  const parsed = numeric ? Number(value) : NaN;
  const underflow = typeof value === "string" && parsed === 0 && /[1-9]/.test(value.trim().split(/e/i)[0]);
  return !Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER || underflow
    ? { value: null, state: "invalid", reason: "Expected a finite nonnegative numeric value within safe integer magnitude; no empty/boolean coercion or underflow" }
    : { value: parsed, state: "usable", reason: "Supplied query-wide measurement; run scope is unverified" };
}

export function parseEstimate(input) {
  const rows = typeof input === "string"
    ? input.split("\n").filter(line => line.trim()).map(line => JSON.parse(line))
    : input;

  return rows.reduce((estimates, row) => {
    estimates[`${row.database}.${row.table}`] = {
      rows: parseEstimateCount(row.rows),
      parts: parseEstimateCount(row.parts),
      marks: parseEstimateCount(row.marks)
    };
    return estimates;
  }, {});
}
