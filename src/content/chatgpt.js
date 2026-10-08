import { installEnhancement } from './enhancement.js';
import { siteForURL } from '../ai-web.js';
import { createWebAdapter } from './adapters.js';
import { pickSendButton } from './send-picker.js';
import { installGeminiDefaults } from './gemini-defaults.js';

(() => {
  if (globalThis.__siderChatInitialized) return;
  globalThis.__siderChatInitialized = true;
  const extensionRoot = chrome.runtime.getURL('/');
  const extensionOrigin = extensionRoot.replace(/\/$/, '');
  let bridgeId = new URL(location.href).searchParams.get('sider_bridge') || null;
  let bridge;
  let reconnect;
  let enhancement;
  let enhancementReady = false;
  let enhancementDetail = '';
  let site = siteForURL(location.href);
  let siteConfirmed = false;
  let handshake;
  let picker;
  let geminiDefaults;

  function isExtensionSender(sender) {
    if (sender?.id !== chrome.runtime.id) return false;
    if (!sender.url) return !sender.tab;
    return sender.url.startsWith(extensionRoot);
  }

  function isEmbedded() {
    if (window.parent === window) return false;
    const ancestors = Array.from(location.ancestorOrigins || []);
    // Only the sidebar's direct child can contact its extension parent. Nested
    // ChatGPT frames can also have the extension among more distant ancestors.
    return ancestors.length ? ancestors[0] === extensionOrigin : document.referrer.startsWith(`${extensionOrigin}/`);
  }

  function announce() {
    try {
      bridge?.postMessage({ type: 'SIDER_CHAT_READY', embedded: isEmbedded(), bridgeId, siteId: site?.id });
      bridge?.postMessage({ type: 'SIDER_ENHANCEMENT_READY', bridgeId, ready: enhancementReady, detail: enhancementDetail });
    } catch {}
  }

  function enhance() {
    if (!isEmbedded() || !bridgeId || !site || !siteConfirmed || enhancement) return;
    enhancement = installEnhancement({ document, chrome, bridgeId, adapter: createWebAdapter(document, site), onReady({ ready, detail = '' }) {
      enhancementReady = ready; enhancementDetail = detail; announce();
    } });
  }

  function closeHandshake() {
    if (!handshake) return;
    clearTimeout(handshake.timer);
    handshake.port.close();
    handshake = null;
  }

  window.addEventListener('message', event => {
    if (event.data?.type !== 'SIDER_AI_SEND_PICK_REQUEST' || !isEmbedded() || event.source !== window.parent || event.origin !== extensionOrigin
      || !bridgeId || event.data.bridgeId !== bridgeId || event.data.siteId !== site?.id || event.ports.length !== 1) return;
    picker?.abort();
    const controller = new AbortController();
    picker = controller;
    const port = event.ports[0];
    port.onmessage = message => { if (message.data?.type === 'SIDER_AI_SEND_PICK_CANCEL') controller.abort(); };
    port.start();
    pickSendButton(document, { signal: controller.signal }).then(result => {
      try { port.postMessage(result); } catch {}
    }, error => {
      try { port.postMessage({ ok: false, error: error.message || '无法点选发送按钮，请重试。' }); } catch {}
    }).finally(() => { port.close(); if (picker === controller) picker = null; });
  });

  // Start from the loaded child. The initial iframe inherits the extension's
  // origin, and a redirect can replace its WindowProxy at any time. A response
  // port stays bound to this document without requiring a guessed child origin.
  function requestParentBridge() {
    if (!isEmbedded()) return;
    closeHandshake();
    const channel = new MessageChannel();
    const pending = { port: channel.port1, timer: null };
    handshake = pending;
    channel.port1.onmessage = event => {
      if (handshake !== pending) return;
      const message = event.data;
      closeHandshake();
      if (message?.type !== 'SIDER_EMBED_HELLO' || !/^[a-zA-Z0-9-]{16,100}$/.test(message.bridgeId)) return;
      if (bridgeId && bridgeId !== message.bridgeId) return;
      if (message.site) {
        if (message.site.origin !== location.origin) return;
        site = message.site;
      }
      siteConfirmed = Boolean(site);
      bridgeId = message.bridgeId;
      announce(); enhance();
    };
    pending.timer = setTimeout(() => { if (handshake === pending) closeHandshake(); }, 5000);
    try {
      window.parent.postMessage({ type: 'SIDER_EMBED_HELLO_REQUEST' }, extensionOrigin, [channel.port2]);
    } catch {
      closeHandshake(); channel.port2.close();
    }
  }

  async function fill(message) {
    if (typeof message.text !== 'string' || message.text.length > 1_000_000) {
      return { ok: false, error: '提示词格式错误或过长，请精简后重试。' };
    }
    const target = message.site || site;
    if (!target || target.origin !== location.origin) return { ok: false, error: 'AI 网站与当前输入框不匹配。' };
    return createWebAdapter(document, target).writeDraft(message.text, { mode: message.mode || 'append' });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'SIDER_CHAT_FILL') return false;
    if (!isExtensionSender(sender)) {
      sendResponse({ ok: false, error: '拒绝来自非扩展页面的填入请求。' });
      return false;
    }
    fill(message).then(sendResponse, () => sendResponse({ ok: false, error: '填入失败，请复制提示词。' }));
    return true;
  });

  function connectBridge() {
    try {
      bridge = chrome.runtime.connect({ name: 'sider-chat-bridge' });
      announce(); enhance();
      bridge.onMessage.addListener((message) => {
        if (message?.type === 'SIDER_TAB_CONTEXT_CHANGED') {
          void enhancement?.refresh().catch(() => {});
          return;
        }
        if (message?.type !== 'SIDER_CHAT_FILL' || typeof message.requestId !== 'string') return;
        const receivingBridge = bridge;
        fill(message).then((result) => {
          try {
            receivingBridge.postMessage({ type: 'SIDER_CHAT_RESULT', requestId: message.requestId, ...result });
          } catch {
            // The sidebar or page was closed during editing.
          }
        });
      });
      bridge.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        clearTimeout(reconnect);
        reconnect = setTimeout(connectBridge, 1500);
      });
      chrome.runtime.sendMessage({ type: 'SIDER_CHAT_READY', embedded: isEmbedded(), bridgeId }).catch(() => {});
      requestParentBridge();
    } catch {
      // An extension update invalidates older content-script contexts.
    }
  }

  function startGeminiDefaults() {
    if (site?.id !== 'gemini' || geminiDefaults) return;
    geminiDefaults = installGeminiDefaults({ document, async getSettings() {
      const result = await chrome.runtime.sendMessage({ type: 'SIDER_GEMINI_DEFAULTS_GET' });
      if (!result?.ok) throw new Error(result?.error || '无法读取 Gemini 默认设置。');
      return result.settings;
    }, onResult(result) {
      document.documentElement.setAttribute('data-sider-gemini-defaults', result.complete ? 'applied' : result.reason || 'failed');
      if (!result.complete) console.warn('[Sider] Gemini 默认设置未完成：', result.reason);
    } });
    geminiDefaults.start();
  }

  connectBridge();
  startGeminiDefaults();
  window.addEventListener('pagehide', () => {
    clearTimeout(reconnect);
    closeHandshake();
    picker?.abort();
    geminiDefaults?.dispose();
    enhancement?.dispose();
  });
})();
