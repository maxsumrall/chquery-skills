const LITERAL_PATTERN = /'(?:''|\\.|[^'\\])*'|(?<![\w.])[-+]?\d+(?:\.\d+)?(?![\w.])/gu;
const REDACTED_STRING = /^<str_\d+>$/;
const REDACTED_NUMBER = /^<num_\d+>$/;
const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_$]/u;

export const REVIEW_PRIVACY_MODES = Object.freeze({
  identifiers: Object.freeze(["retain", "pseudonymize"]),
  literals: Object.freeze(["redact", "retain"])
});

// This is deliberately an allowlist. A new ClickHouse plan property must be
// classified here before identifier pseudonymization can be called complete.
export const PRIVACY_SURFACE_CONTRACT = Object.freeze({
  version: 1,
  sql: "ClickHouse SQL lexical identifiers, quoted identifiers, comments and literals",
  plan: Object.freeze({
    structural: Object.freeze(["Plan", "Plans", "Indexes", "Node Type", "Node Id", "Type", "Search Algorithm", "Direction", "Nulls Direction", "With Fill", "Join Kind", "Join Strictness", "Join Algorithm"]),
    identifierText: Object.freeze(["Description", "Condition", "Expression", "Filter", "Predicate", "Key", "Keys", "Name", "Column", "Column Name", "Columns", "Header", "Group By Keys", "Grouping Keys", "Sort Description", "Sorting Key", "Partition By", "Order By", "Window Functions", "Projection", "Projections", "Join Keys", "Left Keys", "Right Keys"]),
    counts: Object.freeze(["Initial Granules", "Selected Granules", "Initial Parts", "Selected Parts", "Rows", "Parts", "Marks"])
  }),
  estimates: Object.freeze(["database", "table"]),
  schema: Object.freeze(["database", "table", "name", "ddl"]),
  querySource: Object.freeze(["sql", "relationship.kind", "relationship.association"]),
  collectionReceipt: "closed enum/count/state projection; extraction paths and unknown field names are excluded"
});

const STRUCTURAL_FIELDS = new Set(PRIVACY_SURFACE_CONTRACT.plan.structural);
const IDENTIFIER_FIELDS = new Set(PRIVACY_SURFACE_CONTRACT.plan.identifierText);
const COUNT_FIELDS = new Set(PRIVACY_SURFACE_CONTRACT.plan.counts);
const SQL_KEYWORDS = new Set(`ADD AFTER ALIAS ALL ALTER AND ANTI ANY ARRAY AS ASC ASOF ASYNC ATTACH BETWEEN BOTH BY CASE CAST CHECK CLEAR CLUSTER CODEC COLLATE COLUMN COMMENT CREATE CROSS CUBE DATABASE DATABASES DATE DEDUPLICATE DELETE DESC DESCRIBE DETACH DICTIONARY DISTINCT DISTRIBUTED DROP ELSE END ENGINE EXISTS EXPLAIN EXPRESSION EXTRACT FETCH FINAL FIRST FOLLOWING FOR FORMAT FREEZE FROM FULL FUNCTION GLOBAL GRANT GROUP HAVING IF ILIKE IN INDEX INNER INSERT INTERVAL INTO IS JOIN KEY KILL LAST LAYOUT LEFT LIKE LIMIT LIVE LOCAL MATERIALIZE MATERIALIZED MODIFY MOVE MUTATION NATURAL NO NOT NULL NULLS OFFSET ON OPTIMIZE OR ORDER OUTER OVER PARTITION PRECEDING PREWHERE PRIMARY PROJECTION RENAME REPLACE REPLICA RIGHT ROLE ROLLUP ROW ROWS SAMPLE SELECT SEMI SET SETTING SHOW SOURCE SYNC SYSTEM TABLE TABLES TEMPORARY THEN TIES TO TOP TOTALS TRUNCATE TTL TYPE UNBOUNDED UNION UPDATE USE USING VALUES VIEW WATCH WHEN WHERE WINDOW WITH`.split(/\s+/));
const SEMANTIC_WORDS = new Set(`AGGREGATING ARRAYJOIN BEFORE CHANGING COLUMN CONVERSION DISTINCT EXPRESSION FILTER FILL FIRST JOIN LIMIT MERGETREE NAMES PRELIMINARY PROJECT PROJECTION READFROMMERGETREE SORTING SPLIT STEP TRUE FALSE INF NAN PRIMARYKEY MINMAX SKIP`.split(/\s+/));
const BUILTINS = new Set(`ABS AND ARRAYJOIN ASSUMENOTNULL AVG CAST COALESCE CONCAT COUNT DATE_DIFF DATEDIFF EQUALS GLOBALIN GLOBALNOTIN HAS IF IN ILIKE ISNOTNULL ISNULL LIKE LOWER MAX MIN MULTIIF NOT NOTEQUALS NOTIN NOW OR PLUS SUBSTRING SUM TO_DATE TODATE TODATETIME TOFLOAT64 TOINT32 TOINT64 TOSTRING TOUINT32 TOUINT64 TOYYYYMM TRIM UPPER`.split(/\s+/));
const STRUCTURAL_VALUES = Object.freeze({
  "Node Type": new Set(["Aggregating", "ArrayJoin", "BuildRuntimeFilter", "CreatingSets", "Distinct", "Expression", "Filter", "Join", "JoinLazyColumnsStep", "LazilyReadFromMergeTree", "Limit", "ReadFromMergeTree", "ReadFromStorage", "Sorting", "Union", "Window"]),
  Type: new Set(["PrimaryKey", "Skip", "Min-Max", "Partition"]),
  "Search Algorithm": new Set(["binary search", "generic exclusion search"]),
  Direction: new Set(["Ascending", "Descending"]),
  "Nulls Direction": new Set(["First", "Last"]),
  "Join Kind": new Set(["Inner", "Left", "Right", "Full", "Cross"]),
  "Join Strictness": new Set(["All", "Any", "Asof", "Semi", "Anti"]),
  "Join Algorithm": new Set(["Hash", "GraceHash", "FullSortingMerge", "PartialMerge", "Direct", "Auto", "ParallelHash"])
});

function isSupportedStructuralValue(key, value) {
  return key === "With Fill" ? ["true", "false"].includes(value.toLowerCase()) : STRUCTURAL_VALUES[key]?.has(value) === true;
}

function record(context, kind, path, original, replacement) {
  context.counts[kind] += 1;
  if (context.review.length < 200) context.review.push({ kind, path, original, replacement });
}

function replacement(context, kind, original, path) {
  const mapping = context.mappings[kind];
  if (!mapping.has(original)) {
    const prefix = kind === "string" ? "str" : kind === "numeric" ? "num" : kind === "reference" ? "ref" : "id";
    mapping.set(original, ["identifier", "reference"].includes(kind) ? `${prefix}_${mapping.size + 1}` : `<${prefix}_${mapping.size + 1}>`);
  }
  const value = mapping.get(original);
  record(context, kind, path, original, value);
  return value;
}

function referenceReplacement(context, original, path) {
  return /^ref_\d+$/.test(original) ? original : replacement(context, "reference", original, path);
}

export function createPrivacyContext({ identifiers = "retain", literals = "redact" } = {}) {
  if (!REVIEW_PRIVACY_MODES.identifiers.includes(identifiers) || !REVIEW_PRIVACY_MODES.literals.includes(literals)) {
    throw new TypeError("Privacy modes must be retained identifiers or pseudonymization, and retained literals or redaction.");
  }
  return {
    identifiers, literals,
    mappings: { string: new Map(), numeric: new Map(), identifier: new Map(), reference: new Map() },
    counts: { string: 0, numeric: 0, identifier: 0, reference: 0 },
    review: [], residual: [], supported: new Set(), failures: []
  };
}

function redactText(text, context, path) {
  if (context.literals === "retain") return text;
  return text.replace(LITERAL_PATTERN, literal => {
    if (literal.startsWith("'")) {
      const value = literal.slice(1, -1);
      if (REDACTED_STRING.test(value)) return literal;
      return `'${replacement(context, "string", value, path)}'`;
    }
    if (REDACTED_NUMBER.test(literal)) return literal;
    const digitCount = (literal.match(/\d/g) || []).length;
    return digitCount > 4 ? replacement(context, "numeric", literal, path) : literal;
  });
}

function commentReplacement(comment) {
  // Keep line structure and force token separation. Removing `a/**/b` as an
  // empty string would silently create the different identifier `ab`.
  return comment.replace(/[^\r\n]/g, " ") || " ";
}

function stripComments(text, context, path, strictQuotes = true) {
  let output = "", index = 0;
  while (index < text.length) {
    const quote = text[index];
    if (["'", '"', "`"].includes(quote)) {
      let end = index + 1, closed = false;
      while (end < text.length) {
        if (text[end] === quote && text[end + 1] === quote) { end += 2; continue; }
        if (quote === "'" && text[end] === "\\" && end + 1 < text.length) { end += 2; continue; }
        if (text[end] === quote) { end++; closed = true; break; }
        end++;
      }
      if (!closed && strictQuotes) throw privacyFailure(path, `Unterminated ${quote === "'" ? "string literal" : "quoted identifier"}.`);
      output += text.slice(index, end); index = end; continue;
    }
    if (text[index] === "-" && text[index + 1] === "-") {
      const end = text.indexOf("\n", index + 2), stop = end < 0 ? text.length : end;
      const original = text.slice(index, stop), replacement = commentReplacement(original);
      output += replacement; context.residual.push({ path, category: "source-comment-removed" });
      if (context.review.length < 200) context.review.push({ kind: "comment", path, original, replacement });
      index = stop; continue;
    }
    if (text[index] === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw privacyFailure(path, "Unterminated block comment.");
      const original = text.slice(index, end + 2), replacement = commentReplacement(original);
      output += replacement; context.residual.push({ path, category: "source-comment-removed" });
      if (context.review.length < 200) context.review.push({ kind: "comment", path, original, replacement });
      index = end + 2; continue;
    }
    if (text[index] === "#") {
      const end = text.indexOf("\n", index + 1), stop = end < 0 ? text.length : end;
      const original = text.slice(index, stop), replacement = commentReplacement(original);
      output += replacement; context.residual.push({ path, category: "source-comment-removed" });
      if (context.review.length < 200) context.review.push({ kind: "comment", path, original, replacement });
      index = stop; continue;
    }
    output += text[index++];
  }
  return output;
}

function protectText(text, context, path, strictQuotes = true) {
  return redactText(stripComments(text, context, path, strictQuotes), context, path);
}

function quotedIdentifier(text, start, quote, context, path) {
  let index = start + 1, value = "";
  while (index < text.length) {
    if (text[index] === quote) {
      if (text[index + 1] === quote) { value += quote; index += 2; continue; }
      const pseudonym = replacement(context, "identifier", value, path);
      return { text: `${quote}${pseudonym}${quote}`, end: index + 1 };
    }
    value += text[index++];
  }
  throw privacyFailure(path, "Unterminated quoted identifier.");
}

function privacyFailure(path, message) {
  const error = new TypeError(`Identifier pseudonymization stopped at ${path}: ${message} Choose retained identifiers or omit optional evidence and prepare again.`);
  error.code = "unsupported-surface";
  error.paths = [path];
  error.repair = "Choose disclosed retained identifiers, or omit the optional evidence containing this surface and prepare again.";
  return error;
}

function isSemanticWord(word, next, previousWord, previousCharacter) {
  const upper = word.toUpperCase();
  if (previousCharacter === "." || next === "." || ["FROM", "JOIN", "INTO", "UPDATE", "TABLE", "DATABASE", "VIEW", "DICTIONARY", "AS"].includes(previousWord)) return false;
  if (upper === "DEFAULT") return /^(?:U?INT\d+|FLOAT\d+|DECIMAL\d*|DATE(?:TIME\d*)?|STRING|FIXEDSTRING|BOOL|BOOLEAN|UUID|IPV[46]|ENUM\d+|LOWCARDINALITY|NULLABLE|ARRAY|TUPLE|MAP)$/.test(previousWord || "");
  return SQL_KEYWORDS.has(upper) || SEMANTIC_WORDS.has(upper) || (BUILTINS.has(upper) && next === "(") ||
    /^(?:U?INT\d+|FLOAT\d+|DECIMAL\d*|DATE(?:TIME\d*)?|STRING|FIXEDSTRING|BOOL|BOOLEAN|UUID|IPV[46]|ENUM\d+|LOWCARDINALITY|NULLABLE|ARRAY|TUPLE|MAP)$/.test(upper) ||
    (next === "(" && /^[A-Z][A-Z0-9_]*$/.test(word));
}

/** Transform a supported SQL/expression surface without parsing or rewriting
 * its structure. Comments and whitespace are retained and disclosed.
 */
export function pseudonymizeSql(text, context, path = "sql") {
  if (typeof text !== "string") throw privacyFailure(path, "Expected text.");
  let output = "", index = 0, previousWord = null;
  while (index < text.length) {
    const character = text[index];
    if (character === "'") {
      let end = index + 1, closed = false;
      while (end < text.length) {
        if (text[end] === "'" && text[end + 1] === "'") { end += 2; continue; }
        if (text[end] === "\\" && end + 1 < text.length) { end += 2; continue; }
        if (text[end] === "'") { end++; closed = true; break; }
        end++;
      }
      if (!closed) throw privacyFailure(path, "Unterminated string literal.");
      output += redactText(text.slice(index, end), context, path); index = end; continue;
    }
    if (character === '"' || character === "`") {
      const token = quotedIdentifier(text, index, character, context, path);
      output += token.text; index = token.end; continue;
    }
    if (character === "-" && text[index + 1] === "-") {
      const end = text.indexOf("\n", index + 2), stop = end < 0 ? text.length : end;
      const original = text.slice(index, stop), replacement = commentReplacement(original);
      output += replacement; context.residual.push({ path, category: "source-comment-removed" });
      if (context.review.length < 200) context.review.push({ kind: "comment", path, original, replacement });
      index = stop; continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw privacyFailure(path, "Unterminated block comment.");
      const original = text.slice(index, end + 2), replacement = commentReplacement(original);
      output += replacement; context.residual.push({ path, category: "source-comment-removed" });
      if (context.review.length < 200) context.review.push({ kind: "comment", path, original, replacement });
      index = end + 2; continue;
    }
    if (character === "#") {
      const end = text.indexOf("\n", index + 1), stop = end < 0 ? text.length : end;
      const original = text.slice(index, stop), replacement = commentReplacement(original);
      output += replacement; context.residual.push({ path, category: "source-comment-removed" });
      if (context.review.length < 200) context.review.push({ kind: "comment", path, original, replacement });
      index = stop; continue;
    }
    if (WORD_START.test(character)) {
      let end = index + 1;
      while (end < text.length && WORD_PART.test(text[end])) end++;
      const word = text.slice(index, end), next = text.slice(end).trimStart()[0], previousCharacter = text.slice(0, index).trimEnd().at(-1);
      output += isSemanticWord(word, next, previousWord, previousCharacter) ? word : replacement(context, "identifier", word, path);
      previousWord = word.toUpperCase();
      index = end; continue;
    }
    if (character === "<") {
      const marker = /^<(?:str|num)_\d+>/.exec(text.slice(index));
      if (marker) { output += marker[0]; index += marker[0].length; continue; }
    }
    if (/\d/.test(character) || ((character === "+" || character === "-") && /\d/.test(text[index + 1]))) {
      const match = /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(text.slice(index));
      if (!match) throw privacyFailure(path, "Unsupported numeric token.");
      output += redactText(match[0], context, path); index += match[0].length; continue;
    }
    if (/\s|[.,;:*+\-/%=<>!?()[\]{}|&^~→←↔─│┌┐└┘×]/u.test(character)) { output += character; index++; continue; }
    throw privacyFailure(path, `Unsupported token ${JSON.stringify(character)}.`);
  }
  context.supported.add(path);
  return output;
}

function transformIdentifierValue(value, context, path) {
  if (typeof value === "string") return pseudonymizeSql(value, context, path);
  if (Array.isArray(value)) return value.map((item, index) => transformIdentifierValue(item, context, `${path}[${index}]`));
  if (value && typeof value === "object") return transformPlan(value, context, path);
  throw privacyFailure(path, "Identifier-bearing properties must contain text, arrays, or records.");
}

function transformPlan(value, context, path) {
  if (Array.isArray(value)) return value.map((item, index) => transformPlan(item, context, `${path}[${index}]`));
  if (!value || typeof value !== "object") throw privacyFailure(path, "Plan containers must be records or arrays.");
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (["Plan", "Plans", "Indexes"].includes(key)) output[key] = transformPlan(child, context, childPath);
    else if (IDENTIFIER_FIELDS.has(key)) output[key] = transformIdentifierValue(child, context, childPath);
    else if (key === "Node Id") output[key] = referenceReplacement(context, String(child), childPath);
    else if (STRUCTURAL_FIELDS.has(key)) {
      if (!["string", "number", "boolean"].includes(typeof child) && child !== null) throw privacyFailure(childPath, "Structural property has an unsupported value.");
      if (typeof child === "string" && !isSupportedStructuralValue(key, child)) throw privacyFailure(childPath, `Unsupported structural ${key} value.`);
      output[key] = child; context.supported.add(childPath);
    } else if (COUNT_FIELDS.has(key)) {
      output[key] = child; context.supported.add(childPath);
    } else throw privacyFailure(childPath, `Unclassified plan property ${JSON.stringify(key)}.`);
  }
  return output;
}

export function transformPlanPropertiesPrivacy(properties, context, path = "branchScope.properties") {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw privacyFailure(path, "Scoped plan properties must be a record.");
  }
  return context.identifiers === "pseudonymize"
    ? transformPlan(properties, context, path)
    : transformPlanLiterals(properties, context, path);
}

function transformPlanLiterals(value, context, path, identifierBearing = false) {
  if (Array.isArray(value)) return value.map((item, index) => transformPlanLiterals(item, context, `${path}[${index}]`, identifierBearing));
  if (identifierBearing && typeof value === "string") return protectText(value, context, path, false);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const childPath = `${path}.${key}`, known = ["Plan", "Plans", "Indexes"].includes(key) || STRUCTURAL_FIELDS.has(key) || COUNT_FIELDS.has(key) || IDENTIFIER_FIELDS.has(key);
    if (!known) context.residual.push({ path: "explain.plan.other-field", category: "unclassified-plan-field-retained" });
    return [key, transformPlanLiterals(child, context, childPath, IDENTIFIER_FIELDS.has(key))];
  }));
}

function pseudonymizeName(value, context, path) {
  if (typeof value !== "string") throw privacyFailure(path, "Expected an identifier string.");
  if (/^id_\d+$/.test(value)) return value;
  return replacement(context, "identifier", value, path);
}

function transformSettings(value, context, key = "", path = "settings") {
  if (Array.isArray(value)) return value.map((child, index) => transformSettings(child, context, "", `${path}[${index}]`));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, transformSettings(child, context, childKey, `${path}.${childKey}`)]));
  if (key === "name") { context.residual.push({ path, category: "setting-name" }); return value; }
  if (typeof value === "number") return redactText(String(value), context, path);
  if (typeof value !== "string") return value;
  if (REDACTED_STRING.test(value) || REDACTED_NUMBER.test(value)) return value;
  const redacted = redactText(value, context, path);
  if (redacted !== value || /^[-+]?\d+(?:\.\d+)?$/.test(value)) return redacted;
  if (context.literals === "retain") return value;
  return replacement(context, "string", value, path);
}

function transformRuntimeReferences(runtime, context) {
  const transformProvenance = (provenance, path) => !provenance ? provenance : Object.fromEntries(Object.entries(provenance).map(([key, value]) =>
    [key, key.endsWith("_ref") ? referenceReplacement(context, value, `${path}.${key}`) : value]));
  return {
    ...runtime,
    ...(runtime.provenance ? { provenance: transformProvenance(runtime.provenance, "runtime.provenance") } : {}),
    ...(runtime.samples ? { samples: runtime.samples.map((sample, index) => ({ ...sample,
      ...(sample.id ? { id: referenceReplacement(context, sample.id, `runtime.samples[${index}].id`) } : {}),
      ...(sample.provenance ? { provenance: transformProvenance(sample.provenance, `runtime.samples[${index}].provenance`) } : {})
    })) } : {})
  };
}

export function transformBundlePrivacy(bundle, context = createPrivacyContext()) {
  if (!bundle || bundle.chquery !== 1) throw new TypeError("Expected a bare v1 bundle.");
  const output = structuredClone(bundle);
  const initial = { ...context.counts };
  // Opaque ANALYZE text includes SQL expressions/identifiers. Do not pretend
  // SQL redaction preserves its tree grammar or measured counters.
  if (output.explain?.analyze !== undefined) {
    delete output.explain.analyze;
    context.residual.push({ path: 'explain.analyze', category: 'raw-analyze-omitted' });
  }
  output.sql = context.identifiers === "pseudonymize" ? pseudonymizeSql(output.sql, context, "sql") : protectText(output.sql, context, "sql");
  output.explain.plan = context.identifiers === "pseudonymize"
    ? transformPlan(output.explain.plan, context, "explain.plan")
    : transformPlanLiterals(output.explain.plan, context, "explain.plan");
  for (const field of ["pipeline", "syntax"]) if (typeof output.explain[field] === "string") {
    output.explain[field] = context.identifiers === "pseudonymize"
      ? pseudonymizeSql(output.explain[field], context, `explain.${field}`)
      : protectText(output.explain[field], context, `explain.${field}`);
  }
  if (output.explain.estimate) output.explain.estimate = output.explain.estimate.map((row, index) => ({ ...row,
    ...Object.fromEntries(["database", "table"].filter(key => row[key] !== undefined).map(key => [key, context.identifiers === "pseudonymize"
      ? pseudonymizeName(row[key], context, `explain.estimate[${index}].${key}`) : row[key]]))
  }));
  if (output.schema) output.schema = output.schema.map((row, index) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const path = `schema[${index}].${key}`;
    if (context.identifiers === "pseudonymize" && ["database", "table", "name"].includes(key)) return [key, pseudonymizeName(value, context, path)];
    if (key === "ddl") return [key, context.identifiers === "pseudonymize" ? pseudonymizeSql(value, context, path) : protectText(value, context, path)];
    if (key === "engine") { context.supported.add(path); return [key, value]; }
    return [key, value];
  })));
  if (output.settings !== undefined) output.settings = transformSettings(output.settings, context);
  if (output.runtime !== undefined) output.runtime = transformRuntimeReferences(output.runtime, context);
  if (output.query_source !== undefined) {
    output.query_source.sql = context.identifiers === "pseudonymize"
      ? pseudonymizeSql(output.query_source.sql, context, "query_source.sql")
      : protectText(output.query_source.sql, context, "query_source.sql");
  }
  const changed = Object.fromEntries(Object.keys(initial).map(key => [key, context.counts[key] - initial[key]]));
  const summary = `${changed.string} string literal${changed.string === 1 ? "" : "s"}, ${changed.numeric} numeric literal${changed.numeric === 1 ? "" : "s"} replaced`;
  const redaction = {
    applied: context.literals === "redact" ? ["string_literals", "numeric_literals"] : [],
    identifiers: context.identifiers === "pseudonymize",
    summary
  };
  if (changed.string === 0 && changed.numeric === 0 && changed.identifier === 0 && changed.reference === 0 && output.redaction?.summary) {
    // Preserve a previously prepared artifact byte-for-byte on another literal
    // redaction pass, including its original replacement counts.
  } else if (context.literals === "redact" || context.identifiers === "pseudonymize") output.redaction = redaction;
  else delete output.redaction;
  const inventory = {
    contractVersion: PRIVACY_SURFACE_CONTRACT.version,
    status: "complete",
    literals: { mode: context.literals, stringReplacements: changed.string, numericReplacements: changed.numeric,
      warning: "Numbers with four or fewer digits are retained." },
    identifiers: { mode: context.identifiers, replacements: changed.identifier,
      warning: context.identifiers === "pseudonymize" ? "Equal identifiers share a review-local pseudonym, disclosing within-review correlation." : "Identifiers are retained and may be sensitive." },
    references: { mode: "review-local-token", replacements: changed.reference,
      warning: "Equal runtime references share a review-local token, disclosing within-review correlation." },
    residualExposure: [...new Map(context.residual.map(item => [`${item.path}:${item.category}`, item])).values()],
    claims: ["Not anonymized.", "Prepared SQL is not executable source.", "No literal equality, semantic equivalence, result equivalence, or correctness is established."]
  };
  return { bundle: output, summary, inventory, review: context.review };
}

// Compatibility API used by existing CLI/link flows. A caller preparing a pair
// should pass one shared context to preserve pair-local identity.
export function redactBundle(bundle, context = createPrivacyContext()) {
  const initial = { ...context.counts };
  const redactPlan = (value, path) => {
    if (Array.isArray(value)) return value.map((item, index) => redactPlan(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      key === "Description" && typeof child === "string" ? protectText(child, context, `${path}.${key}`, false) : redactPlan(child, `${path}.${key}`)]));
  };
  const output = {
    ...bundle,
    sql: protectText(bundle.sql, context, "sql"),
    explain: {
      ...bundle.explain,
      ...(bundle.explain?.plan !== undefined ? { plan: redactPlan(bundle.explain.plan, "explain.plan") } : {}),
      ...(typeof bundle.explain?.pipeline === "string" ? { pipeline: protectText(bundle.explain.pipeline, context, "explain.pipeline") } : {}),
      ...(typeof bundle.explain?.syntax === "string" ? { syntax: protectText(bundle.explain.syntax, context, "explain.syntax") } : {})
    }
  };
  delete output.explain.analyze;
  if (bundle.settings !== undefined) output.settings = transformSettings(bundle.settings, context);
  const strings = context.counts.string - initial.string, numerics = context.counts.numeric - initial.numeric;
  const summary = `${strings} string literal${strings === 1 ? "" : "s"}, ${numerics} numeric literal${numerics === 1 ? "" : "s"} replaced`;
  output.redaction = strings === 0 && numerics === 0 && bundle.redaction?.summary ? bundle.redaction : {
    applied: ["string_literals", "numeric_literals"], identifiers: false, summary
  };
  return { bundle: output, summary, inventory: {
    contractVersion: PRIVACY_SURFACE_CONTRACT.version, status: "partial", literals: { mode: "redact", stringReplacements: strings, numericReplacements: numerics },
    identifiers: { mode: "retain", replacements: 0 }, residualExposure: [{ path: "bundle", category: "legacy-unclassified-fields" }],
    claims: ["Not anonymized."]
  }, review: context.review.map(item => ({ ...item })) };
}
