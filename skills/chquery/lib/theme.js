// CSS handles live system changes. Only an explicit choice sets data-theme.
const button = document.querySelector('[data-theme-toggle]');
const status = document.querySelector('[data-theme-status]');
const states = ['system', 'light', 'dark'];
const icons = { system: '◐', light: '☼', dark: '☾' };

function renderTheme(announce = false) {
  const state = document.documentElement.dataset.theme || 'system';
  const label = state[0].toUpperCase() + state.slice(1);
  button.textContent = icons[state];
  button.setAttribute('aria-label', `Theme: ${label}`);
  button.setAttribute('aria-pressed', String(state !== 'system'));
  button.title = `Theme: ${label}. Switch to ${states[(states.indexOf(state) + 1) % states.length]}.`;
  if (announce) status.textContent = `Theme: ${label}${state === 'system' ? ' (follows your device)' : ''}.`;
}

if (button && status) {
  renderTheme();
  button.addEventListener('click', () => {
    const root = document.documentElement;
    const next = states[(states.indexOf(root.dataset.theme || 'system') + 1) % states.length];
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem('chquery-theme');
      else localStorage.setItem('chquery-theme', next);
    } catch { /* The choice still works for this page when storage is blocked. */ }
    renderTheme(true);
  });
  window.addEventListener('storage', event => {
    if (event.key !== 'chquery-theme' && event.key !== null) return;
    if (event.newValue === 'light' || event.newValue === 'dark') document.documentElement.dataset.theme = event.newValue;
    else delete document.documentElement.dataset.theme;
    renderTheme(true);
  });
}
