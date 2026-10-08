import { COMPARISON_LIMITS, isRecord, stableStringify, validateComparisonEvidence } from "./comparison-artifact.js";
import { assessWorkloadIntent } from "./finding-contract.js";
import { invalidateWorkloadIntent } from "./intent-context.js";

export const INVESTIGATION_LIMITS = Object.freeze({
  ...COMPARISON_LIMITS, title: 200, problem: 16384, notes: 65536, proposedExperiment: 16384
});
const fields = ["chquery_investigation", "title", "problem", "notes", "proposedExperiment", "evidence", "preparation"];
const clone = value => JSON.parse(JSON.stringify(value));
export const investigationBytes = value => new TextEncoder().encode(stableStringify(value)).length;

function omissionList(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 100000 ||
      Object.keys(value).length !== value.length) return false;
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || typeof descriptor.value !== "string" || descriptor.value.length > 65536) return false;
  }
  return true;
}

export function freezeInvestigation(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeInvestigation);
    Object.freeze(value);
  }
  return value;
}

/** Portable investigations contain context and ONE comparison-owned artifact.
 * Local IDs, save revisions, timestamps and capabilities do not belong here.
 */
export function validateInvestigation(value) {
  const errors = [];
  const error = (path, code, message) => errors.push({ path, code, message });
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return { valid: false, errors: [{ path: "$", code: "type", message: "Expected an investigation object." }] };
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!fields.includes(key)) error(String(key), "field", "Unsupported investigation field; local metadata belongs outside the portable artifact.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) error(String(key), "json", "Expected enumerable JSON data fields, not accessors.");
  }
  if (errors.length) return { valid: false, errors };
  if (value.chquery_investigation !== 1) error("chquery_investigation", "version", "Expected chquery_investigation: 1.");
  for (const key of ["title", "problem", "notes", "proposedExperiment"]) {
    if (["notes", "proposedExperiment"].includes(key) && !Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== "string" || value[key].length > INVESTIGATION_LIMITS[key] || (key === "title" && !value[key].trim())) {
      error(key, "text", `Expected ${key} text of at most ${INVESTIGATION_LIMITS[key]} characters${key === "title" ? ", not blank" : ""}.`);
    }
  }
  const evidence = validateComparisonEvidence(value.evidence);
  errors.push(...evidence.errors.map(item => ({ ...item, path: `evidence.${item.path}` })));
  if (evidence.valid && value.evidence.chquery_comparison === 1 && Object.hasOwn(value, "proposedExperiment")) {
    error("proposedExperiment", "context", "A pair keeps its proposed experiment only in evidence.context.hypothesis.");
  }
  if (Object.hasOwn(value, "preparation")) {
    // An imported manifest is descriptive, never consent or proof of redaction.
    const manifest = value.preparation;
    const keys = ["version", "transformation", "omissions", "sqlOmittedFromReport", "privacy", "warning"];
    if (!isRecord(manifest) || ![Object.prototype, null].includes(Object.getPrototypeOf(manifest)) ||
        Reflect.ownKeys(manifest).some(key => !keys.includes(key) || !Object.getOwnPropertyDescriptor(manifest, key).enumerable ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(manifest, key), "value"))) {
      error("preparation", "shape", "Invalid preparation manifest.");
    } else if (manifest.version !== 1 || typeof manifest.transformation !== "string" || manifest.transformation.length > 200 ||
        typeof manifest.warning !== "string" || manifest.warning.length > 4096 || typeof manifest.sqlOmittedFromReport !== "boolean" ||
        !omissionList(manifest.omissions) || (manifest.privacy !== undefined && (!isRecord(manifest.privacy) || manifest.privacy.status !== "complete"))) {
      error("preparation", "shape", "Invalid preparation fields.");
    }
  }
  if (errors.length) return { valid: false, errors };
  // Child validation is rooted at evidence. Count the outer level as well.
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    if (item.depth > INVESTIGATION_LIMITS.depth) {
      error("$", "depth", "Investigation nesting exceeds 128 levels.");
      break;
    }
    if (item.value && typeof item.value === "object") {
      for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  if (!errors.length && investigationBytes(value) > INVESTIGATION_LIMITS.totalBytes) error("$", "limit", "Investigation exceeds 20 MiB UTF-8 JSON.");
  return { valid: !errors.length, errors };
}

export function assertInvestigation(value) {
  const result = validateInvestigation(value);
  if (!result.valid) {
    const error = new TypeError("Invalid CH Query investigation.");
    error.errors = result.errors;
    throw error;
  }
  return value;
}

function reassessOwnedIntents(evidence, current = {}) {
  const output = clone(evidence);
  const intents = output.context?.intents;
  if (!intents?.length) return output;
  const assessable = typeof current.evidenceRef === "string" && current.evidenceRef.trim() &&
    typeof current.contractRevision === "string" && current.contractRevision.trim();
  output.context.intents = intents.map(record => assessable
    ? assessWorkloadIntent(record, { evidenceRef: current.evidenceRef, branchScope: record.branchScope,
      contractRevision: current.contractRevision })
    : invalidateWorkloadIntent(record, { evidenceRef: record.evidenceRef,
      reason: "Current owning evidence identity was not supplied; reconfirm intent after reopening or replacement." }));
  return output;
}

export function parseInvestigation(text, { intentEvidence } = {}) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > INVESTIGATION_LIMITS.totalBytes) {
    throw new RangeError("Investigation exceeds 20 MiB UTF-8 JSON.");
  }
  const value = assertInvestigation(JSON.parse(text));
  value.evidence = reassessOwnedIntents(value.evidence, intentEvidence);
  return freezeInvestigation(assertInvestigation(value));
}

export function createInvestigation(evidence, { title = "Untitled investigation", problem = "", notes = "", proposedExperiment, intentEvidence } = {}) {
  const value = { chquery_investigation: 1, title, problem, notes, evidence: reassessOwnedIntents(evidence, intentEvidence),
    ...(proposedExperiment !== undefined ? { proposedExperiment } : {}) };
  return freezeInvestigation(clone(assertInvestigation(value)));
}

/** Immutable slot replacement. The UI obtains discard/replace confirmation.
 * A single draft becomes a complete pair when candidate evidence is captured.
 * Checks for the old pair do not attest correctness of a replacement pair.
 */
export function replaceInvestigationSlot(investigation, role, bundle, { intentEvidence } = {}) {
  assertInvestigation(investigation);
  const validation = validateComparisonEvidence(bundle);
  if (!["baseline", "candidate"].includes(role) || !validation.valid || bundle.chquery !== 1) {
    throw new TypeError("Choose baseline or candidate and a valid single bundle.");
  }
  const output = clone(investigation);
  delete output.preparation;
  if (output.evidence.chquery === 1) {
    if (role === "baseline") output.evidence = reassessOwnedIntents(bundle, intentEvidence);
    else {
      const historicalIntents = output.evidence.context?.intents || [];
      output.evidence = { chquery_comparison: 1, baseline: { bundle: output.evidence }, candidate: { bundle: clone(bundle) },
        ...(output.proposedExperiment !== undefined ? { context: { hypothesis: output.proposedExperiment } } : {}) };
      if (historicalIntents.length) {
        if (typeof intentEvidence?.evidenceRef !== "string" || !intentEvidence.evidenceRef.trim()) {
          throw new TypeError("Promoting saved intent requires the new pair's opaque evidence reference.");
        }
        output.evidence.context ||= {};
        output.evidence.context.intents = historicalIntents.map(record => invalidateWorkloadIntent(record, {
          evidenceRef: intentEvidence.evidenceRef,
          branchScope: { ...record.branchScope, role: "baseline" },
          reason: "Single evidence was promoted to a comparison baseline; reconfirm intent against the pair."
        }));
      }
      delete output.proposedExperiment;
    }
  } else {
    output.evidence[role] = { bundle: clone(bundle), ...(output.evidence[role].label !== undefined ? { label: output.evidence[role].label } : {}) };
    if (output.evidence.context) delete output.evidence.context.correctness;
    delete output.evidence.preparation;
    output.evidence = reassessOwnedIntents(output.evidence, intentEvidence);
  }
  return freezeInvestigation(assertInvestigation(output));
}

export function exportInvestigationSource(investigation) {
  assertInvestigation(investigation);
  return Object.freeze({ json: stableStringify(investigation),
    warning: "Original source export includes private notes, original inputs and optional metadata. It is not redacted or encrypted. Review before sharing." });
}
