/** Keep navigation independent from saved preferences and preserve each pane's DOM. */
export function installSettingsNavigation(document) {
  const dialog = document.querySelector('#ai-settings-dialog');
  const tabs = [...dialog.querySelectorAll('[data-settings-tab]')];
  const scroller = dialog.querySelector('.settings-scroll');
  const positions = new Map();
  let active = 'ai';
  function activate(name, { focus = false, reset = false } = {}) {
    const selected = tabs.find(tab => tab.dataset.settingsTab === name);
    if (!selected) return;
    if (scroller) positions.set(active, scroller.scrollTop);
    active = name;
    for (const tab of tabs) {
      const current = tab === selected;
      tab.setAttribute('aria-selected', String(current)); tab.tabIndex = current ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !current;
    }
    if (scroller) scroller.scrollTop = reset ? 0 : positions.get(name) || 0;
    dialog.dataset.settingsSection = name;
    if (focus) selected.focus({ preventScroll: true });
    dialog.dispatchEvent(new document.defaultView.CustomEvent('sider-settings-section', { detail: name }));
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab.dataset.settingsTab));
    tab.addEventListener('keydown', event => {
      const offset = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : offset ? (index + offset + tabs.length) % tabs.length : null;
      if (next === null) return;
      event.preventDefault(); activate(tabs[next].dataset.settingsTab, { focus: true });
    });
  });
  activate('ai');
  return { activate };
}
