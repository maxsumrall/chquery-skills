import { sqlTokens } from './sql-evidence.js';
import { parseEstimateCount } from './parser.js';

// Composition only: expressions are opaque, and source syntax is deliberately bounded.
export function buildLineage({ sql = '', planReads = [], estimates = [] } = {}) {
  const nodes = [], edges = [], unparsed = [];
  if (!sql.trim()) return { nodes, edges, unparsed };
  const tokens = sqlTokens(sql), pairs = new Map(), stack = [];
  const word = i => tokens[i]?.text;
  const identifier = i => /^[a-z_][\w$]*$/.test(word(i) || '') || tokens[i]?.quoteKind === 'identifier';
  const name = i => tokens[i]?.quoteKind === 'identifier'
    ? sql.slice(tokens[i].start + 1, tokens[i].end - 1).replace(/``/g, '`').replace(/""/g, '"') : sql.slice(tokens[i].start, tokens[i].end);
  const add = (kind, label, a, b, extra = {}) => {
    const node = { id: `lineage-${nodes.length}`, kind, label, range: { start: tokens[a]?.start ?? 0, end: tokens[b - 1]?.end ?? sql.length }, depth: 0, ...extra };
    nodes.push(node);
    return node;
  };
  const edge = (from, to, label) => edges.push({ from: from.id, to: to.id, ...(label ? { label } : {}) });
  let invalid = false;
  tokens.forEach((token, i) => {
    if (token.text === '<unsupported>') invalid = true;
    if (token.text === '(') stack.push(i);
    if (token.text === ')') {
      const start = stack.pop();
      if (start === undefined) invalid = true;
      else pairs.set(start, i);
    }
  });
  if (invalid || stack.length) {
    unparsed.push(add('unparsed', 'unparsed segment', 0, tokens.length));
    return { nodes, edges, unparsed };
  }
  const tables = new Map();
  const unknown = (body, a, b) => {
    if (edges.some(e => e.to === body.id && unparsed.some(n => n.id === e.from))) return;
    const node = add('unparsed', 'unparsed segment', a, b);
    unparsed.push(node); edge(node, body);
  };
  const reserved = new Set('select from join inner left right full cross outer on using where group order having limit settings format union all distinct final sample array prewhere qualify as offset window'.split(' '));
  function body(a, b, target, inherited) {
    const scope = new Map(inherited);
    let start = a;
    if (word(start) === 'with') {
      start++;
      if (word(start) === 'recursive') { unknown(target, a, b); return; }
      while (start < b && word(start) !== 'select') {
        if (identifier(start) && word(start + 1) === 'as' && word(start + 2) === '(' && ['select', 'with'].includes(word(start + 3))) {
          const end = pairs.get(start + 2);
          const cte = add('cte', name(start), start, end + 1);
          body(start + 3, end, cte, scope);
          scope.set(name(start), cte);
          start = end + 1;
        } else {
          // Scalar WITH aliases are expressions, not relation definitions.
          while (start < b && ![',', 'select'].includes(word(start))) {
            if (word(start) === '(') start = pairs.get(start);
            start++;
          }
        }
        if (word(start) === ',') start++;
      }
    }
    if (word(start) !== 'select') { unknown(target, a, b); return; }
    const unions = [];
    for (let i = start; i < b; i++) {
      if (word(i) === '(') i = pairs.get(i);
      else if (word(i) === 'union') unions.push(i);
    }
    if (unions.length) {
      const union = add('union', 'UNION', start, b);
      edge(union, target);
      let branch = start;
      for (let j = 0; j <= unions.length; j++) {
        const end = unions[j] ?? b;
        const marker = unions[Math.max(0, j - 1)];
        const label = ['all', 'distinct'].includes(word(marker + 1)) ? `UNION ${word(marker + 1).toUpperCase()}` : undefined;
        scan(branch, end, union, new Map(scope), label);
        branch = end + (['all', 'distinct'].includes(word(end + 1)) ? 2 : 1);
      }
    } else scan(start, b, target, scope);
  }
  function scan(a, b, target, scope, unionLabel) {
    let inFrom = false, nesting = 0;
    for (let i = a; i < b; i++) {
      const token = word(i);
      if (nesting === 0 && ['intersect', 'except'].includes(token)) unknown(target, i, b);
      if (['where', 'prewhere', 'group', 'order', 'having', 'limit', 'qualify', 'window'].includes(token)) inFrom = false;
      if (token === 'join' && word(i - 1) === 'array') { inFrom = false; continue; }
      const source = nesting === 0 && (token === 'from' || token === 'join' || (token === ',' && inFrom));
      if (source) {
        inFrom = true;
        let p = i + 1, node;
        let label = unionLabel;
        if (token === 'join') {
          const modifier = word(i - 1) === 'outer' ? word(i - 2) : word(i - 1);
          if (['right', 'full'].includes(modifier)) unknown(target, i, b);
          label = ['left', 'inner', 'cross'].includes(modifier) ? `${modifier.toUpperCase()} JOIN` : 'JOIN';
        }
        if (word(p) === '(' && ['select', 'with'].includes(word(p + 1))) {
          const end = pairs.get(p);
          const aliasAt = word(end + 1) === 'as' ? end + 2 : end + 1;
          node = add('subquery', identifier(aliasAt) && !reserved.has(word(aliasAt)) ? name(aliasAt) : 'subquery', p, end + 1);
          body(p + 1, end, node, scope); p = end + 1;
        } else if (identifier(p) && !reserved.has(word(p))) {
          const begin = p, parts = [name(p++)];
          if (word(p) === '.' && identifier(p + 1)) { parts.push(name(p + 1)); p += 2; }
          if (['.', '['].includes(word(p))) { unknown(target, begin, b); i = p; continue; }
          if (word(p) === '(') {
            p = pairs.get(p) + 1;
            node = add('function', parts.join('.'), begin, p);
          } else if (parts.length === 1 && scope.has(parts[0])) node = scope.get(parts[0]);
          else {
            const key = parts.join('.');
            node = tables.get(key);
            if (!node) {
              node = add('table', key, begin, p, { name: parts.at(-1), ...(parts.length === 2 ? { database: parts[0] } : {}) });
              tables.set(key, node);
            }
          }
        } else { unknown(target, p, b); continue; }
        edge(node, target, label);
        if (word(p) === 'as') p++;
        if (identifier(p) && !reserved.has(word(p))) { scope.set(name(p), node); p++; }
        i = p - 1;
      } else if (token === '(' && ['select', 'with'].includes(word(i + 1))) {
        const end = pairs.get(i), sub = add('subquery', 'subquery', i, end + 1);
        body(i + 1, end, sub, scope); edge(sub, target, word(i - 1) === 'in' ? 'IN' : 'scalar'); i = end;
      } else if (token === '(') nesting++;
      else if (token === ')') nesting--;
    }
  }
  const result = add('result', 'Result', 0, tokens.length);
  body(0, tokens.length, result, new Map());
  const reads = planReads.map(read => ({ database: read.database ?? read.table?.database, name: typeof read.table === 'string' ? read.table : read.table?.name ?? read.name }));
  const matches = (node, read) => node.name === read.name && (!node.database || node.database === read.database);
  for (const node of tables.values()) {
    const candidates = reads.filter(read => matches(node, read));
    if (candidates.length && new Set(candidates.map(r => r.database)).size === 1) {
      node.inPlan = true;
      const estimate = estimates.find(e => e.table === node.name && e.database === candidates[0].database);
      const rows = parseEstimateCount(estimate?.rows);
      if (rows !== null) node.estimate = { rows, ...(parseEstimateCount(estimate.granulesKept) !== null ? { granulesKept: parseEstimateCount(estimate.granulesKept) } : {}), ...(parseEstimateCount(estimate.granulesTotal) !== null ? { granulesTotal: parseEstimateCount(estimate.granulesTotal) } : {}) };
    } else node.note = 'view or dictionary — resolved by the server';
  }
  const added = new Set();
  for (const read of reads) {
    const key = [read.database, read.name].filter(Boolean).join('.');
    if (!read.name || added.has(key) || [...tables.values()].some(node => node.inPlan && matches(node, read))) continue;
    added.add(key);
    edge(add('table', key, 0, 0, { name: read.name, database: read.database, range: { start: 0, end: 0 }, note: 'read by a view' }), result);
  }
  const depths = new Map();
  const depth = node => {
    if (depths.has(node.id)) return depths.get(node.id);
    const incoming = edges.filter(e => e.to === node.id);
    node.depth = incoming.length ? Math.max(...incoming.map(e => depth(nodes.find(n => n.id === e.from)))) + 1 : 0;
    depths.set(node.id, node.depth);
    return node.depth;
  };
  nodes.forEach(depth);
  return { nodes, edges, unparsed };
}
