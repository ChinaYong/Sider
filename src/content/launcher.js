import { LAUNCHER_SETTINGS_KEY, normalizeLauncherSettings, launcherVisible, setLauncherSite } from '../launcher-settings.js';

const INSTALL_KEY = '__siderFloatingLauncherInstalled';
const SIZE = 40, GAP = 8;

if (window === window.top && /^https?:$/.test(location.protocol) && document.contentType === 'text/html' && !globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;
  let settings = normalizeLauncherSettings();
  let host, button, status, dialog, dismissButton, choiceStatus, drag, frame, busy = false, suppressClick = false, toastTimer;
  let dismissed = false, closing = false;
  let settingsChanged = false, allowed = true;
  let panelOpen = false, panelRevision = 0;

  function applyPanelState(opened) {
    panelOpen = opened === true;
    if (!button) return;
    button.title = `${panelOpen ? '关闭' : '打开'} Sider · 拖动可调整位置`;
    button.setAttribute('aria-label', `${panelOpen ? '关闭' : '打开'} Sider 侧栏`);
    button.setAttribute('aria-expanded', String(panelOpen));
  }

  const bounds = () => ({ x: Math.max(0, innerWidth - SIZE - GAP * 2), y: Math.max(0, innerHeight - SIZE - GAP * 2) });
  function position(x, y) {
    host.style.setProperty('left', `${x}px`, 'important');
    host.style.setProperty('top', `${y}px`, 'important');
  }
  function dock() {
    if (!host) return;
    const { x, y } = bounds();
    position(GAP + (settings.side === 'left' ? 0 : x), GAP + y * settings.y);
  }
  function toast(message) {
    status.textContent = message; status.hidden = false;
    const below = parseFloat(host.style.top) < status.offsetHeight + 48;
    status.style.top = below ? '48px' : 'auto'; status.style.bottom = below ? 'auto' : '48px';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { status.hidden = true; }, 3000);
  }
  function cancelDrag() {
    if (!drag) return;
    const pointerId = drag.id; drag = null;
    cancelAnimationFrame(frame); frame = null; button.classList.remove('dragging');
    if (button.hasPointerCapture?.(pointerId)) button.releasePointerCapture(pointerId);
    suppressClick = true; dock();
  }
  function drawDrag() {
    frame = null;
    if (!drag) return;
    const { x, y } = bounds();
    position(Math.max(GAP, Math.min(GAP + x, drag.left + drag.x - drag.startX)), Math.max(GAP, Math.min(GAP + y, drag.top + drag.y - drag.startY)));
  }
  function closeChoice(restore = true) {
    if (dialog?.open) dialog.close();
    dismissButton?.setAttribute('aria-expanded', 'false');
    if (restore && host?.isConnected) dismissButton.focus();
  }
  async function savePosition(position) {
    const stored = await chrome.storage.local.get(LAUNCHER_SETTINGS_KEY);
    await chrome.storage.local.set({ [LAUNCHER_SETTINGS_KEY]: { ...normalizeLauncherSettings(stored[LAUNCHER_SETTINGS_KEY]), ...position } });
  }
  async function dismiss(scope) {
    if (closing) return;
    closing = true; choiceStatus.textContent = '';
    const choices = [...dialog.querySelectorAll('button')]; choices.forEach(item => { item.disabled = true; });
    try {
      if (scope === 'once') { dismissed = true; render(); return; }
      const stored = await chrome.storage.local.get(LAUNCHER_SETTINGS_KEY);
      const current = normalizeLauncherSettings(stored[LAUNCHER_SETTINGS_KEY]);
      const next = scope === 'global' ? { ...current, floating: false } : setLauncherSite(current, location.href, current.mode === 'blacklist');
      await chrome.storage.local.set({ [LAUNCHER_SETTINGS_KEY]: next });
      settings = next; render();
    } catch (error) { choiceStatus.textContent = error.message || '关闭设置未保存，请重试。'; }
    finally { closing = false; choices.forEach(item => { item.disabled = false; }); }
  }
  function render() {
    if (dismissed || !launcherVisible(settings, location.href) || !allowed) { cancelDrag(); closeChoice(false); clearTimeout(toastTimer); host?.remove(); return; }
    if (host) { if (!host.isConnected) document.documentElement.append(host); dock(); return; }
    host = document.createElement('div'); host.id = 'sider-floating-launcher';
    host.setAttribute('data-sider-ui', 'launcher');
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483646!important;width:40px!important;height:40px!important;display:block!important;pointer-events:auto!important;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{color-scheme:light dark}*{box-sizing:border-box}[hidden]{display:none!important}button{font:13px system-ui;cursor:pointer}button:focus-visible{outline:2px solid #177455;outline-offset:3px}.launcher-button{display:grid;place-items:center;width:40px;height:40px;padding:0;border:1px solid #17745544;border-radius:50%;background:#f8fffb;color:#177455;box-shadow:0 2px 10px #123b2424;touch-action:none;user-select:none;opacity:.72;transition:opacity 120ms,box-shadow 120ms,background 120ms}.launcher-button:hover,.launcher-button:focus-visible{opacity:1;box-shadow:0 3px 14px #123b2438}.launcher-button:active{background:#e6f4ec}.launcher-button.dragging{cursor:grabbing;opacity:1}.launcher-button[aria-busy=true]{cursor:wait}svg{width:21px;height:21px;pointer-events:none}.dismiss-button{position:absolute;top:-4px;right:-4px;display:grid;place-items:center;width:20px;height:20px;border:1px solid #17745544;border-radius:50%;padding:0;background:#f8fffb;color:#52675c;font-size:16px;line-height:1;box-shadow:0 1px 4px #123b2424}.dismiss-button:hover{background:#e6f4ec}.status{position:absolute;bottom:48px;width:max-content;max-width:min(280px,calc(100vw - 32px));padding:9px 12px;border-radius:10px;background:#243b30;color:#fff;box-shadow:0 3px 14px #0002;font:12px/1.6 system-ui;overflow-wrap:anywhere}:host([data-side=right]) .status{right:0}:host([data-side=left]) .status{left:0}dialog{position:fixed;inset:0;margin:auto;width:min(300px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:18px;border:1px solid #17745533;border-radius:14px;background:#f8fffb;color:#243b30;box-shadow:0 12px 40px #0003;font:13px/1.6 system-ui}dialog::backdrop{background:#0003}dialog h2{font-size:15px;margin:0 0 6px}dialog p{margin:0 0 12px;color:#52675c;font-size:12px}dialog button{display:block;width:100%;padding:9px 12px;margin-top:8px;border:1px solid #17745533;border-radius:8px;text-align:left;background:transparent;color:inherit}dialog button:hover{background:#17745510}dialog button:disabled{opacity:.6;cursor:wait}dialog button small{display:block;font-size:11px;opacity:.75}dialog .cancel{text-align:center;border:0}dialog [role=status]{color:#b34832;margin:10px 0 0;overflow-wrap:anywhere}dialog [role=status]:empty{display:none}@media(prefers-color-scheme:dark){.launcher-button,.dismiss-button,dialog{background:#20332a;color:#b6e2cd;border-color:#91d6b640}dialog p{color:#aec7b9}.dismiss-button:hover{background:#2b4939}dialog [role=status]{color:#ffb3a2}}@media(prefers-reduced-motion:reduce){.launcher-button{transition:none}}`;
    style.textContent += '@media(max-height:420px){dialog{padding:12px}dialog>p:not([role=status]){display:none}dialog button{font-size:12px;line-height:1.4;padding:4px 9px;margin-top:5px}dialog button small{font-size:11px}dialog .cancel{margin-top:4px}}';
    button = document.createElement('button'); button.type = 'button'; button.className = 'launcher-button';
    applyPanelState(panelOpen);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', 'M15 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4Zm0 0v16M18 8v8');
    path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.8'); path.setAttribute('stroke-linecap', 'round');
    svg.append(path); button.append(svg);
    status = document.createElement('div'); status.className = 'status'; status.hidden = true; status.setAttribute('role', 'status');
    dismissButton = document.createElement('button'); dismissButton.type = 'button'; dismissButton.className = 'dismiss-button';
    dismissButton.textContent = '×'; dismissButton.title = '隐藏悬浮球'; dismissButton.setAttribute('aria-label', '隐藏悬浮球');
    dismissButton.setAttribute('aria-haspopup', 'dialog'); dismissButton.setAttribute('aria-expanded', 'false');
    dialog = document.createElement('dialog'); dialog.setAttribute('aria-labelledby', 'launcher-close-title');
    const title = document.createElement('h2'); title.id = 'launcher-close-title'; title.textContent = '关闭悬浮球';
    const help = document.createElement('p'); help.textContent = '选择关闭范围，仍可通过扩展图标、右键或快捷键打开侧栏。';
    dialog.append(title, help);
    for (const [scope, label, detail] of [['global', '全局关闭', '所有网站隐藏，可在设置中重新开启'], ['once', '仅本次', '仅当前页面隐藏，刷新或重新打开后恢复'], ['site', '仅该网站', `在 ${location.hostname} 隐藏，可在名单中恢复`]]) {
      const item = document.createElement('button'); item.type = 'button'; item.dataset.scope = scope; item.textContent = label;
      const hint = document.createElement('small'); hint.textContent = detail; item.append(hint);
      item.addEventListener('click', event => { event.stopPropagation(); void dismiss(scope); }); dialog.append(item);
    }
    choiceStatus = document.createElement('p'); choiceStatus.setAttribute('role', 'status'); choiceStatus.setAttribute('aria-live', 'polite');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'cancel'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => closeChoice()); dialog.append(choiceStatus, cancel);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!closing) closeChoice(); });
    dialog.addEventListener('click', event => { if (event.target === dialog && !closing) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeChoice(); } });
    dismissButton.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation(); cancelDrag(); choiceStatus.textContent = '';
      dialog.showModal(); dismissButton.setAttribute('aria-expanded', 'true');
    });
    root.append(style, button, status, dismissButton, dialog); document.documentElement.append(host);
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || busy || drag || dialog.open) return;
      event.preventDefault(); suppressClick = false;
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, left: parseFloat(host.style.left), top: parseFloat(host.style.top), moved: false };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      drag.x = event.clientX; drag.y = event.clientY;
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6) drag.moved = true;
      if (drag.moved) { button.classList.add('dragging'); if (frame == null) frame = requestAnimationFrame(drawDrag); }
    });
    button.addEventListener('pointerup', event => {
      if (!drag || drag.id !== event.pointerId) return;
      drag.x = event.clientX; drag.y = event.clientY;
      const moved = drag.moved || Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6;
      cancelAnimationFrame(frame); frame = null;
      if (moved) {
        drawDrag();
        const { y } = bounds();
        settings = { ...settings, side: parseFloat(host.style.left) + SIZE / 2 < innerWidth / 2 ? 'left' : 'right', y: y ? (parseFloat(host.style.top) - GAP) / y : settings.y };
      }
      drag = null; suppressClick = moved; button.classList.remove('dragging');
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      applySide(); dock();
      if (moved) void savePosition({ side: settings.side, y: settings.y }).catch(() => toast('位置未保存，刷新后可重新拖动。'));
    });
    button.addEventListener('pointercancel', cancelDrag);
    button.addEventListener('lostpointercapture', cancelDrag);
    button.addEventListener('keydown', event => { if (event.key === 'Escape') cancelDrag(); });
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      if ((suppressClick && event.detail !== 0) || busy) return;
      busy = true; button.setAttribute('aria-busy', 'true');
      try {
        // Send directly from the click so sidePanel.open keeps the user gesture.
        const revision = panelRevision;
        const result = await chrome.runtime.sendMessage({ type: 'SIDER_TOGGLE_PANEL', opened: panelOpen });
        if (!result?.ok) throw new Error(result?.error || '切换侧栏失败，请重试。');
        if (revision === panelRevision && typeof result.opened === 'boolean') applyPanelState(result.opened);
      } catch (error) { toast(error.message || '请在扩展管理页重新加载 Sider。'); }
      finally { busy = false; button.removeAttribute('aria-busy'); }
    });
    applySide(); dock();
    if (document.fullscreenElement) host.style.setProperty('display', 'none', 'important');
  }
  function applySide() { if (host) host.dataset.side = settings.side; }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[LAUNCHER_SETTINGS_KEY]) return;
    settingsChanged = true; cancelDrag(); settings = normalizeLauncherSettings(changes[LAUNCHER_SETTINGS_KEY].newValue); applySide(); render();
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'SIDER_LAUNCHER_ACCESS') { allowed = message.allowed === true; render(); }
    if (message?.type === 'SIDER_PANEL_STATE_CHANGED') { panelRevision++; applyPanelState(message.opened); }
  });
  window.addEventListener('resize', () => { cancelDrag(); dock(); });
  document.addEventListener('keydown', event => { if (drag && event.key === 'Escape') cancelDrag(); });
  document.addEventListener('fullscreenchange', () => { if (host) host.style.setProperty('display', document.fullscreenElement ? 'none' : 'block', 'important'); });
  chrome.storage.local.get(LAUNCHER_SETTINGS_KEY).then(stored => {
    if (!settingsChanged) settings = normalizeLauncherSettings(stored[LAUNCHER_SETTINGS_KEY]); render();
  }).catch(() => {});
  const initialRevision = panelRevision;
  chrome.runtime.sendMessage({ type: 'SIDER_PANEL_STATE_GET' }).then(result => {
    if (result?.ok && initialRevision === panelRevision) applyPanelState(result.opened);
  }).catch(() => {});
}
