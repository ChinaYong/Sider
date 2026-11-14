import { GEMINI_CONFIG_ATTRIBUTE, GEMINI_CONFIG_MESSAGE } from './gemini-preference-interceptor.js';
import { GEMINI_CATALOG_ATTRIBUTE, validateGeminiCatalog } from '../gemini-catalog.js';

if (!globalThis.__siderGeminiPreferenceBridge) {
  globalThis.__siderGeminiPreferenceBridge = true;
  let lastCatalog = '';
  const publishCatalog = () => {
    const root = document.documentElement;
    const raw = root?.getAttribute(GEMINI_CATALOG_ATTRIBUTE);
    if (!raw) return;
    root.removeAttribute(GEMINI_CATALOG_ATTRIBUTE);
    if (raw.length > 30000) return;
    try {
      const value = JSON.parse(raw);
      const unavailable = value?.unavailable === true;
      const catalog = unavailable ? null : validateGeminiCatalog(value);
      if (!catalog && !unavailable) return;
      const key = JSON.stringify(catalog);
      if (key === lastCatalog) return;
      lastCatalog = key;
      chrome.runtime.sendMessage({ type: 'SIDER_GEMINI_CATALOG_PUBLISH', catalog }).catch(() => {});
    } catch { /* Ignore invalid page metadata and stale extension contexts. */ }
  };
  const observer = new MutationObserver(publishCatalog);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: [GEMINI_CATALOG_ATTRIBUTE] });
  publishCatalog();
  chrome.runtime.sendMessage({ type: 'SIDER_GEMINI_DEFAULTS_GET' }).then(result => {
    if (!result?.ok || !result.settings) return;
    const settings = result.settings;
    const publish = () => {
      document.documentElement?.setAttribute(GEMINI_CONFIG_ATTRIBUTE, JSON.stringify(settings));
      window.postMessage({ type: GEMINI_CONFIG_MESSAGE, settings }, location.origin);
    };
    publish();
    if (!document.documentElement) document.addEventListener('DOMContentLoaded', publish, { once: true });
  }).catch(() => {});
}
