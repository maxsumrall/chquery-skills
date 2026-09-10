import './theme.js';
import { initWorkspaceUI } from './workspace-ui.js';
import './agent-handoff-ui.js';
import './comparison-ui.js';
import './investigation-ui.js';
import { initInterchangeUI } from './interchange-ui.js';
import { initPasteEntry } from './paste-entry.js';

// Static imports install feature handlers before the page load event. Keep
// asynchronous evidence loading after both controllers have been initialized.
const workspace = initWorkspaceUI();
initPasteEntry(workspace);
await initInterchangeUI(workspace);
