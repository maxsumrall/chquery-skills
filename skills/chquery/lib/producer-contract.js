import { stableStringify, validateComparisonEvidence } from "./comparison-artifact.js";
import { compareBundles } from "./comparison.js";
import { validateInvestigation } from "./investigation.js";

const REPAIR_ACTIONS = Object.freeze({
  depth: "Reduce JSON nesting and submit the complete evidence again.",
  field: "Remove the unsupported field from the portable artifact.",
  json: "Supply one finite, acyclic JSON value without accessors.",
  limit: "Reduce optional evidence without truncating the required plan.",
  required: "Supply the named required evidence.",
  shape: "Collect the documented lossless JSON shape and submit it again.",
  text: "Shorten the field without changing required evidence.",
  type: "Supply the documented JSON type.",
  version: "Use a supported contract version reported by the capabilities command."
});

export function producerDiagnostic(error) {
  const code = typeof error?.code === "string" ? error.code : "invalid";
  return {
    severity: "error",
    path: typeof error?.path === "string" ? error.path : "$",
    code,
    message: typeof error?.message === "string" ? error.message : "Invalid producer evidence.",
    action: REPAIR_ACTIONS[code] || "Review the producer contract and submit the complete evidence again."
  };
}

export function validateProducerArtifact(value) {
  const discriminator = key => value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const investigation = discriminator("chquery_investigation") === 1;
  const comparison = discriminator("chquery_comparison") === 1;
  const bundle = discriminator("chquery") === 1;
  const result = investigation
    ? validateInvestigation(value)
    : validateComparisonEvidence(value);
  const artifact = investigation ? "investigation" : comparison ? "comparison" : bundle ? "bundle" : "unknown";
  if (!result.valid) return { valid: false, artifact, diagnostics: result.errors.map(producerDiagnostic) };
  const planErrors = [];
  const evidence = investigation ? value.evidence : value;
  const bundles = evidence?.chquery_comparison === 1
    ? [[`${investigation ? "evidence." : ""}baseline.bundle`, evidence.baseline.bundle], [`${investigation ? "evidence." : ""}candidate.bundle`, evidence.candidate.bundle]]
    : evidence?.chquery === 1 ? [[investigation ? "evidence" : "$", evidence]] : [];
  for (const [path, evidenceBundle] of bundles) {
    for (const [rootIndex, envelope] of evidenceBundle.explain.plan.entries()) {
      const stack = [[envelope?.Plan, `${path}.explain.plan[${rootIndex}].Plan`]];
      while (stack.length) {
        const [node, nodePath] = stack.pop();
        if (!node || typeof node !== "object" || Array.isArray(node) || typeof node["Node Type"] !== "string") {
          planErrors.push({ path: nodePath, code: "shape", message: "Plan nodes require a Node Type string." });
          continue;
        }
        if (node.Plans !== undefined && !Array.isArray(node.Plans)) {
          planErrors.push({ path: `${nodePath}.Plans`, code: "shape", message: "Plan node children must be an array." });
        } else node.Plans?.forEach((child, index) => stack.push([child, `${nodePath}.Plans[${index}]`]));
      }
    }
  }
  const errors = [...result.errors, ...planErrors];
  return {
    valid: errors.length === 0,
    artifact,
    diagnostics: errors.map(producerDiagnostic)
  };
}

const uniqueSorted = values => [...new Set(values.filter(value => typeof value === "string" && value))].sort();

/** Deterministic local integration output. It neither contacts GitHub nor
 * publishes anything. Callers decide where, if anywhere, to store the bytes.
 */
export function buildCiReview(pair, options = {}) {
  const validation = validateProducerArtifact(pair);
  if (!validation.valid || pair?.chquery_comparison !== 1) {
    const error = new TypeError("A valid comparison is required for CI review output.");
    error.diagnostics = validation.diagnostics.length ? validation.diagnostics : [producerDiagnostic({ path: "$", code: "required",
      message: "CI review output requires a complete baseline/candidate comparison." })];
    throw error;
  }
  const report = compareBundles(pair, options);
  const references = [];
  for (const finding of report.findings) {
    for (const role of ["baseline", "candidate"]) {
      const occurrence = finding[role];
      const scope = occurrence?.evidenceScope;
      for (const node of scope?.nodes || []) references.push({
        role, kind: "node", nodeId: node.nodeId,
        ...(node.nodeType ? { nodeType: node.nodeType } : {}),
        ...(node.table ? { table: node.table } : {})
      });
      if (scope?.kind === "setting" && scope.setting) references.push({ role, kind: "setting", name: scope.setting });
    }
  }
  const claims = Array.isArray(report.claims) ? report.claims : [];
  return {
    chquery_ci_review: 1,
    analysisRevision: report.analysisRevision,
    comparisonRevision: report.comparisonRevision,
    labels: { baseline: report.sides.baseline.label, candidate: report.sides.candidate.label },
    claims,
    supportingReferences: [...new Map(references.map(item => [stableStringify(item), item])).values()]
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
    gaps: uniqueSorted(report.limitations),
    summary: {
      correctness: report.correctness.status,
      comparability: report.comparability.status,
      findingTransitions: report.findings.map(item => ({ ruleId: item.ruleId, state: item.state }))
    }
  };
}

export function ciReviewJson(pair, options) {
  return `${stableStringify(buildCiReview(pair, options), 2)}\n`;
}
