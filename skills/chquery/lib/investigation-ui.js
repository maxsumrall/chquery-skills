import { getComparisonPair, openComparisonFile } from './comparison-ui.js';
import { parseInvestigation } from './investigation.js';
import { INVESTIGATION_DATABASE } from './investigation-store.js';
import { createWorkerClient } from './worker-client.js';

const root = document.createElement('section');
root.id = 'investigationWorkspace'; root.className = 'comparison-workspace wrap'; root.hidden = true;
root.setAttribute('aria-labelledby', 'investigationHeading');
// Static markup only. Imported text is assigned through value/textContent.
root.innerHTML = `
  <div class="comparison-heading"><div><span class="section-label">Your work · your device</span><h1 id="investigationHeading" tabindex="-1">Query investigations</h1><p>Name the problem, retain your evidence, and give a reviewer a concrete experiment.</p></div><button id="investigationClose" class="compact-button">Back to analysis</button></div>
  <p>No automatic saving or uploads. Ordinary analysis and the homepage demo stay separate.</p>
  <div class="comparison-actions"><label>Open investigation, bundle or pair<input id="investigationImport" type="file" accept=".json,application/json"></label><button id="investigationSeed" class="compact-button">Capture personal result</button><button id="investigationPair" class="compact-button">Capture current comparison</button><button id="investigationList" class="compact-button">Saved on this device</button></div>
  <p id="investigationStatus" role="status" aria-live="polite">Open evidence or capture your personal result to start an unsaved investigation.</p><p id="investigationError" role="alert" hidden></p>
  <button id="investigationCancel" class="compact-button" disabled>Cancel pending computation</button>
  <section id="investigationLibrary" class="comparison-slot" hidden><h2>Saved on this device</h2><p>Plaintext in this browser profile, until deletion or browser eviction. Not a backup or sync service. Other people using this profile can read SQL and private notes. Deleting here cannot revoke downloads, recipient copies or stored links.</p><div id="investigationRecords"></div><button id="investigationClear" class="compact-button">Delete all saved investigations…</button></section>
  <div id="investigationEditor" hidden>
    <section class="comparison-slot"><h2>Problem &amp; proposed experiment</h2><p id="investigationIdentity"></p>
      <label>Investigation title<input id="investigationTitle" maxlength="200"></label>
      <label>Problem to solve<textarea id="investigationProblem" rows="3" maxlength="16384"></textarea></label>
      <label>Proposed experiment / pair hypothesis<textarea id="investigationExperiment" rows="3" maxlength="10000"></textarea></label>
      <label>Private working notes<textarea id="investigationNotes" rows="3" maxlength="65536"></textarea></label><p>Private notes are saved only with your explicit device save and excluded from reviewed handoffs. Original source exports include them.</p>
      <p id="investigationEvidence"></p><button id="investigationExplore" class="compact-button">Explore evidence snapshot…</button><p>Explorer changes and sample-group selections stay separate. Capture changed evidence as a new snapshot; opening the explorer does not update this investigation.</p><div class="comparison-columns"><label>Replace baseline / single bundle<input id="investigationBaseline" type="file" accept=".json,application/json"></label><label>Add or replace candidate bundle<input id="investigationCandidate" type="file" accept=".json,application/json"></label></div><p>Adding a candidate promotes a single draft to a pair and moves the experiment into its hypothesis. Replacing a pair slot clears old correctness assertions, not private notes.</p>
      <div class="comparison-actions"><button id="investigationSave" class="compact-button">Save on this device…</button><button id="investigationSaveCopy" class="compact-button">Save as new copy…</button><button id="investigationDelete" class="compact-button" disabled>Delete this saved investigation…</button><button id="investigationForget" class="compact-button">Clear current workspace…</button></div>
    </section>
    <section class="comparison-export"><h2>Durable review handoff</h2><p>Portable JSON reopens the evidence. Markdown explains the problem and proposed experiment without a live site. These files have no seven-day link expiry. No hosted investigation links or new encryption format.</p>
      <label><input id="investigationRedact" type="checkbox" checked> Apply partial literal redaction</label><fieldset id="investigationOmissions"><legend>Omit optional content before analysis</legend></fieldset><label><input id="investigationOmitSql" type="checkbox"> Omit raw SQL from reports only (portable evidence still contains SQL)</label>
      <p>Identifiers, small numbers, unsupported fields and free text can remain sensitive. Exports are not automatically anonymous. Inspect every outgoing file as text.</p>
      <div class="comparison-actions"><button id="investigationPrepare" class="compact-button">Prepare investigation review</button><button id="investigationSource" class="compact-button">Export original private source…</button></div>
      <section id="investigationPreview" hidden><h3>Exact outgoing files</h3><p id="investigationManifest"></p><label>Review file<select id="investigationFormat"><option value="json">Portable investigation JSON</option><option value="markdown">Markdown report</option><option value="reportJson">Report JSON (not an evidence import)</option></select></label><div class="comparison-actions"><button id="investigationPrevious" class="compact-button">Previous page</button><span id="investigationPosition"></span><button id="investigationNext" class="compact-button">Next page</button></div><pre id="investigationText" tabindex="0" aria-label="Exact investigation output page"></pre><label><input id="investigationConfirm" type="checkbox"> I reviewed every outgoing file and page and want to export these exact bytes.</label><div class="comparison-actions"><button id="investigationDownload" class="compact-button" disabled>Download reviewed investigation file</button><button id="investigationCopy" class="compact-button" disabled>Copy reviewed investigation Markdown</button></div></section>
    </section>
  </div>`;
document.querySelector('.page-content').prepend(root);
const $ = suffix => document.getElementById(`investigation${suffix}`);
let investigation, identity, dirty = false, conflict = false, epoch = 0, computing, reviewed, storage, committing = false, page = 0, pages = 1, pageTicket = 0, knowledge, loadingKnowledge = false, storageUnavailable = false;
const urls = new Set();
let pendingStorageChanges;
const status = text => { $('Status').textContent = text; };
const savedStatus = document.getElementById('savedInvestigationsStatus');
const resumeSaved = document.getElementById('resumeInvestigations');
let savedCount = null;
function fail(error) { if (error.name !== 'AbortError') { $('Error').hidden = false; $('Error').textContent = `${error.message} ${error.details || ''}`; } }
function client(events = () => {}) {
  const worker = new Worker(new URL('./investigation-worker.js', import.meta.url), { type: 'module' });
  return createWorkerClient(worker, {
    onEvent: events,
    workerError: () => new Error('Investigation worker unavailable. Memory retained; retry or export source.'),
    cancelError: () => new DOMException('Cancelled', 'AbortError')
  });
}
function controls() {
  $('Editor').hidden = !investigation;
  $('Cancel').disabled = !computing && !loadingKnowledge;
  root.querySelectorAll('input,textarea,select,button').forEach(element => {
    if (committing) { if (!element.disabled) { element.dataset.commitDisabled = 'true'; element.disabled = true; } }
    else if (element.dataset.commitDisabled) { element.disabled = false; delete element.dataset.commitDisabled; }
  });
  $('Delete').disabled = committing || !identity;
  $('Save').disabled = committing || conflict || storageUnavailable;
  $('SaveCopy').disabled = committing || storageUnavailable;
  $('Download').disabled = $('Copy').disabled = committing || !reviewed || !$('Confirm').checked;
  $('Confirm').disabled = committing || !reviewed;
  $('Previous').disabled = committing || !reviewed || page === 0;
  $('Next').disabled = committing || !reviewed || page + 1 >= pages;
  if (investigation) {
    $('Identity').textContent = identity ? `Saved identity · revision ${identity.expectedRevision}${dirty ? ' · unsaved changes' : ''}${conflict ? ' · changed elsewhere; resume or save a new copy' : ''}` : 'Unsaved new copy · nothing stored on this device';
    $('Evidence').textContent = investigation.evidence.chquery_comparison === 1 ? 'Evidence: baseline + candidate snapshots. Pair roles and provenance remain attached to their original bundles.' : 'Evidence: single bundle. No candidate or improvement claim yet.';
  }
}
function invalidate() {
  epoch++; pageTicket++; computing?.stop(); computing = null; reviewed?.stop(); reviewed = null;
  loadingKnowledge = false;
  $('Confirm').checked = false;
  if (!$('Preview').hidden) $('Manifest').textContent = 'Previous preview — not current. Prepare again before exporting.';
  for (const url of urls) URL.revokeObjectURL(url); urls.clear(); controls();
}
function release() {
  invalidate(); investigation = identity = null; dirty = conflict = false;
  for (const field of ['Title', 'Problem', 'Experiment', 'Notes', 'Text']) $(field).value !== undefined ? $(field).value = '' : $(field).textContent = '';
  $('Preview').hidden = true; controls();
}
function publish(value, savedIdentity = null) {
  investigation = value; identity = savedIdentity; dirty = !identity; conflict = false;
  $('Title').value = value.title; $('Problem').value = value.problem; $('Notes').value = value.notes || '';
  $('Experiment').value = value.evidence.chquery_comparison === 1 ? value.evidence.context?.hypothesis || '' : value.proposedExperiment || '';
  $('Experiment').maxLength = value.evidence.chquery_comparison === 1 ? 10000 : 16384;
  for (const key of ['context', 'labels']) $('Omissions').querySelector(`[value="${key}"]`).closest('label').hidden = value.evidence.chquery_comparison !== 1;
  controls();
}
const discard = () => !investigation || confirm('Replace the current investigation workspace? Unsaved changes and notes will be discarded. Existing device saves remain.');

export function openInvestigationArtifact(json) {
  if (typeof json !== 'string') throw new TypeError('Transferred investigation must include its exact JSON text.');
  const value = parseInvestigation(json);
  if (!discard()) return false;
  publish(value);
  opener.click();
  status('Transferred investigation opened in memory. Nothing was saved or uploaded.');
  return !root.hidden && !$('Editor').hidden;
}

async function compute(action, data, accept) {
  if (committing) return;
  invalidate(); const ticket = epoch, runner = computing = client(); $('Error').hidden = true;
  status('Processing locally in a worker. Cancel to retain the previous workspace.'); controls();
  try { const result = await runner.call(action, data); if (ticket === epoch) accept(result, runner); }
  catch (error) { if (ticket === epoch) { fail(error); status('Operation refused. Original evidence and prior view retained; review consent invalidated.'); } }
  finally { if (computing === runner) computing = null; if (reviewed !== runner) runner.stop(); controls(); }
}
function storageClient() {
  return storage ||= client(event => {
    pendingStorageChanges?.push(event);
    if (event.type === 'cleared') $('Records').replaceChildren();
    if (event.type === 'deleted') for (const row of $('Records').children) { if (row.dataset.id === event.id) row.remove(); }
    if (event.type === 'unavailable') { conflict = storageUnavailable = true; status('Storage version changed. Reload the page with a compatible reader. Memory retained.'); }
    if (identity && (event.type === 'cleared' || event.type === 'deleted' && event.id === identity.id)) { release(); status('Saved investigation deleted. Its in-memory evidence and private notes have been cleared. External copies cannot be revoked.'); }
    if (identity && event.type === 'saved' && event.id === identity.id && event.revision !== identity.expectedRevision && !committing) { conflict = true; invalidate(); status('This investigation changed in another tab. Resume the saved version or explicitly save your draft as a new copy.'); }
    if (['saved', 'deleted', 'cleared'].includes(event.type)) refreshSavedSummary();
    controls();
  });
}
function showSavedSummary(records) {
  const count = savedCount = records.length;
  savedStatus.parentElement.hidden = count === 0;
  savedStatus.textContent = count
    ? `This device has ${count} saved investigation${count === 1 ? '' : 's'}.`
    : 'This device has no saved investigations.';
  resumeSaved.textContent = count ? `Open saved investigations (${count})` : 'Open investigations';
}
async function refreshSavedSummary({ existingOnly = false } = {}) {
  try {
    if (existingOnly) {
      if (typeof globalThis.indexedDB?.databases !== 'function') {
        savedStatus.textContent = 'Open investigations to check for saved work.';
        return;
      }
      const databases = await globalThis.indexedDB.databases();
      if (!databases.some(database => database.name === INVESTIGATION_DATABASE)) {
        showSavedSummary([]);
        return;
      }
    }
    showSavedSummary(await storageClient().call('list'));
  } catch {
    savedStatus.parentElement.hidden = true;
    savedStatus.textContent = 'This browser cannot check saved investigations.';
    resumeSaved.textContent = 'Open investigations';
  }
}
async function stored(action, data, accept) {
  if (committing) return;
  committing = true; pendingStorageChanges = []; controls(); $('Error').hidden = true;
  try {
    const result = await storageClient().call(action, data);
    // A queued read/commit response must not restore memory after a later
    // deletion notification. The transaction still owns durable consistency.
    if (['get', 'save', 'list'].includes(action) && pendingStorageChanges.some(event => event.type === 'cleared' ||
        event.type === 'deleted' && (action === 'list' || event.id === result?.id) ||
        event.type === 'saved' && event.id === result?.id && event.revision > result.revision)) {
      throw new Error('Storage changed during this operation. Open the saved list to verify its current state.');
    }
    accept(result);
  }
  catch (error) { if (error.code === 'conflict') conflict = true; fail(error); status('Storage action failed. Current memory retained; no success claimed. Export source or retry.'); }
  finally { committing = false; pendingStorageChanges = null; controls(); }
}
async function list() {
  await stored('list', {}, records => {
    $('Library').hidden = false; $('Records').replaceChildren();
    if (!records.length) $('Records').textContent = 'No saved investigations.';
    for (const record of records) {
      const row = document.createElement('div'); row.className = 'investigation-record'; row.dataset.id = record.id;
      const text = document.createElement('p'); text.textContent = `${record.title} · revision ${record.revision} · ${new Date(record.updatedAt).toLocaleString()} · ${record.bytes.toLocaleString()} bytes`; row.append(text);
      for (const [label, action] of [['Resume', 'get'], ['Delete…', 'delete']]) {
        const button = document.createElement('button'); button.className = 'compact-button'; button.textContent = label; row.append(button);
        button.onclick = async () => {
          if (action === 'get' ? !discard() : !confirm('Delete this saved investigation? Recipient copies and stored links remain.')) return;
          invalidate();
          await stored(action, { key: record.id, revision: record.revision }, result => {
            if (action === 'get') { if (!result) throw new Error('Save was deleted. Refresh the saved list.'); publish(result.investigation, { id: result.id, expectedRevision: result.revision }); status('Resumed saved investigation. Further edits require explicit Save.'); }
            else status('Saved investigation deleted. Recipient copies remain.');
          });
          if (action === 'delete') list();
        };
      }
      $('Records').append(row);
    }
  });
}
function download(blob, filename) { const url = URL.createObjectURL(blob); urls.add(url); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 30000); }
for (const [field, key] of [['Title', 'title'], ['Problem', 'problem'], ['Notes', 'notes'], ['Experiment', 'proposedExperiment']]) $(field).oninput = () => {
  if (!investigation) return; invalidate(); dirty = true;
  if (field === 'Experiment' && investigation.evidence.chquery_comparison === 1) investigation = { ...investigation, evidence: { ...investigation.evidence, context: { ...investigation.evidence.context, hypothesis: $(field).value } } };
  else investigation = { ...investigation, [key]: $(field).value };
  controls();
};
for (const group of ['title', 'problem', 'experiment', 'schema', 'runtime', 'settings', 'estimate', 'pipeline', 'syntax', 'context', 'labels']) {
  const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = group; label.append(input, ` ${group}`); $('Omissions').append(label);
}
for (const field of ['Redact', 'OmitSql', 'Omissions']) $(field).onchange = invalidate;
$('Import').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file && discard()) compute('import', { file }, value => { publish(value); status('Imported as an unsaved new copy. No local identity or consent inherited.'); }); };
for (const [field, role] of [['Baseline', 'baseline'], ['Candidate', 'candidate']]) $(field).onchange = event => {
  const file = event.target.files[0]; event.target.value = '';
  if (file && confirm(`Replace ${role} evidence? Private notes and the hypothesis remain; previous pair correctness assertions are cleared. Nothing is saved automatically.`)) compute('replace', { file, role, investigation }, value => { const prior = identity; publish(value, prior); dirty = true; controls(); status('Evidence snapshot replaced. Save explicitly to update the device copy.'); });
};
for (const [field, source] of [['Seed', () => window.chqueryWizard?.getPersonalBundle()], ['Pair', getComparisonPair]]) $(field).onclick = () => {
  const evidence = source(); if (!evidence) return fail(new Error('No personal evidence available. The homepage demo is not your investigation; analyze a query or complete a comparison first.'));
  if (discard()) compute('create', { evidence }, value => { publish(value); status('Captured independent unsaved snapshot. Original analysis is unchanged.'); });
};
for (const [field, copy] of [['Save', false], ['SaveCopy', true]]) $(field).onclick = async () => {
  if (!investigation || !confirm('Save SQL, evidence and private notes as plaintext on this device? Anyone using this browser profile can read them. Retained until explicit deletion or browser eviction; not a backup.')) return;
  invalidate(); await stored('save', { investigation, identity: copy ? undefined : identity || undefined }, record => { publish(record.investigation, { id: record.id, expectedRevision: record.revision }); status('Saved on this device. No upload occurred.'); });
};
$('List').onclick = list;
$('Delete').onclick = async () => { if (identity && confirm('Delete this saved investigation and clear its current private notes? External copies remain.')) { invalidate(); await stored('delete', { key: identity.id, revision: identity.expectedRevision }, () => { release(); status('Deleted local save and cleared current workspace.'); }); list(); } };
$('Clear').onclick = async () => { if (confirm('Delete ALL saved investigations on this device? This cannot revoke recipient copies, downloads or stored links.')) { invalidate(); await stored('clear', {}, () => { if (identity) release(); status('All local saves deleted.'); }); list(); } };
$('Forget').onclick = () => { if (confirm('Clear the current in-memory workspace and private notes? Device saves are not deleted.')) { release(); status('Current workspace cleared. Device saves remain.'); } };
$('Cancel').onclick = () => { invalidate(); status('Computation cancelled. Original evidence and previous view retained; prepare again to review.'); };
async function preview(requested = 0) {
  const ticket = ++pageTicket, runner = reviewed; if (!runner) return;
  try { const result = await runner.call('preview', { format: $('Format').value, page: requested }); if (ticket !== pageTicket || runner !== reviewed) return;
    page = result.page; pages = result.pages; $('Text').textContent = result.text; $('Position').textContent = `Page ${page + 1} of ${pages} · exact file segment`; controls();
  } catch (error) { fail(error); }
}
$('Prepare').onclick = async () => {
  if (!investigation) return;
  // Knowledge is static site data, not an evidence request. Cache it in memory
  // for further preparation after connectivity is lost.
  invalidate(); const ticket = epoch; loadingKnowledge = true; controls();
  try {
    knowledge ||= Promise.all(['settings-catalog', 'settings-concerns'].map(async name => { const response = await fetch(`./data/${name}.json`); if (!response.ok) throw new Error('Settings knowledge unavailable. Retry when site assets are available.'); return response.json(); })).then(([catalog, concerns]) => ({ catalog, concerns }));
    const analysis = await knowledge; if (ticket !== epoch) return;
    const omit = [...$('Omissions').querySelectorAll('input:checked')].filter(input => !input.closest('label').hidden).map(input => input.value);
    compute('prepare', { investigation, analysis, options: { redact: $('Redact').checked, omit, omitSqlFromReport: $('OmitSql').checked } }, (manifest, runner) => {
      reviewed = runner; $('Preview').hidden = false; $('Manifest').textContent = `${manifest.warning} Omitted: ${manifest.omissions.join(', ') || 'none'}. ${Object.entries(manifest.bytes).map(([key, bytes]) => `${key}: ${bytes.toLocaleString()} bytes`).join(' · ')}`;
      status('Prepared immutable outgoing files. Review all pages before confirming.'); preview();
    });
  } catch (error) { knowledge = null; if (ticket === epoch) fail(error); }
  finally { if (ticket === epoch) { loadingKnowledge = false; controls(); } }
};
$('Format').onchange = () => { $('Confirm').checked = false; reviewed?.call('confirm', { confirmed: false }).catch(fail); controls(); preview(); };
$('Previous').onclick = () => preview(page - 1); $('Next').onclick = () => preview(page + 1);
$('Confirm').onchange = async () => { const runner = reviewed, ticket = epoch; try { const confirmed = await runner?.call('confirm', { confirmed: $('Confirm').checked }); if (ticket === epoch) { $('Confirm').checked = !!confirmed; controls(); } } catch (error) { fail(error); } };
$('Download').onclick = async () => { const ticket = epoch, format = $('Format').value; try { const blob = await reviewed.call('export', { format }); if (ticket === epoch) download(blob, format === 'markdown' ? 'chquery-investigation.md' : format === 'json' ? 'chquery-investigation.json' : 'chquery-investigation-report.json'); } catch (error) { fail(error); } };
$('Copy').onclick = async () => {
  const ticket = epoch;
  try { if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('Clipboard unavailable. Download instead.');
    const blob = reviewed.call('export', { format: 'markdown' }).then(value => { if (ticket !== epoch) throw new Error('Review changed.'); return value; });
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]); if (ticket === epoch) status('Exact reviewed Markdown copied.');
  } catch { fail(new Error('Clipboard unavailable or review changed. Download the reviewed file instead.')); }
};
$('Source').onclick = () => { if (confirm('Export original source including PRIVATE NOTES, original literals and optional metadata? This is NOT redacted or encrypted. Keep this backup private.')) compute('source', { investigation }, blob => { download(blob, 'chquery-investigation-private-source.json'); status('Original private source exported. No redaction or upload.'); }); };
$('Explore').onclick = () => {
  if (!confirm('Open an independent evidence snapshot in the explorer? Its existing workspace may require replacement. This investigation and private notes stay here.')) return;
  const paired = investigation.evidence.chquery_comparison === 1;
  compute('evidence', { investigation }, blob => {
    const file = new File([blob], 'investigation-evidence.json', { type: 'application/json' });
    if (paired) openComparisonFile(file).catch(fail);
    else {
      const transfer = new DataTransfer(); transfer.items.add(file);
      const input = document.getElementById('importBundleInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true })); close();
    }
  });
};
function close() { root.hidden = true; delete document.body.dataset.investigations; document.getElementById('openInvestigations').setAttribute('aria-expanded', 'false'); }
const opener = document.getElementById('openInvestigations'); opener.setAttribute('aria-controls', root.id); opener.setAttribute('aria-expanded', 'false');
opener.onclick = () => { document.getElementById('closeComparison').click(); root.hidden = false; document.body.dataset.investigations = 'true'; opener.setAttribute('aria-expanded', 'true'); $('Heading').focus(); };
resumeSaved.onclick = () => { opener.click(); if (savedCount > 0) list(); };
$('Close').onclick = () => {
  close();
  if (document.body.dataset.page === 'home' && savedCount > 0) resumeSaved.focus();
  else opener.closest('details').querySelector('summary').focus();
};
document.getElementById('openComparison').addEventListener('click', close);
document.getElementById('homeLink').addEventListener('click', close);
document.querySelectorAll('.top-nav a[href^="#"]').forEach(link => link.addEventListener('click', close));
window.addEventListener('popstate', close);
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  await refreshSavedSummary({ existingOnly: !storage });
  if (!identity || !storage || committing) return;
  const key = identity.id;
  try { const record = await storage.call('get', { key }); if (identity?.id !== key) return;
    if (!record) { release(); status('Saved record was deleted while this tab was away. Memory cleared.'); }
    else if (record.revision !== identity.expectedRevision) { conflict = true; invalidate(); status('Save changed while this tab was away. Resume it or save a new copy.'); }
  } catch (error) { fail(error); }
});
controls();
refreshSavedSummary({ existingOnly: true });
