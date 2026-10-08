import { EVIDENCE_CONTRACT_VERSION, EVIDENCE_KINDS, EVIDENCE_LIMITS, OPTIONAL_EVIDENCE_STATES } from "./evidence-contract.js";
import { parseTableReference } from "./identifiers.js";
import { knownPlanPropertyError } from "./plan-shape.js";

const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: EVIDENCE_LIMITS.wrapperInputBytes,
  maxCanonicalBytes: EVIDENCE_LIMITS.bundleBytes,
  maxDepth: EVIDENCE_LIMITS.depth,
  maxValues: 1_000_000,
  maxPlanNodes: EVIDENCE_LIMITS.planNodesPerBundle,
  maxCandidates: 32
});

const PLAN_FIELDS = new Set(["Node Type", "Node Id", "Description", "Plans", "Indexes"]);
const OPTIONAL_STATES = new Set(OPTIONAL_EVIDENCE_STATES);

export class EvidenceNormalizationError extends TypeError {
  constructor(code, message, repair, { path = "$", details } = {}) {
    super(message);
    this.name = "EvidenceNormalizationError";
    this.code = code;
    this.path = path;
    this.repair = repair;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, repair, context) {
  throw new EvidenceNormalizationError(code, message, repair, context);
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(text) {
  // This is a deterministic candidate identifier, not a cryptographic integrity digest.
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const char of text) {
    const code = char.codePointAt(0);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

function preflightInput(value, limits, { rawRootString = false } = {}) {
  const stack = [{ value, path: "$", depth: 0 }];
  const active = new WeakSet();
  let values = 0;
  let bytes = 0;
  const addBytes = (count, path) => {
    bytes += count;
    if (bytes > limits.maxInputBytes) fail("oversized", `Aggregate input exceeds ${limits.maxInputBytes} bytes.`, "Supply a complete wrapper within the documented intake limit.", { path });
  };
  while (stack.length) {
    const item = stack.pop();
    if (item.exit) { active.delete(item.value); continue; }
    const { value: current, path, depth } = item;
    if (++values > limits.maxValues) fail("oversized", `Evidence contains more than ${limits.maxValues} values.`, "Collect a smaller complete evidence result; do not truncate it.", { path });
    if (depth > limits.maxDepth) fail("too_deep", `Evidence nesting exceeds ${limits.maxDepth} levels.`, "Collect the original bounded JSON result without recursive transport wrappers.", { path });
    if (current === null || ["string", "boolean", "number"].includes(typeof current)) {
      if (typeof current === "number" && !Number.isFinite(current)) fail("invalid_shape", "Non-finite numbers are not JSON evidence.", "Supply finite JSON numbers or omit unavailable values.", { path });
      addBytes(typeof current === "string" && depth === 0 && rawRootString ? byteLength(current) : byteLength(JSON.stringify(current)), path);
      continue;
    }
    if (typeof current !== "object") fail("invalid_shape", `Unsupported ${typeof current} value in evidence.`, "Supply finite acyclic plain JSON without BigInt, functions, symbols, or undefined.", { path });
    if (active.has(current)) fail("invalid_shape", "Cyclic objects are not JSON evidence.", "Supply an acyclic JSON value.", { path });
    if (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current))) fail("invalid_shape", "Evidence objects must use a plain or null prototype.", "Convert the value to plain JSON before normalization.", { path });
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!Object.hasOwn(descriptor, "value")) fail("invalid_shape", "Evidence accessors are unsupported.", "Materialize trusted data as plain JSON before normalization.", { path: `${path}.${key}` });
    }
    for (const symbol of Object.getOwnPropertySymbols(current)) {
      if (Object.getOwnPropertyDescriptor(current, symbol)?.enumerable) fail("invalid_shape", "Enumerable symbol keys are not JSON evidence.", "Remove symbol-keyed values before normalization.", { path });
    }
    active.add(current);
    stack.push({ value: current, exit: true });
    const keys = Object.keys(descriptors).filter(key => descriptors[key].enumerable);
    addBytes(2 + Math.max(0, keys.length - 1), path);
    if (Array.isArray(current)) {
      if (keys.some(key => !/^(?:0|[1-9]\d*)$/.test(key)) || keys.length !== current.length || keys.some((key, index) => Number(key) !== index)) fail("invalid_shape", "Evidence arrays must be dense and contain no enumerable named properties.", "Supply a plain JSON array without holes or extra properties.", { path });
      for (let index = keys.length - 1; index >= 0; index--) stack.push({ value: descriptors[index].value, path: `${path}[${index}]`, depth: depth + 1 });
    } else {
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        addBytes(byteLength(JSON.stringify(key)) + 1, path);
        stack.push({ value: descriptors[key].value, path: `${path}.${key}`, depth: depth + 1 });
      }
    }
  }
}

function completeFence(text, transformations) {
  const match = text.match(/^```([^\r\n]*)\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (match) {
    transformations.push("removed_complete_code_fence");
    return { text: match[2], language: match[1].trim().toLowerCase() };
  }
  if (text.startsWith("```")) fail("truncated", "The code fence is incomplete or has content after its closing fence.", "Copy the complete fenced result, including the closing fence, or supply the raw result.");
  return { text, language: "" };
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
    } else if (afterQuote) {
      if (char === ",") { row.push(cell); cell = ""; afterQuote = false; }
      else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; afterQuote = false; }
      else if (char === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; afterQuote = false; i++; }
      else fail("invalid_shape", "CSV has characters after a closing quote.", "Export valid RFC 4180 CSV without text between a closing quote and its delimiter.");
    } else if (char === '"') {
      if (cell !== "") fail("invalid_shape", "CSV quote begins inside an unquoted cell.", "Quote the complete CSV cell and double embedded quotes.");
      quoted = true;
    } else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (char === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else if (char === "\r") fail("invalid_shape", "CSV contains a bare carriage return.", "Export RFC 4180 CSV with CRLF or LF row boundaries.");
    else cell += char;
  }
  if (quoted) fail("truncated", "A quoted CSV/TSV cell is incomplete.", "Copy the complete text result, including the closing quote.");
  row.push(cell);
  if (row.length > 1 || row[0] !== "" || !rows.length) rows.push(row);
  return rows;
}

function parseTsv(text) {
  const rows = [[]];
  let cell = "";
  const finishCell = () => { rows.at(-1).push(cell === "\\N" ? null : cell); cell = ""; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\t") finishCell();
    else if (char === "\n") { finishCell(); rows.push([]); }
    else if (char === "\r" && text[index + 1] === "\n") { finishCell(); rows.push([]); index++; }
    else if (char === "\r") fail("invalid_shape", "TSV contains a bare carriage return.", "Export ClickHouse TabSeparated text with complete row boundaries.");
    else if (char !== "\\") cell += char;
    else {
      if (++index >= text.length) fail("truncated", "TSV ends with an incomplete escape.", "Copy the complete ClickHouse TabSeparated result.");
      const escaped = text[index];
      const escapes = { "0": "\0", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "\\": "\\", "'": "'" };
      if (escaped === "x") {
        const hex = text.slice(index + 1, index + 3);
        if (!/^[0-9a-f]{2}$/i.test(hex)) fail("invalid_shape", "TSV contains an invalid hexadecimal escape.", "Export valid ClickHouse TabSeparated text.");
        cell += String.fromCharCode(Number.parseInt(hex, 16)); index += 2;
      } else if (escaped === "N" && cell === "" && ["\t", "\r", "\n", undefined].includes(text[index + 1])) cell = "\\N";
      else cell += escapes[escaped] ?? escaped;
    }
  }
  finishCell();
  if (rows.at(-1).length === 1 && rows.at(-1)[0] === "" && rows.length > 1) rows.pop();
  return rows;
}

function tableRows(columns, rows, path) {
  const names = columns.map(column => typeof column === "string" ? column : column?.name);
  if (names.some(name => typeof name !== "string" || !name) || new Set(names).size !== names.length) fail("invalid_shape", "Tabular evidence needs unique non-empty column names.", "Correct the driver column metadata and collect the complete result again.", { path });
  for (let index = 0; index < rows.length; index++) {
    if (!Array.isArray(rows[index]) || rows[index].length !== names.length) fail("invalid_shape", `Tabular row ${index + 1} width does not match its columns.`, "Collect the complete rectangular result again; do not drop or pad cells.", { path: `${path}[${index}]` });
  }
  return rows.map(row => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

function planCanonical(value) {
  if (Array.isArray(value) && value.length && value.every(item => item && typeof item === "object" && !Array.isArray(item) && item.Plan !== undefined)) return value;
  if (Array.isArray(value) && value.length && value.every(item => item && typeof item === "object" && !Array.isArray(item) && typeof item["Node Type"] === "string")) return value.map(Plan => ({ Plan }));
  if (value && typeof value === "object" && !Array.isArray(value) && value.Plan !== undefined) return [value];
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value["Node Type"] === "string") return [{ Plan: value }];
  return null;
}

function rowsCanonical(value) {
  if (Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row))) return value;
  const envelope = value && typeof value === "object" && (Array.isArray(value.data) || Array.isArray(value.rows) || Array.isArray(value.columns) || Array.isArray(value.meta) || Array.isArray(value.content) || value.structuredContent !== undefined || value.result !== undefined);
  if (value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "Plan") && !envelope) return [value];
  return null;
}

function compactRows(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.meta) || !Array.isArray(value.data) || !value.data.every(Array.isArray)) return null;
  return tableRows(value.meta, value.data, "$.data");
}

function columnsRows(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.columns) || !Array.isArray(value.rows)) return null;
  return tableRows(value.columns, value.rows, "$.rows");
}

function jsonIsTruncated(text) {
  const stack = [];
  let quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }
  return quoted || stack.length > 0;
}

function parseJsonText(text, path, limits) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    if (/^[\[{\"]/.test(text.trim()) && jsonIsTruncated(text.trim())) {
      fail("truncated", "JSON evidence appears truncated.", "Copy the complete database or driver result again; do not repair missing plan data by hand.", { path });
    }
    return undefined;
  }
  preflightInput(parsed, limits);
  return parsed;
}

function extractCandidates(input, kind, limits, transformations) {
  const candidates = [];
  const add = (value, path, transport) => {
    const canonical = kind === "plan" ? planCanonical(value) : rowsCanonical(value);
    if (!canonical) return false;
    if (candidates.length >= limits.maxCandidates) fail("oversized", `More than ${limits.maxCandidates} evidence candidates were found.`, "Supply one explicitly selected complete result.", { path });
    candidates.push({ value: canonical, path, transport });
    return true;
  };
  const visit = (value, path, transport = "json", depth = 0) => {
    if (depth > limits.maxDepth) fail("too_deep", `Transport nesting exceeds ${limits.maxDepth} levels.`, "Remove recursive wrappers and supply one complete result.", { path });
    if (typeof value === "string") {
      let text = value;
      if (byteLength(text) > limits.maxInputBytes) fail("oversized", `Input exceeds ${limits.maxInputBytes} bytes.`, "Supply a complete result within the documented intake limit.", { path });
      if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); transformations.push("removed_utf8_bom"); }
      text = text.trim();
      if (!text) return;
      if (/^(?:Code:|DB::Exception|ACCESS_DENIED|UNKNOWN_|SYNTAX_ERROR)/i.test(text)) fail("invalid_shape", "The supplied value is a ClickHouse error, not evidence.", "Resolve collection access/options, then supply a successful complete result.", { path });
      const fenced = completeFence(text, transformations); text = fenced.text.trim();
      const parsed = ["csv", "tsv"].includes(fenced.language) ? undefined : parseJsonText(text, path, limits);
      if (parsed !== undefined) {
        transformations.push(typeof parsed === "string" ? "decoded_json_string" : "parsed_json");
        visit(parsed, path, "json", depth + 1);
        return;
      }
      if (text.includes("\n")) {
        const lines = text.split(/\r?\n/).filter(line => line.trim());
        const parsedLines = lines.map(line => parseJsonText(line, path, limits));
        if (parsedLines.length && parsedLines.every(value => value !== undefined)) {
          preflightInput(parsedLines, limits);
          transformations.push("parsed_json_each_row");
          visit(parsedLines, path, "json-each-row", depth + 1);
          if (kind === "plan") parsedLines.forEach((row, index) => {
            if (row && typeof row === "object" && !Array.isArray(row)) Object.values(row).forEach((cell, cellIndex) => visit(cell, `${path}.rows[${index}].cells[${cellIndex}]`, "json-each-row", depth + 1));
          });
          return;
        }
      }
      const delimiter = fenced.language === "csv" ? "," : fenced.language === "tsv" ? "\t" : text.includes("\t") ? "\t" : text.includes(",") ? "," : null;
      if (delimiter) {
        const rows = delimiter === "\t" ? parseTsv(text) : parseCsv(text);
        transformations.push(delimiter === "\t" ? "parsed_tsv" : "parsed_csv");
        if (kind === "plan") {
          for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            for (let cellIndex = 0; cellIndex < rows[rowIndex].length; cellIndex++) visit(rows[rowIndex][cellIndex], `${path}.rows[${rowIndex}][${cellIndex}]`, delimiter === "\t" ? "tsv" : "csv", depth + 1);
          }
        } else {
          if (rows.length < 2) fail("invalid_shape", "Delimited row evidence needs a header and at least one data row.", "Export the complete result with column names.", { path });
          const headers = rows[0];
          add(tableRows(headers, rows.slice(1), `${path}.rows`), path, delimiter === "\t" ? "tsv" : "csv");
        }
        return;
      }
      if (/^[┌│+]|\b(?:Expression|ReadFrom|Join|Sorting)\b.*(?:\n|─)/.test(text)) fail("unsupported_transport", "A rendered text tree or client table is not lossless JSON evidence.", "Collect a decoded JSON/JSONCompact/JSONEachRow result or a properly quoted TSV/CSV cell.", { path });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (add(value, path, transport)) return;

    const inspectRowCells = (rows, rowPath, rowTransport) => {
      if (kind !== "plan") return;
      rows.forEach((row, rowIndex) => Object.values(row).forEach((cell, cellIndex) => visit(cell, `${rowPath}[${rowIndex}].cells[${cellIndex}]`, rowTransport, depth + 1)));
    };
    const compact = compactRows(value);
    if (compact) {
      transformations.push("decoded_json_compact_rows");
      visit(compact, `${path}.data`, "clickhouse-json-compact", depth + 1);
      inspectRowCells(compact, `${path}.data`, "clickhouse-json-compact");
    }
    const tabular = columnsRows(value);
    if (tabular) {
      transformations.push("decoded_columns_rows");
      visit(tabular, `${path}.rows`, "columns-rows", depth + 1);
      inspectRowCells(tabular, `${path}.rows`, "columns-rows");
    }
    if (Array.isArray(value.data)) {
      transformations.push("extracted_clickhouse_data");
      visit(value.data, `${path}.data`, "clickhouse-json", depth + 1);
      if (kind === "plan") value.data.forEach((row, rowIndex) => {
        if (row && typeof row === "object" && !Array.isArray(row)) Object.values(row).forEach((cell, cellIndex) => {
          transformations.push("extracted_clickhouse_cell");
          visit(cell, `${path}.data[${rowIndex}].cells[${cellIndex}]`, "clickhouse-json", depth + 1);
        });
      });
    }
    if (value.structuredContent !== undefined) { transformations.push("extracted_mcp_structured_content"); visit(value.structuredContent, `${path}.structuredContent`, "mcp-structured", depth + 1); }
    if (Array.isArray(value.content)) {
      value.content.forEach((item, index) => {
        if (item && typeof item === "object" && typeof item.text === "string") {
          transformations.push("extracted_mcp_text_content");
          visit(item.text, `${path}.content[${index}].text`, "mcp-text", depth + 1);
        }
      });
    }
    if (value.result !== undefined) visit(value.result, `${path}.result`, transport, depth + 1);
    if (kind === "plan") for (const key of ["explain", "plan", "json"]) if (value[key] !== undefined) visit(value[key], `${path}.${key}`, transport, depth + 1);
  };
  visit(input, "$", typeof input === "string" ? "text" : "object");
  return candidates;
}

function validatePlan(canonical, limits) {
  let nodes = 0, descriptions = 0, namedReads = 0, anonymousReads = 0;
  const names = new Map(), unknown = new Set();
  const stack = canonical.map((wrapper, index) => [wrapper.Plan, `$[${index}].Plan`, 0]);
  while (stack.length) {
    const [node, path, depth] = stack.pop();
    if (!node || typeof node !== "object" || Array.isArray(node) || typeof node["Node Type"] !== "string" || !node["Node Type"].trim()) fail("invalid_shape", `${path} must be an object with a Node Type string.`, "Supply complete EXPLAIN PLAN JSON, not pipeline or text output.", { path });
    if (++nodes > limits.maxPlanNodes) fail("oversized", `Plan has more than ${limits.maxPlanNodes} nodes.`, "Use a complete plan within the documented node limit; do not truncate branches.", { path });
    if (depth > limits.maxDepth) fail("too_deep", `Plan exceeds ${limits.maxDepth} nested operators.`, "Supply a complete plan within the documented nesting limit.", { path });
    const propertyError = knownPlanPropertyError(node);
    if (propertyError) fail("invalid_shape", `${path}.${propertyError.field}: ${propertyError.message}`, "Collect complete EXPLAIN PLAN JSON again without changing known property types.", { path: `${path}.${propertyError.field}` });
    if (typeof node.Description === "string" && node.Description.length) descriptions++;
    for (const field of Object.keys(node)) if (!PLAN_FIELDS.has(field)) unknown.add(field);
    if (node["Node Type"] === "ReadFromMergeTree") {
      const reference = parseTableReference(node.Description);
      const table = reference && `${reference.database}.${reference.name}`;
      if (table) { namedReads++; names.set(table, (names.get(table) || 0) + 1); }
      else anonymousReads++;
    }
    node.Plans?.forEach((child, index) => stack.push([child, `${path}.Plans[${index}]`, depth + 1]));
  }
  return { nodes, descriptions, namedReads, anonymousReads, repeatedNamedReads: [...names.values()].filter(count => count > 1).reduce((sum, count) => sum + count, 0), tableNames: [...names.keys()], unknownPlanFields: [...unknown].sort() };
}

function optionalEvidence(states = {}) {
  return Object.fromEntries(["estimates", "metadata", "schema", "pipeline", "settings", "runtime"].map(name => {
    const state = states[name] || "uncollected";
    if (!OPTIONAL_STATES.has(state)) fail("invalid_shape", `Unknown optional evidence state ${state}.`, "Use collected, empty, missing, omitted, unsupported, or uncollected.", { path: `$.optionalEvidence.${name}` });
    return [name, state];
  }));
}

export function normalizeEvidence(input, { kind = "plan", candidate, limits: overrides, optionalEvidence: states, estimateRows = [] } = {}) {
  if (!EVIDENCE_KINDS.includes(kind)) fail("invalid_shape", `Unsupported evidence kind ${kind}.`, "Use kind plan or rows.");
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  preflightInput(input, limits, { rawRootString: typeof input === "string" });
  preflightInput(estimateRows, limits);
  const artifactKeys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
  const artifact = artifactKeys.includes("content") && !Array.isArray(input.content) && artifactKeys.every(key => ["content", "name", "mediaType"].includes(key))
    ? input : { content: input };
  const transformations = [];
  const extracted = extractCandidates(artifact.content, kind, limits, transformations);
  const unique = new Map();
  const fingerprints = new Map();
  for (const item of extracted) {
    const canonicalText = stable(item.value);
    if (unique.has(canonicalText)) {
      unique.get(canonicalText).duplicatePaths.push(item.path);
      continue;
    }
    const hash = fingerprint(canonicalText);
    const collision = fingerprints.get(hash) || 0;
    fingerprints.set(hash, collision + 1);
    unique.set(canonicalText, { ...item, fingerprint: collision ? `${hash}-${collision}` : hash, duplicatePaths: [] });
  }
  const candidates = [...unique.values()];
  if (!candidates.length) fail("malformed", `No valid ${kind} evidence candidate was found.`, kind === "plan" ? "Supply complete lossless EXPLAIN PLAN JSON." : "Supply decoded JSON rows or properly quoted CSV/TSV.");
  let selected;
  if (candidate !== undefined) selected = typeof candidate === "number" ? candidates[candidate] : candidates.find(item => item.fingerprint === candidate);
  else if (candidates.length === 1) selected = candidates[0];
  if (!selected) fail("ambiguous_candidates", `${candidates.length} distinct valid ${kind} candidates were found.`, "Select one candidate explicitly by fingerprint or index; do not rely on document order.", { details: { candidates: candidates.map(({ fingerprint: id, value }, index) => ({ index, fingerprint: id, roots: kind === "plan" ? value.length : undefined, rows: kind === "rows" ? value.length : undefined })) } });
  const canonicalBytes = byteLength(JSON.stringify(selected.value));
  if (canonicalBytes > limits.maxCanonicalBytes) fail("oversized", `Canonical evidence exceeds ${limits.maxCanonicalBytes} bytes.`, "Supply a complete result within the canonical evidence limit; do not truncate it.", { path: selected.path });
  const summary = kind === "plan" ? validatePlan(selected.value, limits) : { nodes: 0, descriptions: 0, namedReads: 0, anonymousReads: 0, repeatedNamedReads: 0, unknownPlanFields: [] };
  const estimateNames = new Set(estimateRows.filter(row => row && typeof row.database === "string" && typeof row.table === "string").map(row => `${row.database}.${row.table}`));
  const matchedEstimateNames = new Set([...estimateNames].filter(name => summary.tableNames?.includes(name)));
  const receipt = {
    version: EVIDENCE_CONTRACT_VERSION,
    kind,
    transport: selected.transport,
    transformations: [...new Set(transformations)],
    deduplicatedCandidates: selected.duplicatePaths.length,
    roots: kind === "plan" ? selected.value.length : 0,
    nodes: summary.nodes,
    fidelity: { transport: "lossless", databaseCompleteness: "unverified" },
    descriptions: { present: summary.descriptions, total: summary.nodes },
    attribution: {
      namedReads: summary.namedReads,
      anonymousReads: summary.anonymousReads,
      repeatedNamedReads: summary.repeatedNamedReads,
      matchedEstimates: matchedEstimateNames.size,
      unmatchedEstimates: estimateNames.size - matchedEstimateNames.size
    },
    unknownPlanFields: { count: summary.unknownPlanFields.length },
    optionalEvidence: optionalEvidence(states),
    nextAction: states?.estimates === "uncollected" || !states ? "collect_estimates" : null
  };
  return {
    value: selected.value,
    receipt,
    diagnostics: [],
    privateProvenance: {
      version: EVIDENCE_CONTRACT_VERSION,
      original: artifact.content,
      artifact: artifact.name ? { name: artifact.name, mediaType: artifact.mediaType || null } : null,
      selectedFingerprint: selected.fingerprint,
      extractionPath: selected.path,
      unknownPlanFields: summary.unknownPlanFields,
      candidates: candidates.map(item => ({ fingerprint: item.fingerprint, path: item.path, duplicatePaths: item.duplicatePaths }))
    }
  };
}

export function normalizeEvidenceArtifacts(artifacts, options = {}) {
  if (!Array.isArray(artifacts) || !artifacts.length) fail("invalid_shape", "At least one explicitly supplied artifact is required.", "Supply artifact content directly.");
  const normalized = artifacts.map(artifact => normalizeEvidence(artifact, options));
  return { evidence: normalized.map(item => item.value), receipts: normalized.map(item => item.receipt), diagnostics: normalized.flatMap(item => item.diagnostics), privateProvenance: normalized.map(item => item.privateProvenance) };
}
