const INDEX_TEXT_FIELDS = ["Type", "Name", "Condition"];
const INDEX_SCALAR_FIELDS = ["Initial Granules", "Selected Granules", "Initial Parts", "Selected Parts"];

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isScalar = value => value === null || ["string", "number", "boolean"].includes(typeof value);

// Validate only properties with canonical semantics. Unknown fields remain
// lossless evidence and are deliberately not interpreted here.
export function knownPlanPropertyError(node) {
  if (node.Description !== undefined && node.Description !== null && typeof node.Description !== "string") {
    return { field: "Description", message: "Description must be a string or null when present." };
  }
  if (node.Plans !== undefined && !Array.isArray(node.Plans)) {
    return { field: "Plans", message: "Plans must be an array when present." };
  }
  if (node.Indexes === undefined) return null;
  if (!Array.isArray(node.Indexes)) return { field: "Indexes", message: "Indexes must be an array when present." };
  for (let index = 0; index < node.Indexes.length; index++) {
    const value = node.Indexes[index];
    if (!isRecord(value)) return { field: `Indexes[${index}]`, message: "Index entries must be objects." };
    for (const field of INDEX_TEXT_FIELDS) {
      if (value[field] !== undefined && typeof value[field] !== "string") return { field: `Indexes[${index}].${field}`, message: `${field} must be a string when present.` };
    }
    for (const field of INDEX_SCALAR_FIELDS) {
      if (value[field] !== undefined && !isScalar(value[field])) return { field: `Indexes[${index}].${field}`, message: `${field} must be a JSON scalar when present.` };
    }
    if (value.Keys !== undefined && (!Array.isArray(value.Keys) || value.Keys.some(key => typeof key !== "string"))) {
      return { field: `Indexes[${index}].Keys`, message: "Keys must be an array of strings when present." };
    }
  }
  return null;
}
