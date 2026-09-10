import { buildLineage } from './lineage.js';

export function createLineageView({ panel, revealSQL, closeSQL, selectRead }) {
  const d3 = window.d3;
  let model, sql = '', svg, graph, zoom, cards, links, selected;
  const active = () => !panel.hidden && panel.getClientRects().length > 0 && !document.querySelector('dialog[open]');
  const clearMark = () => { document.getElementById('sqlPreview').textContent = sql || 'No SQL provided.'; };
  function select(node, jump = true) {
    if (!svg) return;
    if (jump && node?.inPlan) { clearMark(); selectRead(node); return; }
    selected = selected === node ? null : node;
    const upstream = new Set();
    const visit = id => {
      if (upstream.has(id)) return;
      upstream.add(id);
      model.edges.filter(e => e.to === id).forEach(e => visit(e.from));
    };
    if (selected) visit(selected.id);
    cards.classed('is-selected', n => n === selected).attr('aria-pressed', n => String(n === selected)).style('opacity', n => !selected || upstream.has(n.id) ? 1 : .35);
    links.style('opacity', e => !selected || upstream.has(e.from) && upstream.has(e.to) ? 1 : .35);
    clearMark();
    if (selected && selected.note !== 'read by a view') {
      revealSQL();
      const preview = document.getElementById('sqlPreview'), mark = document.createElement('mark');
      mark.textContent = sql.slice(selected.range.start, selected.range.end);
      preview.replaceChildren(document.createTextNode(sql.slice(0, selected.range.start)), mark, document.createTextNode(sql.slice(selected.range.end)));
      preview.scrollTop = mark.offsetTop - preview.offsetTop - 24;
    }
  }
  function fit() {
    if (!svg || !active()) return;
    const w = svg.node().clientWidth, h = svg.node().clientHeight;
    const box = graph.node().getBBox();
    const k = Math.min(1, (w - 96) / (box.width || 1), (h - 96) / (box.height || 1));
    svg.call(zoom.transform, d3.zoomIdentity.translate((w - box.width * k) / 2 - box.x * k, (h - box.height * k) / 2 - box.y * k).scale(k));
  }
  function load(input) {
    sql = input.sql || ''; model = buildLineage(input); selected = null;
    panel.replaceChildren(); svg = null;
    if (!sql.trim()) { panel.textContent = 'No SQL in this bundle.'; return; }
    const columns = new Map();
    model.nodes.forEach(node => {
      const row = columns.get(node.depth) || 0;
      columns.set(node.depth, row + 1);
      node.x = node.depth * 340; node.y = row * 160;
      node.height = node.kind === 'table' ? 126 : 108;
    });
    const byId = new Map(model.nodes.map(n => [n.id, n]));
    svg = d3.select(panel).append('svg').attr('aria-label', 'SQL lineage').attr('role', 'group');
    graph = svg.append('g');
    zoom = d3.zoom().scaleExtent([.1, 3]).on('zoom', event => {
      graph.attr('transform', event.transform);
      if (active()) document.getElementById('graphZoom').textContent = `${Math.round(event.transform.k * 100)}%`;
    });
    svg.call(zoom).on('dblclick.zoom', null).on('click', event => { if (event.target === svg.node()) select(null); });
    links = graph.append('g').selectAll('g').data(model.edges).join('g').attr('class', 'lineage-edge');
    let lane = 0;
    links.each(function(e, index) {
      const from = byId.get(e.from), to = byId.get(e.to);
      const siblings = model.edges.filter(other => other.from === e.from && other.to === e.to);
      const offset = (siblings.indexOf(e) - (siblings.length - 1) / 2) * 16;
      const x = from.x + 260, y = from.y + from.height / 2 + offset, tx = to.x, ty = to.y + to.height / 2 + offset;
      const group = d3.select(this);
      const bypass = to.depth - from.depth > 1;
      const obstacles = model.nodes.filter(n => n.depth > from.depth && n.depth < to.depth && n.y <= Math.max(from.y, to.y));
      const laneY = Math.max(y, ty, ...obstacles.map(n => n.y + n.height + 16)) + lane * 12;
      if (bypass) lane++;
      group.append('path').attr('d', bypass
        ? `M${x},${y} C${x + 40},${y} ${x + 30},${laneY} ${x + 60},${laneY} C${x + 90},${laneY} ${tx - 90},${laneY} ${tx - 60},${laneY} C${tx - 30},${laneY} ${tx - 40},${ty} ${tx},${ty}`
        : `M${x},${y} C${x + 48},${y} ${tx - 48},${ty} ${tx},${ty}`);
      group.append('path').attr('d', `M${tx - 6},${ty - 4} L${tx - 1},${ty} L${tx - 6},${ty + 4}`);
      if (e.label) group.append('text').attr('x', (x + tx) / 2).attr('y', (bypass ? laneY : (y + ty) / 2) - 9 - (index % 2) * 3).text(e.label);
    });
    cards = graph.append('g').selectAll('g').data(model.nodes).join('g')
      .attr('class', n => `lineage-node lineage-${n.kind}${n.note ? ' has-note' : ''}`)
      .attr('transform', n => `translate(${n.x},${n.y})`).attr('role', 'button').attr('tabindex', 0)
      .attr('aria-label', n => `${n.kind}: ${n.label}${n.note ? `. ${n.note}` : ''}`)
      .on('click', (event, node) => { event.stopPropagation(); select(node); })
      .on('keydown', (event, node) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(node); } });
    cards.append('rect').attr('width', 260).attr('height', n => n.height).attr('rx', 10);
    cards.append('title').text(n => [n.label, n.note].filter(Boolean).join('\n'));
    cards.append('circle').attr('class', 'lineage-glyph').attr('cx', 28).attr('cy', 28).attr('r', 12);
    cards.append('path').attr('class', 'lineage-glyph-mark').attr('d', n => n.kind === 'table'
      ? 'M22 24 C22 20 34 20 34 24 C34 28 22 28 22 24 M22 24 V32 C22 36 34 36 34 32 V24'
      : 'M23 24 L28 28 L33 24 M28 28 V34');
    cards.append('text').attr('class', 'lineage-kind').attr('x', 50).attr('y', 32).text(n => {
      if (n.kind !== 'union') return n.kind.toUpperCase();
      const labels = [...new Set(model.edges.filter(e => e.to === n.id).map(e => e.label).filter(label => label?.startsWith('UNION')))];
      return labels.length === 1 ? labels[0] : 'UNION';
    });
    cards.filter(n => n.kind !== 'union').each(function(n) {
      const label = d3.select(this).append('text').attr('class', 'lineage-name').attr('x', 16).attr('y', 58);
      label.text(n.label.length > 29 ? `${n.label.slice(0, 28)}…` : n.label);
    });
    cards.append('text').attr('class', 'lineage-detail').attr('x', 16).attr('y', 82).text(n => n.estimate ? `Est. rows ${Number(n.estimate.rows).toLocaleString('en-US')}` : '');
    cards.append('text').attr('class', 'lineage-detail').attr('x', 16).attr('y', 102).text(n => n.estimate?.granulesKept != null ? `Granules ${n.estimate.granulesKept}/${n.estimate.granulesTotal ?? '—'}` : '');
    fit();
  }
  document.addEventListener('chquery:view-control', ({ detail }) => {
    if (detail.view !== 'lineage' || !active()) return;
    if (detail.action === 'fit') fit();
    else if (detail.action === 'zoom') svg?.call(zoom.scaleBy, detail.factor);
    else if (detail.action === 'search') {
      const query = detail.query.trim().toLowerCase();
      selected = null;
      select(query ? model?.nodes.find(n => n.label.toLowerCase().includes(query)) : null, false);
    }
  });
  document.addEventListener('keydown', event => {
    if (!active() || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && !(event.key === 'Escape' && event.target.matches('.plan-search'))) return;
    if (!['f', 'F', '=', '+', '-', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key.toLowerCase() === 'f') fit();
    else if (event.key === 'Escape') { document.querySelector('.plan-search').value = ''; select(null); closeSQL(); }
    else svg?.call(zoom.scaleBy, event.key === '-' ? .8 : 1.25);
  }, true);
  new ResizeObserver(() => { if (active()) fit(); }).observe(panel);
  return { load, show: () => requestAnimationFrame(fit), hide: () => { if (svg) select(null); else clearMark(); } };
}
