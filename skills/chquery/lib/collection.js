import { sqlTokens } from './sql-evidence.js';
import { EvidenceNormalizationError, normalizeEvidence } from './normalizer.js';

export const metadataSQL = {
  version: 'SELECT version()',
  cloud: "SELECT value FROM system.settings WHERE name = 'cloud_mode'",
  settings: 'SELECT name, value, default FROM system.settings WHERE changed = 1 FORMAT JSONEachRow',
  settingsWithoutDefault: 'SELECT name, value FROM system.settings WHERE changed = 1 FORMAT JSONEachRow'
};
export const runtimeFields = ['read_rows', 'read_bytes', 'result_rows', 'memory_usage', 'query_duration_ms'];
export const collectionProfiles = Object.freeze({
  core: Object.freeze({ plan: 'required', estimates: 'excluded', metadata: 'excluded', schema: 'excluded', pipeline: 'excluded', settings: 'excluded', runtime: 'excluded' }),
  described: Object.freeze({ plan: 'required', estimates: 'optional', metadata: 'optional', schema: 'enrichment', pipeline: 'optional', settings: 'optional', runtime: 'enrichment' })
});

function outputClause(output, kind) {
  if (output?.owner === 'client') return '';
  if (output?.owner !== undefined && output.owner !== 'chquery') throw new TypeError('Output owner must be chquery or client.');
  const formats = { plan: 'TSVRaw', estimate: 'JSONEachRow', pipeline: 'TSVRaw', rows: 'JSONEachRow' };
  const format = output?.[kind] || formats[kind];
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(format)) throw new TypeError(`Invalid ${kind} output format.`);
  const textFormats = kind === 'rows' || kind === 'estimate'
    ? ['JSON', 'JSONCompact', 'JSONEachRow', 'CSV', 'TSV']
    : ['TSVRaw', 'JSON', 'JSONCompact', 'JSONEachRow', 'CSV', 'TSV'];
  if (!textFormats.includes(format)) throw new TypeError(`${format} is not a supported lossless text format. Binary Native output must be decoded by the client before normalization.`);
  return `\nFORMAT ${format}`;
}

function assertExecutableSQL(sql) {
  if (/\{[{%#][\s\S]*[}%#]\}/.test(sql) || /\b(?:ref|source)\s*\(\s*['"]/i.test(sql)) {
    throw new EvidenceNormalizationError('source_requires_compilation', 'This appears to be uncompiled Jinja/dbt source, not executable ClickHouse SQL.', 'Compile it in the project that owns its dbt context, then supply the executable SQL while preserving this source separately.');
  }
}

// Conservative preparation, not SQL rewriting. The original SQL stays untouched.
export function collectionSQL(sql, { output } = {}) {
  assertExecutableSQL(sql);
  const tokens = sqlTokens(sql);
  if (!['select', 'with'].includes(tokens[0]?.text)) throw new Error('Supply a nonempty SELECT/WITH query, not EXPLAIN or a script. Your original SQL is kept unchanged.');
  if (tokens.some(token => token.text === '<unsupported>')) throw new Error('This query contains an unfinished quote/comment or unsupported quoting. Review it before collecting; no SQL was changed.');
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.text === '(') depth++;
    if (token.text === ')' && --depth < 0) throw new Error('Check the closing parentheses in your original query.');
    if (token.text === ';' && index !== tokens.length - 1) throw new Error('Use one SELECT/WITH statement. Remove additional statements; semicolons inside quoted text are allowed.');
    if (token.text === 'format' && depth === 0) throw new Error('Remove the output FORMAT clause for collection (or quote an identifier named format). CH Query supplies its own raw output format.');
  }
  if (depth) throw new Error('Check the parentheses in your original query.');
  const last = tokens.at(-1);
  const prepared = (last.text === ';' ? sql.slice(0, last.start) + sql.slice(last.end) : sql).trim();
  return {
    plan: `EXPLAIN PLAN indexes = 1, json = 1, description = 1\n${prepared}${outputClause(output, 'plan')}`,
    estimate: `EXPLAIN ESTIMATE\n${prepared}${outputClause(output, 'estimate')}`,
    pipeline: `EXPLAIN PIPELINE\n${prepared}${outputClause(output, 'pipeline')}`
  };
}

function parseInput(text, label, optional) {
  text = text.trim();
  if (/^(?:Code:|DB::Exception|ACCESS_DENIED|UNKNOWN_|SYNTAX_ERROR)/i.test(text)) {
    throw new Error(`${label}: this is a ClickHouse error, not evidence. Check access to the named resource or supported options in your SQL client.${optional ? ' You can clear and skip this optional evidence.' : ' A valid plan is required; ask for access to the referenced table.'}`);
  }
  return text;
}

export function planInput(text) {
  try { return normalizeEvidence(text, { kind: 'plan' }).value; }
  catch (error) {
    if (error instanceof EvidenceNormalizationError) throw error;
    throw new EvidenceNormalizationError('malformed', 'Paste complete lossless EXPLAIN PLAN JSON.', 'Copy the complete plan output again; do not repair escapes or missing branches by hand.');
  }
}

export function rowInput(text, kind) {
  const label = kind === 'estimate' ? 'EXPLAIN ESTIMATE' : kind === 'settings' ? 'changed settings' : 'runtime measurements';
  text = parseInput(text, label, true);
  if (!text) return [];
  let rows;
  try {
    rows = normalizeEvidence(text, { kind: 'rows' }).value;
  } catch (error) {
    if (error instanceof EvidenceNormalizationError) {
      throw new EvidenceNormalizationError(
        error.code,
        `${label}: ${error.message} You can clear and skip this optional evidence.`,
        `${error.repair} Or clear this field and continue without the optional evidence.`,
        { path: error.path, details: error.details }
      );
    }
    throw new Error(`${label}: invalid lossless row evidence. Use JSON, JSONEachRow, JSONCompact, columns/rows, or properly quoted CSV/TSV; or clear and skip this optional evidence.`);
  }
  for (const [i, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label}: row ${i + 1} must be a JSON object.`);
    if (kind === 'settings' && (typeof row.name !== 'string' || !row.name || typeof row.value !== 'string' || (row.default !== undefined && typeof row.default !== 'string'))) throw new Error(`changed settings: row ${i + 1} needs name/value strings and an optional default string.`);
    if (kind === 'estimate') {
      if (typeof row.database !== 'string' || typeof row.table !== 'string') throw new Error(`EXPLAIN ESTIMATE: row ${i + 1} needs database/table strings.`);
      for (const name of ['rows', 'parts', 'marks']) if (row[name] !== undefined && !validCount(row[name])) throw new Error(`EXPLAIN ESTIMATE: row ${i + 1}.${name} must be a nonnegative safe integer, or omit it when unknown.`);
    }
  }
  return rows;
}

function validCount(value) {
  return (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

export function runtimeInput(text) {
  const rows = rowInput(text, 'runtime');
  if (rows.length !== 1) throw new Error(rows.length ? 'Multiple runtime records match. Choose one authorized completed run in your SQL client; do not sum them or hide ambiguity with LIMIT 1.' : 'No runtime record supplied. Logs may be delayed, unavailable or on another node. Cancel to keep measurements unknown; do not rerun or flush logs.');
  const metrics = rows[0];
  for (const name of Object.keys(metrics)) {
    if (!runtimeFields.includes(name)) throw new Error(`Only the five numeric runtime fields are accepted. Remove other fields; do not paste query IDs, text, users or hostnames.`);
    if (!validCount(metrics[name])) throw new Error(`${name} must be a nonnegative safe integer (bytes, rows or milliseconds). Omit unavailable fields; preserve actual zero.`);
  }
  if (!Object.keys(metrics).length) throw new Error('Supply at least one measured value, or cancel without adding runtime evidence.');
  return metrics;
}

export function runtimeSQL(id, from, to, { output } = {}) {
  if (!id.trim()) throw new Error('Enter the query ID of an already-authorized completed run. It is used only in this dialog.');
  const dates = [from, to].map(value => /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value) ? Date.parse(`${value}Z`) : NaN);
  if (!dates.every(Number.isFinite) || dates[1] <= dates[0] || dates[1] - dates[0] > 86400000) throw new Error('Choose a UTC time window with an end after the start, no longer than 24 hours.');
  const literal = value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\0', '\\0')}'`;
  const stamp = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
  return `SELECT ${runtimeFields.join(', ')}\nFROM system.query_log\nWHERE query_id = ${literal(id)}\n  AND type = 'QueryFinish' AND is_initial_query = 1\n  AND event_time >= toDateTime('${stamp(dates[0])}', 'UTC')\n  AND event_time < toDateTime('${stamp(dates[1])}', 'UTC')${outputClause(output, 'rows')}`;
}

export function mergeManualRuntime(bundle, metrics, { associated, successful, scope, source } = {}) {
  if (bundle.runtime?.samples !== undefined) throw new Error('This bundle contains authoritative runtime samples. Use the comparison workflow to edit them; a single-run editor cannot replace them.');
  if (!associated) throw new Error('Confirm that these metrics describe one approved run of the current SQL.');
  // Replace, rather than mix measurements or provenance from different runs.
  const provenance = { version: 1, association: 'user_attested' };
  if (['query_log', 'response_summary', 'other'].includes(source)) provenance.source = source;
  if (successful) provenance.status = 'successful';
  if (['query_wide', 'single_node', 'distributed_aggregate'].includes(scope)) provenance.scope = scope;
  return { ...bundle, runtime: { ...bundle.runtime, query_log: metrics, provenance } };
}

export function withoutQueryEvidence(bundle = {}) {
  // Called only after explicit confirmation in the wizard. Keep independent metadata.
  const next = structuredClone(bundle);
  delete next.runtime;
  delete next.explain;
  return next;
}

export async function copyCollectionText(element, status) {
  try {
    await navigator.clipboard.writeText(element.textContent);
    status.textContent = 'Copied. Run this statement separately in your approved SQL client.';
  } catch {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    status.textContent = 'Clipboard unavailable. Copy the selected text manually.';
  }
}
