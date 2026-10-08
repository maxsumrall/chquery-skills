import { assertInvestigation, createInvestigation, parseInvestigation, replaceInvestigationSlot, exportInvestigationSource, INVESTIGATION_LIMITS } from './investigation.js';
import { parseComparisonEvidence, stableStringify } from './comparison-artifact.js';
import { prepareInvestigation } from './investigation-handoff.js';
import { createInvestigationStore } from './investigation-store.js';
import { textPage } from './text-page.js';

// Separate instances serve cancellable computation and non-cancellable commits.
// Construction alone never opens IndexedDB or a BroadcastChannel.
const store = createInvestigationStore();
store.subscribe(event => self.postMessage({ event }));
let prepared, confirmed = false;
const formats = ['json', 'reportJson', 'markdown'];
self.onmessage = async ({ data: { id, action, ...data } }) => {
  try {
    let result;
    if (action === 'import' || action === 'replace') {
      if (data.file.size > INVESTIGATION_LIMITS.totalBytes) throw new Error('File exceeds the 20 MiB investigation limit.');
      const text = await data.file.text();
      // Parse the discriminator only after the byte bound; canonical validators
      // reject conflicting versions and unsupported nested evidence.
      const value = JSON.parse(text);
      if (action === 'replace') result = replaceInvestigationSlot(data.investigation, data.role, parseComparisonEvidence(text));
      else result = Object.hasOwn(value, 'chquery_investigation') ? parseInvestigation(text) : createInvestigation(parseComparisonEvidence(text));
    } else if (action === 'create') result = createInvestigation(data.evidence);
    else if (action === 'validate') result = assertInvestigation(data.investigation);
    else if (action === 'evidence') result = new Blob([stableStringify(assertInvestigation(data.investigation).evidence)], { type: 'application/json' });
    else if (action === 'source') result = new Blob([exportInvestigationSource(data.investigation).json], { type: 'application/json' });
    else if (action === 'prepare') {
      prepared = null; confirmed = false;
      const next = prepareInvestigation(data.investigation, { ...data.options, analysis: data.analysis });
      prepared = next; // Publish only after every output guard succeeds.
      result = { ...next.preparation, privacy: next.privacy, privacyReview: next.privacyReview,
        bytes: Object.fromEntries(formats.map(key => [key, new Blob([next[key]]).size])) };
    } else if (action === 'preview') {
      if (!prepared || !formats.includes(data.format)) throw new Error('Prepare a fresh review first.');
      // Bound DOM content without truncating the downloadable output.
      const { characters: _characters, ...page } = textPage(prepared[data.format], data.page);
      result = page;
    } else if (action === 'confirm') result = confirmed = Boolean(prepared && data.confirmed);
    else if (action === 'export') {
      if (!prepared || !confirmed || !formats.includes(data.format)) throw new Error('Review and confirm these exact files first.');
      result = new Blob([prepared[data.format]], { type: data.format === 'markdown' ? 'text/plain' : 'application/json' });
    } else if (action === 'save') result = await store.save(data.investigation, data.identity);
    else if (action === 'list') result = await store.list();
    else if (action === 'get') result = await store.get(data.key);
    else if (action === 'delete') result = await store.delete(data.key, data.revision);
    else if (action === 'clear') result = await store.clear();
    else throw new Error('Unknown investigation operation.');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: { message: error.message, code: error.code,
      paths: error.paths, repair: error.repair,
      details: error.errors?.slice(0, 3).map(item => `${item.path}: ${item.message}`).join(' ') } });
  }
};
