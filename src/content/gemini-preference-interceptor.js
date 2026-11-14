import { normalizeGeminiDefaults } from '../ai-web.js';
import { GEMINI_CATALOG_ATTRIBUTE, extractGeminiCatalog, geminiChoiceModelId, geminiLevelNumber, isGeminiModelId, resolveGeminiModel } from '../gemini-catalog.js';

export const GEMINI_CONFIG_ATTRIBUTE = 'data-sider-gemini-preferences';
export const GEMINI_CONFIG_MESSAGE = 'SIDER_GEMINI_PREFERENCE_CONFIG';

const RPC_PATH = /^(?:\/u\/\d+)?\/_\/BardChatUi\/data\/batchexecute$/;
const AUTO_WRITE_WINDOW_MS = 10000;

export function isGeminiAppRoute(path) {
  return !/(?:^|\/)spark(?:\/|$)/.test(path) && /^(?:\/u\/\d+)?\/app(?:\/|$)/.test(path) && !/\/app\/download/.test(path);
}

function frameLengthAfterChange(original, changed, declared) {
  const encoder = new TextEncoder();
  const measurements = [
    [original.length, changed.length],
    [[...original].length, [...changed].length],
    [encoder.encode(original).length, encoder.encode(changed).length],
  ].filter(([before]) => before + 2 === declared);
  const deltas = new Set(measurements.map(([before, after]) => after - before));
  return deltas.size === 1 ? declared + [...deltas][0] : null;
}

function hasSafeNumbers(value) {
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(hasSafeNumbers);
  if (value && typeof value === 'object') return Object.values(value).every(hasSafeNumbers);
  return true;
}

export function readGeminiFrame(body, rpc) {
  if (typeof body !== 'string' || body.length > 2_000_000) return null;
  for (const line of body.split('\n')) {
    try {
      const rows = JSON.parse(line);
      if (!Array.isArray(rows) || !hasSafeNumbers(rows)) continue;
      const row = rows.find(item => Array.isArray(item) && item[0] === 'wrb.fr' && item[1] === rpc && typeof item[2] === 'string');
      if (!row) continue;
      const data = JSON.parse(row[2]);
      if (hasSafeNumbers(data)) return data;
    } catch { /* Ignore framing and unrelated rows. */ }
  }
  return null;
}

// Only change a fully recognised, length-delimited RPC frame. Unknown Google
// response formats pass through untouched instead of breaking page startup.
export function rewriteGeminiFrame(body, rpc, transform) {
  if (typeof body !== 'string' || body.length > 2_000_000) return null;
  const lines = body.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\d+$/.test(lines[i])) continue;
    const original = lines[i + 1];
    let rows;
    try { rows = JSON.parse(original); } catch { continue; }
    if (!Array.isArray(rows) || !hasSafeNumbers(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row) || row[0] !== 'wrb.fr' || row[1] !== rpc || typeof row[2] !== 'string') continue;
      let data;
      try { data = JSON.parse(row[2]); } catch { continue; }
      if (!hasSafeNumbers(data)) continue;
      const value = transform(data);
      if (!value) continue;
      row[2] = JSON.stringify(data);
      const changed = JSON.stringify(rows);
      const length = frameLengthAfterChange(original, changed, Number(lines[i]));
      if (length === null) return null;
      lines[i] = String(length);
      lines[i + 1] = changed;
      return { body: lines.join('\n'), value };
    }
  }
  return null;
}

export function patchGeminiCatalog(data, settings) {
  const models = data?.[15];
  const choices = data?.[24]?.[1];
  const catalog = extractGeminiCatalog(data);
  const target = catalog && resolveGeminiModel(catalog.models, settings.model);
  const requestedLevel = geminiLevelNumber(settings.thinkingLevel);
  if (!target?.available || (requestedLevel === null && settings.thinkingLevel !== 'site-default')) return null;
  // A model may stop exposing thinking levels. Keep the saved preference for
  // possible later use, but still select the model using the site's default.
  const level = target.levels.length ? requestedLevel : null;
  if (level !== null && !target.levels.some(option => option.id === level)) return null;
  // Gemini can initialize another built-in model before the saved target and
  // keep its already-selected level when switching to the target model.
  const available = new Set(catalog.models.filter(model => model.available).map(model => model.id));
  for (const choice of choices || []) {
    const surfaces = choice?.[3];
    if (level !== null && available.has(geminiChoiceModelId(choice, models)) && !choice?.[0]?.[14]
      && (!Array.isArray(surfaces) || !surfaces.length || surfaces.includes(1)) && Array.isArray(choice?.[1])
      && choice[1].some(option => Array.isArray(option) && option[0] === level)) choice[2] = level;
  }
  return { modelId: target.id, thinkingLevel: level };
}

export function patchGeminiPreferences(data, catalog) {
  const prefs = data?.[0];
  if (!Array.isArray(prefs) || prefs.length < 165 || !catalog || (catalog.modelId == null && catalog.thinkingLevel == null)) return null;
  if (catalog.modelId != null && !isGeminiModelId(catalog.modelId)) return null;
  if (catalog.thinkingLevel != null && (!Number.isSafeInteger(catalog.thinkingLevel) || catalog.thinkingLevel < 1 || catalog.thinkingLevel > 9999)) return null;
  if (prefs[99] != null && !isGeminiModelId(prefs[99])) return null;
  if (prefs[164] != null && !isGeminiModelId(prefs[164])) return null;
  const tail = prefs[prefs.length - 1];
  const hasTailObject = tail && typeof tail === 'object' && !Array.isArray(tail);
  if (hasTailObject && !Object.keys(tail).every(key => /^\d+$/.test(key))) return null;
  const levelInTail = hasTailObject && prefs.length <= 265;
  const previousLevel = levelInTail ? tail['265'] : prefs[264];
  if (catalog.thinkingLevel != null && previousLevel != null && !Number.isInteger(previousLevel)) return null;
  if (catalog.modelId != null) {
    prefs[99] = catalog.modelId;
    prefs[164] = catalog.modelId;
  }
  if (catalog.thinkingLevel == null) return catalog;
  if (levelInTail) {
    tail['265'] = catalog.thinkingLevel;
  } else if (prefs.length >= 265) {
    prefs[264] = catalog.thinkingLevel;
  } else {
    // A trailing object makes high-numbered JsPb fields sparse; putting it
    // after the existing fields preserves their indices and values.
    prefs.push({ 265: catalog.thinkingLevel });
  }
  return catalog;
}

function protoField(prefs, field) {
  if (!Array.isArray(prefs)) return undefined;
  const tail = prefs[prefs.length - 1];
  if (tail && typeof tail === 'object' && !Array.isArray(tail) && prefs.length <= field) return tail[String(field)];
  return prefs[field - 1];
}

// Google writes the initial selection back to account preferences. Acknowledge
// only the exact automatic write; unrelated and manual preference writes pass.
export function automaticPreferenceWrite(body, catalog) {
  if (typeof body !== 'string' || body.length > 2_000_000 || !catalog) return null;
  let calls, data;
  try {
    calls = JSON.parse(new URLSearchParams(body).get('f.req') || '');
    if (!Array.isArray(calls) || calls.length !== 1 || !Array.isArray(calls[0]) || calls[0].length !== 1 || calls[0][0]?.[0] !== 'L5adhe') return null;
    data = JSON.parse(calls[0][0][1]);
  } catch { return null; }
  const fields = data?.[2];
  if (!Array.isArray(fields) || fields.length !== 1) return null;
  const field = fields[0];
  const value = protoField(data?.[0], field);
  if ((field === 100 || field === 165) && isGeminiModelId(catalog.modelId) && value === catalog.modelId) return field;
  if (field === 265 && Number.isSafeInteger(catalog.thinkingLevel) && catalog.thinkingLevel > 0 && value === catalog.thinkingLevel) return field;
  return null;
}

function syntheticSuccess(window) {
  const row = JSON.stringify([['wrb.fr', 'L5adhe', '[1]', null, null, null, 'generic']]);
  return new window.Response(")]}'\n\n" + (row.length + 2) + '\n' + row + '\n', { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function replaceResponse(window, response, body) {
  const headers = new window.Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  const result = new window.Response(body, { status: response.status, statusText: response.statusText, headers });
  for (const name of ['url', 'redirected', 'type']) {
    try { Object.defineProperty(result, name, { configurable: true, value: response[name] }); } catch { /* Optional response metadata. */ }
  }
  return result;
}

function requestURL(window, input) {
  try {
    const url = new URL(typeof input === 'string' || input instanceof window.URL ? String(input) : input?.url, window.location.href);
    return url.origin === 'https://gemini.google.com' && RPC_PATH.test(url.pathname) ? url : null;
  } catch { return null; }
}

function requestBody(window, input, init) {
  if (typeof init?.body === 'string' || init?.body instanceof window.URLSearchParams) return Promise.resolve(String(init.body));
  if (window.Request && input instanceof window.Request) return input.clone().text();
  return Promise.resolve('');
}

export function installGeminiPreferenceInterceptor(window, { configTimeoutMs = 2000, catalogTimeoutMs = 1200 } = {}) {
  if (window.__siderGeminiPreferenceInterceptor || typeof window.fetch !== 'function') return null;
  window.__siderGeminiPreferenceInterceptor = true;
  const document = window.document;
  const originalFetch = window.fetch;
  let config, configFinished = false, interrupted = false, preferencesPrepared = false, thinkingPrepared = false;
  let catalog, catalogueFinished = false, writeTarget, autoWriteUntil = 0;
  let observer;
  let resolveConfig, resolveCatalog;
  const configReady = new Promise(resolve => { resolveConfig = resolve; });
  const catalogReady = new Promise(resolve => { resolveCatalog = resolve; });
  const timeout = window.setTimeout(() => finishConfig(null), configTimeoutMs);
  const setStatus = status => document.documentElement?.setAttribute('data-sider-gemini-defaults', status);
  function finishConfig(value) {
    if (configFinished) return;
    configFinished = true;
    observer?.disconnect();
    window.removeEventListener('message', onMessage);
    window.clearTimeout(timeout);
    resolveConfig(value);
  }
  function receive(raw) {
    if (configFinished || !raw) return;
    try { config = normalizeGeminiDefaults(raw, true); } catch { return; }
    finishConfig(config);
  }
  function readAttribute() {
    const root = document.documentElement;
    const raw = root?.getAttribute(GEMINI_CONFIG_ATTRIBUTE);
    if (!raw) return;
    root.removeAttribute(GEMINI_CONFIG_ATTRIBUTE);
    try { receive(JSON.parse(raw)); } catch { /* Invalid page-provided data is ignored. */ }
  }
  observer = new window.MutationObserver(readAttribute);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: [GEMINI_CONFIG_ATTRIBUTE] });
  function onMessage(event) {
    if (event.source === window && event.origin === window.location.origin && event.data?.type === GEMINI_CONFIG_MESSAGE) receive(event.data.settings);
  }
  window.addEventListener('message', onMessage);
  readAttribute();
  const interaction = event => {
    if (!event.isTrusted) return;
    // Opening the picker can be just a status check. A later selection in the
    // menu, or interaction elsewhere, still cancels pending automatic changes.
    const picker = event.target?.closest?.('[data-test-id="bard-mode-menu-button"]');
    if (picker) {
      if (event.type !== 'keydown' || picker.getAttribute('aria-expanded') !== 'true') return;
      interrupted = true;
      autoWriteUntil = 0;
      return;
    }
    interrupted = true;
    if (event.target?.closest?.('[data-test-id="gem-mode-menu"],[data-test-id^="bard-mode-option-"]')) autoWriteUntil = 0;
  };
  for (const type of ['pointerdown', 'keydown', 'input']) document.addEventListener(type, interaction, true);

  window.fetch = function (input, init) {
    const url = requestURL(window, input);
    if (!url || !isGeminiAppRoute(window.location.pathname)) return Reflect.apply(originalFetch, this, arguments);
    const ids = (url.searchParams.get('rpcids') || '').split(',');
    if (ids.includes('L5adhe') && writeTarget && Date.now() < autoWriteUntil) {
      const receiver = this, args = arguments;
      return (async () => {
        try {
          const body = await requestBody(window, input, init);
          if (Date.now() < autoWriteUntil && isGeminiAppRoute(window.location.pathname)
            && !input?.signal?.aborted && !init?.signal?.aborted && automaticPreferenceWrite(body, writeTarget)) return syntheticSuccess(window);
        } catch { /* Preserve the original request if its format changes. */ }
        return Reflect.apply(originalFetch, receiver, args);
      })();
    }
    if (!ids.includes('otAQ7b') && !ids.includes('ESY5D')) return Reflect.apply(originalFetch, this, arguments);
    const request = Reflect.apply(originalFetch, this, arguments);
    return (async () => {
      const response = await request;
      if (!response.ok || !isGeminiAppRoute(window.location.pathname)) return response;
      let body;
      if (ids.includes('otAQ7b')) {
        try {
          body = await response.clone().text();
          const observed = extractGeminiCatalog(readGeminiFrame(body, 'otAQ7b'));
          const publish = () => document.documentElement?.setAttribute(GEMINI_CATALOG_ATTRIBUTE, JSON.stringify(observed || { unavailable: true }));
          if (document.documentElement) publish(); else document.addEventListener('DOMContentLoaded', publish, { once: true });
        } catch { /* A changed response must not affect native page loading. */ }
      }
      const settings = await configReady;
      if (!settings || interrupted || !isGeminiAppRoute(window.location.pathname)) return response;
      try {
        if (body === undefined) body = await response.clone().text();
        if (interrupted || !isGeminiAppRoute(window.location.pathname)) return response;
        let changed = false;
        if (ids.includes('otAQ7b')) {
          const result = rewriteGeminiFrame(body, 'otAQ7b', data => patchGeminiCatalog(data, settings));
          if (!catalogueFinished) { catalogueFinished = true; catalog = result?.value || null; resolveCatalog(catalog); }
          if (!result) { if (!thinkingPrepared) setStatus('catalog-unavailable'); return response; }
          if (!catalog) catalog = result.value;
          writeTarget = catalog;
          autoWriteUntil = Date.now() + AUTO_WRITE_WINDOW_MS;
          setStatus(preferencesPrepared ? 'prepared' : thinkingPrepared ? 'thinking-prepared' : 'catalog-ready');
          body = result.body;
          changed = true;
        }
        if (ids.includes('ESY5D')) {
          if (!catalogueFinished) await Promise.race([catalogReady, new Promise(resolve => window.setTimeout(resolve, catalogTimeoutMs))]);
          // A preference response can arrive before the catalog. Apply its
          // known thinking value without guessing a model ID after the bounded
          // wait, while preserving fallback for a known unavailable catalog.
          const pendingLevel = geminiLevelNumber(settings.thinkingLevel);
          const target = catalog || (!catalogueFinished && pendingLevel !== null ? { thinkingLevel: pendingLevel } : null);
          if (target && !interrupted) {
            const result = rewriteGeminiFrame(body, 'ESY5D', data => patchGeminiPreferences(data, target));
            if (result) {
              preferencesPrepared = Boolean(target.modelId);
              thinkingPrepared = true;
              writeTarget = target;
              autoWriteUntil = Date.now() + AUTO_WRITE_WINDOW_MS;
              setStatus(preferencesPrepared ? 'prepared' : 'thinking-prepared');
              body = result.body;
              changed = true;
            } else if (!thinkingPrepared) setStatus('preferences-unavailable');
          }
        }
        return changed ? replaceResponse(window, response, body) : response;
      } catch {
        if (ids.includes('otAQ7b') && !catalogueFinished) { catalogueFinished = true; resolveCatalog(null); }
        setStatus('unavailable');
        return response;
      }
    })();
  };
  return { receive };
}
