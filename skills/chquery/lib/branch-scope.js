const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonicalPlanPath = value => typeof value === "string" && /^\$\[\d+\]\.Plan(?:\.Plans\[\d+\])*$/.test(value);
const branchNode = value => isRecord(value) && canonicalPlanPath(value.path) &&
  typeof value.operator_type === "string" && Boolean(value.operator_type);

export function isBranchScope(scope) {
  return isRecord(scope) && ["single", "baseline", "candidate"].includes(scope.role) && branchNode(scope.anchor) &&
    Array.isArray(scope.chain) && scope.chain.length > 0 && scope.chain.length <= 100 &&
    scope.chain.every(item => branchNode(item) && (item.properties === undefined || isRecord(item.properties)));
}

function stableStringify(value) {
  return JSON.stringify(value, (_, child) => isRecord(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
}

/** Deterministic structural equality key for inspectable W2 branch scopes.
 * This is not an evidence identity, hash, authenticity claim or node ID. */
export function canonicalBranchScope(scope) {
  if (!isBranchScope(scope)) {
    throw new TypeError("Branch scope requires an owning role, canonical source paths and ordered operator signatures.");
  }
  return stableStringify({ role: scope.role, anchor: scope.anchor,
    chain: scope.chain.map(item => ({ path: item.path, operator_type: item.operator_type,
      ...(item.properties === undefined ? {} : { properties: item.properties }) })) });
}
