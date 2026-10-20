import { installChatGPTSessionCookieCompat } from './chatgpt-session.js';

const EVENTS = new Set(['document-start', 'dom-ready', 'load', 'pagehide', 'error', 'rejection', 'route-import-error', 'console-error', 'startup-probe-ready', 'navigation-request', 'session-cookie-compat']);
const STATES = new Set(['loading', 'interactive', 'complete']);
const PAGES = new Set(['verification', 'editor', 'other']);
const ERRORS = new Set(['security', 'chunk-load', 'network', 'hydration', 'resource', 'storage-access', 'frame-access', 'null-property', 'reference', 'syntax', 'unsupported-api', 'initialization', 'other']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'SecurityError', 'NotAllowedError', 'InvalidStateError', 'QuotaExceededError', 'AbortError']);
const STARTUP_CONFIG = 'sider-embed-startup-config';
const STARTUP_READY = 'sider-embed-startup-ready';
const STARTUP_REPORT = 'sider-embed-startup-report';
const startupEvent = (document, type, data) => document.dispatchEvent(new document.defaultView.CustomEvent(type, { detail: JSON.stringify(data) }));

/** Accept enums and bounded numbers only; never copy webpage text or URLs. */
export function normalizeEmbedDiagnostic(value) {
  if (!value || !EVENTS.has(value.event) || typeof value.documentId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(value.documentId)) return null;
  const result = { event: value.event, documentId: value.documentId };
  for (const [key, allowed] of [['readyState', STATES], ['page', PAGES], ['error', ERRORS]]) if (allowed.has(value[key])) result[key] = value[key];
  if (['navigate', 'reload', 'back_forward', 'prerender'].includes(value.navigation)) result.navigation = value.navigation;
  if (ERROR_NAMES.has(value.errorName)) result.errorName = value.errorName;
  if (['site-module', 'challenge', 'inline', 'extension', 'unknown'].includes(value.initiator)) result.initiator = value.initiator;
  if (typeof value.metaRefresh === 'boolean') result.metaRefresh = value.metaRefresh;
  for (const key of ['epochFallback', 'accountFallback']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (typeof value.script === 'string' && /^[a-zA-Z0-9._-]{1,120}\.m?js$/.test(value.script)) result.script = value.script;
  for (const [key, max] of [['httpStatus', 599], ['heapMB', 1048576], ['elapsedMs', 86400000], ['line', 10000000], ['column', 10000000], ['scriptCount', 10000]]) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = Math.min(max, Math.round(value[key]));
  }
  return result;
}

/** Stop only a proven pre-editor reload storm; never discard an established draft. */
export function createEmbedReloadGuard() {
  let sawEditor = false;
  let documents = [];
  return {
    ready() { sawEditor = true; },
    observe(value, now) {
      if (value.page === 'editor') sawEditor = true;
      if (sawEditor || value.event !== 'document-start' || value.navigation !== 'reload' || !(value.httpStatus >= 200 && value.httpStatus < 300)) return false;
      documents = documents.filter(entry => now - entry.at < 10000);
      if (!documents.some(entry => entry.id === value.documentId)) documents.push({ id: value.documentId, at: now });
      return documents.length >= 6;
    },
  };
}

/** Observe only our direct embedded document. No polling or navigation changes. */
export function installEmbedDiagnostics({ window: view, chrome }) {
  const origin = chrome.runtime.getURL('/').replace(/\/$/, '');
  const ancestors = Array.from(view.location.ancestorOrigins || []);
  if (view.parent === view || (ancestors.length ? ancestors[0] !== origin : !view.document.referrer.startsWith(origin + '/'))) return () => {};
  const documentId = view.crypto.randomUUID();
  let reports = 0, errors = 0, disposed = false;
  const bindings = [];
  const errorKind = value => {
    const text = String(value || '');
    if (/securityerror|cross.origin|blocked a frame/i.test(text)) return 'security';
    if (/chunkload|loading chunk|dynamically imported module/i.test(text)) return 'chunk-load';
    if (/failed to fetch|networkerror|load failed/i.test(text)) return 'network';
    if (/hydration|hydrating|react error #(?:418|423|425)/i.test(text)) return 'hydration';
    return 'other';
  };
  function report(event, extra = {}) {
    if (disposed || reports >= 12) return;
    reports++;
    try {
      const document = view.document;
      const navigation = view.performance.getEntriesByType?.('navigation')?.[0];
      const verification = /just a moment|security verification|checking your browser/i.test(document.title)
        || Boolean(document.querySelector('#challenge-running,#cf-challenge-running,script[src*="/cdn-cgi/challenge-platform/"]'));
      const data = normalizeEmbedDiagnostic({ event, documentId, readyState: document.readyState,
        page: verification ? 'verification' : document.querySelector('textarea,[contenteditable="true"][role="textbox"]') ? 'editor' : 'other',
        navigation: navigation?.type, httpStatus: navigation?.responseStatus,
        scriptCount: document.scripts.length, metaRefresh: Boolean(document.querySelector('meta[http-equiv="refresh" i]')),
        heapMB: view.performance.memory?.usedJSHeapSize / 1048576, elapsedMs: view.performance.now(), ...extra });
      view.parent.postMessage({ type: 'SIDER_EMBED_DIAGNOSTIC', diagnostic: data }, origin);
    } catch { /* Diagnostics must never interfere with the website. */ }
  }
  const listen = (type, callback) => { view.addEventListener(type, callback, true); bindings.push([type, callback]); };
  const configureMain = () => { try { startupEvent(view.document, STARTUP_CONFIG, { parentOrigin: origin, documentId }); } catch {} };
  const forwardMain = event => {
    try {
      const diagnostic = normalizeEmbedDiagnostic(JSON.parse(event.detail));
      if (diagnostic?.documentId === documentId) view.parent.postMessage({ type: 'SIDER_EMBED_DIAGNOSTIC', diagnostic }, origin);
    } catch {}
  };
  view.document.addEventListener(STARTUP_READY, configureMain);
  view.document.addEventListener(STARTUP_REPORT, forwardMain);
  function dispose() {
    if (disposed) return;
    disposed = true;
    view.document.removeEventListener(STARTUP_READY, configureMain);
    view.document.removeEventListener(STARTUP_REPORT, forwardMain);
    for (const [type, callback] of bindings) view.removeEventListener(type, callback, true);
  }
  listen('DOMContentLoaded', () => report('dom-ready'));
  listen('load', event => { if (event.target === view.document) report('load'); });
  listen('pagehide', () => { report('pagehide'); dispose(); });
  listen('error', event => {
    if (errors++ >= 4) return;
    report('error', { error: event.target !== view ? 'resource' : errorKind(event.message) });
  });
  listen('unhandledrejection', event => {
    if (errors++ >= 4) return;
    let error = 'other';
    try { error = errorKind(event.reason?.name + ' ' + event.reason?.message); } catch {}
    report('rejection', { error });
  });
  report('document-start');
  configureMain();
  return dispose;
}

/** Route imports catch their own exceptions, log them, then synchronously reload. */
export function installEmbedStartupDiagnostics(view) {
  let configured = false;
  const configure = event => {
    let value;
    try { value = JSON.parse(event.detail); } catch { return; }
    if (configured || !/^chrome-extension:\/\/[a-p]{32}$/.test(value?.parentOrigin || '') || !normalizeEmbedDiagnostic({ event: 'console-error', documentId: value.documentId })) return;
    configured = true;
    view.document.removeEventListener(STARTUP_CONFIG, configure);
    const original = view.console.error;
    const restoreCookies = installChatGPTSessionCookieCompat(view.document, flags => {
      try { startupEvent(view.document, STARTUP_REPORT, normalizeEmbedDiagnostic({ event: 'session-cookie-compat', documentId: value.documentId, ...flags })); } catch {}
    });
    view.addEventListener('pagehide', restoreCookies, { once: true });
    let count = 0;
    function capture(args) {
      if (count++ >= 4) return;
      try {
        const error = args.find(value => value && typeof value === 'object' && typeof value.message === 'string');
        const message = error?.message || (typeof args[0] === 'string' ? args[0] : '');
        const route = /^Error loading route module/.test(message);
        const source = (route ? message : error?.stack || '').match(/\/cdn\/assets\/(?:async\/)?([a-zA-Z0-9._-]+\.m?js)(?::(\d+):(\d+))?/);
        let kind = 'other';
        if (/(?:localStorage|sessionStorage|indexedDB|Storage|cookie).*(?:denied|access|blocked)|(?:denied|access|blocked).*(?:localStorage|sessionStorage|indexedDB|Storage|cookie)/i.test(message)) kind = 'storage-access';
        else if (/cross.origin|blocked a frame|Permission denied to access property/i.test(message)) kind = 'frame-access';
        else if (/dynamically imported module|Loading (?:CSS )?chunk|Importing a module script failed/i.test(message)) kind = 'chunk-load';
        else if (/Cannot (?:read|set) properties of (?:undefined|null)/i.test(message)) kind = 'null-property';
        else if (/not defined/i.test(message)) kind = 'reference';
        else if (/unexpected token|syntaxerror/i.test(message)) kind = 'syntax';
        else if (/not supported|unsupported/i.test(message)) kind = 'unsupported-api';
        else if (/before initialization/i.test(message)) kind = 'initialization';
        const diagnostic = normalizeEmbedDiagnostic({ event: route ? 'route-import-error' : 'console-error', documentId: value.documentId,
          error: kind, errorName: error?.name, script: source?.[1], line: source?.[2] ? Number(source[2]) : undefined, column: source?.[3] ? Number(source[3]) : undefined });
        startupEvent(view.document, STARTUP_REPORT, diagnostic);
      } catch { /* Keep the original console call and the website's control flow. */ }
    }
    function wrapped(...args) { capture(args); return Reflect.apply(original, this, args); }
    try { view.console.error = wrapped; } catch { return; }
    const send = diagnostic => {
      try { startupEvent(view.document, STARTUP_REPORT, normalizeEmbedDiagnostic({ documentId: value.documentId, ...diagnostic })); } catch {}
    };
    let navigations = 0;
    const navigating = event => {
      if (navigations++ >= 4 || event.destination?.sameDocument) return;
      const stack = new view.Error().stack || '';
      const source = stack.match(/\/cdn\/assets\/(?:async\/)?([a-zA-Z0-9._-]+\.m?js):(\d+):(\d+)/);
      const inline = stack.match(/https:\/\/chatgpt\.com\/[^\s)\n]*?:(\d+):(\d+)/);
      send({ event: 'navigation-request', navigation: event.navigationType, initiator: source ? 'site-module' : /\/cdn-cgi\//.test(stack) ? 'challenge' : inline ? 'inline' : 'unknown',
        script: source?.[1], line: Number(source?.[2] || inline?.[1]) || undefined, column: Number(source?.[3] || inline?.[2]) || undefined,
        elapsedMs: view.performance?.now(), heapMB: view.performance?.memory?.usedJSHeapSize / 1048576 });
    };
    view.navigation?.addEventListener('navigate', navigating);
    send({ event: 'startup-probe-ready' });
    view.addEventListener('pagehide', () => {
      if (view.console.error === wrapped) view.console.error = original;
      view.navigation?.removeEventListener('navigate', navigating);
    }, { once: true });
  };
  view.document.addEventListener(STARTUP_CONFIG, configure);
  try { startupEvent(view.document, STARTUP_READY, {}); } catch {}
}
