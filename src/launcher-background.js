import { LAUNCHER_SETTINGS_KEY, normalizeLauncherSettings, launcherVisible } from './launcher-settings.js';

export function installLauncherBackground(chrome) {
  const scriptId = 'sider-floating-launcher';
  let queue = Promise.resolve();

  async function inject(tab) {
    if (!Number.isInteger(tab?.id) || !/^https?:\/\//.test(tab.url || '')) return;
    const stored = await chrome.storage.local.get(LAUNCHER_SETTINGS_KEY);
    if (!launcherVisible(stored[LAUNCHER_SETTINGS_KEY], tab.url)) return;
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['launcher-content.js'] });
    // A toolbar/context-menu click can restore temporary activeTab access after
    // persistent host access was revoked on this still-open document.
    await chrome.tabs.sendMessage(tab.id, { type: 'SIDER_LAUNCHER_ACCESS', allowed: true }, { frameId: 0 }).catch(() => {});
  }

  function sync() {
    const pending = queue.then(async () => {
      if (!chrome.permissions.getAll || !chrome.scripting.getRegisteredContentScripts) return;
      const [stored, permissions] = await Promise.all([chrome.storage.local.get(LAUNCHER_SETTINGS_KEY), chrome.permissions.getAll()]);
      const enabled = normalizeLauncherSettings(stored[LAUNCHER_SETTINGS_KEY]).floating;
      const matches = [...new Set((permissions.origins || []).flatMap(pattern => pattern === '<all_urls>'
        ? ['https://*/*', 'http://*/*'] : /^(?:https?|\*):\/\//.test(pattern) ? [pattern] : []))].sort();
      const [current] = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
      const wanted = enabled && matches.length > 0;
      const unchanged = wanted && current && JSON.stringify([...current.matches].sort()) === JSON.stringify(matches)
        && JSON.stringify(current.js) === JSON.stringify(['launcher-content.js']) && !current.allFrames;
      if (current && !unchanged) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
      if (wanted && !unchanged) await chrome.scripting.registerContentScripts([{
        id: scriptId, matches, js: ['launcher-content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
      }]);
      const tabs = await chrome.tabs.query({});
      await Promise.allSettled(tabs.map(async tab => {
        const allowed = enabled && /^https?:\/\//.test(tab.url || '') && await chrome.permissions.contains({ origins: [`${new URL(tab.url).origin}/*`] });
        if (allowed) await inject(tab);
        // Revoking host access does not remove a previously injected UI.
        await chrome.tabs.sendMessage(tab.id, { type: 'SIDER_LAUNCHER_ACCESS', allowed: Boolean(allowed) }, { frameId: 0 }).catch(() => {});
      }));
    });
    queue = pending.catch(() => {});
    return pending;
  }

  // List changes can make an existing tab eligible for its first injection.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[LAUNCHER_SETTINGS_KEY]) return;
    const before = normalizeLauncherSettings(changes[LAUNCHER_SETTINGS_KEY].oldValue), after = normalizeLauncherSettings(changes[LAUNCHER_SETTINGS_KEY].newValue);
    if (['floating', 'mode', 'blacklist', 'whitelist'].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))) void sync().catch(() => {});
  });
  chrome.permissions.onAdded?.addListener(() => { void sync().catch(() => {}); });
  chrome.permissions.onRemoved?.addListener(() => { void sync().catch(() => {}); });
  void sync().catch(() => {});
  return { inject, sync };
}
