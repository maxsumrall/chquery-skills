export const EVIDENCE_CONTRACT_VERSION = 1;

// Canonical bundle/pair/artifact limits are shared by normalization,
// comparison and transfer. Wrapper input is separately bounded because a
// lossless escaped or mirrored transport can be larger than canonical JSON.
export const EVIDENCE_LIMITS = Object.freeze({
  bundleBytes: 8 * 1024 * 1024,
  pairBytes: 16 * 1024 * 1024,
  artifactBytes: 20 * 1024 * 1024,
  wrapperInputBytes: 20 * 1024 * 1024,
  depth: 128,
  planNodesPerBundle: 10_000
});

export const EVIDENCE_KINDS = Object.freeze(["plan", "rows"]);
export const OPTIONAL_EVIDENCE_STATES = Object.freeze(["collected", "empty", "missing", "omitted", "unsupported", "uncollected"]);
export const NORMALIZATION_ERROR_CODES = Object.freeze(["malformed", "truncated", "oversized", "too_deep", "unsupported_transport", "ambiguous_candidates", "invalid_shape", "source_requires_compilation"]);
export const EVIDENCE_TRANSPORTS = Object.freeze(["object", "text", "json", "clickhouse-json", "clickhouse-json-compact", "json-each-row", "columns-rows", "mcp-structured", "mcp-text", "csv", "tsv"]);
export const EVIDENCE_TRANSFORMATIONS = Object.freeze(["removed_utf8_bom", "removed_complete_code_fence", "parsed_json", "decoded_json_string", "parsed_json_each_row", "parsed_csv", "parsed_tsv", "decoded_json_compact_rows", "decoded_columns_rows", "extracted_clickhouse_data", "extracted_clickhouse_cell", "extracted_mcp_structured_content", "extracted_mcp_text_content"]);
