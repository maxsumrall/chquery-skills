import { assertComparisonEvidence, isRecord, METRIC_NAMES, PROVENANCE_FIELDS, stableStringify } from "./comparison-artifact.js";
import { compareBundles } from "./comparison.js";
import { createPrivacyContext, transformBundlePrivacy, transformPlanPropertiesPrivacy } from "./redact.js";
import { byteBudget, checkReportJsonSize, countText, COMPARISON_REPORT_LIMITS } from "./comparison-budget.js";
import { collectionProfiles } from "./collection.js";
import { EVIDENCE_KINDS, EVIDENCE_TRANSPORTS, EVIDENCE_TRANSFORMATIONS, OPTIONAL_EVIDENCE_STATES } from "./evidence-contract.js";
import { invalidateWorkloadIntent } from "./intent-context.js";
export { ComparisonPreparationLimitError, COMPARISON_REPORT_LIMITS } from "./comparison-budget.js";

// Encode punctuation rather than allowing Markdown links, images, raw HTML or
// table/fence syntax from imported text. Consumers still render reports as text
// or with their normal safe Markdown renderer, never as trusted HTML.
export function escapeComparisonMarkdown(value) {
  const text = typeof value === "object" && value !== null ? stableStringify(value) : String(value ?? "Not supplied");
  return text.replace(/[&<>\\`*_{}[\]()#+\-.!|:]/g, character => `&#${character.charCodeAt(0)};`).replace(/\r/g, "").replace(/\n/g, "<br>");
}

function codeBlock(value, add) {
  const text = String(value);
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  countText(text, add);
  add(2 * length + 6);
  const fence = "`".repeat(length);
  return `${fence}text\n${text}\n${fence}`;
}

export function comparisonToMarkdown(report, { omitSql = false } = {}) {
  checkReportJsonSize(report);
  const expansion = byteBudget("markdown");
  const md = item => {
    const text = typeof item === "object" && item !== null ? stableStringify(item) : String(item ?? "Not supplied");
    countText(text, count => expansion.add(count), "markdown");
    return escapeComparisonMarkdown(text);
  };
  const value = number => number === null ? "Unavailable" : md(number);
  const measurement = summary => `${value(summary.value)} (range ${value(summary.min)}–${value(summary.max)}; ${summary.valid}/${summary.selected} valid selected, ${summary.total} total)`;
  const code = text => codeBlock(text, count => expansion.add(count));
  const rendered = byteBudget("markdown");
  rendered.add(1); // final newline
  const parts = [];
  const sections = { push(...items) {
    for (const item of items) {
      if (parts.length) rendered.add(2);
      countText(item, count => rendered.add(count));
      parts.push(item);
    }
  } };
  sections.push(
    `# ${md(report.name || "CH Query comparison report")}`,
    `Baseline: ${md(report.sides.baseline.label)} → Candidate: ${md(report.sides.candidate.label)}`,
    `Review question (author context): ${md(report.question || "Not supplied")}`,
    `Analysis revision: ${md(report.analysisRevision)} · Comparison revision: ${md(report.comparisonRevision)}`,
    `Hypothesis (author assertion): ${md(report.hypothesis || "Not supplied")}`,
    "## Correctness and comparability",
    `Correctness: **${md(report.correctness.status)}**. ${md(report.correctness.limitation)}`,
    ...["method", "scope", "checked_at"].filter(key => report.correctness[key]).map(key => `${md(key)}: ${md(report.correctness[key])}`),
    `Comparability: ${md(report.comparability.status)}. ${md(report.comparability.limitation)}`,
    "| Context | Baseline | Candidate | Status |\n| --- | --- | --- | --- |\n" + report.comparability.dimensions.map(item => `| ${md(item.name)} | ${md(item.baseline)} | ${md(item.candidate)} | ${md(item.status)} |`).join("\n"),
    "## Evidence fidelity and source association",
    md(report.fidelity.limitation),
    "| Side | Fidelity | Descriptions | Collection profile | Source relationship | Gaps |\n| --- | --- | --- | --- | --- | --- |\n" + ["baseline", "candidate"].map(role => {
      const item = report.fidelity.sides[role];
      return `| ${role} | ${md(item.status)} | ${item.describedNodes}/${item.totalNodes} | ${md(item.collectionProfile)} | ${md(item.sourceRelation)} | ${md(item.gaps)} |`;
    }).join("\n"),
    "## Typed review claims"
  );
  for (const claim of report.claims) sections.push(`### ${md(claim.authorClaim.statement)} — ${md(claim.assessment)}`,
    `Check: ${md(claim.checkType)}. ${md(claim.reason)}`, `Scope: ${md(claim.structuralScope)}`,
    `Evidence: ${md(claim.evidence)}`, `Missing evidence: ${md(claim.missingEvidence)}`);
  if (!report.claims.length) sections.push("No review claim supplied. The factual comparison remains available without one.");
  sections.push(
    "## Runtime observations (check reported scope)",
    "Candidate minus baseline. No automatic winner; result rows are a correctness signal, not a performance score.",
    "| Metric | Unit | Baseline | Candidate | Absolute change | Percent change |\n| --- | --- | --- | --- | --- | --- |\n" + report.metrics.map(item => `| ${md(item.name)} | ${md(item.unit)} | ${measurement(item.baseline)} | ${measurement(item.candidate)} | ${value(item.absolute)} | ${item.percent === null ? "Unavailable" : `${md(item.percent)}%`} |`).join("\n"),
    ...report.metrics.map(item => `- ${md(item.name)}: ${md(item.reason)} ${md(item.interpretation)}. ${md(item.repeatability)}`),
    "## Samples and coverage"
  );
  for (const role of ["baseline", "candidate"]) {
    const side = report.sides[role];
    sections.push(`### ${role}`, md(side.measurements.selectionReason),
      `Selected protocol group: ${md(side.measurements.selectedGroup)}`,
      code(stableStringify({ groups: side.measurements.groups, samples: side.measurements.samples, coverage: side.coverage, tableEstimates: side.tableEstimates }, 2)));
  }
  sections.push("## SQL and supplied settings", `SQL text equality: ${md(report.sql.literalEquality)}. Semantic equality: unknown.`,
    omitSql ? "Raw SQL omitted from this report. Other evidence and findings may still contain SQL or sensitive descriptions."
      : `### Baseline SQL\n\n${code(report.sql.baseline)}\n\n### Candidate SQL\n\n${code(report.sql.candidate)}`,
    "| Setting | Baseline records | Candidate records | Status |\n| --- | --- | --- | --- |\n" + report.settings.map(item => `| ${md(item.name)} | ${md(item.baseline)} | ${md(item.candidate)} | ${md(item.status)} |`).join("\n"),
    "A missing changed setting does not establish a default. Redacted values do not establish literal equality.",
    "## Changed branches and plan structure", md(report.structure.limitation),
    ...report.structure.branches.map(branch => `- **${md(branch.status)}:** ${md(branch.statement)} ${md(branch.basis)} Types: ${md(branch.types)}. Evidence: ${md(branch.evidence)}`),
    code(stableStringify(report.structure, 2)),
    "## Finding transitions");
  for (const transition of report.findings) {
    sections.push(`### ${md(transition.ruleId)}: ${md(transition.state)}`, md(transition.reason));
    for (const role of ["baseline", "candidate"]) {
      const finding = transition[role];
      if (!finding) continue;
      sections.push(`**${role}:** ${md(finding.message)}\n\nClassification: ${md(finding.classification)}; severity: ${md(finding.severity)}; impact confidence: ${md(finding.impactConfidence)}.`,
        `Priority: ${md(finding.priorityReason)}`, `Why: ${md(finding.why)}`, `Next check: ${md(finding.confirmationCheck)}`,
        `Evidence reference: ${md({ role, scope: finding.evidenceScope, occurrenceId: finding.occurrenceId })}`,
        "| Evidence | Value |\n| --- | --- |\n" + finding.evidence.map(([name, val]) => `| ${md(name)} | ${md(val)} |`).join("\n"));
    }
  }
  if (!report.findings.length) sections.push("No finding transitions from supplied evidence. This does not establish query correctness or absence of performance concerns.");
  sections.push("## Limitations and next evidence", ...report.limitations.map(text => `- ${md(text)}`));
  if (report.preparation) sections.push("## Outgoing evidence review", code(stableStringify(report.preparation, 2)));
  sections.push("CH Query is independent and is not affiliated with or endorsed by ClickHouse, Inc.");
  return `${parts.join("\n\n")}\n`;
}

export const REVIEW_PROJECTION = Object.freeze({
  pair: Object.freeze(["chquery_comparison", "name", "question", "baseline", "candidate", "context"]),
  context: Object.freeze(["hypothesis", "correctness", "claims", "intents"]),
  bundle: Object.freeze(["chquery", "name", "question", "sql", "query_source", "explain", "created_at", "source", "clickhouse", "settings", "schema", "runtime", "collection", "context", "redaction"])
});
const bundleKeys = REVIEW_PROJECTION.bundle;
// Reference fields can contain query IDs, local paths or environment names.
// They are not required to interpret the reviewed measurements.
const provenanceKeys = ["version", ...Object.keys(PROVENANCE_FIELDS)];
const forbidden = /^(?:private[_-]?notes|notes|delete[_-]?token|deletion[_-]?receipt|capabilities|capability[_-]?(?:url|link)|share[_-]?(?:url|link|key)|encryption[_-]?key|secret|credentials|password|access[_-]?token)$/i;

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function projection(omissions) {
  const pick = (object, keys, path) => {
    if (!isRecord(object)) return object;
    return Object.fromEntries(Object.entries(object).filter(([key]) => {
      const keep = keys.includes(key);
      if (!keep) omissions.push(`${path}.other-metadata`);
      return keep;
    }));
  };
  const strip = (value, path) => {
    if (Array.isArray(value)) return value.map((item, index) => strip(item, `${path}[${index}]`));
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => {
      if (!forbidden.test(key)) return true;
      omissions.push(`${path}.private-or-capability-field`);
      return false;
    }).map(([key, item]) => [key, strip(item, `${path}.${key}`)]));
  };
  return { pick, strip };
}

const bundleOmissions = ["schema", "runtime", "settings", "estimate", "pipeline", "syntax", "intents", "name", "question"];
const receiptEnums = Object.freeze({
  kind: EVIDENCE_KINDS,
  transport: EVIDENCE_TRANSPORTS,
  transformations: EVIDENCE_TRANSFORMATIONS,
  nextAction: ["collect_estimates", null]
});
const optionalStates = OPTIONAL_EVIDENCE_STATES;

function projectReceipt(collection, omissions) {
  if (!isRecord(collection) || !isRecord(collection.receipt)) throw Object.assign(new TypeError("Unsupported collection receipt; raw normalization provenance stays local."), { code: "unsupported-surface", paths: ["bundle.collection"] });
  const receipt = collection.receipt;
  const allowed = ["version", "kind", "transport", "transformations", "deduplicatedCandidates", "roots", "nodes", "fidelity", "descriptions", "attribution", "unknownPlanFields", "optionalEvidence", "nextAction"];
  const unknown = Object.keys(receipt).filter(key => !allowed.includes(key));
  if (unknown.length) throw Object.assign(new TypeError("Unsupported collection receipt fields; extraction paths and field names stay local."), { code: "unsupported-surface", paths: unknown.map(key => `bundle.collection.receipt.${key}`) });
  const isCountRecord = (value, keys) => isRecord(value) && Object.keys(value).every(key => keys.includes(key)) && Object.values(value).every(item => Number.isSafeInteger(item) && item >= 0);
  const valid = receipt.version === 1 && receiptEnums.kind.includes(receipt.kind) && receiptEnums.transport.includes(receipt.transport) &&
    Array.isArray(receipt.transformations) && receipt.transformations.every(item => receiptEnums.transformations.includes(item)) &&
    ["deduplicatedCandidates", "roots", "nodes"].every(key => Number.isSafeInteger(receipt[key]) && receipt[key] >= 0) &&
    isRecord(receipt.fidelity) && receipt.fidelity.transport === "lossless" && receipt.fidelity.databaseCompleteness === "unverified" &&
    isCountRecord(receipt.descriptions, ["present", "total"]) &&
    isCountRecord(receipt.attribution, ["namedReads", "anonymousReads", "repeatedNamedReads", "matchedEstimates", "unmatchedEstimates"]) &&
    isCountRecord(receipt.unknownPlanFields, ["count"]) && isRecord(receipt.optionalEvidence) &&
    Object.keys(receipt.optionalEvidence).every(key => ["estimates", "metadata", "schema", "pipeline", "settings", "runtime"].includes(key)) &&
    Object.values(receipt.optionalEvidence).every(value => optionalStates.includes(value)) && receiptEnums.nextAction.includes(receipt.nextAction);
  if (!valid) throw Object.assign(new TypeError("Unsupported or invalid safe collection receipt."), { code: "unsupported-surface", paths: ["bundle.collection.receipt"] });
  const output = { receipt: JSON.parse(JSON.stringify(receipt)) };
  if (collection.profile !== undefined || collection.version !== undefined) {
    const profile = collection.profile;
    if (collection.version !== 1 || !isRecord(profile) || !Object.hasOwn(collectionProfiles, profile.name) ||
      !isRecord(profile.evidence) || stableStringify(profile.evidence) !== stableStringify(collectionProfiles[profile.name])) {
      throw Object.assign(new TypeError("Unsupported collection profile."), { code: "unsupported-surface", paths: ["bundle.collection.profile"] });
    }
    output.version = 1;
    output.profile = JSON.parse(JSON.stringify(profile));
  }
  return output;
}

const intentFields = ["version", "kind", "statement", "evidenceRef", "branchScope", "contractRevision", "attestedAt", "state", "stateReason", "limitation"];
function validateIntentFields(intent, path) {
  if (!isRecord(intent)) throw Object.assign(new TypeError("Unsupported workload intent."), { code: "unsupported-surface", paths: [path] });
  if (Object.keys(intent).some(key => !intentFields.includes(key))) {
    throw Object.assign(new TypeError("Unsupported workload intent fields."), { code: "unsupported-surface", paths: [`${path}.other-field`] });
  }
}

function transformIntent(intent, context, path, intentEvidenceRef) {
  validateIntentFields(intent, path);
  const scope = structuredClone(intent.branchScope);
  if (!isRecord(scope) || !["single", "baseline", "candidate"].includes(scope.role) || !isRecord(scope.anchor) ||
    typeof scope.anchor.path !== "string" || !Array.isArray(scope.chain) || Object.keys(scope).some(key => !["role", "anchor", "chain"].includes(key))) {
    throw Object.assign(new TypeError("Unsupported workload intent branch scope."), { code: "unsupported-surface", paths: [`${path}.branchScope`] });
  }
  const transformEntry = (entry, entryPath) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.operator_type !== "string" ||
      Object.keys(entry).some(key => !["path", "operator_type", "properties"].includes(key))) {
      throw Object.assign(new TypeError("Unsupported workload intent branch scope entry."), { code: "unsupported-surface", paths: [entryPath] });
    }
    return { ...entry, ...(entry.properties === undefined ? {} : {
      properties: transformPlanPropertiesPrivacy(entry.properties, context, `${entryPath}.properties`)
    }) };
  };
  scope.anchor = transformEntry(scope.anchor, `${path}.branchScope.anchor`);
  scope.chain = scope.chain.map((entry, index) => transformEntry(entry, `${path}.branchScope.chain[${index}]`));
  context.residual.push({ path, category: "author-text-stale-intent" });
  return invalidateWorkloadIntent(intent, { evidenceRef: intentEvidenceRef, branchScope: scope,
    reason: "Privacy preparation changed the evidence projection; reconfirm this intent against the reviewed artifact." });
}

/** Project one bare v1 bundle for exact review. No role, context, report,
 * persistence or consent is added. The preparation manifest stays separate.
 */
export function projectBundleForReview(input, { redact = true, identifiers = "retain", omit = [], privacyContext, intentEvidenceRef } = {}) {
  assertComparisonEvidence(input);
  if (input.chquery !== 1) throw new TypeError("Expected a bare v1 bundle.");
  if (typeof redact !== "boolean" || !["retain", "pseudonymize"].includes(identifiers)) throw new TypeError("Unsupported privacy review options.");
  if (!Array.isArray(omit) || omit.some(key => !bundleOmissions.includes(key))) throw new TypeError("Unsupported bundle omission group.");
  const omissions = [];
  const { pick, strip } = projection(omissions);
  let bundle = pick(JSON.parse(JSON.stringify(input)), bundleKeys, "bundle");
  const context = privacyContext || createPrivacyContext({ identifiers, literals: redact ? "redact" : "retain" });
  if (context.identifiers !== identifiers || context.literals !== (redact ? "redact" : "retain")) throw new TypeError("Privacy context does not match review options.");
  if (bundle.query_source) {
    bundle.query_source = pick(bundle.query_source, ["sql", "relationship"], "bundle.query_source");
    bundle.query_source.relationship = pick(bundle.query_source.relationship, ["kind", "association"], "bundle.query_source.relationship");
    const { kind, association } = bundle.query_source.relationship || {};
    if (typeof bundle.query_source.sql !== "string" || !["declared_compiled_from", "same_executable_source"].includes(kind) ||
      !["collector_attested", "user_attested"].includes(association)) throw Object.assign(new TypeError("Unsupported query source relationship."), { code: "unsupported-surface", paths: ["bundle.query_source"] });
  }
  if (bundle.collection) bundle.collection = projectReceipt(bundle.collection, omissions);
  if (bundle.context) {
    bundle.context = pick(bundle.context, ["intents"], "bundle.context");
    if (bundle.context.intents) bundle.context.intents.forEach((intent, index) => validateIntentFields(intent, `bundle.context.intents[${index}]`));
    if (omit.includes("intents") || !intentEvidenceRef) { delete bundle.context.intents; omissions.push("intents"); }
    else if (bundle.context.intents) bundle.context.intents = bundle.context.intents.map((intent, index) =>
      transformIntent(intent, context, `bundle.context.intents[${index}]`, intentEvidenceRef));
    if (!Object.keys(bundle.context).length) delete bundle.context;
  }
  bundle.explain = pick(bundle.explain, ["plan", "estimate", "pipeline", "syntax"], "bundle.explain");
  if (bundle.explain.estimate) bundle.explain.estimate = bundle.explain.estimate.map((item, i) => pick(item, ["database", "table", "rows", "parts", "marks"], `bundle.explain.estimate[${i}]`));
  if (bundle.schema) bundle.schema = bundle.schema.map((item, i) => pick(item, ["database", "table", "name", "engine", "ddl"], `bundle.schema[${i}]`));
  if (bundle.redaction) bundle.redaction = pick(bundle.redaction, ["applied", "identifiers", "summary"], "bundle.redaction");
  if (bundle.source) bundle.source = pick(bundle.source, ["kind", "tool", "skill_version"], "bundle.source");
  if (bundle.clickhouse) bundle.clickhouse = pick(bundle.clickhouse, ["version", "cloud_mode", "cloud"], "bundle.clickhouse");
  if (bundle.settings) {
    bundle.settings = pick(bundle.settings, ["changed"], "bundle.settings");
    if (bundle.settings.changed) bundle.settings.changed = bundle.settings.changed.map((item, i) => pick(item, ["name", "value", "default"], `bundle.settings.changed[${i}]`));
  }
  if (bundle.runtime) {
    bundle.runtime = pick(bundle.runtime, ["query_log", "provenance", "samples"], "bundle.runtime");
    if (bundle.runtime.query_log) bundle.runtime.query_log = pick(bundle.runtime.query_log, METRIC_NAMES, "bundle.runtime.query_log");
    if (bundle.runtime.provenance) bundle.runtime.provenance = pick(bundle.runtime.provenance, provenanceKeys, "bundle.runtime.provenance");
    if (bundle.runtime.samples) bundle.runtime.samples = bundle.runtime.samples.map((sample, i) => {
      const path = `bundle.runtime.samples[${i}]`;
      const result = pick(sample, ["id", "metrics", "provenance", "excluded", "warmup", "exclusion_reason"], path);
      result.metrics = pick(result.metrics, METRIC_NAMES, `${path}.metrics`);
      if (result.provenance) result.provenance = pick(result.provenance, provenanceKeys, `${path}.provenance`);
      return result;
    });
  }
  for (const key of omit) {
    const target = ["estimate", "pipeline", "syntax"].includes(key) ? bundle.explain : bundle;
    if (Object.hasOwn(target, key)) { delete target[key]; omissions.push(key); }
  }
  bundle = strip(bundle, "bundle");
  for (const field of ["name", "question"]) if (typeof bundle[field] === "string") context.residual.push({ path: field, category: "author-text" });
  const transformed = transformBundlePrivacy(bundle, context);
  const artifact = transformed.bundle;
  assertComparisonEvidence(artifact);
  const transformation = identifiers === "pseudonymize"
    ? `${redact ? "literal-redaction-and-" : ""}review-local-identifier-pseudonymization`
    : redact ? "partial-literal-redaction-retained-identifiers" : "retained-literals-and-identifiers";
  const preparation = { version: 2, transformation,
    omissions: [...new Set(omissions)].sort(),
    privacy: transformed.inventory,
    warning: "Review the entire outgoing evidence. This is not anonymization: small numbers, retained identifiers and deliberately included prose can remain sensitive. Source comments are omitted from reviewed SQL. Pseudonymized SQL is not executable source and establishes no equality, equivalence or correctness. No upload or persistence has occurred." };
  return freeze({ artifact, preparation, privacyReview: transformed.review.map(item => ({ ...item })) });
}

/** Prepare a standalone bundle for exact-byte preview/export/transport. The
 * lower-level projectBundleForReview projection remains manifest-free so it
 * can be embedded in comparisons and investigations without nested manifests.
 */
export function prepareBundleForOutgoingReview(input, options = {}) {
  if (options.privacyContext !== undefined) throw new TypeError("Outgoing bundle preparation owns a fresh privacy context.");
  const reviewed = projectBundleForReview(input, options);
  const artifact = structuredClone(reviewed.artifact);
  artifact.preparation = reviewed.preparation;
  assertComparisonEvidence(artifact);
  const json = `${stableStringify(artifact)}\n`;
  const total = byteBudget("prepared-total", COMPARISON_REPORT_LIMITS.preparedBytes);
  countText(json, count => total.add(count));
  return freeze({ artifact, json, preparation: artifact.preparation, privacyReview: reviewed.privacyReview });
}

export const prepareBundleForReview = prepareBundleForOutgoingReview;

/** Prepare ONCE, preview this exact result, then export its json/markdown. This
 * performs no upload/copy/save and does not assert user consent or sanitization.
 * Unknown optional fields and known private/capability fields are excluded.
 */
export function prepareComparison(pair, { redact = true, identifiers = "retain", omit = [], omitSqlFromReport = false, analysis = {}, intentEvidenceRef } = {}) {
  assertComparisonEvidence(pair, { pair: true });
  if (typeof redact !== "boolean" || !["retain", "pseudonymize"].includes(identifiers)) throw new TypeError("Unsupported comparison privacy options.");
  const allowedOmissions = [...bundleOmissions, "context", "labels", "name", "question", "claims", "intents"];
  if (!Array.isArray(omit) || omit.some(key => !allowedOmissions.includes(key))) throw new TypeError("Unsupported comparison omission group.");
  const omissions = [];
  const { pick, strip } = projection(omissions);
  const output = pick(JSON.parse(JSON.stringify(pair)), REVIEW_PROJECTION.pair, "$" );
  for (const field of ["name", "question"]) if (omit.includes(field) && Object.hasOwn(output, field)) {
    delete output[field]; omissions.push(field);
  }
  const privacyContext = createPrivacyContext({ identifiers, literals: redact ? "redact" : "retain" });
  let privacyReview;
  for (const role of ["baseline", "candidate"]) {
    output[role] = pick(output[role], ["bundle", "label"], role);
    const reviewed = projectBundleForReview(output[role].bundle, { redact, identifiers, privacyContext, intentEvidenceRef, omit: omit.filter(key => bundleOmissions.includes(key)) });
    output[role].bundle = reviewed.artifact;
    privacyReview = reviewed.privacyReview;
    omissions.push(...reviewed.preparation.omissions.map(path => `${role}.${path}`));
    if (omit.includes("labels") && Object.hasOwn(output[role], "label")) {
      delete output[role].label;
      omissions.push(`${role}.labels`);
    }
  }
  if (omit.includes("context")) {
    if (output.context) omissions.push("context");
    delete output.context;
  } else if (output.context) {
    output.context = pick(output.context, REVIEW_PROJECTION.context, "context");
    if (output.context.correctness) output.context.correctness = pick(output.context.correctness, ["status", "method", "scope", "checked_at"], "context.correctness");
    if (output.context.intents) output.context.intents.forEach((intent, index) => validateIntentFields(intent, `context.intents[${index}]`));
    if (output.context.intents && !intentEvidenceRef && !omit.includes("intents")) {
      delete output.context.intents;
      omissions.push("context.intents");
    }
    for (const field of ["claims", "intents"]) if (omit.includes(field) && Object.hasOwn(output.context, field)) {
      delete output.context[field]; omissions.push(`context.${field}`);
    }
    if (output.context.intents) output.context.intents = output.context.intents.map((intent, index) =>
      transformIntent(intent, privacyContext, `context.intents[${index}]`, intentEvidenceRef));
  }
  if (output.context) output.context = strip(output.context, "$.context");
  const artifact = output;
  assertComparisonEvidence(artifact, { pair: true });
  const privacy = {
    contractVersion: 1, status: "complete",
    literals: { mode: redact ? "redact" : "retain", stringReplacements: privacyContext.counts.string, numericReplacements: privacyContext.counts.numeric,
      warning: "Numbers with four or fewer digits are retained." },
    identifiers: { mode: identifiers, replacements: privacyContext.counts.identifier,
      scope: identifiers === "pseudonymize" ? "supported SQL and evidence identifier fields only" : "none",
      warning: identifiers === "pseudonymize" ? "Equal identifiers share one fresh mapping across both sides, disclosing within-review correlation. Author text is not pseudonymized." : "Identifiers are retained and may be sensitive." },
    references: { mode: "review-local-token", replacements: privacyContext.counts.reference,
      warning: "Equal runtime references share one fresh mapping across both sides, disclosing within-review correlation." },
    residualExposure: [
      ...privacyContext.residual,
      ...(!omit.includes("labels") && (output.baseline.label || output.candidate.label) ? [{ path: "labels", category: "author-text" }] : []),
      ...["name", "question"].filter(field => output[field]).map(path => ({ path, category: "author-text" })),
      ...(!omit.includes("context") && output.context ? Object.keys(output.context).filter(key => key !== "correctness").map(key => ({ path: `context.${key}`, category: "author-text" })) : [])
    ],
    claims: ["Not anonymized.", "Prepared SQL is not executable source.", "No literal equality, semantic equivalence, result equivalence, or correctness is established."]
  };
  const transformation = identifiers === "pseudonymize"
    ? `${redact ? "literal-redaction-and-" : ""}review-local-identifier-pseudonymization`
    : redact ? "partial-literal-redaction-retained-identifiers" : "retained-literals-and-identifiers";
  const preparation = { version: 2, transformation,
    omissions: [...new Set(omissions)].sort(), sqlOmittedFromReport: omitSqlFromReport,
    privacy,
    warning: "Review the entire outgoing JSON and Markdown. This is not anonymization: small numbers, retained identifiers, labels and context can remain sensitive. Source comments are omitted from reviewed SQL. Equal pseudonyms disclose within-review correlation. No upload or persistence has occurred." };
  const report = { ...compareBundles(artifact, analysis), preparation };
  if (omitSqlFromReport) report.sql = { ...report.sql, baseline: null, candidate: null, change: null, omitted: true };
  // The artifact manifest contains only preparation decisions, not source claims.
  artifact.preparation = preparation;
  assertComparisonEvidence(artifact, { pair: true });
  // Refuse amplified report detail before allocating its serialized copy.
  const reportBytes = checkReportJsonSize(report);
  const total = byteBudget("prepared-total", COMPARISON_REPORT_LIMITS.preparedBytes);
  total.add(reportBytes);
  const json = `${stableStringify(artifact)}\n`;
  countText(json, count => total.add(count));
  const reportJson = `${stableStringify(report, 2)}\n`;
  const markdown = comparisonToMarkdown(report, { omitSql: omitSqlFromReport });
  countText(markdown, count => total.add(count));
  return freeze({ artifact, report, json, reportJson, markdown, preparation, privacyReview });
}

/** W6 transport boundary: consume these bytes directly. A transport must not
 * serialize, project, redact, or otherwise prepare the artifact again.
 */
export function outgoingReviewBytes(prepared) {
  if (!prepared || typeof prepared.json !== "string" || prepared.artifact?.preparation !== prepared.preparation) {
    throw new TypeError("Expected one immutable prepared outgoing review.");
  }
  const bytes = new TextEncoder().encode(prepared.json);
  return Object.freeze({ bytes, manifest: Object.freeze({
    contractVersion: 1, byteLength: bytes.byteLength,
    transformation: prepared.preparation.transformation,
    privacyStatus: prepared.preparation.privacy.status,
    omissions: prepared.preparation.omissions
  }) });
}

function observableCoverage(artifact) {
  if (artifact.chquery_investigation === 1) return observableCoverage(artifact.evidence);
  const sides = artifact.chquery_comparison === 1 ? ["baseline", "candidate"] : [null];
  return Object.fromEntries(sides.map((role, index) => {
    const bundle = role ? artifact[role].bundle : artifact;
    const roots = bundle.explain.plan.length;
    let nodes = 0;
    const stack = bundle.explain.plan.flatMap(item => item?.Plan ? [item.Plan] : []);
    while (stack.length) { const node = stack.pop(); nodes++; stack.push(...(node.Plans || [])); }
    return [role || "single", { roots, nodes, estimates: bundle.explain.estimate?.length || 0,
      schema: bundle.schema?.length || 0, settings: bundle.settings?.changed?.length || 0,
      runtime: Boolean(bundle.runtime) }];
  }));
}

const omissionGroup = path => ["schema", "runtime", "settings", "estimate", "pipeline", "syntax", "context", "labels", "name", "question", "claims", "intents"]
  .find(group => path === group || path.endsWith(`.${group}`) || path.includes(`.${group}.`)) || "other-metadata";

/** Compact fragment-safe assertion for W6. It intentionally excludes paths,
 * values, identifier examples, mappings, labels, names and author text.
 */
export async function createOutgoingReviewEnvelope(prepared) {
  const { bytes } = outgoingReviewBytes(prepared);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  const residual = Object.entries(prepared.preparation.privacy.residualExposure.reduce((counts, item) => {
    counts[item.category] = (counts[item.category] || 0) + 1; return counts;
  }, {})).map(([category, count]) => ({ category, count }));
  const disclosure = {
    version: 1, byteLength: bytes.byteLength, sha256,
    transformation: prepared.preparation.transformation,
    privacy: {
      status: prepared.preparation.privacy.status,
      literals: prepared.preparation.privacy.literals.mode,
      identifiers: prepared.preparation.privacy.identifiers.mode,
      references: prepared.preparation.privacy.references?.mode || "none",
      residual,
      warning: "Not anonymized. Residual content and within-review equality can identify subjects."
    },
    omissions: [...new Set(prepared.preparation.omissions.map(omissionGroup))].sort(),
    coverage: observableCoverage(prepared.artifact)
  };
  const disclosureJson = stableStringify(disclosure);
  if (new TextEncoder().encode(disclosureJson).byteLength > 2048) throw new RangeError("Outgoing disclosure exceeds 2 KiB.");
  return Object.freeze({ json: prepared.json, bytes, sha256, disclosure: freeze(disclosure), disclosureJson });
}

export function exportComparisonSource(pair) {
  assertComparisonEvidence(pair, { pair: true });
  return { json: `${stableStringify(pair)}\n`, warning: "Full source export contains original inputs and optional metadata. It is not redacted; review before sharing." };
}
