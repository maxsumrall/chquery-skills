import { validateBundle } from "./bundle.js";
import { EVIDENCE_LIMITS } from "./evidence-contract.js";
import { isBranchScope } from "./branch-scope.js";

export const COMPARISON_LIMITS = Object.freeze({
  bundleBytes: EVIDENCE_LIMITS.bundleBytes, evidenceBytes: EVIDENCE_LIMITS.pairBytes,
  totalBytes: EVIDENCE_LIMITS.artifactBytes, depth: EVIDENCE_LIMITS.depth,
  nodes: EVIDENCE_LIMITS.planNodesPerBundle, samples: 1000
});
export const METRIC_NAMES = Object.freeze(["query_duration_ms", "read_bytes", "read_rows", "memory_usage", "result_rows"]);
export const CLAIM_CHECK_TYPES = Object.freeze(["structural-chain-absence", "measurement-delta", "external-correctness"]);
export const PROVENANCE_FIELDS = Object.freeze({
  source: ["query_log", "response_summary", "other"],
  scope: ["query_wide", "single_node", "distributed_aggregate"],
  status: ["successful", "failed"],
  association: ["user_attested", "collector_attested"],
  cache: ["warm", "cold", "mixed"],
  settings_coverage: ["changed_only", "effective_snapshot"],
  captured_at: null, data_ref: null, environment_ref: null, protocol_ref: null
});
const discriminators = ["chquery", "chquery_comparison", "chquery_investigation"];
export const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const scalar = value => value === null || ["string", "number", "boolean"].includes(typeof value);
const canonicalPlanPath = value => typeof value === "string" && /^\$\[\d+\]\.Plan(?:\.Plans\[\d+\])*$/.test(value);
const branchNode = value => isRecord(value) && canonicalPlanPath(value.path) && typeof value.operator_type === "string" && Boolean(value.operator_type);

// Check the object graph before recursive parsers/serializers touch imported data.
// Accept JSON data only, including safely held __proto__ keys; never merge them.
function checkTree(value, errors) {
  const seen = new Set();
  const stack = [{ value, depth: 0, path: "$" }];
  let budget = 0;
  while (stack.length) {
    const item = stack.pop();
    if (item.exit) { seen.delete(item.value); continue; }
    if (++budget > COMPARISON_LIMITS.totalBytes) {
      errors.push({ path: "$", code: "limit", message: "JSON collection is too large." });
      return;
    }
    if (item.depth > COMPARISON_LIMITS.depth) {
      errors.push({ path: item.path, code: "depth", message: "JSON nesting exceeds 128 levels." });
      return;
    }
    if (item.value === null || ["string", "boolean", "number"].includes(typeof item.value)) {
      // Non-finite runtime values receive numeric diagnostics later, but cannot
      // survive JSON serialization. Reject these non-JSON programmatic inputs.
      if (typeof item.value === "number" && !Number.isFinite(item.value)) errors.push({ path: item.path, code: "json", message: "Non-finite numbers are not JSON values." });
      continue;
    }
    if (typeof item.value !== "object" || seen.has(item.value) ||
      (!Array.isArray(item.value) && ![Object.prototype, null].includes(Object.getPrototypeOf(item.value)))) {
      errors.push({ path: item.path, code: "json", message: "Expected an acyclic JSON value." });
      return;
    }
    seen.add(item.value);
    stack.push({ value: item.value, exit: true });
    for (const key of Object.keys(item.value)) {
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
      if (!Object.hasOwn(descriptor, "value")) {
        errors.push({ path: item.path, code: "json", message: "JSON accessors are unsupported." });
        return;
      }
      stack.push({ value: descriptor.value, depth: item.depth + 1, path: `${item.path}.${key}` });
    }
  }
}

function discriminator(value, expected, path, errors) {
  if (!isRecord(value) || value[expected] !== 1 || discriminators.filter(key => Object.hasOwn(value, key)).length !== 1) {
    errors.push({ path, code: "version", message: `Expected only ${expected}: 1 at this artifact boundary.` });
  }
}

function checkBundle(bundle, path, errors) {
  discriminator(bundle, "chquery", path, errors);
  const validation = validateBundle(bundle);
  errors.push(...validation.errors.map(error => ({ ...error, path: `${path}.${error.path}` })));
  if (!validation.valid) return;
  if (bytes(bundle) > COMPARISON_LIMITS.bundleBytes) errors.push({ path, code: "limit", message: "Bundle exceeds 8 MiB UTF-8 JSON." });
  const stack = bundle.explain.plan.map(wrapper => wrapper.Plan);
  let count = 0;
  while (stack.length) {
    const node = stack.pop();
    if (++count > COMPARISON_LIMITS.nodes) {
      errors.push({ path: `${path}.explain.plan`, code: "limit", message: "Plan exceeds 10,000 nodes." });
      break;
    }
    if (!isRecord(node) || (node.Plans !== undefined && !Array.isArray(node.Plans)) ||
      (node["Node Type"] !== undefined && typeof node["Node Type"] !== "string") ||
      (node.Description !== undefined && node.Description !== null && typeof node.Description !== "string") ||
      (node.Indexes !== undefined && (!Array.isArray(node.Indexes) || node.Indexes.some(index => !isRecord(index) ||
        ["Type", "Name", "Condition"].some(key => index[key] !== undefined && typeof index[key] !== "string") ||
        ["Initial Granules", "Selected Granules", "Initial Parts", "Selected Parts"].some(key => index[key] !== undefined && !scalar(index[key])) ||
        (index.Keys !== undefined && (!Array.isArray(index.Keys) || index.Keys.some(key => typeof key !== "string"))))))) {
      errors.push({ path: `${path}.explain.plan`, code: "shape", message: "Invalid Plan node, Plans children, Description or Indexes." });
      break;
    }
    if ((node.Plans?.length || 0) + stack.length + count > COMPARISON_LIMITS.nodes) {
      errors.push({ path: `${path}.explain.plan`, code: "limit", message: "Plan exceeds 10,000 nodes." });
      break;
    }
    for (const child of node.Plans || []) stack.push(child);
  }
  if (bundle.settings?.changed !== undefined && (!Array.isArray(bundle.settings.changed) || bundle.settings.changed.some(setting =>
    !isRecord(setting) || typeof setting.name !== "string" || !setting.name ||
    ["value", "default"].some(key => setting[key] !== undefined && !scalar(setting[key]))))) {
    errors.push({ path: `${path}.settings.changed`, code: "shape", message: "Settings must be named records." });
  }
  if (bundle.clickhouse && ["version", "cloud_mode", "cloud"].some(key => bundle.clickhouse[key] !== undefined && !scalar(bundle.clickhouse[key]))) errors.push({ path: `${path}.clickhouse`, code: "shape", message: "Server fields must be scalar values." });
  if (bundle.explain.estimate?.some(row => ["database", "table"].some(key => row[key] !== undefined && typeof row[key] !== "string"))) errors.push({ path: `${path}.explain.estimate`, code: "shape", message: "Estimate table references must be text." });
  if (bundle.schema?.some(table => !isRecord(table) || ["database", "table", "name", "engine", "ddl"].some(key => table[key] !== undefined && typeof table[key] !== "string"))) errors.push({ path: `${path}.schema`, code: "shape", message: "Schema entries must be records with text fields." });
  if (bundle.runtime?.query_log !== undefined && !isRecord(bundle.runtime.query_log)) errors.push({ path: `${path}.runtime.query_log`, code: "shape", message: "Runtime metrics must be a record." });
  if (bundle.runtime?.samples !== undefined) {
    if (!Array.isArray(bundle.runtime.samples) || bundle.runtime.samples.length > COMPARISON_LIMITS.samples || bundle.runtime.samples.some(sample =>
      !isRecord(sample) || !isRecord(sample.metrics) || (sample.id !== undefined && (typeof sample.id !== "string" || !sample.id)) ||
      (sample.excluded !== undefined && typeof sample.excluded !== "boolean") || (sample.warmup !== undefined && typeof sample.warmup !== "boolean") ||
      (sample.exclusion_reason !== undefined && typeof sample.exclusion_reason !== "string"))) {
      errors.push({ path: `${path}.runtime.samples`, code: "shape", message: "Expected at most 1,000 samples with metrics and optional string id/exclusion reason." });
    }
  }
  checkIntents(bundle.context?.intents, `${path}.context.intents`, errors);
}

function checkIntents(intents, path, errors) {
  if (intents === undefined) return;
  if (!Array.isArray(intents) || intents.length > 100) {
    errors.push({ path, code: "shape", message: "Intents must be an array of at most 100 records." });
    return;
  }
  intents.forEach((intent, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(intent) || intent.version !== 1 ||
        ["kind", "statement", "contractRevision", "attestedAt", "state", "stateReason", "limitation"].some(key => typeof intent[key] !== "string") ||
        !intent.kind.trim() || !intent.statement.trim() || !intent.contractRevision.trim() ||
        intent.kind.length > 120 || intent.statement.length > 10000 || intent.contractRevision.length > 240 || intent.stateReason.length > 10000 || intent.limitation.length > 10000 ||
        !["attested", "current", "stale"].includes(intent.state) || Number.isNaN(Date.parse(intent.attestedAt)) ||
        typeof intent.evidenceRef !== "string" || !intent.evidenceRef.trim() || intent.evidenceRef.length > 4096 || !isBranchScope(intent.branchScope)) {
      errors.push({ path: itemPath, code: "shape", message: "Intent must use the versioned workload-intent record with evidenceRef and canonical branchScope." });
    }
  });
}

function checkClaim(claim, index, errors) {
  const path = `context.claims[${index}]`;
  if (!isRecord(claim)) {
    errors.push({ path, code: "shape", message: "A review claim must be a record." });
    return;
  }
  if (typeof claim.id !== "string" || !claim.id.trim() || claim.id.length > 120 ||
      typeof claim.statement !== "string" || !claim.statement.trim() || claim.statement.length > 10000 ||
      !CLAIM_CHECK_TYPES.includes(claim.check_type) || !isRecord(claim.scope)) {
    errors.push({ path, code: "shape", message: "A review claim requires a bounded id, statement, supported check_type and scope." });
  }
  if (claim.evidence !== undefined && (!Array.isArray(claim.evidence) || claim.evidence.length > 100 || claim.evidence.some(item =>
    !isRecord(item) || !["baseline", "candidate"].includes(item.role) || typeof item.path !== "string" || !item.path || item.path.length > 2048 ||
    (item.nodeId !== undefined && (typeof item.nodeId !== "string" || !item.nodeId || item.nodeId.length > 240))))) {
    errors.push({ path: `${path}.evidence`, code: "shape", message: "Claim evidence must contain bounded baseline/candidate path references." });
  }
  const scope = claim.scope;
  if (!isRecord(scope)) return;
  if (claim.check_type === "structural-chain-absence") {
    const anchor = value => isRecord(value) && canonicalPlanPath(value.path) &&
      typeof value.operator_type === "string" && Boolean(value.operator_type);
    if (!anchor(scope.baseline_anchor) || !anchor(scope.candidate_anchor) || !Array.isArray(scope.baseline_chain) || !scope.baseline_chain.length ||
        scope.baseline_chain.length > 100 || scope.baseline_chain.some(item => !anchor(item) || (item.properties !== undefined && !isRecord(item.properties)))) {
      errors.push({ path: `${path}.scope`, code: "shape", message: "A structural chain scope requires canonical source paths, operator types and optional supplied-property records." });
    }
  } else if (claim.check_type === "measurement-delta" &&
      (!METRIC_NAMES.includes(scope.metric) || !["decrease", "increase", "unchanged"].includes(scope.direction) ||
       (scope.percent !== undefined && (typeof scope.percent !== "number" || !Number.isFinite(scope.percent))) ||
       (scope.tolerance !== undefined && (typeof scope.tolerance !== "number" || !Number.isFinite(scope.tolerance) || scope.tolerance < 0)))) {
    errors.push({ path: `${path}.scope`, code: "shape", message: "A measurement claim requires a known metric, direction and finite optional percentage/tolerance." });
  } else if (claim.check_type === "external-correctness" && !["equivalent", "different"].includes(scope.expected)) {
    errors.push({ path: `${path}.scope`, code: "shape", message: "A correctness claim must expect equivalent or different results." });
  }
}

/** Validate a standalone v1 bundle or complete pair. Investigations dispatch in
 * the owning module and call this on their evidence (with their own total cap).
 */
export function validateComparisonEvidence(value) {
  const errors = [];
  checkTree(value, errors);
  if (errors.length) return { valid: false, errors };
  if (bytes(value) > COMPARISON_LIMITS.totalBytes) errors.push({ path: "$", code: "limit", message: "Artifact exceeds 20 MiB UTF-8 JSON." });
  if (isRecord(value) && Object.hasOwn(value, "chquery_comparison")) {
    discriminator(value, "chquery_comparison", "$", errors);
    for (const role of ["baseline", "candidate"]) {
      if (!isRecord(value[role]) || !isRecord(value[role].bundle)) {
        errors.push({ path: role, code: "required", message: "A comparison requires both bundle slots." });
      } else {
        checkBundle(value[role].bundle, `${role}.bundle`, errors);
        if (value[role].label !== undefined && (typeof value[role].label !== "string" || !value[role].label.trim() || value[role].label.length > 240)) errors.push({ path: `${role}.label`, code: "type", message: "Label must be nonblank text of at most 240 characters." });
      }
    }
    if (value.baseline?.bundle && value.candidate?.bundle && bytes(value.baseline.bundle) + bytes(value.candidate.bundle) > COMPARISON_LIMITS.evidenceBytes) errors.push({ path: "$", code: "limit", message: "Pair evidence exceeds 16 MiB." });
    if (value.context !== undefined && !isRecord(value.context)) errors.push({ path: "context", code: "type", message: "Context must be a record." });
    if (value.context?.hypothesis !== undefined && typeof value.context.hypothesis !== "string") errors.push({ path: "context.hypothesis", code: "type", message: "Hypothesis must be text." });
    for (const [key, limit] of [["name", 240], ["question", 10000]]) if (value[key] !== undefined &&
        (typeof value[key] !== "string" || !value[key].trim() || value[key].length > limit)) {
      errors.push({ path: key, code: "type", message: `${key === "name" ? "Analysis name" : "Review question"} must be nonblank text of at most ${limit} characters.` });
    }
    if (value.context?.claims !== undefined) {
      if (!Array.isArray(value.context.claims) || value.context.claims.length > 50) errors.push({ path: "context.claims", code: "shape", message: "Claims must be an array of at most 50 records." });
      else value.context.claims.forEach((claim, index) => checkClaim(claim, index, errors));
    }
    checkIntents(value.context?.intents, "context.intents", errors);
  } else checkBundle(value, "$", errors);
  return { valid: errors.length === 0, errors };
}

export function assertComparisonEvidence(value, { pair = false } = {}) {
  const validation = validateComparisonEvidence(value);
  if (validation.valid && pair && value?.chquery_comparison !== 1) validation.errors.push({ path: "$", code: "required", message: "A complete comparison is required." });
  if (validation.errors.length) {
    const error = new TypeError("Invalid CH Query comparison evidence.");
    error.errors = validation.errors;
    throw error;
  }
  return value;
}

export function parseComparisonEvidence(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > COMPARISON_LIMITS.totalBytes) throw new RangeError("Artifact exceeds 20 MiB UTF-8 JSON.");
  return assertComparisonEvidence(JSON.parse(text));
}

/** Canonical key ordering is for determinism, never authenticity or identity. */
export function stableStringify(value, space) {
  return JSON.stringify(value, (_, child) => isRecord(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child, space);
}

export function readProvenance(value) {
  const diagnostics = [];
  if (value === undefined) return { values: {}, diagnostics, status: "unknown" };
  if (!isRecord(value) || value.version !== 1) return { values: {}, diagnostics: ["Unsupported or invalid runtime provenance version."], status: "unsupported" };
  const values = {};
  for (const [key, choices] of Object.entries(PROVENANCE_FIELDS)) {
    if (!Object.hasOwn(value, key)) continue;
    const field = value[key];
    if (typeof field !== "string" || field.length > 1024 || !field.trim() || (choices && !choices.includes(field)) ||
      (key === "captured_at" && !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(field)) ||
      (key === "captured_at" && Number.isNaN(Date.parse(field)))) diagnostics.push(`Invalid provenance ${key}; treated as unknown.`);
    else values[key] = field;
  }
  return { values, diagnostics, status: diagnostics.length ? "partial" : "supplied" };
}
