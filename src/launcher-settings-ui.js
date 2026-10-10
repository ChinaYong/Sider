import { LAUNCHER_SETTINGS_KEY, LAUNCHER_ORIGINS, normalizeLauncherSettings, normalizeLauncherSite, setLauncherSite } from './launcher-settings.js';

export function installLauncherSettingsUI({ document, chrome, sourceTabId }) {
  const toggle = document.querySelector('#launcher-floating');
  if (!toggle || !chrome?.runtime?.id) return;
  const grant = document.querySelector('#launcher-grant-all');
  const status = document.querySelector('#launcher-status');
  const shortcut = document.querySelector('#launcher-shortcut');
  const mode = document.querySelector('#launcher-mode');
  const current = document.querySelector('#launcher-current-site');
  const addCurrent = document.querySelector('#launcher-add-current');
  const input = document.querySelector('#launcher-site-input');
  const addSite = document.querySelector('#launcher-add-site');
  const list = document.querySelector('#launcher-sites');
  let settings = normalizeLauncherSettings(), busy = false, revision = 0;
  let source, sourceHasAccess = false, sourceRevision = 0;
  const message = value => { status.textContent = value; };
  const render = () => {
    toggle.checked = settings.floating; mode.value = settings.mode;
    const label = settings.mode === 'whitelist' ? '白名单' : '黑名单';
    const site = normalizeLauncherSite(source?.url), listed = settings[settings.mode].includes(site);
    current.textContent = site ? `当前网站：${site}` : '当前网页地址不可用，请在网页上点击 Sider 图标后重试。';
    addCurrent.textContent = listed ? `当前网站已在${label}` : `当前网站加入${label}`;
    addCurrent.disabled = busy || !site || listed;
    toggle.disabled = mode.disabled = input.disabled = addSite.disabled = busy;
    document.querySelector('#launcher-list-summary').textContent = `${label}（${settings[settings.mode].length}）`;
    list.replaceChildren(...settings[settings.mode].map(site => {
      const item = document.createElement('li'), name = document.createElement('span'), remove = document.createElement('button');
      name.textContent = site; remove.type = 'button'; remove.textContent = '移除'; remove.disabled = busy;
      remove.setAttribute('aria-label', `从${label}移除 ${site}`);
      remove.addEventListener('click', () => { void update(value => setLauncherSite(value, site, false), `已从${label}移除 ${site}。`); });
      item.append(name, remove); return item;
    }));
  };
  async function refreshAccess() {
    const all = await chrome.permissions.contains({ origins: LAUNCHER_ORIGINS });
    grant.textContent = all ? '已授予所有网页访问权限' : '允许访问所有网页'; grant.disabled = busy || all;
  }
  async function save(patch) {
    // Read again to preserve changes made on other pages.
    const stored = await chrome.storage.local.get(LAUNCHER_SETTINGS_KEY);
    const value = normalizeLauncherSettings(stored[LAUNCHER_SETTINGS_KEY]);
    const next = typeof patch === 'function' ? patch(value) : { ...value, ...patch };
    await chrome.storage.local.set({ [LAUNCHER_SETTINGS_KEY]: next }); settings = next; render();
  }
  async function update(patch, text) {
    if (busy) return; busy = true; render();
    try { await save(patch); message(text); }
    catch (error) { message(error.message || '设置保存失败，请重试。'); }
    finally { busy = false; render(); }
  }
  async function refreshSource() {
    const run = ++sourceRevision; source = undefined; render();
    if (!Number.isInteger(sourceTabId)) return;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SIDER_SOURCE_INFO', tabId: sourceTabId });
      if (!result?.ok) throw new Error(result?.error || '无法读取当前网页。');
      const next = result.source;
      const allowed = normalizeLauncherSite(next?.url) && await chrome.permissions.contains({ origins: [`${new URL(next.url).origin}/*`] });
      if (run !== sourceRevision) return;
      source = next; sourceHasAccess = Boolean(allowed); render();
    } catch (error) { if (run === sourceRevision) { render(); message(error.message); } }
  }
  async function load() {
    const current = revision;
    const stored = await chrome.storage.local.get(LAUNCHER_SETTINGS_KEY);
    if (current === revision) { settings = normalizeLauncherSettings(stored[LAUNCHER_SETTINGS_KEY]); render(); }
    await refreshAccess();
    const commands = await chrome.commands.getAll();
    const key = commands.find(command => command.name === 'open-side-panel')?.shortcut;
    shortcut.textContent = key || '尚未设置快捷键';
  }
  toggle.addEventListener('change', async () => {
    const floating = toggle.checked;
    await update({ floating }, floating ? '悬浮球已开启，按当前名单在已授权网页显示。' : '悬浮球已关闭。仍可用右键、快捷键或扩展图标打开。');
  });
  mode.addEventListener('change', () => { void update({ mode: mode.value }, '显示模式已切换，立即生效。'); });
  addCurrent.addEventListener('click', async () => {
    if (busy || !source?.url) return;
    const url = source.url, selectedMode = settings.mode;
    busy = true; render();
    try {
      // Request in the click before any await, so a newly allowed site can display immediately.
      if (selectedMode === 'whitelist' && !sourceHasAccess && !await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] })) throw new Error('未授予当前网站访问权限，请授权后重试。');
      await save(value => setLauncherSite({ ...value, mode: selectedMode }, url));
      message(`当前网站已加入${selectedMode === 'whitelist' ? '白名单' : '黑名单'}。`);
    } catch (error) { message(error.message || '加入名单失败，请重试。'); }
    finally { busy = false; render(); }
  });
  const addInput = () => {
    const site = normalizeLauncherSite(input.value);
    if (!site) { message('请输入有效的网站域名或 HTTP(S) 地址。'); return; }
    void update(value => setLauncherSite(value, site), `已加入 ${site}。`).then(() => { if (settings[settings.mode].includes(site)) input.value = ''; });
  };
  addSite.addEventListener('click', addInput);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addInput(); } });
  grant.addEventListener('click', async () => {
    if (busy) return; busy = true; grant.disabled = true; render();
    try {
      // Invoke the permission prompt before any await to retain the click gesture.
      if (!await chrome.permissions.request({ origins: LAUNCHER_ORIGINS })) throw new Error('未授予所有网页的访问权限。悬浮球仍只在已授权网页显示。');
      await save({ floating: true }); message('已开启悬浮球，按当前名单在已授权网页显示。');
    } catch (error) { message(error.message || '授权失败，请重试。'); }
    finally { busy = false; render(); await refreshAccess().catch(() => {}); }
  });
  document.querySelector('#launcher-configure-shortcut').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(error => message(error.message));
  });
  const changed = (changes, area) => {
    if (area === 'local' && changes[LAUNCHER_SETTINGS_KEY]) { revision++; settings = normalizeLauncherSettings(changes[LAUNCHER_SETTINGS_KEY].newValue); render(); }
  };
  const accessChanged = () => { void refreshAccess().catch(() => {}); if (details.open) void refreshSource(); };
  chrome.storage.onChanged.addListener(changed);
  chrome.permissions.onAdded.addListener(accessChanged); chrome.permissions.onRemoved.addListener(accessChanged);
  const details = document.querySelector('#launcher-settings');
  details.addEventListener('toggle', () => { if (details.open) void refreshSource(); });
  const sourceChanged = (tabId, change) => { if (tabId === sourceTabId && change.url && details.open) void refreshSource(); };
  chrome.tabs.onUpdated?.addListener(sourceChanged);
  // Refresh customized shortcuts whenever the settings dialog is opened.
  document.querySelector('#ai-settings-toggle').addEventListener('click', () => { void load().catch(error => message(error.message)); if (details.open) void refreshSource(); });
  document.defaultView.addEventListener('pagehide', () => {
    chrome.storage.onChanged.removeListener(changed);
    chrome.permissions.onAdded.removeListener(accessChanged); chrome.permissions.onRemoved.removeListener(accessChanged);
    chrome.tabs.onUpdated?.removeListener(sourceChanged);
  });
  void load().catch(error => message(error.message));
}
