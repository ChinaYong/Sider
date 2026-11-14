import { normalizeChatGPTDefaults } from '../ai-web.js';
import { CHATGPT_CATALOG_ATTRIBUTE, chatgptModelId, chatgptPresetValue, extractChatGPTCatalog } from '../chatgpt-catalog.js';

export const CHATGPT_CONFIG_ATTRIBUTE = 'data-sider-chatgpt-preferences';
export const CHATGPT_CONFIG_MESSAGE = 'SIDER_CHATGPT_PREFERENCE_CONFIG';
const STARTUP_WINDOW_MS = 60000;
const CHATGPT_LAST_MODEL_STATE = 'chatgpt-last-selected-model-v1';
const CHATGPT_HOME_MODEL_STATE = 'chatgpt-last-selected-home-model-v1';
const NEW_CHAT_CONTROL = '[data-testid="create-new-chat-button"], button[aria-label="New chat"], button[aria-label="新聊天"], button[aria-label="新建聊天"]';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function hasSafeNumbers(value) {
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(hasSafeNumbers);
  if (plain(value)) return Object.values(value).every(hasSafeNumbers);
  return true;
}

function whitespace(text, offset) {
  while (/\s/.test(text[offset] || '') && offset < text.length) offset++;
  return offset;
}

function stringEnd(text, offset) {
  for (let i = offset + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

function valueEnd(text, offset) {
  if (text[offset] === '"') return stringEnd(text, offset);
  if (text[offset] === '{' || text[offset] === '[') {
    const stack = [text[offset] === '{' ? '}' : ']'];
    for (let i = offset + 1; i < text.length; i++) {
      if (text[i] === '"') { i = stringEnd(text, i) - 1; if (i < 0) return -1; }
      else if (text[i] === '{' || text[i] === '[') stack.push(text[i] === '{' ? '}' : ']');
      else if (text[i] === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1; }
    }
    return -1;
  }
  let end = offset;
  while (end < text.length && !/[\s,}\]]/.test(text[end])) end++;
  return end > offset ? end : -1;
}

function propertySpan(text, objectStart, name, unique = false) {
  let offset = whitespace(text, objectStart);
  if (text[offset++] !== '{') return null;
  let match = null;
  while ((offset = whitespace(text, offset)) < text.length && text[offset] !== '}') {
    if (text[offset] !== '"') return null;
    const end = stringEnd(text, offset);
    if (end < 0) return null;
    const key = JSON.parse(text.slice(offset, end));
    offset = whitespace(text, end);
    if (text[offset++] !== ':') return null;
    offset = whitespace(text, offset);
    const valueStart = offset, valueStop = valueEnd(text, offset);
    if (valueStop < 0) return null;
    if (key === name) {
      if (unique && match) return null;
      match = [valueStart, valueStop];
    }
    offset = whitespace(text, valueStop);
    if (text[offset] === ',') offset++;
    else if (text[offset] !== '}') return null;
  }
  return match;
}

function arrayElementSpan(text, arrayStart, index) {
  let offset = whitespace(text, arrayStart), current = 0;
  if (text[offset++] !== '[') return null;
  while ((offset = whitespace(text, offset)) < text.length && text[offset] !== ']') {
    const start = offset, end = valueEnd(text, offset);
    if (end < 0) return null;
    if (current++ === index) return [start, end];
    offset = whitespace(text, end);
    if (text[offset] === ',') offset++;
    else if (text[offset] !== ']') return null;
  }
  return null;
}

export function chatgptPreferenceStateSpan(text) {
  try {
    const settings = propertySpan(text, 0, 'settings');
    return settings ? propertySpan(text, settings[0], 'last_used_model_config') : null;
  } catch { return null; }
}

function selectedChatGPTPreset(catalog, settings) {
  const id = chatgptModelId(settings?.model);
  const version = catalog?.versions.find(item => item.id === id && item.available);
  return version?.presets.find(item => item.available && chatgptPresetValue(item) === settings?.preset) || null;
}

export function patchChatGPTPreferences(data, catalog, settings) {
  const preset = selectedChatGPTPreset(catalog, settings);
  const state = data?.settings?.last_used_model_config;
  if (!preset || !plain(state) || !plain(state.slugs) || !plain(state.juices)) return null;
  for (const area of ['default', 'web']) {
    if (state.slugs[area] != null && typeof state.slugs[area] !== 'string') return null;
    if (state.juices[area] != null && !plain(state.juices[area])) return null;
  }
  for (const area of ['default', 'web']) {
    state.slugs[area] = preset.slug;
    if (preset.effort !== null) state.juices[area] = { ...state.juices[area], [preset.slug]: preset.effort };
  }
  return { slug: preset.slug, effort: preset.effort };
}

function chatgptInitRequestSpan(text) {
  if (typeof text !== 'string' || text.length > 2_000_000) return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!plain(body)) return null;
  const fields = ['conversation_id', 'conversation_origin', 'gizmo_id', 'requested_default_model', 'system_hints'];
  if (fields.some(field => !Object.hasOwn(body, field) || !propertySpan(text, 0, field, true))) return null;
  if (body.conversation_id !== null || body.conversation_origin !== null || body.gizmo_id !== null
    || body.requested_default_model !== null || !(body.system_hints === null || Array.isArray(body.system_hints) && body.system_hints.length === 0)) return null;
  return propertySpan(text, 0, 'requested_default_model', true);
}

// The same endpoint also serves quota checks and existing or custom chats.
// Only the recognised, explicitly unselected new-chat request is eligible.
export function patchChatGPTInitRequest(text, catalog, settings) {
  const preset = selectedChatGPTPreset(catalog, settings), span = chatgptInitRequestSpan(text);
  if (!preset || !span) return null;
  return { model: preset.slug, body: text.slice(0, span[0]) + JSON.stringify(preset.slug) + text.slice(span[1]) };
}

// On a new chat the site may initialize its thinking level from the model
// catalog before it reads account preferences. Change only the selected
// model's supported default; keep all other models and raw metadata intact.
export function patchChatGPTModelDefaults(text, data, catalog, settings) {
  const preset = selectedChatGPTPreset(catalog, settings);
  if (!preset?.effort || !Array.isArray(data?.models)) return null;
  const index = data.models.findIndex(model => model?.slug === preset.slug);
  const model = data.models[index];
  if (!model || model.configurable_thinking_effort !== true || !Array.isArray(model.thinking_efforts)
    || !model.thinking_efforts.some(item => item?.thinking_effort === preset.effort)) return null;
  const current = model.default_thinking_effort;
  if (current != null && typeof current !== 'string') return null;
  const models = propertySpan(text, 0, 'models', true), item = models && arrayElementSpan(text, models[0], index);
  if (!item || text[item[0]] !== '{' || !propertySpan(text, item[0], 'slug', true)) return null;
  const existing = propertySpan(text, item[0], 'default_thinking_effort', true);
  if (Object.hasOwn(model, 'default_thinking_effort') && !existing) return null;
  if (existing) return text.slice(0, existing[0]) + JSON.stringify(preset.effort) + text.slice(existing[1]);
  const insert = item[1] - 1, comma = text.slice(item[0] + 1, insert).trim() ? ',' : '';
  return text.slice(0, insert) + comma + '"default_thinking_effort":' + JSON.stringify(preset.effort) + text.slice(insert);
}

function requestSignal(window, input, init) {
  if (init && Object.hasOwn(init, 'signal')) return init.signal;
  return window.Request && input instanceof window.Request ? input.signal : null;
}

async function initRequestBody(window, input, init) {
  const headers = new window.Headers(init?.headers || (window.Request && input instanceof window.Request ? input.headers : undefined));
  if ((headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return null;
  if (init && Object.hasOwn(init, 'body')) return typeof init.body === 'string' ? init.body : null;
  return window.Request && input instanceof window.Request ? input.clone().text() : null;
}

function waitForSignal(window, promise, signal, timeoutMs) {
  return new Promise(resolve => {
    let timer, finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => finish(false);
    if (signal?.aborted) return finish(false);
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs !== undefined) timer = window.setTimeout(() => finish(false), timeoutMs);
    promise.then(() => finish(true), () => finish(false));
  });
}

function replaceResponse(window, response, body) {
  const headers = new window.Headers(response.headers);
  headers.delete('content-length'); headers.delete('content-encoding');
  const result = new window.Response(body, { status: response.status, statusText: response.statusText, headers });
  for (const name of ['url', 'redirected', 'type']) {
    try { Object.defineProperty(result, name, { configurable: true, value: response[name] }); } catch { /* Optional metadata. */ }
  }
  return result;
}

export function isChatGPTNewChat(location) {
  return location?.origin === 'https://chatgpt.com' && location.pathname === '/'
    && !new URLSearchParams(location.search).has('model');
}

function isChatGPTPendingFirstTurn(location) {
  // The composer navigates to a client-only ID before the first turn receives
  // a server conversation ID. Keep this separate from startup preparation.
  return location?.origin === 'https://chatgpt.com'
    && /^\/c\/local-chatgpt%3A[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(location.pathname)
    && !new URLSearchParams(location.search).has('model');
}

export function installChatGPTPreferenceInterceptor(window, { configTimeoutMs = 2000, catalogTimeoutMs = 1500 } = {}) {
  if (window.__siderChatGPTPreferenceInterceptor || typeof window.fetch !== 'function') return null;
  window.__siderChatGPTPreferenceInterceptor = true;
  const document = window.document, originalFetch = window.fetch;
  let started = Date.now(), selectionEpoch = 0, route = window.location.href, newChatRequested = false;
  let config, configFinished = false, interrupted = false, catalog = null, observer;
  let hostStateReady = false, lastModelPrepared = false, selectionInterrupted = false;
  let resolveConfig, resolveCatalog;
  const configReady = new Promise(resolve => { resolveConfig = resolve; });
  const catalogReady = new Promise(resolve => { resolveCatalog = resolve; });
  const timeout = window.setTimeout(() => finishConfig(null), configTimeoutMs);
  function finishConfig(value) {
    if (configFinished) return;
    configFinished = true; observer?.disconnect(); window.removeEventListener('message', onMessage);
    window.clearTimeout(timeout); resolveConfig(value);
  }
  function receive(raw) {
    if (configFinished || !raw) return;
    try { config = normalizeChatGPTDefaults(raw, true); } catch { return; }
    finishConfig(config);
    prepareLastModel();
  }
  function readAttribute() {
    const root = document.documentElement, raw = root?.getAttribute(CHATGPT_CONFIG_ATTRIBUTE);
    if (!raw) return;
    root.removeAttribute(CHATGPT_CONFIG_ATTRIBUTE);
    try { receive(JSON.parse(raw)); } catch { /* Ignore invalid page data. */ }
  }
  function onMessage(event) {
    if (event.source === window && event.origin === window.location.origin && event.data?.type === CHATGPT_CONFIG_MESSAGE) receive(event.data.settings);
  }
  // ChatGPT restores the last picker selection through its host state channel.
  // Update only the in-memory picker state after its initial sync and only with
  // a preset confirmed by the current account's catalog. This notification does
  // not write the site's persisted host state or account preferences.
  function prepareLastModel() {
    if (!hostStateReady || lastModelPrepared || interrupted || !isChatGPTNewChat(window.location)
      || Date.now() - started > STARTUP_WINDOW_MS) return;
    const preset = selectedChatGPTPreset(catalog, config), versionId = chatgptModelId(config?.model);
    if (!preset || !versionId) return;
    try {
      lastModelPrepared = true;
      // The merged home picker prefers its own last selection over the ordinary
      // chat picker, including when New chat reuses the cached model catalog.
      for (const key of [CHATGPT_LAST_MODEL_STATE, CHATGPT_HOME_MODEL_STATE]) {
        window.dispatchEvent(new window.MessageEvent('message', {
          source: window, origin: window.location.origin,
          data: { type: 'persisted-atom-updated', key,
            value: { slug: preset.slug, thinkingEffort: preset.effort, versionId }, deleted: false },
        }));
      }
      document.documentElement?.setAttribute('data-sider-chatgpt-selection', 'prepared');
    } catch { lastModelPrepared = false; }
  }
  function onHostMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin
      || event.data?.type !== 'persisted-atom-sync' || !plain(event.data.state)) return;
    hostStateReady = true;
    // The site's sync listener processes this same event after capture.
    window.queueMicrotask(prepareLastModel);
  }
  observer = new window.MutationObserver(readAttribute);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: [CHATGPT_CONFIG_ATTRIBUTE] });
  window.addEventListener('message', onMessage);
  window.addEventListener('message', onHostMessage, true);
  readAttribute();
  function beginNewChat() {
    started = Date.now(); selectionEpoch++;
    interrupted = false; selectionInterrupted = false; lastModelPrepared = false;
    for (const name of ['selection', 'init', 'thinking', 'defaults']) document.documentElement?.removeAttribute('data-sider-chatgpt-' + name);
    // Run after the site's New chat handler and route update, without clicking
    // its model menu or touching drafts, attachments, cookies or saved state.
    window.queueMicrotask(prepareLastModel);
  }
  function onNavigation() {
    const next = window.location.href;
    if (next === route) return;
    route = next;
    if (isChatGPTNewChat(window.location)) {
      if (!newChatRequested) beginNewChat();
      else window.queueMicrotask(prepareLastModel);
    } else if (!isChatGPTPendingFirstTurn(window.location)) {
      selectionEpoch++;
      interrupted = true; selectionInterrupted = true; lastModelPrepared = false;
    }
    newChatRequested = false;
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = window.history[method];
    window.history[method] = function () {
      const result = Reflect.apply(original, this, arguments);
      onNavigation();
      return result;
    };
  }
  window.addEventListener('popstate', onNavigation);
  document.addEventListener('click', event => {
    if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || !event.target?.closest?.(NEW_CHAT_CONTROL)) return;
    newChatRequested = true;
    beginNewChat();
  }, true);
  const interaction = event => {
    if (!event.isTrusted) return;
    if (event.target?.closest?.(NEW_CHAT_CONTROL)) return;
    if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key?.toLowerCase() === 'o') {
      newChatRequested = true;
      beginNewChat();
      return;
    }
    const picker = event.target?.closest?.('button[aria-label="Select ChatGPT model"]');
    if (picker && (event.type !== 'keydown' || picker.getAttribute('aria-expanded') !== 'true')) return;
    interrupted = true;
    // Once prepared, normal composing must not discard the chosen default:
    // first-turn admission can refresh /conversation/init after typing, even
    // minutes later. Other interactions (including a manual model choice)
    // relinquish it; early input still cancels pending startup preparation.
    const composing = event.target?.closest?.('#prompt-textarea, [data-testid="prompt-textarea"], button[data-testid="send-button"]');
    if (!lastModelPrepared || !composing) selectionInterrupted = true;
  };
  for (const type of ['pointerdown', 'keydown', 'input']) document.addEventListener(type, interaction, true);
  function publishCatalog(observed) {
    if (observed) { catalog = observed; resolveCatalog(observed); }
    else catalog = null;
    if (observed) prepareLastModel();
    const publish = () => document.documentElement?.setAttribute(CHATGPT_CATALOG_ATTRIBUTE, JSON.stringify(observed || { unavailable: true }));
    if (document.documentElement) publish(); else document.addEventListener('DOMContentLoaded', publish, { once: true });
  }
  window.fetch = function (input, init) {
    onNavigation();
    const epoch = selectionEpoch;
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof window.URL ? String(input) : input?.url, window.location.href); } catch { return Reflect.apply(originalFetch, this, arguments); }
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (url.origin !== 'https://chatgpt.com') return Reflect.apply(originalFetch, this, arguments);
    if (method === 'POST' && url.pathname === '/backend-api/conversation/init') {
      const receiver = this, originalArgs = [...arguments];
      return (async () => {
        let args = originalArgs, patched = null;
        try {
          const text = await initRequestBody(window, input, init), signal = requestSignal(window, input, init);
          // Reject unrelated calls before waiting for extension configuration.
          const shape = text && chatgptInitRequestSpan(text);
          const canApply = () => epoch === selectionEpoch && !selectionInterrupted && (
            lastModelPrepared && (isChatGPTNewChat(window.location) || isChatGPTPendingFirstTurn(window.location))
            || !interrupted && isChatGPTNewChat(window.location) && Date.now() - started <= STARTUP_WINDOW_MS);
          if (shape && canApply()
            && await waitForSignal(window, configReady, signal) && config && config.model !== 'site-default' && config.preset !== 'site-default') {
            if (!catalog) await waitForSignal(window, catalogReady, signal, catalogTimeoutMs);
            if (!signal?.aborted && canApply()) {
              patched = patchChatGPTInitRequest(text, catalog, config);
              if (patched) args = [input, { ...init, body: patched.body }];
            }
          }
        } catch { /* Unknown bodies and request formats pass through unchanged. */ }
        const result = Reflect.apply(originalFetch, receiver, args);
        if (patched) document.documentElement?.setAttribute('data-sider-chatgpt-init', 'requested');
        return result;
      })();
    }
    if (method !== 'GET' || !['/backend-api/models', '/backend-api/settings/user'].includes(url.pathname)) return Reflect.apply(originalFetch, this, arguments);
    const request = Reflect.apply(originalFetch, this, arguments);
    return (async () => {
      const response = await request;
      if (!response.ok) { if (url.pathname === '/backend-api/models') publishCatalog(null); return response; }
      try {
        const text = await response.clone().text();
        if (text.length > 2_000_000) { if (url.pathname === '/backend-api/models') publishCatalog(null); return response; }
        const data = JSON.parse(text);
        if (url.pathname === '/backend-api/models') {
          const observed = extractChatGPTCatalog(data);
          publishCatalog(observed);
          if (!observed || epoch !== selectionEpoch || interrupted || !isChatGPTNewChat(window.location)) return response;
          const settings = await configReady;
          if (!settings || settings.model === 'site-default' || settings.preset === 'site-default'
            || epoch !== selectionEpoch || interrupted || !isChatGPTNewChat(window.location) || Date.now() - started > STARTUP_WINDOW_MS) return response;
          const updated = patchChatGPTModelDefaults(text, data, observed, settings);
          if (!updated) return response;
          document.documentElement?.setAttribute('data-sider-chatgpt-thinking', 'prepared');
          return replaceResponse(window, response, updated);
        }
        const settings = await configReady;
        if (!settings || settings.model === 'site-default' || settings.preset === 'site-default' || epoch !== selectionEpoch || interrupted || !isChatGPTNewChat(window.location)) return response;
        if (!catalog) await Promise.race([catalogReady, new Promise(resolve => window.setTimeout(resolve, catalogTimeoutMs))]);
        if (epoch !== selectionEpoch || interrupted || !isChatGPTNewChat(window.location) || Date.now() - started > STARTUP_WINDOW_MS) return response;
        const span = chatgptPreferenceStateSpan(text), state = data?.settings?.last_used_model_config;
        if (!span || !hasSafeNumbers(state)) return response;
        const applied = patchChatGPTPreferences(data, catalog, settings);
        if (!applied) return response;
        document.documentElement?.setAttribute('data-sider-chatgpt-defaults', 'prepared');
        return replaceResponse(window, response, text.slice(0, span[0]) + JSON.stringify(state) + text.slice(span[1]));
      } catch { if (url.pathname === '/backend-api/models') publishCatalog(null); return response; }
    })();
  };
  return { receive };
}
