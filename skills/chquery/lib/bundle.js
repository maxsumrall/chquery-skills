import { knownPlanPropertyError } from "./plan-shape.js";

const SOURCE_KINDS = new Set(["web", "agent-skill", "cli"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePlan(plan) {
  return typeof plan === "string" ? JSON.parse(plan) : plan;
}

function parseEstimate(estimate) {
  if (estimate === undefined) return undefined;
  if (Array.isArray(estimate)) return estimate;
  if (typeof estimate !== "string") return estimate;

  return estimate
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

function addOptional(target, key, value) {
  if (value !== undefined) target[key] = value;
}

export function createBundle({
  sql,
  plan,
  name,
  question,
  estimate,
  pipeline,
  syntax,
  analyze,
  created_at = new Date().toISOString(),
  source = { kind: "web" },
  clickhouse,
  settings,
  schema,
  runtime,
  redaction,
  query_source,
  collection,
  context,
  ...extra
} = {}) {
  const explain = { plan: parsePlan(plan) };
  addOptional(explain, "estimate", parseEstimate(estimate));
  addOptional(explain, "pipeline", pipeline);
  addOptional(explain, "syntax", syntax);
  addOptional(explain, "analyze", analyze);

  const bundle = {
    ...extra,
    chquery: 1,
    created_at,
    source,
    sql,
    explain
  };

  addOptional(bundle, "clickhouse", clickhouse);
  addOptional(bundle, "settings", settings);
  addOptional(bundle, "schema", schema);
  addOptional(bundle, "runtime", runtime);
  addOptional(bundle, "redaction", redaction);
  addOptional(bundle, "query_source", query_source);
  addOptional(bundle, "collection", collection);
  addOptional(bundle, "context", context);
  addOptional(bundle, "name", name);
  addOptional(bundle, "question", question);
  return bundle;
}

export function validateBundle(obj) {
  const errors = [];
  const error = (path, code, message) => errors.push({ path, code, message });

  if (!isObject(obj)) {
    error("$", "type", "Bundle must be a JSON object.");
    return { valid: false, errors };
  }

  if (obj.chquery !== 1) {
    error("chquery", "version", "chquery must be the number 1.");
  }
  if (typeof obj.sql !== "string" || !obj.sql.trim()) {
    error("sql", "required", "sql must be a non-empty string.");
  }
  if (obj.name !== undefined && (typeof obj.name !== "string" || !obj.name.trim() || obj.name.length > 240)) {
    error("name", "type", "Analysis name must be nonblank text of at most 240 characters.");
  }
  if (obj.question !== undefined && (typeof obj.question !== "string" || !obj.question.trim() || obj.question.length > 10000)) {
    error("question", "type", "Review question must be nonblank text of at most 10000 characters.");
  }
  if (!isObject(obj.explain)) {
    error("explain", "required", "explain must be an object.");
  } else {
    if (!Array.isArray(obj.explain.plan) || !obj.explain.plan.length || !obj.explain.plan.every(item => isObject(item) && isObject(item.Plan))) {
      error("explain.plan", "shape", "explain.plan must be a non-empty EXPLAIN PLAN JSON array whose every item contains a Plan object.");
    } else {
      const stack = obj.explain.plan.map((item, index) => ({ node: item.Plan, path: `explain.plan[${index}].Plan` }));
      while (stack.length) {
        const { node, path } = stack.pop();
        const propertyError = knownPlanPropertyError(node);
        if (propertyError) {
          error(`${path}.${propertyError.field}`, "shape", propertyError.message);
          continue;
        }
        node.Plans?.forEach((child, index) => {
          if (!isObject(child)) error(`${path}.Plans[${index}]`, "shape", "Plan children must be objects.");
          else stack.push({ node: child, path: `${path}.Plans[${index}]` });
        });
      }
    }
    if (obj.explain.estimate !== undefined && !Array.isArray(obj.explain.estimate)) {
      error("explain.estimate", "type", "explain.estimate must be an array when present.");
    } else {
      obj.explain.estimate?.forEach((row, index) => {
        if (!isObject(row)) {
          error(`explain.estimate[${index}]`, "type", "Estimate rows must be objects.");
        }
      });
    }
    for (const key of ["pipeline", "syntax"]) {
      if (obj.explain[key] !== undefined && typeof obj.explain[key] !== "string") {
        error(`explain.${key}`, "type", `explain.${key} must be a string when present.`);
      }
    }
    const analyze = obj.explain.analyze;
    if (analyze !== undefined && (!isObject(analyze) || typeof analyze.text !== 'string' || !analyze.text.trim() || analyze.text.length > 2 * 1024 * 1024 || typeof analyze.sql !== 'string' || !analyze.sql.trim() || !['user_attested', 'collector_attested'].includes(analyze.association))) {
      error('explain.analyze', 'shape', 'ANALYZE needs text (at most 2 MiB characters), captured SQL, and user_attested or collector_attested association.');
    }
  }

  if (obj.created_at !== undefined && (typeof obj.created_at !== "string" || Number.isNaN(Date.parse(obj.created_at)))) {
    error("created_at", "format", "created_at must be an ISO 8601 date-time string when present.");
  }
  if (obj.source !== undefined) {
    if (!isObject(obj.source)) {
      error("source", "type", "source must be an object when present.");
    } else if (!SOURCE_KINDS.has(obj.source.kind)) {
      error("source.kind", "enum", "source.kind must be web, agent-skill, or cli.");
    }
  }
  if (obj.clickhouse !== undefined && !isObject(obj.clickhouse)) {
    error("clickhouse", "type", "clickhouse must be an object when present.");
  }
  if (obj.settings !== undefined && !isObject(obj.settings)) {
    error("settings", "type", "settings must be an object when present.");
  }
  if (obj.schema !== undefined && !Array.isArray(obj.schema)) {
    error("schema", "type", "schema must be an array when present.");
  }
  if (obj.runtime !== undefined && !isObject(obj.runtime)) {
    error("runtime", "type", "runtime must be an object when present.");
  }
  if (obj.redaction !== undefined && !isObject(obj.redaction)) {
    error("redaction", "type", "redaction must be an object when present.");
  }
  if (obj.query_source !== undefined) {
    if (!isObject(obj.query_source) || typeof obj.query_source.sql !== "string" || !obj.query_source.sql.trim() ||
      !isObject(obj.query_source.relationship) || !["declared_compiled_from", "same_executable_source"].includes(obj.query_source.relationship.kind) ||
      !["collector_attested", "user_attested"].includes(obj.query_source.relationship.association)) {
      error("query_source", "shape", "query_source needs source SQL and an explicit supported relationship kind and association.");
    }
  }
  if (obj.collection !== undefined && !isObject(obj.collection)) {
    error("collection", "type", "collection must be an object when present.");
  }
  if (obj.context !== undefined && !isObject(obj.context)) {
    error("context", "type", "context must be an object when present.");
  }

  return { valid: errors.length === 0, errors };
}

export function bundleFromWizard(state) {
  const bundle = createBundle({
    ...(state.bundle || {}),
    sql: state.originalQuery,
    plan: state.explainPlan,
    estimate: state.explainEstimate,
    pipeline: state.bundle?.explain?.pipeline,
    syntax: state.bundle?.explain?.syntax
  });
  bundle.explain = { ...state.bundle?.explain, ...bundle.explain };
  if (state.bundle) {
    // Reopening is not a new collection event. Preserve missing metadata and
    // distinguish uncollected estimates from a supplied empty result.
    for (const field of ['created_at', 'source']) if (!Object.hasOwn(state.bundle, field)) delete bundle[field];
    if (!Object.hasOwn(state.bundle.explain || {}, 'estimate') && !bundle.explain.estimate?.length) delete bundle.explain.estimate;
  }
  return bundle;
}

export function wizardFromBundle(bundle) {
  const result = validateBundle(bundle);
  if (!result.valid) {
    const error = new TypeError("Invalid CH Query bundle.");
    error.errors = result.errors;
    throw error;
  }

  return {
    originalQuery: bundle.sql,
    explainPlan: JSON.stringify(bundle.explain.plan, null, 2),
    explainEstimate: (bundle.explain.estimate || []).map(row => JSON.stringify(row)).join("\n"),
    bundle
  };
}
