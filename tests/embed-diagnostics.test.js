import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEmbedReloadGuard, installEmbedDiagnostics, installEmbedStartupDiagnostics, normalizeEmbedDiagnostic } from '../src/embed-diagnostics.js';

const origin = 'chrome-extension://diagnostic-test';
const documentId = '00000000-0000-4000-8000-000000000001';
function fixture(t, { ancestors = [origin], topLevel = false, referrer = '' } = {}) {
  const dom = new JSDOM('<title>Private conversation title</title><textarea>Private draft</textarea>', { url: 'https://chatgpt.com/c/private-id?token=secret' });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.document, 'referrer', { value: referrer });
  const messages = [], listeners = new Map();
  const view = { document: dom.window.document, location: { ancestorOrigins: ancestors },
    crypto: { randomUUID: () => documentId }, performance: { now: () => 123.4, memory: { usedJSHeapSize: 2 * 1048576 }, getEntriesByType: () => [{ type: 'reload', responseStatus: 403 }] },
    parent: { postMessage(data, target) { messages.push({ data, target }); } },
    addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type) { listeners.delete(type); } };
  if (topLevel) view.parent = view;
  const dispose = installEmbedDiagnostics({ window: view, chrome: { runtime: { getURL: () => origin + '/' } } });
  return { view, messages, listeners, dispose, emit(type, event = {}) { listeners.get(type)?.({ target: type === 'load' ? view.document : view, ...event }); } };
}

test('embed diagnostics reject top-level, foreign and nested frames', t => {
  for (const options of [{ topLevel: true }, { ancestors: ['https://chatgpt.com', origin] }, { ancestors: ['chrome-extension://another-extension'] }, { ancestors: [], referrer: origin + '.evil/panel.html' }]) {
    const f = fixture(t, options);
    assert.equal(f.messages.length, 0); assert.equal(f.listeners.size, 0);
  }
  const fallback = fixture(t, { ancestors: [], referrer: origin + '/panel.html' });
  assert.equal(fallback.messages.length, 1);
});

test('document lifecycle reports HTTP, reload and verification state without webpage content', t => {
  const f = fixture(t);
  assert.equal(f.messages[0].target, origin);
  assert.deepEqual(f.messages[0].data.diagnostic, { event: 'document-start', documentId, readyState: 'loading', page: 'editor', navigation: 'reload', httpStatus: 403, scriptCount: 0, metaRefresh: false, heapMB: 2, elapsedMs: 123 });
  f.view.document.title = 'Just a moment...'; f.emit('DOMContentLoaded'); f.emit('load');
  assert.equal(f.messages.at(-1).data.diagnostic.page, 'verification');
  const output = JSON.stringify(f.messages);
  for (const secret of ['Private draft', 'Private conversation title', 'private-id', 'token', 'secret', 'Just a moment']) assert.ok(!output.includes(secret));
  f.emit('pagehide'); assert.equal(f.messages.at(-1).data.diagnostic.event, 'pagehide');
  assert.equal(f.listeners.size, 0); f.emit('error'); assert.equal(f.messages.length, 4);
});

test('resource load events do not consume the document lifecycle report budget', t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.emit('load', { target: f.view.document.createElement('script') });
  assert.equal(f.messages.length, 1);
  f.emit('load'); assert.equal(f.messages.at(-1).data.diagnostic.event, 'load');
});

test('script errors are classified and bounded, without retaining messages or rejection data', t => {
  const f = fixture(t);
  f.emit('error', { message: 'SecurityError: private token=secret' });
  f.emit('unhandledrejection', { reason: new Error('Failed to fetch https://example.com/?secret=token') });
  f.emit('error', { message: 'Loading chunk private-path failed' });
  f.emit('error', { message: 'Hydration failed with Private draft' });
  for (let i = 0; i < 100; i++) f.emit('error', { message: 'Private draft' });
  assert.deepEqual(f.messages.slice(1).map(message => message.data.diagnostic.error), ['security', 'network', 'chunk-load', 'hydration']);
  assert.doesNotMatch(JSON.stringify(f.messages), /private|secret|token|https:\/\//i);
  f.emit('pagehide'); assert.equal(f.messages.at(-1).data.diagnostic.event, 'pagehide');
});

test('parent normalization drops raw fields and rejects invalid document identities', () => {
  const safe = normalizeEmbedDiagnostic({ event: 'error', documentId, error: 'network', message: 'secret', url: 'https://private.example', httpStatus: Infinity, heapMB: -1, elapsedMs: 1e20, page: 'private title' });
  assert.deepEqual(safe, { event: 'error', documentId, error: 'network', elapsedMs: 86400000 });
  assert.equal(normalizeEmbedDiagnostic({ event: 'reload-me', documentId }), null);
  assert.equal(normalizeEmbedDiagnostic({ event: 'load', documentId: 'https://private.example' }), null);
});

function startupFixture(t) {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' });
  t.after(() => dom.window.close());
  const view = dom.window, reports = [], calls = [];
  const console = { error(...args) { calls.push({ receiver: this, args }); return 42; } };
  view.console = console;
  view.document.addEventListener('sider-embed-startup-report', event => reports.push(JSON.parse(event.detail)));
  installEmbedStartupDiagnostics(view);
  const configure = value => view.document.dispatchEvent(new view.CustomEvent('sider-embed-startup-config', { detail: JSON.stringify(value) }));
  return { view, console, reports, calls, configure, config: { parentOrigin: 'chrome-extension://' + 'a'.repeat(32), documentId } };
}

test('MAIN startup diagnostics wait for the sidebar probe and preserve console behavior', t => {
  const f = startupFixture(t), original = f.console.error;
  f.configure({ ...f.config, parentOrigin: 'https://foreign.example' }); assert.equal(f.console.error, original);
  f.configure(f.config); assert.notEqual(f.console.error, original);
  assert.equal(f.reports[0].event, 'startup-probe-ready');
  assert.equal(f.console.error('Error loading route module `/cdn/assets/123.abc.js`, reloading page...'), 42);
  const error = new TypeError("Cannot read properties of undefined (reading 'private-token')");
  error.stack = 'TypeError: private message\n at bootstrap (https://chatgpt.com/cdn/assets/async/456.def.js:1:1234)';
  assert.equal(f.console.error(error), 42);
  assert.equal(f.calls[0].receiver, f.console); assert.equal(f.calls[1].args[0], error);
  assert.deepEqual(f.reports.slice(1), [
    { event: 'route-import-error', documentId, error: 'other', script: '123.abc.js' },
    { event: 'console-error', documentId, error: 'null-property', errorName: 'TypeError', script: '456.def.js', line: 1, column: 1234 },
  ]);
  assert.doesNotMatch(JSON.stringify(f.reports), /private|token|message|https:\/\//);
  for (let i = 0; i < 20; i++) f.console.error('private message');
  assert.equal(f.reports.length, 5); assert.equal(f.calls.length, 22);
  f.view.dispatchEvent(new f.view.Event('pagehide')); assert.equal(f.console.error, original);
});

test('startup diagnostics identify denied storage without exporting the exception text', t => {
  const f = startupFixture(t); f.configure(f.config);
  f.console.error({ name: 'SecurityError', message: "Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document. private" });
  assert.equal(f.reports[1].error, 'storage-access'); assert.equal(f.reports[1].errorName, 'SecurityError');
  assert.doesNotMatch(JSON.stringify(f.reports), /private|sessionStorage/);
});

test('navigation diagnostics report a public initiating module without cancelling the navigation', t => {
  const f = startupFixture(t), callbacks = new Map();
  f.view.navigation = { addEventListener(type, callback) { callbacks.set(type, callback); }, removeEventListener(type) { callbacks.delete(type); } };
  f.view.Error = class extends Error { constructor() { super(); this.stack = 'Error\n at reload (https://chatgpt.com/cdn/assets/123.abc.js:1:456)'; } };
  f.configure(f.config);
  const event = { navigationType: 'reload', destination: { sameDocument: false }, preventDefault() { assert.fail('diagnostics cannot cancel navigation'); } };
  callbacks.get('navigate')(event);
  assert.equal(f.reports[1].event, 'navigation-request'); assert.equal(f.reports[1].navigation, 'reload');
  assert.equal(f.reports[1].initiator, 'site-module'); assert.equal(f.reports[1].script, '123.abc.js');
  assert.equal(f.reports[1].column, 456);
  f.view.dispatchEvent(new f.view.Event('pagehide')); assert.equal(callbacks.size, 0);
});

test('reload guard requires six distinct successful reloads in ten seconds before an editor', () => {
  const guard = createEmbedReloadGuard();
  const value = { event: 'document-start', page: 'other', navigation: 'reload', httpStatus: 200, documentId };
  for (let i = 0; i < 20; i++) assert.equal(guard.observe(value, i * 10), false, 'duplicate reports are one document');
  for (let i = 1; i < 5; i++) assert.equal(guard.observe({ ...value, documentId: documentId + i }, i * 400), false);
  assert.equal(guard.observe({ ...value, documentId: documentId + 5 }, 2000), true);
  const slow = createEmbedReloadGuard();
  for (let i = 0; i < 10; i++) assert.equal(slow.observe({ ...value, documentId: documentId + i }, i * 3000), false);
  const unknown = createEmbedReloadGuard();
  for (let i = 0; i < 10; i++) assert.equal(unknown.observe({ ...value, httpStatus: undefined, documentId: documentId + i }, i * 400), false);
});

test('reload guard preserves an established editor or confirmed enhancement', () => {
  for (const initialize of [guard => guard.ready(), guard => guard.observe({ event: 'dom-ready', page: 'editor' }, 0)]) {
    const guard = createEmbedReloadGuard(); initialize(guard);
    for (let i = 0; i < 10; i++) assert.equal(guard.observe({ event: 'document-start', page: 'other', navigation: 'reload', httpStatus: 200, documentId: documentId + i }, i * 400), false);
  }
});

