import { sameAgentPrompt } from './agent-handoff.js';
import { textPage } from './text-page.js';

const dialog = document.createElement('dialog');
dialog.id = 'agentHandoffDialog';
dialog.className = 'collection-dialog agent-handoff-dialog';
dialog.setAttribute('aria-labelledby', 'agentHandoffHeading');
dialog.innerHTML = `
  <div class="collection-dialog-heading"><div><span class="section-label">Selected finding</span><h2 id="agentHandoffHeading">Continue with your agent</h2></div><button id="agentHandoffClose" type="button">Cancel</button></div>
  <p>Continue the conversation, or prepare evidence for a new recipient. Nothing is uploaded or executed here.</p>
  <label>Send to<select id="agentHandoffMode"><option value="same">Same agent conversation</option><option value="new">New conversation or recipient</option></select></label>
  <p id="agentHandoffFinding" class="agent-handoff-finding"></p>
  <label>Your question for the agent<textarea id="agentHandoffQuestion" rows="3" maxlength="10000" placeholder="What should the agent help you decide?"></textarea></label>
  <section id="agentHandoffSame"><p>Review the prompt below. It includes this finding and your question, but no evidence file or review judgments.</p><button id="agentHandoffSameCopy" type="button">Copy continuation prompt</button><pre id="agentHandoffSameText" tabindex="0" aria-label="Prompt for the same agent"></pre></section>
  <div id="agentHandoffNew" hidden>
  <label class="collection-consent"><input id="agentHandoffReviews" type="checkbox"><span id="agentHandoffReviewsLabel">Include my current review judgments in this handoff. They are author judgments, not evidence.</span></label>
  <label class="collection-consent"><input id="agentHandoffRedact" type="checkbox" checked>Apply partial literal redaction to the outgoing evidence.</label>
  <details><summary>Omit optional evidence</summary><fieldset id="agentHandoffOmissions"><legend>Remove selected groups before preparing the handoff</legend></fieldset></details>
  <p>Redaction can leave identifiers, small numbers, DDL, provenance, and unsupported fields sensitive. Inspect both exact outputs.</p>
  <button id="agentHandoffPrepare" type="button">Prepare exact handoff</button>
  <section id="agentHandoffPreview" hidden aria-labelledby="agentHandoffPreviewHeading"><h3 id="agentHandoffPreviewHeading" tabindex="-1">Exact outgoing content</h3>
    <p id="agentHandoffManifest"></p><label>Preview<select id="agentHandoffFormat"><option value="prompt">Agent instructions</option><option value="evidence">Evidence artifact JSON</option></select></label>
    <div class="agent-handoff-pages"><button id="agentHandoffPrevious" type="button">Previous page</button><span id="agentHandoffPosition"></span><button id="agentHandoffNext" type="button">Next page</button></div>
    <pre id="agentHandoffText" tabindex="0" aria-label="Exact outgoing handoff content"></pre>
    <label class="collection-consent"><input id="agentHandoffConfirm" type="checkbox">I reviewed both exact outputs and want to copy or download these exact bytes.</label>
    <div class="agent-handoff-actions"><button id="agentHandoffCopy" type="button" disabled>Copy prompt + evidence</button><button id="agentHandoffDownload" type="button" disabled>Download evidence JSON</button></div>
  </section></div>
  <p id="agentHandoffStatus" role="status" aria-live="polite"></p><p id="agentHandoffError" role="alert" hidden></p>`;
document.body.append(dialog);

const $ = suffix => document.getElementById(`agentHandoff${suffix}`);
for (const group of ['schema', 'runtime', 'settings', 'estimate', 'pipeline', 'syntax']) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox'; input.value = group;
  label.append(input, ` ${group}`); $('Omissions').append(label);
}

let source, prepared, worker, requestId = 0, returnTarget, page = 0;
function invalidate() {
  prepared = null; worker?.terminate(); worker = null;
  $('Prepare').disabled = false;
  $('Confirm').checked = false; $('Preview').hidden = true;
  $('Copy').disabled = $('Download').disabled = true;
  $('Status').textContent = '';
}
function close() { worker?.terminate(); worker = null; dialog.close(); returnTarget?.focus({ preventScroll: true }); }
function fail(message) { $('Error').hidden = false; $('Error').textContent = message; $('Status').textContent = 'Nothing was copied, downloaded, saved, or uploaded.'; }
function omissions() { return [...$('Omissions').querySelectorAll('input:checked')].map(input => input.value); }
function render() {
  if (!prepared) return;
  const text = $('Format').value === 'prompt' ? prepared.prompt : prepared.evidenceJson;
  const segment = textPage(text, page, 65536);
  page = segment.page;
  $('Text').textContent = segment.text;
  const pages = segment.pages;
  $('Position').textContent = `Page ${page + 1} of ${pages} · exact output segment`;
  $('Previous').disabled = page === 0; $('Next').disabled = page + 1 === pages;
}
function controls() { $('Copy').disabled = $('Download').disabled = !prepared || !$('Confirm').checked; }

export function openAgentHandoff(input, opener) {
  source = structuredClone(input); returnTarget = opener;
  invalidate(); $('Error').hidden = true;
  $('Question').value = 'Does this finding matter for our intended result? What is the smallest useful check before changing the query?';
  $('Mode').value = 'same'; updateMode();
  $('Reviews').checked = false; $('Redact').checked = true;
  for (const input of $('Omissions').querySelectorAll('input')) input.checked = false;
  $('Finding').textContent = source.finding.message;
  const count = source.reviewJudgments.length;
  $('ReviewsLabel').textContent = count
    ? `Include my ${count} current review judgment${count === 1 ? '' : 's'} in this handoff. They are author judgments, not evidence.`
    : 'No current review judgments are available to include.';
  $('Reviews').disabled = count === 0;
  $('Reviews').closest('label').hidden = count === 0;
  dialog.showModal(); $('Question').focus();
}

function updateMode() {
  invalidate(); $('Error').hidden = true;
  const same = $('Mode').value === 'same';
  $('Same').hidden = !same; $('New').hidden = same;
  $('SameText').textContent = sameAgentPrompt(source.finding, $('Question').value);
  $('SameCopy').disabled = !$('Question').value.trim();
}
$('Mode').onchange = updateMode;
$('Question').addEventListener('input', updateMode);
$('SameCopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('SameText').textContent);
    $('Status').textContent = 'Continuation prompt copied. Paste into the same conversation; no new permissions are granted.';
  } catch {
    $('SameText').focus();
    const range = document.createRange(); range.selectNodeContents($('SameText'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    fail('Clipboard unavailable. Copy the selected prompt manually.');
  }
};

$('Close').onclick = close;
dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
for (const field of ['Question', 'Reviews', 'Redact', 'Omissions']) $(field).addEventListener('input', invalidate);
$('Format').onchange = () => { page = 0; $('Confirm').checked = false; controls(); render(); };
$('Previous').onclick = () => { page--; render(); };
$('Next').onclick = () => { page++; render(); };
$('Confirm').onchange = controls;
$('Prepare').onclick = () => {
  invalidate(); $('Error').hidden = true;
  const question = $('Question').value;
  if (!question.trim()) { fail('Enter the question you want the agent to answer.'); $('Question').focus(); return; }
  const id = ++requestId;
  worker = new Worker(new URL('./agent-handoff-worker.js', import.meta.url), { type: 'module' });
  $('Prepare').disabled = true; $('Status').textContent = 'Preparing locally. No network request is made.';
  worker.onmessage = ({ data }) => {
    if (data.id !== id) return;
    worker.terminate(); worker = null; $('Prepare').disabled = false;
    if (data.error) { fail(data.error.message); return; }
    prepared = data.result; $('Preview').hidden = false;
    $('Manifest').textContent = `${prepared.preparation.warning} Omitted: ${prepared.preparation.omissions.join(', ') || 'none'}. Instructions: ${new TextEncoder().encode(prepared.prompt).length.toLocaleString()} bytes · evidence: ${new TextEncoder().encode(prepared.evidenceJson).length.toLocaleString()} bytes.`;
    $('Status').textContent = 'Prepared immutable outputs. Review both before confirming.';
    $('Format').value = 'prompt'; render(); $('PreviewHeading').focus(); controls();
  };
  worker.onerror = () => { worker?.terminate(); worker = null; $('Prepare').disabled = false; fail('Could not prepare the handoff locally. Retry without changing your source evidence.'); };
  worker.postMessage({ id, input: { ...source, question, reviewJudgments: $('Reviews').checked ? source.reviewJudgments : [] },
    options: { redact: $('Redact').checked, omit: omissions() } });
};
$('Copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(prepared.combined);
    $('Status').textContent = 'Exact reviewed prompt and evidence copied. Pasting it authorizes analysis and a proposal only.';
  } catch {
    $('Format').value = 'prompt'; render(); $('Text').focus();
    const range = document.createRange(); range.selectNodeContents($('Text'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    fail('Clipboard unavailable. The instructions are selected; copy them manually, then download the exact evidence JSON.');
  }
};
$('Download').onclick = () => {
  const url = URL.createObjectURL(new Blob([prepared.evidenceJson], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'chquery-agent-evidence.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  $('Status').textContent = 'Exact reviewed evidence downloaded. No upload occurred.';
};

window.chqueryAgentHandoff = { open: openAgentHandoff };
