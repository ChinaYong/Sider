import { CHATGPT_CONFIG_ATTRIBUTE, CHATGPT_CONFIG_MESSAGE } from './chatgpt-preference-interceptor.js';
import { CHATGPT_CATALOG_ATTRIBUTE, validateChatGPTCatalog } from '../chatgpt-catalog.js';

if (!globalThis.__siderChatGPTPreferenceBridge) {
  globalThis.__siderChatGPTPreferenceBridge = true;
  let lastCatalog = '';
  const publishCatalog = () => {
    const root = document.documentElement, raw = root?.getAttribute(CHATGPT_CATALOG_ATTRIBUTE);
    if (!raw) return;
    root.removeAttribute(CHATGPT_CATALOG_ATTRIBUTE);
    if (raw.length > 30000) return;
    try {
      const value = JSON.parse(raw), unavailable = value?.unavailable === true;
      const catalog = unavailable ? null : validateChatGPTCatalog(value);
      if (!catalog && !unavailable) return;
      const key = JSON.stringify(catalog);
      if (key === lastCatalog) return;
      lastCatalog = key;
      chrome.runtime.sendMessage({ type: 'SIDER_CHATGPT_CATALOG_PUBLISH', catalog }).catch(() => {});
    } catch { /* Ignore invalid page metadata and stale extension contexts. */ }
  };
  const observer = new MutationObserver(publishCatalog);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: [CHATGPT_CATALOG_ATTRIBUTE] });
  publishCatalog();
  chrome.runtime.sendMessage({ type: 'SIDER_CHATGPT_DEFAULTS_GET' }).then(result => {
    if (!result?.ok || !result.settings) return;
    const settings = result.settings;
    const publish = () => {
      document.documentElement?.setAttribute(CHATGPT_CONFIG_ATTRIBUTE, JSON.stringify(settings));
      window.postMessage({ type: CHATGPT_CONFIG_MESSAGE, settings }, location.origin);
    };
    publish();
    if (!document.documentElement) document.addEventListener('DOMContentLoaded', publish, { once: true });
  }).catch(() => {});
}
