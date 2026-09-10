// ClickHouse 26.7/26.8 TSVRaw ANALYZE trees. Metrics stay out of the input
// plan JSON: untrusted extra plan properties cannot impersonate measurements.
const measurements = new WeakMap();
export const measurementFor = node => measurements.get(node);

function count(label) {
  if (/^\d+$/.test(label) && Number.isSafeInteger(Number(label))) return { label, exact: Number(label) };
  if (/^\d+(?:\.\d+)? (?:thousand|million|billion|trillion|quadrillion|quintillion)$/.test(label)) return { label: `≈${label}`, exact: null };
  throw new Error('Unsupported ANALYZE row count. Keep the complete TSVRaw output.');
}

export function parseAnalyze(text) {
  if (typeof text === 'string') text = text.replaceAll('\r\n', '\n');
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024 || !text.startsWith('Query summary:\n') || /(?:^|\n)Code: \d+\./.test(text)) throw new Error('Paste complete EXPLAIN ANALYZE TSVRaw text (26.7/26.8), or clear this optional evidence.');
  const nodes = [], stack = [];
  let current;
  for (const line of text.split('\n')) {
    const heading = line.match(/^((?:│  |   )*)(├──|└──)([A-Za-z][A-Za-z0-9_]*)(?: \((.*)\))?$/)
      || (!nodes.length && line.match(/^()()([A-Za-z][A-Za-z0-9_]*)(?: \((.*)\))?$/));
    if (heading) {
      const depth = heading[2] ? heading[1].length / 3 + 1 : 0;
      if (depth > 128 || nodes.length >= 10000) throw new Error('ANALYZE exceeds the supported tree size.');
      if (depth > stack.length || (nodes.length && !depth)) throw new Error('Incomplete ANALYZE tree.');
      current = { type: heading[3], description: heading[4] || '', children: [], times: [] };
      if (depth) stack[depth - 1].children.push(current);
      stack.length = depth;
      stack.push(current);
      nodes.push(current);
      continue;
    }
    // Unicode branch markers must never be silently ignored as detail text.
    if (/[├└]──/.test(line)) throw new Error('Unsupported ANALYZE operator heading.');
    const detail = line.replace(/^[│ ]+/, '');
    if (detail.startsWith('I/O: rows')) {
      if (!current || current.input) throw new Error('Duplicate or misplaced ANALYZE I/O.');
      const flow = detail.match(/^I\/O: rows (.+?) → (.+?)(?: \([^)]+\))?(?: · .+)?$/);
      if (!flow) throw new Error('Unsupported ANALYZE I/O.');
      current.input = count(flow[1]); current.output = count(flow[2]);
    }
    if (/^(?:time |Stage \()/.test(detail)) {
      const time = detail.match(/^(?:Stage \(([^)]+)\): )?time (\d+(?:\.\d+)? (?:ns|us|µs|ms|s)) \(/);
      if (!current || !time) throw new Error('Unsupported ANALYZE stage timing.');
      current.times.push(`${time[1] || 'Stage'} wall: ${time[2]}`);
    }
  }
  if (!nodes.length || nodes.some(node => !node.input || !node.output || !node.times.length)) throw new Error('Incomplete ANALYZE tree or missing measurements.');
  return { root: nodes[0], nodes };
}

export function attachAnalyze(plan, bundle) {
  const stack = [plan];
  while (stack.length) { const node = stack.pop(); measurements.delete(node); stack.push(...(node.children || [])); }
  const capture = bundle.explain?.analyze;
  if (!capture) return { status: 'missing', message: '' };
  if (capture.sql !== bundle.sql || !['user_attested', 'collector_attested'].includes(capture.association)) return { status: 'unmatched', message: 'ANALYZE not mapped: query association is missing or differs.' };
  let parsed;
  try { parsed = parseAnalyze(capture.text); }
  catch (error) { return { status: 'unsupported', message: `ANALYZE not mapped: ${error.message}` }; }
  const pairs = [], pending = [[plan, parsed.root]];
  while (pending.length) {
    const [node, measured] = pending.pop();
    const children = node.children || [];
    if (node['Node Type'] !== measured.type || (node.Description || '') !== measured.description || children.length !== measured.children.length) return { status: 'unmatched', message: 'ANALYZE not mapped: the ordered operator types/descriptions differ from this plan. Keep the same SQL, settings and schema; compact or changed plans may not match.' };
    // Identical sibling subtrees cannot establish unique branch identity.
    const signatures = measured.children.length > 1 ? measured.children.map(child => JSON.stringify(child, (key, value) => ['input', 'output', 'times'].includes(key) ? undefined : value)) : [];
    if (new Set(signatures).size !== signatures.length) return { status: 'unmatched', message: 'ANALYZE not mapped: repeated identical branches have ambiguous identity.' };
    pairs.push([node, measured]);
    children.forEach((child, index) => pending.push([child, measured.children[index]]));
  }
  for (const [node, measured] of pairs) measurements.set(node, measured);
  return { status: 'matched', message: `ANALYZE: ${pairs.length} operators matched by ordered tree and description; query association attested, not independently verified. Rounded rows use ≈. Stage wall times overlap; do not sum. Raw ANALYZE is omitted from privacy-protected shares.` };
}

export function measuredEdgeRows(child, parent) {
  const output = measurementFor(child)?.output.exact;
  const input = measurementFor(parent)?.input.exact;
  return parent.children?.length === 1 && parent.children[0] === child && output != null && output === input ? output : null;
}

export function measuredEdgeWidth(rows, maximum) {
  return rows == null ? 1.8 : 1.8 + 6 * Math.sqrt(rows / Math.max(1, maximum));
}
