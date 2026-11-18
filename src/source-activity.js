// Only the actual reference sources of open sidebars need passive capture.
// Keep this independent of host permissions and the selection-button setting.
export function installSourceActivity({ chrome, panels, references, activate }) {
  let active = new Set();
  let queue = Promise.resolve();
  function sync() {
    const pending = queue.then(async () => {
      await panels.ready;
      const sessions = await references.all();
      const next = new Set(panels.openTabIds().map(owner => sessions[owner]?.sourceTabId ?? owner));
      const previous = active;
      active = next;
      await Promise.allSettled([...new Set([...previous, ...next])].map(async tabId => {
        if (previous.has(tabId) === next.has(tabId)) return;
        // A slow or inaccessible source must not delay closing another panel.
        if (next.has(tabId)) void activate(tabId).catch(() => {});
        else await chrome.tabs.sendMessage(tabId, { type: 'SIDER_SOURCE_ACTIVITY_CHANGED', active: false }, { frameId: 0 });
      }));
    });
    queue = pending.catch(() => {});
    return pending;
  }
  panels.subscribe(() => { void sync().catch(() => {}); });
  const ready = sync();
  return { ready, sync, has: tabId => active.has(tabId), async isActive(tabId) { await sync(); return active.has(tabId); } };
}
