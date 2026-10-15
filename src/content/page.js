import { captureReference, captureSelection, highlightReference, isEditable, isSupportedDocument } from './extract.js';
import { DEFAULT_FONT_FAMILY, installFontSettings } from '../font-settings.js';

const INSTALL_KEY = '__siderPageCaptureInstalled';

if (isSupportedDocument(document) && !globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;
  let cachedSelection = null;
  let sourceURL = location.href;
  let lastPublished;
  let enabled = false;
  let explicitlyConfigured = false;
  let captureTimer;
  let host;
  let button;
  let toast;
  let toastTimer;
  let fontSettings;

  function ensureOverlay() {
    if (host?.isConnected) return;
    fontSettings?.dispose();
    host = document.createElement('div');
    host.id = 'sider-selection-tools';
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    fontSettings = installFontSettings({ element: host, chrome });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial}button{display:none;position:fixed;padding:8px 12px;border:1px solid #5663cf;border-radius:9px;background:#303f9f;color:white;box-shadow:0 3px 12px #0003;font:13px system-ui;cursor:pointer;white-space:nowrap}button:hover{background:#25317f}button:focus-visible{outline:3px solid #bac5ff;outline-offset:2px}button:disabled{opacity:.7;cursor:wait}.toast{display:none;position:fixed;right:18px;bottom:18px;max-width:320px;padding:10px 14px;border-radius:9px;background:#20243b;color:white;font:13px system-ui;box-shadow:0 3px 12px #0003;}';
    style.textContent += `button,.toast{font-family:var(--sider-font-family,${DEFAULT_FONT_FAMILY})}`;
    button = document.createElement('button');
    button.type = 'button';
    button.textContent = '在侧栏提问';
    button.title = '在侧栏针对当前划词提问';
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', openSelectionPanel);
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    shadow.append(style, button, toast);
    document.documentElement.append(host);
  }

  function showToast(message) {
    ensureOverlay();
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.style.display = 'block';
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 2600);
  }

  function source() {
    return { url: location.href, title: document.title || '未命名网页' };
  }

  function publishSelection(force = false) {
    const message = { type: 'SIDER_SELECTION_CHANGED', source: source(), reference: cachedSelection };
    // capturedAt is a snapshot timestamp, not a change to the user's selection.
    const signature = JSON.stringify({ ...message, reference: cachedSelection && { ...cachedSelection, capturedAt: undefined } });
    if (!force && signature === lastPublished) return Promise.resolve();
    lastPublished = signature;
    return chrome.runtime.sendMessage(message).catch(() => {
      if (lastPublished === signature) lastPublished = undefined;
    });
  }

  function resetForNavigation() {
    if (sourceURL === location.href) return false;
    sourceURL = location.href;
    cachedSelection = null;
    // An SPA can keep the same DOM range after navigating to another page.
    // It must not become a selection of that new page.
    window.getSelection()?.removeAllRanges();
    return true;
  }

  function refreshSelection(clearFocusedCollapsed = true) {
    const navigated = resetForNavigation();
    const selection = window.getSelection();
    const editable = isEditable(document.activeElement);
    const reference = editable ? null : captureSelection(document);
    if (reference) cachedSelection = reference;
    else if (navigated || (selection && !selection.isCollapsed) || editable || (clearFocusedCollapsed && document.hasFocus())) cachedSelection = null;
    return { selection, reference };
  }

  function updateSelection(force = false) {
    const { selection, reference } = refreshSelection();
    publishSelection(force);
    if (!enabled || !reference) {
      if (button) button.style.display = 'none';
      return;
    }
    ensureOverlay();
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect?.();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.right - 40, window.innerWidth - 160));
    const top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 44));
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    button.style.display = 'block';
  }

  function scheduleCapture() {
    // Keep a replacement before focus can move to ChatGPT and collapse the DOM
    // range. Only the notification is delayed; focused deselection is decided
    // after the focus transition has settled.
    refreshSelection(false);
    clearTimeout(captureTimer);
    captureTimer = setTimeout(updateSelection, 90);
  }

  async function openSelectionPanel(event) {
    event.preventDefault();
    if (!cachedSelection || button.disabled) return;
    button.disabled = true;
    try {
      publishSelection(true);
      // Start opening before awaiting anything so the click remains a user gesture.
      const result = await chrome.runtime.sendMessage({ type: 'SIDER_OPEN_SOURCE_PANEL', source: source() });
      if (!result?.ok) throw new Error(result?.error || '打开侧栏失败。');
      showToast('已在侧栏显示当前划词');
      button.style.display = 'none';
    } catch (error) {
      showToast(error.message || '打开侧栏失败，请重新打开扩展。');
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('selectionchange', scheduleCapture);
  document.addEventListener('mouseup', scheduleCapture, true);
  document.addEventListener('focusin', scheduleCapture);
  window.addEventListener('focus', scheduleCapture);
  window.addEventListener('popstate', scheduleCapture);
  window.addEventListener('hashchange', scheduleCapture);
  setInterval(() => { if (sourceURL !== location.href) updateSelection(); }, 250);
  window.addEventListener('scroll', () => { if (button) button.style.display = 'none'; }, true);
  window.addEventListener('resize', () => { if (button) button.style.display = 'none'; });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    try {
      if (message.type === 'SIDER_PAGE_CAPTURE') {
        updateSelection();
        sendResponse({ ok: true, reference: captureReference(document, message.kind, cachedSelection) });
      } else if (message.type === 'SIDER_PAGE_SELECTION_GET') {
        updateSelection();
        sendResponse({ ok: true, reference: cachedSelection, source: source() });
      } else if (message.type === 'SIDER_PAGE_CLEAR_SELECTION') {
        cachedSelection = null;
        window.getSelection()?.removeAllRanges();
        if (button) button.style.display = 'none';
        publishSelection(true);
        sendResponse({ ok: true, source: source() });
      } else if (message.type === 'SIDER_ENABLE_SELECTION') {
        explicitlyConfigured = true;
        enabled = message.enabled !== false;
        updateSelection();
        sendResponse({ ok: true, enabled });
      } else if (message.type === 'SIDER_HIGHLIGHT') {
        sendResponse({ ok: true, found: highlightReference(document, message.locator) });
      } else {
        return false;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message || '读取网页内容失败。' });
    }
    return false;
  });

  updateSelection(true);

  chrome.storage.local.get('siderEnabledOrigins').then(settings => {
    if (!explicitlyConfigured && Array.isArray(settings.siderEnabledOrigins) && settings.siderEnabledOrigins.includes(location.origin)) {
      enabled = true;
      updateSelection();
    }
  }).catch(() => {});
}
