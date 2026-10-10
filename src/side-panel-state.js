const STORAGE_KEY = 'sider.openPanels.v1';

// Session storage survives service-worker suspension, but not a browser restart.
export function installSidePanelState(chrome) {
  const states = new Map(), revisions = new Map();
  let writes = Promise.resolve();
  const ready = (chrome.storage.session?.get(STORAGE_KEY) || Promise.resolve({})).then(stored => {
    const saved = stored[STORAGE_KEY];
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const [key, opened] of Object.entries(saved)) {
      const tabId = Number(key);
      if (Number.isInteger(tabId) && tabId >= 0 && typeof opened === 'boolean' && !revisions.has(tabId)) states.set(tabId, opened);
    }
  }).catch(() => {});
  const isOpen = (tabId, fallback = false) => states.get(tabId) ?? fallback === true;
  const revision = tabId => revisions.get(tabId) || 0;
  function persist() {
    writes = writes.then(async () => {
      await ready;
      await chrome.storage.session?.set({ [STORAGE_KEY]: Object.fromEntries(states) });
    }).catch(() => {});
  }
  function set(tabId, opened) {
    if (!Number.isInteger(tabId)) return;
    revisions.set(tabId, revision(tabId) + 1); states.set(tabId, opened);
    persist();
    void chrome.tabs.sendMessage(tabId, { type: 'SIDER_PANEL_STATE_CHANGED', opened }, { frameId: 0 }).catch(() => {});
  }
  function commit(tabId, expected, opened) {
    // Native events take priority over a late open/close API result.
    if (revision(tabId) === expected) set(tabId, opened);
    return isOpen(tabId, opened);
  }
  chrome.sidePanel.onOpened?.addListener(info => set(info.tabId, true));
  chrome.sidePanel.onClosed?.addListener(info => set(info.tabId, false));
  chrome.tabs.onRemoved.addListener(tabId => {
    revisions.set(tabId, revision(tabId) + 1); states.delete(tabId); persist();
  });
  return { ready, isOpen, revision, commit };
}
