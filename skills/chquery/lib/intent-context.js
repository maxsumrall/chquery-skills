import { isBranchScope } from "./branch-scope.js";

const boundedRef = value => typeof value === "string" && Boolean(value.trim()) && value.length <= 4096;

/** Move an intent onto a new owning artifact identity without asserting that
 * its attestation still corresponds. W1 assessment/reconfirmation is separate. */
export function invalidateWorkloadIntent(record, {
  evidenceRef,
  branchScope = record?.branchScope,
  reason = "Owning evidence changed; reconfirm intent against the current artifact."
} = {}) {
  if (!record || typeof record !== "object" || record.version !== 1 || !boundedRef(evidenceRef) ||
      !isBranchScope(branchScope) || typeof reason !== "string" || !reason.trim() || reason.length > 10000) {
    throw new TypeError("Invalid workload intent invalidation inputs.");
  }
  return { ...record, evidenceRef, branchScope: structuredClone(branchScope), state: "stale", stateReason: reason };
}
