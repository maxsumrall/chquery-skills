import { wizardFromBundle } from './bundle.js';
import { createWorkerClient } from './worker-client.js';

const $ = id => document.getElementById(id);
const roles = ['baseline', 'candidate'];
let slots = {}, context = {}, pairMetadata = {}, groups = {}, generation = 0, client, rawClient, timer, ready = false, busy = false;
let filenames = {};
const imports = new Map();
let inspection, preview, inspectTicket = 0, previewTicket = 0;
let renderedBrief = null;
const cancelled = () => new DOMException('Comparison operation cancelled.', 'AbortError');

function workerClient() {
  const worker = new Worker(new URL('./comparison-worker.js', import.meta.url), { type: 'module' });
  return createWorkerClient(worker, {
    workerError: () => new Error('Comparison worker failed. Retry or export source evidence.'),
    cancelError: cancelled
  });
}
const complete = () => roles.every(role => slots[role]);
const pair = () => ({ ...pairMetadata, chquery_comparison: 1, baseline: slots.baseline, candidate: slots.candidate, context });
export function getComparisonPair() { return complete() && !imports.size ? structuredClone(pair()) : null; }
export function getComparisonBrief() { return renderedBrief ? structuredClone(renderedBrief) : null; }
export async function openComparisonFile(file) { await importSource(file, 'pair'); $('openComparison').click(); }
export async function openComparisonArtifact(artifact, isCurrent) {
  if (!await importSource({ artifact }, 'pair', isCurrent)) return false;
  $('openComparison').click();
  return true;
}
const hasNotes = () => Object.entries(context).some(([key, value]) => key === 'correctness' ? Object.values(value || {}).some(item => item && item !== 'unknown') : Boolean(value));
const replaceNotes = () => !hasNotes() || confirm('Replacing or removing a run invalidates the comparison hypothesis and correctness notes. Discard those notes and continue?');
function status(text) { $('comparisonStatus').textContent = text; }
function error(error) {
  if (error.name === 'AbortError') return;
  $('comparisonError').hidden = false;
  $('comparisonError').textContent = `${error.message} ${error.details || ''}`;
}
function controls() {
  $('comparisonSwap').disabled = !complete();
  $('comparisonRaw').disabled = !complete() || imports.size > 0;
  $('comparisonPrepare').disabled = !ready || busy || imports.size > 0;
  $('comparisonCancel').disabled = !busy && !imports.size && !rawClient;
  $('comparisonRetry').disabled = !complete() || busy || imports.size > 0;
  $('comparisonInspection').querySelectorAll('button,select').forEach(node => { node.disabled = !ready || busy; });
  $('comparisonResults').querySelectorAll('button,select').forEach(node => { node.disabled = !ready || busy; });
  for (const role of roles) {
    $(`comparison-${role}-state`).textContent = imports.has(role) ? 'Reading and validating…' : slots[role] ? 'Bundle loaded · original evidence retained' : 'No bundle loaded';
    if (slots[role] && filenames[role]) $(`comparison-${role}-state`).textContent += ` · Local file: ${filenames[role]}`;
    $(`comparison-${role}-remove`).disabled = !slots[role] && !imports.has(role);
  }
  window.refreshStoredComparisonShare?.();
}
function invalidate() {
  generation++; clearTimeout(timer); client?.stop(); client = null; rawClient?.stop(); rawClient = null;
  ready = false; busy = false; inspectTicket++; previewTicket++;
  renderedBrief = null;
  $('comparisonPreview').hidden = true; $('comparisonPreviewText').textContent = '';
  $('comparisonConfirm').checked = false; $('comparisonDownload').disabled = true; $('comparisonCopy').disabled = true;
  $('comparisonSave').disabled = true;
  $('comparisonResults').dataset.stale = 'true';
  controls();
}
function cancelImports() { for (const worker of imports.values()) worker.stop(); imports.clear(); }
function schedule() {
  invalidate();
  if (!complete()) {
    $('comparisonResults').hidden = true; $('comparisonInspection').hidden = true;
    status('Add both runs to compare, then save them together. Your personal analysis stays separate.');
  } else if (imports.size) status('Waiting for pending evidence. Previous comparison is not current.');
  else { status('Updating comparison. Previous comparison is not current.'); timer = setTimeout(analyze, 150); }
}
async function analyze() {
  if (!complete() || imports.size) return;
  const ticket = generation;
  client = workerClient(); busy = true; controls(); status('Comparing in a worker. You can cancel or replace either run.');
  try {
    const result = await client.call('analyze', { pair: pair(), groups });
    if (ticket !== generation) return;
    ready = true; busy = false;
    render(result); controls(); status('Comparison current. Observed changes are not proof of improvement.');
  } catch (failure) {
    if (ticket !== generation) return;
    busy = false; error(failure); controls(); status('Comparison unavailable. Source retained; any previous view is not current.');
  }
}
function syncInputs() {
  for (const role of roles) $(`comparison-${role}-label`).value = slots[role]?.label || '';
  $('comparisonName').value = pairMetadata.name || '';
  $('comparisonQuestion').value = pairMetadata.question || '';
  $('comparisonHypothesis').value = context.hypothesis || '';
  $('comparisonCorrectness').value = context.correctness?.status || 'unknown';
  $('comparisonMethod').value = context.correctness?.method || '';
  $('comparisonScope').value = context.correctness?.scope || '';
}
async function importSource(source, kind, isCurrent = () => true) {
  if (!source || !isCurrent()) return false;
  const replacing = kind === 'pair' || Boolean(slots[kind]);
  if (replacing && !replaceNotes()) return false;
  if (kind === 'pair') cancelImports();
  else { imports.get(kind)?.stop(); imports.get('pair')?.stop(); imports.delete('pair'); }
  invalidate(); $('comparisonError').hidden = true;
  const loader = workerClient(); imports.set(kind, loader); controls(); status('Reading evidence. Existing evidence stays until validation succeeds.');
  try {
    const data = typeof source === 'string' ? { link: source } : source instanceof File ? { file: source } : source;
    const result = await loader.call('import', { ...data, kind });
    if (imports.get(kind) !== loader || !isCurrent()) return false;
    if (kind === 'pair') {
      const { baseline, candidate, context: importedContext, ...metadata } = result;
      slots = { baseline, candidate }; context = importedContext || {}; pairMetadata = metadata; groups = {};
      filenames = { baseline: data.file?.name, candidate: data.file?.name };
    }
    else { slots[kind] = { bundle: result, label: data.file?.name || (kind === 'baseline' ? 'Baseline' : 'Candidate') }; filenames[kind] = data.file?.name; delete groups[kind]; if (replacing) context = {}; }
    syncInputs();
    return true;
  } catch (failure) {
    if (imports.get(kind) === loader && isCurrent()) {
      if (source.artifact && failure.name !== 'AbortError') throw failure;
      error(failure);
    }
    return false;
  }
  finally { if (imports.get(kind) === loader) { imports.delete(kind); loader.stop(); schedule(); } }
}
function node(tag, text, parent, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  parent?.append(element); return element;
}
function inspectButton(parent, label, section) {
  const button = node('button', label, parent, 'text-button'); button.type = 'button';
  button.onclick = () => { $('comparisonSection').value = section; inspectPage(0, 0); $('comparisonInspectionTitle').focus(); };
}
function table(parent, headings, rows) {
  const wrapper = node('div', undefined, parent, 'comparison-table'); wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', `${headings[0]} comparison table`);
  const table = node('table', undefined, wrapper), head = node('tr', undefined, node('thead', undefined, table));
  headings.forEach(text => { const cell = node('th', text, head); cell.scope = 'col'; });
  const body = node('tbody', undefined, table);
  rows.forEach(row => { const tr = node('tr', undefined, body); row.forEach((text, index) => { const cell = node('td', text, tr); cell.dataset.label = headings[index]; }); });
}
const num = value => value === null ? 'Unavailable' : String(value);
const summary = value => `${num(value.value)} · ${value.valid}/${value.selected} usable selected (${value.total} total); range ${num(value.min)}–${num(value.max)}${value.value === null ? '. No usable selected value; inspect samples for missing/invalid fields.' : ''}`;
function render(result) {
  const brief = structuredClone(result.brief);
  renderedBrief = brief;
  const root = $('comparisonResults'); root.replaceChildren(); root.hidden = false; root.dataset.stale = 'false';
  const verdict = node('section', undefined, root, 'comparison-verdict');
  node('h2', brief.name || 'What the evidence supports', verdict);
  if (brief.question) node('p', `Review question: ${brief.question}`, verdict, 'comparison-question');
  node('p', `Correctness: ${brief.coverage.correctness.status}. Comparability: ${result.comparability}.`, verdict, 'comparison-verdict-line');
  node('p', 'Imported assertions remain unverified. A single observation, matching plan, or equal result row count does not prove correctness or repeatable improvement.', verdict);
  node('p', `Next step: ${brief.nextStep}`, verdict, 'comparison-next-step');
  if (brief.gaps.length) node('p', `Material gaps: ${brief.gaps.join(' ')}`, verdict, 'comparison-material-gaps');
  node('p', brief.disclaimer, verdict, 'comparison-disclaimer');
  const dimensions = node('details', undefined, verdict); node('summary', 'Data, environment, version, settings & cache context', dimensions);
  table(dimensions, ['Context', 'Baseline (summary)', 'Candidate (summary)', 'Assessment'], result.dimensions.map(item => [item.name, item.baseline, item.candidate, item.status]));
  inspectButton(dimensions, 'Inspect full comparability evidence', 'comparability');
  const metrics = node('section', undefined, root); node('h2', 'Measured observations', metrics);
  node('p', 'Candidate minus baseline. Query-wide only when that scope was supplied; estimates are separate. Missing values are not zero. Result rows are a correctness signal, not a performance score.', metrics);
  table(metrics, ['Metric / unit', 'Baseline', 'Candidate', 'Absolute change', 'Percent change'], brief.metrics.map(item => [
    `${item.name} (${item.unit})`, summary(item.baseline), summary(item.candidate), item.absolute === null ? `Unavailable. ${item.reason}` : num(item.absolute), item.percent === null ? `Unavailable. ${item.reason}` : `${item.percent}%`
  ]));
  const reasons = node('details', undefined, metrics); node('summary', 'Interpretation and uncertainty for each metric', reasons);
  brief.metrics.forEach(item => node('p', `${item.name}: ${item.reason} ${item.interpretation}. ${item.repeatability}`, reasons));
  const columns = node('div', undefined, metrics, 'comparison-columns');
  node('p', 'Sample-group selection stays in page memory. Reopening a pair may require selecting a group again.', metrics);
  for (const role of roles) {
    const side = result.sides[role], column = node('section', undefined, columns);
    node('h3', `${role}: ${side.label}`, column); node('p', `${side.runtime.status} runtime · ${side.runtime.scope} scope · run correspondence unverified`, column);
    node('p', side.selectionReason, column);
    const label = node('label', `${role} sample group`, column), select = node('select', undefined, label); select.id = `comparison-${role}-group`;
    const auto = node('option', 'Automatic selection (conservative)', select); auto.value = '';
    side.groups.forEach(group => { const option = node('option', group.label, select); option.value = group.index; });
    select.value = groups[role] ?? '';
    select.onchange = () => { if (select.value === '') delete groups[role]; else groups[role] = Number(select.value); schedule(); };
    inspectButton(column, `Explore ${role} operators`, `${role}-nodes`); inspectButton(column, `${role} samples & provenance`, `${role}-measurements`);
    const explorer = node('button', `Open ${role} in full explorer (new tab)`, column, 'text-button'); explorer.type = 'button'; explorer.onclick = () => openExplorer(role);
  }
  const changes = node('section', undefined, root); node('h2', 'SQL, settings & plan structure', changes);
  node('p', `SQL: ${result.sql}. Semantic equality remains unknown. ${result.settings} setting names supplied; absent settings do not establish defaults.`, changes);
  node('p', `${result.structure.matches} heuristic operator matches; ${result.structure.baselineUnmatched} baseline and ${result.structure.candidateUnmatched} candidate operators unmatched. Repeated anchors can be ambiguous, not removed or added.`, changes);
  const branchFocus = node('div', undefined, changes, 'comparison-branch-focus');
  node('h3', 'Changed branch focus', branchFocus);
  if (!brief.observedShape.branches.length) node('p', 'No unmatched branch chains. Full trees and reconfigured matched operators remain inspectable.', branchFocus);
  brief.observedShape.branches.forEach(branch => {
    const card = node('article', undefined, branchFocus, 'comparison-branch-card');
    card.dataset.branchStatus = branch.status;
    node('strong', branch.statement, card); node('p', `${branch.types.join(' → ')}. ${branch.basis}`, card);
  });
  for (const [label, key] of [['Baseline SQL', 'baseline-sql'], ['Candidate SQL', 'candidate-sql'], ['Exact SQL change block', 'sql-change'], ['Inspect settings', 'settings'], ['Inspect changed branches', 'branches'], ['Inspect structural correspondence', 'structure']]) inspectButton(changes, label, key);
  const claims = node('section', undefined, root); node('h2', 'Review claims', claims);
  if (!brief.checks.length) node('p', 'No claim supplied. The factual change summary remains available.', claims);
  for (const claim of brief.checks) {
    const card = node('article', undefined, claims, 'comparison-claim-card');
    card.dataset.assessment = claim.assessment;
    node('h3', claim.authorClaim.statement, card); node('strong', claim.assessment, card); node('p', claim.reason, card);
    if (claim.missingEvidence.length) node('p', `Smallest missing evidence: ${claim.missingEvidence.join(' ')}`, card);
  }
  if (brief.omittedChecks) node('p', `Showing ${brief.checks.length} of ${brief.checks.length + brief.omittedChecks} claims in the concise brief. Inspect claim scope and evidence for the complete set.`, claims);
  if (brief.checks.length) inspectButton(claims, 'Inspect claim scope and evidence', 'claims');
  const fidelity = node('details', undefined, claims); node('summary', 'Evidence fidelity and source association', fidelity);
  for (const role of roles) node('p', `${role}: ${brief.coverage.fidelity.sides[role].status}. ${brief.coverage.fidelity.sides[role].gaps.join(' ') || 'Declared fidelity fields supplied.'}`, fidelity);
  inspectButton(fidelity, 'Inspect fidelity differences', 'fidelity');
  const findings = node('section', undefined, root); node('h2', 'Finding transitions', findings);
  const list = node('dl', undefined, findings, 'comparison-counts');
  for (const [state, count] of Object.entries(result.findings)) { node('dt', state, list); node('dd', count, list); }
  node('p', 'Introduced/resolved requires evaluated opposite evidence on a matched scope. Missing evidence is not resolution; unmatched scopes remain not assessable. Occurrence IDs are role-local.', findings);
  inspectButton(findings, 'Inspect findings and supporting evidence', 'findings');
  $('comparisonInspection').hidden = false; inspection = null; $('comparisonInspectCards').replaceChildren(); $('comparisonInspectText').textContent = 'Choose an evidence view to inspect its pages.';
}
async function inspectPage(recordPage = 0, textPage = 0) {
  if (!ready || busy) return;
  const ticket = ++inspectTicket, epoch = generation;
  $('comparisonInspectCards').replaceChildren(); $('comparisonInspectText').textContent = ''; $('comparisonInspectPosition').textContent = 'Loading evidence page…';
  $('comparisonInspectNext').disabled = true; $('comparisonInspectPrevious').disabled = true;
  try {
    const result = await client.call('inspect', { section: $('comparisonSection').value, recordPage, textPage });
    if (epoch !== generation || ticket !== inspectTicket) return;
    inspection = result; $('comparisonInspectText').textContent = result.text;
    const cards = $('comparisonInspectCards'); cards.replaceChildren();
    if (result.cards.length) node('p', 'Readable excerpts for this record page. Complete fields follow in the exact evidence pages.', cards);
    for (const item of result.cards) {
      const card = node('article', undefined, cards, 'comparison-evidence-card'); node('h3', item.title, card);
      item.lines.forEach(line => node('p', line, card));
    }
    $('comparisonInspectPosition').textContent = `Records page ${result.recordPage + 1}/${result.recordPages} · text page ${result.page + 1}/${result.pages}`;
    $('comparisonInspectPrevious').disabled = !result.recordPage && !result.page;
    $('comparisonInspectNext').disabled = result.recordPage + 1 === result.recordPages && result.page + 1 === result.pages;
  } catch (failure) { if (epoch === generation) error(failure); }
}
async function previewPage(page = 0) {
  const ticket = ++previewTicket, epoch = generation;
  $('comparisonPreviewText').textContent = ''; $('comparisonPreviewPosition').textContent = 'Loading exact segment…';
  $('comparisonPreviewPrevious').disabled = true; $('comparisonPreviewNext').disabled = true;
  try {
    const result = await client.call('preview', { format: $('comparisonFormat').value, page });
    if (epoch !== generation || ticket !== previewTicket) return;
    preview = result; $('comparisonPreviewText').textContent = result.text;
    $('comparisonPreviewPosition').textContent = `Page ${result.page + 1}/${result.pages} · ${result.characters.toLocaleString()} characters total · exact file segment`;
    $('comparisonPreviewPrevious').disabled = result.page === 0; $('comparisonPreviewNext').disabled = result.page + 1 === result.pages;
  } catch (failure) { if (epoch === generation) error(failure); }
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function openExplorer(role) {
  const snapshot = structuredClone(slots[role].bundle);
  const target = window.open(`./?comparison-side=${role}`, '_blank');
  if (!target) return error(new Error('Popup blocked. Allow this local explorer tab or use the paged operator evidence here.'));
  target.addEventListener('load', async () => {
    try {
      const loaded = await target.chqueryWizard.importState(wizardFromBundle(snapshot));
      if (!loaded) throw new Error('Side explorer could not render this snapshot.');
      target.document.title = `${role} snapshot · CH Query`;
      target.renderBundleMetadata(snapshot); target.document.getElementById('shareStatus').textContent = `${role} snapshot from comparison. Independent single-run workspace; changes here do not alter the pair.`;
      target.scrollToWorkspace(true); target.opener = null;
    } catch (failure) { error(new Error('Side explorer could not load. Use paged evidence or export the source bundle.')); }
  }, { once: true });
}
for (const role of roles) {
  const section = node('section', undefined, $('comparisonSlots'), 'comparison-slot');
  node('h2', role === 'baseline' ? 'Baseline' : 'Candidate', section);
  node('p', role === 'baseline' ? 'The original query you want to improve.' : 'The revision you want to test against it.', section);
  const linkLabel = node('label', `${role} analysis link`, section); linkLabel.htmlFor = `comparison-${role}-link`;
  const entry = node('div', undefined, section, 'comparison-link-entry'), link = node('input', undefined, entry);
  link.type = 'url'; link.id = `comparison-${role}-link`; link.placeholder = 'https://chquery.com/#s=…'; link.autocomplete = 'off'; link.spellcheck = false;
  const load = node('button', 'Open link', entry, 'compact-button'); load.type = 'button'; load.id = `comparison-${role}-open`;
  wireLinkInput(link, load, role);
  const files = node('details', undefined, section, 'comparison-files'); node('summary', 'Or import an offline copy', files);
  const fileLabel = node('label', `Import / replace ${role} bundle`, files), input = node('input', undefined, fileLabel);
  input.type = 'file'; input.accept = '.json,application/json'; input.id = `comparison-${role}-file`;
  input.onchange = () => { importSource(input.files[0], role); input.value = ''; };
  node('p', 'No bundle loaded', section).id = `comparison-${role}-state`;
  const label = node('label', `${role} label`, section), text = node('input', undefined, label); text.id = `comparison-${role}-label`; text.maxLength = 240;
  text.oninput = () => { if (slots[role]) { slots[role] = { ...slots[role] }; if (text.value.trim()) slots[role].label = text.value; else delete slots[role].label; schedule(); } };
  const remove = node('button', `Remove ${role}`, section, 'text-button'); remove.type = 'button'; remove.id = `comparison-${role}-remove`;
  remove.onclick = () => { if (!replaceNotes()) return; cancelImports(); delete slots[role]; delete groups[role]; context = {}; syncInputs(); schedule(); };
}
function wireLinkInput(input, button, kind) {
  button.onclick = async () => {
    const link = input.value;
    if (!link.trim()) { input.focus(); return error(new Error('Paste a CH Query link first.')); }
    if (await importSource(link, kind) && input.value === link) input.value = '';
  };
  input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); button.click(); } };
  input.oninput = () => { if (imports.has(kind)) { imports.get(kind).stop(); imports.delete(kind); schedule(); } };
}
wireLinkInput($('comparisonLink'), $('comparisonOpenLink'), 'pair');
for (const group of ['schema', 'runtime', 'settings', 'context', 'labels', 'estimate', 'pipeline', 'syntax']) {
  const label = node('label', undefined, $('comparisonOmissions')), input = node('input', undefined, label); input.type = 'checkbox'; input.value = group; label.append(` ${group}`);
}
$('comparisonOmissions').onchange = schedule; $('comparisonRedact').onchange = schedule; $('comparisonOmitSql').onchange = schedule;
for (const id of ['comparisonHypothesis', 'comparisonCorrectness', 'comparisonMethod', 'comparisonScope']) $(id).oninput = () => {
  context = { ...context, hypothesis: $('comparisonHypothesis').value, correctness: { ...context.correctness, status: $('comparisonCorrectness').value, method: $('comparisonMethod').value, scope: $('comparisonScope').value } }; schedule();
};
for (const [id, key] of [['comparisonName', 'name'], ['comparisonQuestion', 'question']]) $(id).oninput = () => {
  pairMetadata = { ...pairMetadata };
  if ($(id).value.trim()) pairMetadata[key] = $(id).value;
  else delete pairMetadata[key];
  schedule();
};
$('comparisonFile').onchange = event => { importSource(event.target.files[0], 'pair'); event.target.value = ''; };
$('comparisonSwap').onclick = () => { cancelImports(); [slots.baseline, slots.candidate] = [slots.candidate, slots.baseline]; [filenames.baseline, filenames.candidate] = [filenames.candidate, filenames.baseline]; [groups.baseline, groups.candidate] = [groups.candidate, groups.baseline]; syncInputs(); schedule(); };
$('comparisonSeed').onclick = () => {
  const bundle = window.chqueryWizard?.getPersonalBundle();
  if (!bundle) return error(new Error('No personal result yet. Import a bundle or analyze your own query first; the homepage demo is not your baseline.'));
  if (slots.baseline && !replaceNotes()) return;
  if (slots.baseline) context = {};
  delete filenames.baseline;
  cancelImports(); slots.baseline = { bundle, label: 'Personal result snapshot' }; delete groups.baseline; syncInputs(); schedule();
};
$('compareRevision').onclick = () => {
  const bundle = window.chqueryWizard?.getPersonalBundle();
  if (!bundle) return;
  if ((Object.keys(slots).length || imports.size || hasNotes()) && !confirm('Start a new comparison with this analysis as baseline? This replaces the current comparison and its notes, not your personal analysis.')) return;
  cancelImports(); slots = { baseline: { bundle, label: 'Original query' } };
  context = {}; pairMetadata = {}; groups = {}; filenames = {};
  $('comparisonError').hidden = true;
  syncInputs(); schedule(); $('openComparison').click();
  status('Baseline captured. Ask your agent for the revised query’s analysis link, then paste it into Candidate.');
};
$('comparisonCopyPrompt').onclick = async () => {
  const text = $('comparisonAgentPrompt');
  try {
    await navigator.clipboard.writeText(text.textContent);
    status('Prompt copied. Keep the baseline unchanged and paste the returned link into Candidate.');
  } catch {
    text.focus();
    const range = document.createRange(); range.selectNodeContents(text);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    status('Clipboard unavailable. Copy the selected prompt manually.');
  }
};
$('comparisonCancel').onclick = () => { cancelImports(); invalidate(); status('Pending work cancelled. Source retained; previous comparison is not current. Change an input or retry.'); };
$('comparisonRetry').onclick = schedule;
$('comparisonPrepare').onclick = async () => {
  if (!ready || busy) return;
  const epoch = ++generation; inspectTicket++; previewTicket++; busy = true; controls(); $('comparisonPreview').hidden = true; $('comparisonConfirm').checked = false; $('comparisonDownload').disabled = true; $('comparisonCopy').disabled = true;
  $('comparisonSave').disabled = true; $('comparisonFormat').value = 'json';
  status('Preparing exact outgoing evidence in a worker. Cancel or change an option to stop.'); $('comparisonError').hidden = true;
  try {
    const result = await client.call('prepare', { options: { redact: $('comparisonRedact').checked, omit: [...$('comparisonOmissions').querySelectorAll('input:checked')].map(input => input.value), omitSqlFromReport: $('comparisonOmitSql').checked } });
    if (epoch !== generation) return;
    render(result.view);
    $('comparisonManifest').textContent = `${result.transformation}; ${result.omissionCount} omissions (listed in the file manifest). ${Object.entries(result.bytes).map(([key, bytes]) => `${key}: ${bytes.toLocaleString()} bytes`).join(' · ')}. ${result.warning}`;
    $('comparisonPreview').hidden = false; await previewPage(); if (epoch === generation) status('Prepared immutable files. Review all outgoing pages before confirming.');
  } catch (failure) { if (epoch === generation) { error(failure); status('Preparation refused. Source and comparison retained. No partial preview or confirmation is available.'); } }
  finally { if (epoch === generation) { busy = false; controls(); } }
};
$('comparisonConfirm').onchange = async () => {
  const epoch = generation;
  $('comparisonDownload').disabled = true; $('comparisonCopy').disabled = true; $('comparisonSave').disabled = true;
  window.refreshStoredComparisonShare?.();
  try { const confirmed = await client.call('confirm', { confirmed: $('comparisonConfirm').checked }); if (epoch === generation) { $('comparisonDownload').disabled = !confirmed; $('comparisonCopy').disabled = !confirmed; $('comparisonSave').disabled = !confirmed; } }
  catch (failure) { if (epoch === generation) error(failure); }
};
$('comparisonSave').onclick = async () => {
  const epoch = generation;
  const isCurrent = () => epoch === generation && $('comparisonConfirm').checked && !$('comparisonPreview').hidden;
  if (!isCurrent()) return;
  try {
    const json = await (await client.call('export', { format: 'json' })).text();
    if (isCurrent()) window.openStoredComparisonShare({ json, isCurrent });
  } catch (failure) { if (epoch === generation) error(failure); }
};
$('comparisonDownload').onclick = async () => {
  const epoch = generation, format = $('comparisonFormat').value;
  try { const blob = await client.call('export', { format }); if (epoch === generation) download(blob, format === 'markdown' ? 'chquery-comparison-report.md' : format === 'json' ? 'chquery-comparison.json' : 'chquery-comparison-report.json'); }
  catch (failure) { if (epoch === generation) error(failure); }
};
$('comparisonCopy').onclick = async () => {
  const epoch = generation;
  try {
    if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('Clipboard unavailable. Download the reviewed Markdown file instead; no partial text was copied.');
    const blob = client.call('export', { format: 'markdown' }).then(blob => { if (epoch !== generation) throw cancelled(); return blob; });
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    if (epoch === generation) status('Exact reviewed Markdown copied. No upload occurred.');
  } catch (failure) { if (epoch === generation) error(new Error('Clipboard unavailable or denied. Download the reviewed Markdown file instead.')); }
};
$('comparisonRaw').onclick = async () => {
  if (!complete() || !confirm('Export full source evidence? Original literals, private metadata and capabilities may be included. This is not redacted.')) return;
  const epoch = generation, exporter = workerClient(); rawClient?.stop(); rawClient = exporter; controls();
  try { const blob = await exporter.call('source', { pair: pair() }); if (epoch === generation && rawClient === exporter) download(blob, 'chquery-comparison-source.json'); }
  catch (failure) { if (epoch === generation) error(failure); }
  finally { exporter.stop(); if (rawClient === exporter) rawClient = null; controls(); }
};
$('comparisonSection').onchange = () => inspectPage();
const inspectCards = document.createElement('div'); inspectCards.id = 'comparisonInspectCards'; $('comparisonInspectText').before(inspectCards);
$('comparisonInspectNext').onclick = () => inspection && inspectPage(inspection.page + 1 < inspection.pages ? inspection.recordPage : inspection.recordPage + 1, inspection.page + 1 < inspection.pages ? inspection.page + 1 : 0);
$('comparisonInspectPrevious').onclick = () => inspection && inspectPage(inspection.page ? inspection.recordPage : inspection.recordPage - 1, inspection.page ? inspection.page - 1 : -1);
$('comparisonFormat').onchange = () => previewPage();
$('comparisonPreviewNext').onclick = () => preview && previewPage(preview.page + 1);
$('comparisonPreviewPrevious').onclick = () => preview && previewPage(preview.page - 1);
function close() {
  $('comparisonWorkspace').hidden = true; delete document.body.dataset.comparison;
  if (document.body.dataset.page === 'comparison') window.showHome(false);
  $('openComparison').setAttribute('aria-expanded', 'false'); $('openComparison').focus();
}
$('openComparison').setAttribute('aria-controls', 'comparisonWorkspace'); $('openComparison').setAttribute('aria-expanded', 'false');
$('openComparison').onclick = () => {
  document.body.dataset.comparison = 'true'; $('comparisonWorkspace').hidden = false; $('openComparison').setAttribute('aria-expanded', 'true');
  // Stop any in-flight loading/personal-workspace scroll before revealing the pair.
  window.scrollTo({ top: 0, behavior: 'instant' }); $('comparisonTitle').focus({ preventScroll: true });
};
$('closeComparison').onclick = close;
$('homeLink').addEventListener('click', close);
document.querySelectorAll('.top-nav a[href^="#"]').forEach(link => link.addEventListener('click', close));
window.addEventListener('popstate', close);
controls();
