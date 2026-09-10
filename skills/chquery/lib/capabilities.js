import { COMPARISON_LIMITS } from "./comparison-artifact.js";
import { COMPARISON_REPORT_LIMITS } from "./comparison-budget.js";
import { EVIDENCE_CONTRACT_VERSION, EVIDENCE_KINDS, EVIDENCE_LIMITS, EVIDENCE_TRANSPORTS, OPTIONAL_EVIDENCE_STATES } from "./evidence-contract.js";
import { HANDOFF_LIMITS, HANDOFF_STATES } from "./handoff-transport.js";
import { INVESTIGATION_LIMITS } from "./investigation.js";
import { PRIVACY_SURFACE_CONTRACT, REVIEW_PRIVACY_MODES } from "./redact.js";
import { MAX_PLAINTEXT_BYTES } from "./share.js";
import { STORED_SHARE_LIMITS } from "./stored-share.js";

export const CAPABILITIES_CONTRACT_VERSION = 1;

export const COLLECTION_PROFILES = Object.freeze({
  plan: Object.freeze({
    description: "Original executable SQL and complete EXPLAIN PLAN JSON.",
    required: Object.freeze(["sql", "explain.plan"]),
    optional: Object.freeze([])
  }),
  review: Object.freeze({
    description: "Plan plus scan estimates, observed server version, and changed settings when available.",
    required: Object.freeze(["sql", "explain.plan"]),
    optional: Object.freeze(["explain.estimate", "clickhouse.version", "settings.changed"])
  }),
  enriched: Object.freeze({
    description: "Review profile plus explicitly authorized pipeline, schema, and associated runtime evidence.",
    required: Object.freeze(["sql", "explain.plan"]),
    optional: Object.freeze(["explain.estimate", "explain.pipeline", "clickhouse.version", "settings.changed", "schema", "runtime"])
  })
});

export function getCapabilities({ toolVersion, build = null, analyzeOutputs = ["full-report", "link"], discoveryExecutable = "chquery-conformance", temporaryHandoff = false } = {}) {
  if (typeof toolVersion !== "string" || !toolVersion) throw new TypeError("toolVersion is required.");
  return {
    chquery_capabilities: CAPABILITIES_CONTRACT_VERSION,
    tool: Object.freeze({ name: "chquery", version: toolVersion, build }),
    runtime: Object.freeze({ node: ">=20", dependencies: "none" }),
    contracts: Object.freeze({ bundle: [1], comparison: [1], investigation: [1], ciReview: [1], normalizer: [EVIDENCE_CONTRACT_VERSION] }),
    commands: Object.freeze({
      analyze: Object.freeze({ executable: "chquery", outputs: Object.freeze([...analyzeOutputs]), network: "link-output-is-local-only" }),
      version: Object.freeze({ executable: discoveryExecutable, network: "none" }),
      capabilities: Object.freeze({ executable: discoveryExecutable, network: "none" }),
      normalize: Object.freeze({ executable: "chquery-conformance", kinds: EVIDENCE_KINDS, network: "none" }),
      validate: Object.freeze({ executable: "chquery-conformance", network: "none" }),
      review: Object.freeze({ executable: "chquery-conformance", network: "none", publication: "never" }),
      ...(temporaryHandoff ? { handoff: Object.freeze({ executable: "chquery", states: HANDOFF_STATES, network: "explicit-invitation-and-grant" }) } : {})
    }),
    collectionProfiles: COLLECTION_PROFILES,
    transports: EVIDENCE_TRANSPORTS,
    optionalEvidenceStates: OPTIONAL_EVIDENCE_STATES,
    privacyPreparation: Object.freeze({
      contractVersion: PRIVACY_SURFACE_CONTRACT.version,
      identifiers: REVIEW_PRIVACY_MODES.identifiers,
      redact: Object.freeze([true, false]),
      outgoingBytes: "canonical-prepared-json"
    }),
    limits: Object.freeze({
      bundleBytes: EVIDENCE_LIMITS.bundleBytes,
      pairEvidenceBytes: EVIDENCE_LIMITS.pairBytes,
      artifactBytes: EVIDENCE_LIMITS.artifactBytes,
      wrapperInputBytes: EVIDENCE_LIMITS.wrapperInputBytes,
      jsonDepth: EVIDENCE_LIMITS.depth,
      planNodesPerBundle: EVIDENCE_LIMITS.planNodesPerBundle,
      runtimeSamplesPerBundle: COMPARISON_LIMITS.samples,
      fragmentPlaintextBytes: MAX_PLAINTEXT_BYTES,
      reportBytes: COMPARISON_REPORT_LIMITS.reportBytes,
      preparedOutputBytes: COMPARISON_REPORT_LIMITS.preparedBytes,
      investigationTitleCharacters: INVESTIGATION_LIMITS.title,
      investigationProblemCharacters: INVESTIGATION_LIMITS.problem,
      investigationNotesCharacters: INVESTIGATION_LIMITS.notes,
      ...(temporaryHandoff ? { temporaryHandoff: HANDOFF_LIMITS } : {}),
      storedShare: STORED_SHARE_LIMITS
    })
  };
}
