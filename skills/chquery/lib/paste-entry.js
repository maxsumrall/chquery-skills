import { parseExplainPlan, isSyntheticPlanRoot } from './parser.js';
import { sqlTokens } from './sql-evidence.js';
import { COMPARISON_LIMITS } from './comparison-artifact.js';

// Shape detection only. The importer/collector still validates the evidence.
// detail is parsed JSON, a link fragment, original SQL, or the first unknown line.
export function classifyPaste(text) {
  const source = text.trim();
  let json;
  try { json = JSON.parse(source); }
  catch {
    try { json = source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { /* Not JSON or JSONEachRow. */ }
  }
  for (const [key, kind] of [['chquery', 'bundle'], ['chquery_comparison', 'comparison'], ['chquery_investigation', 'investigation']]) {
    if (json?.[key] === 1) return { kind, detail: json };
  }
  const rows = Array.isArray(json) ? json : [json];
  if (rows.length && rows.every(row => typeof row?.Plan?.['Node Type'] === 'string')) return { kind: 'plan', detail: json };
  if (rows.length && rows.every(row => typeof row?.database === 'string' && typeof row.table === 'string' && ['rows', 'parts', 'marks'].some(key => Object.hasOwn(row, key)))) return { kind: 'estimate', detail: json };
  try {
    const url = new URL(source);
    if (['https:', 'http:'].includes(url.protocol) && /^#[sbj]=.+/.test(url.hash)) return { kind: 'link', detail: url.hash };
  } catch { /* Not a URL. */ }
  if (['select', 'with'].includes(sqlTokens(source)[0]?.text)) return { kind: 'sql', detail: text };
  return { kind: 'unknown', detail: source.split(/\r?\n/)[0] };
}

export function initPasteEntry(workspace) {
  const input = document.getElementById('pasteInput');
  const status = document.getElementById('pasteStatus');
  const fileInput = document.getElementById('importBundleInput');
  const onHome = () => document.body.dataset.page === 'home' && document.body.dataset.comparison !== 'true' && document.body.dataset.investigations !== 'true' && !document.querySelector('dialog[open]');
  const message = text => { status.textContent = text; status.hidden = !text; };
  let request = 0;
  async function route(text) {
    if (!onHome()) return;
    const ticket = ++request;
    input.value = text;
    message('');
    if (!text.trim()) return;
    try {
      const { kind, detail } = classifyPaste(text);
      if (['bundle', 'comparison', 'investigation'].includes(kind)) {
        await window.chqueryOpenTransferredArtifact({ json: text });
      } else if (kind === 'link') {
        await window.chqueryOpenShareHash(detail);
      } else if (['plan', 'estimate', 'sql'].includes(kind)) {
        let note = 'SQL recognised · Copy the generated EXPLAIN command.';
        if (kind === 'plan') {
          const root = parseExplainPlan(text);
          const count = node => (isSyntheticPlanRoot(node) ? 0 : 1) + (node.children || []).reduce((sum, child) => sum + count(child), 0);
          note = `Plan recognised · ${count(root)} operators. Add the SQL it came from.`;
        } else if (kind === 'estimate') note = 'Scan estimates recognised · Add the SQL and its plan to continue.';
        if (workspace.hasPersonalWork() && !confirm('Start a new collector draft with this evidence? Your current analysis stays available until you visualize the new one.')) return;
        workspace.showWizard(true, { field: { plan: 'explainResult', estimate: 'estimateResult', sql: 'originalQuery' }[kind], text, status: note });
      } else message(`“${detail}” — Paste EXPLAIN PLAN or ESTIMATE JSON, SELECT/WITH SQL, a CH Query analysis, comparison or investigation file, or a CH Query link.`);
    } catch (error) {
      if (ticket === request) message(`Could not open this input. ${error.message}`);
    }
  }
  // Finish the native edit before rendering a result that hides this textarea.
  let inputFrame;
  input.addEventListener('input', () => {
    cancelAnimationFrame(inputFrame);
    inputFrame = requestAnimationFrame(() => route(input.value));
  });
  document.getElementById('choosePasteFile').addEventListener('click', () => fileInput.click());
  async function files(list) {
    if (list.length !== 1) { message('Choose one JSON or text file.'); return; }
    if (list[0].size > COMPARISON_LIMITS.totalBytes) { message('Choose a file no larger than 20 MiB. Nothing was read or replaced.'); return; }
    const ticket = ++request;
    const generation = workspace.beginImport();
    try {
      const text = await list[0].text();
      if (ticket === request && workspace.isCurrentImport(generation)) await route(text);
    } catch (error) {
      if (ticket === request) message(`Could not read this file. ${error.message}`);
    }
  }
  // Capture only homepage selections; retain existing multi-file comparison import elsewhere.
  fileInput.addEventListener('change', event => {
    if (!onHome() || fileInput.files.length !== 1) return;
    event.stopImmediatePropagation();
    const selected = [...fileInput.files];
    fileInput.value = '';
    files(selected);
  }, true);
  document.addEventListener('paste', event => {
    const active = document.activeElement;
    if (!onHome() || active?.matches('input, textarea, select') || active?.isContentEditable) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    route(text);
  });
  document.addEventListener('dragover', event => {
    if (onHome() && [...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', event => {
    if (!onHome() || !event.dataTransfer?.files.length) return;
    event.preventDefault();
    files([...event.dataTransfer.files]);
  });
}
