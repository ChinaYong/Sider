import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { AI_WEB_SETTINGS_KEY, BUILTIN_AI_SITES, normalizeAIWebSettings } from '../src/ai-web.js';

let instance = 0;
const settle = () => new Promise(resolve => setImmediate(resolve));

test('global AI selection loads Gemini and a different website cannot perform its handshake', async t => {
  const f = await fixture(t, { aiSettings: { activeSiteId: 'gemini', customSites: [] } });
  assert.equal(f.calls[0].message.siteId, 'gemini');
  await f.resolve(0, { ok: true, compatibility: true, site: BUILTIN_AI_SITES[1] });
  assert.equal(new URL(f.document.querySelector('iframe').src).origin, 'https://gemini.google.com');
  const port = responsePort(); requestHandshake(f, port); assert.equal(port.messages.length, 0);
  requestHandshake(f, port, { origin: 'https://gemini.google.com' });
  assert.equal(port.messages[0].site.id, 'gemini');
});

test('global website changes keep a live frame and draft until the user reloads', async t => {
  const f = await fixture(t); await f.resolve(0, { ok: true, compatibility: true });
  const before = f.document.querySelector('iframe').src;
  f.updateAI({ activeSiteId: 'claude', customSites: [] });
  assert.equal(f.document.querySelector('iframe').src, before);
  assert.equal(f.document.querySelector('#ai-settings-updated').hidden, false);
  f.document.querySelector('#ai-settings-updated').click(); await settle();
  const call = f.calls.findIndex((entry, index) => index > 0 && entry.message.type === 'SIDER_EMBED_REGISTER');
  assert.equal(f.calls[call].message.siteId, 'claude');
  await f.resolve(call, { ok: true, compatibility: true, site: BUILTIN_AI_SITES[2] });
  assert.equal(new URL(f.document.querySelector('iframe').src).origin, 'https://claude.ai');
  assert.equal(f.document.querySelector('#ai-settings-updated').hidden, true);
});

test('a failed switch keeps the previous frame origin and bridge greeting usable', async t => {
  const f = await fixture(t); await f.resolve(0, { ok: true, compatibility: true });
  const before = f.document.querySelector('iframe').src;
  f.updateAI({ activeSiteId: 'claude', customSites: [] }); f.document.querySelector('#reload-chatgpt').click(); await settle();
  const index = f.calls.findIndex((entry, index) => index > 0 && entry.message.type === 'SIDER_EMBED_REGISTER');
  await f.resolve(index, { ok: false, error: 'Permission denied' });
  assert.equal(f.document.querySelector('iframe').src, before);
  const port = responsePort(); requestHandshake(f, port); assert.equal(port.messages[0].site.id, 'chatgpt');
});

test('website settings remain available after an embedding failure and denied permission keeps edits', async t => {
  const f = await fixture(t, { permissionsGranted: false });
  await f.resolve(0, { ok: false, error: 'Frame blocked' });
  f.document.querySelector('#ai-settings-toggle').click(); await settle();
  await f.resolve(f.calls.length - 1, { ok: true, settings: normalizeAIWebSettings() });
  const select = f.document.querySelector('#ai-active-site'); select.value = 'gemini'; select.dispatchEvent(new f.window.Event('change'));
  f.document.querySelector('#ai-save-settings').click(); await settle();
  assert.deepEqual(f.permissions.at(-1), { origins: ['https://gemini.google.com/*'] });
  assert.equal(f.document.querySelector('#ai-settings-dialog').open, true);
  assert.equal(select.value, 'gemini'); assert.match(f.document.querySelector('#ai-settings-error').textContent, /未授予/);
  assert.equal(f.calls.some(entry => entry.message.type === 'SIDER_AI_WEB_SETTINGS_SAVE'), false);
});

test('custom website advanced settings validate and remain intact when saving fails', async t => {
  const f = await fixture(t); await f.resolve(0, { ok: true, compatibility: true });
  f.document.querySelector('#ai-settings-toggle').click(); await settle();
  await f.resolve(f.calls.length - 1, { ok: true, settings: normalizeAIWebSettings() });
  f.document.querySelector('#ai-add-site').click();
  f.document.querySelector('#ai-site-name').value = 'My AI'; f.document.querySelector('#ai-site-url').value = 'https://my-ai.test/chat';
  f.document.querySelector('#ai-selector-composer').value = '[';
  f.document.querySelector('#ai-apply-site').click(); assert.match(f.document.querySelector('#ai-settings-error').textContent, /选择器无效/);
  f.document.querySelector('#ai-selector-composer').value = '#question'; f.document.querySelector('#ai-send-shortcut').value = 'ctrl-enter';
  f.document.querySelector('#ai-apply-site').click(); f.document.querySelector('#ai-save-settings').click(); await settle();
  const index = f.calls.length - 1; assert.equal(f.calls[index].message.type, 'SIDER_AI_WEB_SETTINGS_SAVE');
  assert.equal(f.calls[index].message.settings.customSites[0].selectors.composer, '#question');
  assert.equal(f.calls[index].message.settings.customSites[0].sendShortcut, 'ctrl-enter');
  await f.resolve(index, { ok: false, error: 'Storage failed' });
  assert.equal(f.document.querySelector('#ai-settings-dialog').open, true);
  assert.match(f.document.querySelector('#ai-settings-error').textContent, /Storage failed/);
  f.document.querySelector('#ai-edit-site').click(); assert.equal(f.document.querySelector('#ai-site-name').value, 'My AI');
});

async function fixture(t, { extension = true, sourceTab = '13', permissionsGranted = true, connectError = '', aiSettings } = {}) {
  const html = await readFile(new URL('../src/panel.html', import.meta.url), 'utf8');
  const { window } = new JSDOM(html, { url: `https://panel.test/${sourceTab === null ? '' : '?sourceTab=' + sourceTab}` });
  const names = ['window','document','chrome','setTimeout','clearTimeout','setInterval','clearInterval'];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = []; const ports = []; const permissions = []; const timers = new Map(); let sequence = 0;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const frameMessages = [];
  let storedAI = normalizeAIWebSettings(aiSettings);
  const storageListeners = new Set();
  const frame = window.document.querySelector('iframe');
  // Model the stable WindowProxy across iframe navigations. Any DOMWindow
  // message would reproduce the startup about:blank origin mismatch.
  const frameWindow = { postMessage(...args) { frameMessages.push(args); } };
  Object.defineProperty(frame, 'contentWindow', { value: frameWindow, configurable: true });
  const chrome = {
    runtime: {
      id: 'panel-test',
      sendMessage(message) { return new Promise(resolve => calls.push({ message, resolve })); },
      connect({ name }) { if (connectError) throw new Error(connectError); const listeners = []; const messages = []; const receivers = []; const port = { name, messages, postMessage(message) { messages.push(message); }, onMessage: { addListener(fn) { receivers.push(fn); } }, receive(message) { for (const fn of receivers) fn(message); }, onDisconnect: { addListener(fn) { listeners.push(fn); } }, disconnect() { for(const fn of listeners) fn(); } }; ports.push(port); return port; },
    },
    windows: { async getCurrent() { return { id: 7 }; } },
    tabs: { async get(id) { return { id, windowId: 7 }; } },
    permissions: { async request(details) { permissions.push(details); return permissionsGranted; } },
    storage: { local: { async get(key) { return { [key]: structuredClone(storedAI) }; } }, onChanged: { addListener(fn) { storageListeners.add(fn); }, removeListener(fn) { storageListeners.delete(fn); } } },
  };
  Object.assign(globalThis, { window, document: window.document });
  if (extension) globalThis.chrome = chrome; else delete globalThis.chrome;
  globalThis.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.setInterval = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay, interval: true }); return id; };
  globalThis.clearInterval = id => timers.delete(id);
  window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function() { this.open = false; };
  t.after(() => {
    window.dispatchEvent(new window.Event('pagehide'));
    window.close();
    Date.now = originalNow;
    for (const name of names) if (original.get(name)) Object.defineProperty(globalThis, name, original.get(name)); else delete globalThis[name];
  });
  await import(`../src/panel.js?instance=${++instance}`);
  await settle();
  return { window, document: window.document, calls, ports, permissions, timers, frameMessages,
    advanceTime(milliseconds) { now += milliseconds; },
    setPermissionGranted(value) { permissionsGranted = value; },
    updateAI(settings) { storedAI = normalizeAIWebSettings(settings); for (const listener of storageListeners) listener({ [AI_WEB_SETTINGS_KEY]: { newValue: structuredClone(storedAI) } }, 'local'); },
    async resolve(index, result) { calls[index].resolve(result); await settle(); },
    async tick(delay) { const [id, timer] = [...timers].find(([,entry]) => entry.delay === delay) || []; if(timer) { timers.delete(id); void timer.fn(); await settle(); } },
  };
}

function responsePort() {
  return {
    messages: [], closed: 0,
    postMessage(message) { this.messages.push(message); },
    close() { this.closed++; },
  };
}

function requestHandshake(f, port, overrides = {}) {
  f.window.dispatchEvent(new f.window.MessageEvent('message', {
    origin: 'https://chatgpt.com',
    source: f.document.querySelector('iframe').contentWindow,
    data: { type: 'SIDER_EMBED_HELLO_REQUEST' },
    ports: port ? [port] : [],
    ...overrides,
  }));
}

test('opens original ChatGPT automatically only after the compatibility rule is accepted', async t => {
  const f = await fixture(t); const frame = f.document.querySelector('iframe');
  assert.equal(f.calls[0].message.type, 'SIDER_EMBED_REGISTER');
  assert.equal(f.calls[0].message.windowId, 7);
  assert.equal(f.calls[0].message.tabId, 13);
  assert.equal(frame.hasAttribute('src'), false);
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  assert.equal(f.document.querySelector('#enable-embed'), null);
  assert.equal(f.document.querySelector('#prompt-input'), null);
  await f.resolve(0, { ok: true, compatibility: true });
  assert.equal(new URL(frame.src).hostname, 'chatgpt.com');
  assert.equal(new URL(frame.src).searchParams.get('sider_bridge'), f.calls[0].message.bridgeId);
  assert.equal(frame.hidden, false);
  assert.equal(f.document.querySelector('#loading-screen').hidden, true, 'pending load and bridge must not mask first paint');
  assert.equal(f.document.querySelector('#connection-status').className, '');
  assert.equal(f.calls[1].message.type, 'SIDER_EMBED_STATUS_GET');
  assert.equal(f.ports[0].name, 'sider-panel-lifecycle');
});

test('source access requests work before the browser exposes the URL and are bound to the owning tab', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  const frame = f.document.querySelector('iframe');
  const request = { type: 'SIDER_SOURCE_ACCESS_REQUEST', bridgeId: f.calls[0].message.bridgeId, tabId: 999, windowId: 999 };
  f.window.dispatchEvent(new f.window.MessageEvent('message', { origin: 'https://evil.test', source: frame.contentWindow, data: request }));
  await settle(); assert.equal(f.calls.length, 2);
  f.window.dispatchEvent(new f.window.MessageEvent('message', { origin: 'https://chatgpt.com', source: frame.contentWindow, data: request }));
  await settle();
  assert.deepEqual(f.calls.at(-1).message, { type: 'SIDER_SOURCE_INFO', tabId: 13 });
  await f.resolve(f.calls.length - 1, { ok: true, source: { tabId: 13, title: '当前网页', url: null, needsAccess: true } });
  assert.equal(f.document.querySelector('#site-dialog').open, true);
  f.document.querySelector('#grant-site').click(); await settle();
  assert.deepEqual(f.calls.at(-1).message, { type: 'SIDER_SOURCE_ACCESS_REQUEST', tabId: 13 });
  await f.resolve(f.calls.length - 1, { ok: true, requested: true });
  assert.equal(f.document.querySelector('#site-dialog').open, false);
  assert.match(f.document.querySelector('#toast').textContent, /浏览器.*权限提示/);
  assert.equal(f.permissions.length, 0); // No broad or guessed-origin permission request.
});

test('allowing capture on a known site requests only that origin and does not enable floating selection', async t => {
  const f = await fixture(t); await f.resolve(0, { ok: true, compatibility: true });
  const frame = f.document.querySelector('iframe');
  f.window.dispatchEvent(new f.window.MessageEvent('message', { origin: 'https://chatgpt.com', source: frame.contentWindow, data: { type: 'SIDER_SOURCE_ACCESS_REQUEST', bridgeId: f.calls[0].message.bridgeId } }));
  await settle();
  await f.resolve(f.calls.length - 1, { ok: true, source: { tabId: 13, url: 'https://article.example/story' } });
  f.document.querySelector('#grant-site').click(); await settle();
  assert.deepEqual(f.permissions, [{ origins: ['https://article.example/*'] }]);
  assert.equal(f.calls.some(call => call.message.type === 'SIDER_ENABLE_SITE'), false);
  assert.match(f.document.querySelector('#toast').textContent, /已允许引用/);
});

test('denied site access remains actionable inside its dialog and can be retried', async t => {
  const f = await fixture(t, { permissionsGranted: false });
  await f.resolve(0, { ok: true, compatibility: true });
  const frame = f.document.querySelector('iframe');
  f.window.dispatchEvent(new f.window.MessageEvent('message', { origin: 'https://chatgpt.com', source: frame.contentWindow, data: { type: 'SIDER_SOURCE_ACCESS_REQUEST', bridgeId: f.calls[0].message.bridgeId } }));
  await settle();
  await f.resolve(f.calls.length - 1, { ok: true, source: { tabId: 13, url: 'https://article.example/story' } });
  const grant = f.document.querySelector('#grant-site');
  grant.click(); await settle();
  const inlineStatus = f.document.querySelector('#site-status');
  assert.equal(f.document.querySelector('#site-dialog').open, true);
  assert.equal(inlineStatus.hidden, false);
  assert.match(inlineStatus.textContent, /权限未授予/);
  assert.equal(grant.disabled, false);
  assert.equal(f.document.querySelector('#toast').hidden, true);

  f.setPermissionGranted(true);
  grant.click(); await settle();
  assert.equal(f.permissions.length, 2);
  assert.equal(f.document.querySelector('#site-dialog').open, false);
  assert.equal(inlineStatus.hidden, true);
  assert.equal(inlineStatus.textContent, '');
  assert.equal(grant.disabled, false);
});

test('late webpage enhancements recover after a non-blocking timeout warning', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  f.advanceTime(36000);
  await f.resolve(1, { ok: true, compatibility: true, connected: true, enhancementReady: false });
  const status = f.document.querySelector('#connection-status');
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  assert.equal(f.document.querySelector('iframe').hidden, false);
  assert.equal(status.className, 'warning');
  assert.match(status.textContent, /网页引用未就绪/);
  assert.match(status.title, /重新连接.*原站入口/);
  assert.match(f.document.querySelector('#diagnostics-text').textContent, /warning:.*重新连接/);
  assert.equal(f.document.querySelector('#toast').hidden, true);
  assert.ok([...f.timers.values()].some(timer => timer.delay === 5000));

  f.advanceTime(5000);
  await f.tick(5000);
  await f.resolve(f.calls.length - 1, { ok: true, compatibility: true, connected: true, enhancementReady: true });
  assert.equal(status.className, 'connected');
  assert.match(status.textContent, /网页引用已就绪/);
  assert.doesNotMatch(f.document.querySelector('#diagnostics-text').textContent, /warning:/);
  assert.ok(![...f.timers.values()].some(timer => timer.delay === 5000));
});

test('an unavailable enhancement stops checking after two minutes while ChatGPT remains visible', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  f.advanceTime(36000);
  await f.resolve(1, { ok: true, compatibility: true, connected: true, enhancementReady: false });
  f.advanceTime(85000);
  await f.tick(5000);
  await f.resolve(f.calls.length - 1, { ok: true, compatibility: true, connected: true, enhancementReady: false });
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  assert.equal(f.document.querySelector('#connection-status').className, 'warning');
  assert.ok(![...f.timers.values()].some(timer => [700, 5000].includes(timer.delay)));
});

test('a temporary enhancement connection error does not cover a connected ChatGPT page', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  await f.resolve(1, { ok: true, compatibility: true, connected: true, enhancementReady: false });
  await f.tick(700);
  await f.resolve(f.calls.length - 1, { ok: false, error: '后台暂时失联' });
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  assert.equal(f.document.querySelector('#connection-status').className, 'warning');
  assert.match(f.document.querySelector('#diagnostics-text').textContent, /后台暂时失联/);
  assert.ok([...f.timers.values()].some(timer => timer.delay === 5000));
});

test('a lifecycle reconnection error retains an already connected ChatGPT page', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  await f.resolve(1, { ok: true, compatibility: true, connected: true, enhancementReady: true });
  f.ports[0].disconnect();
  await f.tick(500);
  await f.resolve(f.calls.length - 1, { ok: false, error: '无法恢复后台连接' });
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  assert.equal(f.document.querySelector('#connection-status').className, 'warning');
  assert.match(f.document.querySelector('#diagnostics-text').textContent, /无法恢复后台连接/);
  assert.match(f.document.querySelector('#diagnostics-text').textContent, /enhancementReady: false/);
});

test('an owning lifecycle report updates failures and recovery after the initial ready poll has ended', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  await f.resolve(1, { ok: true, compatibility: true, connected: true, enhancementReady: true });
  const before = f.calls.length;
  const bridgeId = f.calls[0].message.bridgeId;
  f.ports[0].receive({ type: 'SIDER_ENHANCEMENT_READY', bridgeId: 'another-panel-bridge' });
  await settle(); assert.equal(f.calls.length, before);
  f.ports[0].receive({ type: 'SIDER_ENHANCEMENT_READY', bridgeId, ready: true, detail: 'obsolete payload' });
  await settle(); assert.equal(f.calls.at(-1).message.type, 'SIDER_EMBED_STATUS_GET');
  await f.resolve(f.calls.length - 1, { ok: true, compatibility: true, connected: true, enhancementReady: false, enhancementDetail: '实时连接失败，原站提示已保留。' });
  assert.match(f.document.querySelector('#connection-status').textContent, /网页引用未就绪/);
  assert.match(f.document.querySelector('#diagnostics-text').textContent, /实时连接失败/);
  assert.doesNotMatch(f.document.querySelector('#diagnostics-text').textContent, /可继续使用/);
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  f.ports[0].receive({ type: 'SIDER_ENHANCEMENT_READY', bridgeId, ready: false });
  await settle(); await f.resolve(f.calls.length - 1, { ok: true, compatibility: true, connected: true, enhancementReady: true });
  assert.match(f.document.querySelector('#connection-status').textContent, /网页引用已就绪/);
  assert.doesNotMatch(f.document.querySelector('#diagnostics-text').textContent, /实时连接失败/);
});

test('a newer lifecycle report supersedes pending status reads and a disconnected port cannot update the panel', async t => {
  const f = await fixture(t); await f.resolve(0, { ok: true, compatibility: true });
  const report = { type: 'SIDER_ENHANCEMENT_READY', bridgeId: f.calls[0].message.bridgeId };
  f.ports[0].receive(report); await settle();
  await f.resolve(1, { ok: true, compatibility: true, connected: true, enhancementReady: true });
  assert.doesNotMatch(f.document.querySelector('#connection-status').textContent, /已就绪/);
  await f.resolve(f.calls.length - 1, { ok: true, compatibility: true, connected: true, enhancementReady: false, enhancementDetail: '发送控件缺失。' });
  assert.match(f.document.querySelector('#diagnostics-text').textContent, /发送控件缺失/);
  f.ports[0].disconnect(); const before = f.calls.length;
  f.ports[0].receive(report); await settle(); assert.equal(f.calls.length, before);
});

test('a frame load alone cannot report a working ChatGPT connection', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  f.document.querySelector('iframe').dispatchEvent(new f.window.Event('load'));
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  assert.equal(f.document.querySelector('iframe').hidden, false);
  assert.notEqual(f.document.querySelector('#connection-status').className, 'connected');
  await f.resolve(1, { ok: true, compatibility: true, connected: false, enhancementReady: false });
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  assert.notEqual(f.document.querySelector('#connection-status').className, 'connected');
  await f.tick(700);
  await f.resolve(2, { ok: true, compatibility: true, connected: true, enhancementReady: true });
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  assert.match(f.document.querySelector('#connection-status').textContent, /引用已就绪/);
});

test('permission and rule errors are visible and never silently load a blocked frame', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: false, error: '浏览器不支持内嵌规则。' });
  assert.equal(f.document.querySelector('iframe').hasAttribute('src'), false);
  assert.equal(f.document.querySelector('#recovery-actions').hidden, false);
  assert.match(f.document.querySelector('#loading-detail').textContent, /不支持/);
  f.document.querySelector('#retry-embed').click();
  await settle();
  assert.equal(f.calls[1].message.type, 'SIDER_EMBED_REGISTER');
});

test('an obsolete poll result cannot overwrite a newer retry', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  f.document.querySelector('#reload-chatgpt').click(); await settle();
  await f.resolve(1, { ok: true, connected: true, enhancementReady: true });
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  assert.notEqual(f.document.querySelector('#connection-status').className, 'connected');
  await f.resolve(2, { ok: false, error: '重试失败' });
  assert.match(f.document.querySelector('#loading-detail').textContent, /重试失败/);
  assert.equal(f.document.querySelector('#loading-screen').hasAttribute('data-inline'), true);
  assert.equal(f.document.querySelector('iframe').hidden, false);
});

test('a missing bridge shows compact recovery without covering a started ChatGPT page and clears on connection', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  const frame = f.document.querySelector('iframe'); const recovery = f.document.querySelector('#loading-screen');
  f.advanceTime(36000);
  await f.resolve(1, { ok: true, compatibility: true, connected: false, enhancementReady: false });
  assert.equal(frame.hidden, false); assert.equal(new URL(frame.src).hostname, 'chatgpt.com');
  assert.equal(recovery.hidden, false); assert.equal(recovery.hasAttribute('data-inline'), true);
  assert.equal(f.document.querySelector('#recovery-actions').hidden, false);
  assert.match(f.document.querySelector('#loading-title').textContent, /尚未确认/);
  assert.match(f.document.querySelector('#diagnostics-text').textContent, /error:/);
  frame.dispatchEvent(new f.window.Event('load'));
  await f.resolve(f.calls.length - 1, { ok: true, compatibility: true, connected: true, enhancementReady: true });
  assert.equal(recovery.hidden, true); assert.equal(recovery.hasAttribute('data-inline'), false);
  assert.doesNotMatch(f.document.querySelector('#diagnostics-text').textContent, /error:/);
});

test('retry keeps the old ChatGPT frame visible while registration is pending or fails', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  await f.resolve(1, { ok: true, compatibility: true, connected: true, enhancementReady: true });
  const frame = f.document.querySelector('iframe'); const previousURL = frame.src;
  f.document.querySelector('#reload-chatgpt').click(); await settle();
  assert.equal(frame.src, previousURL); assert.equal(frame.hidden, false);
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
  await f.resolve(f.calls.length - 1, { ok: false, error: '暂时无法准备连接' });
  assert.equal(frame.src, previousURL); assert.equal(frame.hidden, false);
  assert.equal(f.document.querySelector('#loading-screen').hasAttribute('data-inline'), true);
  assert.match(f.document.querySelector('#loading-detail').textContent, /无法准备/);
});

test('a lifecycle startup error cannot put a full-screen mask back over first paint', async t => {
  const f = await fixture(t, { connectError: '后台连接端口暂时不可用' });
  await f.resolve(0, { ok: true, compatibility: true });
  assert.equal(new URL(f.document.querySelector('iframe').src).hostname, 'chatgpt.com');
  assert.equal(f.document.querySelector('iframe').hidden, false);
  assert.equal(f.document.querySelector('#loading-screen').hasAttribute('data-inline'), true);
  assert.match(f.document.querySelector('#loading-detail').textContent, /连接端口/);
  await f.resolve(1, { ok: true, compatibility: true, connected: true, enhancementReady: true });
  assert.equal(f.document.querySelector('#loading-screen').hidden, true);
});

test('localhost preview clearly requires installation and does not fake ChatGPT', async t => {
  const f = await fixture(t, { extension: false });
  assert.equal(f.calls.length, 0);
  assert.equal(f.document.querySelector('iframe').hasAttribute('src'), false);
  assert.match(f.document.querySelector('#loading-title').textContent, /侧栏打开/);
});

test('an unbound old panel does not embed ChatGPT or follow another active tab', async t => {
  const f = await fixture(t, { sourceTab: null });
  assert.equal(f.calls.length, 0);
  assert.equal(f.document.querySelector('iframe').hasAttribute('src'), false);
  assert.match(f.document.querySelector('#loading-detail').textContent, /绑定来源标签页/);
});

test('initial blank frame, load, status polling and lifecycle reconnect never receive DOMWindow messages', async t => {
  const f = await fixture(t);
  const frame = f.document.querySelector('iframe');
  assert.equal(frame.contentDocument.URL, 'about:blank');
  await f.resolve(0, { ok: true, compatibility: true });
  assert.equal(f.frameMessages.length, 0);
  await f.resolve(1, { ok: true, compatibility: true, connected: false, enhancementReady: false });
  await f.tick(700);
  const pollIndex = f.calls.length - 1;
  assert.equal(f.calls[pollIndex].message.type, 'SIDER_EMBED_STATUS_GET');
  await f.resolve(pollIndex, { ok: true, compatibility: true, connected: false, enhancementReady: false });
  frame.dispatchEvent(new f.window.Event('load'));
  f.ports[0].disconnect();
  await f.tick(500);
  const reconnectIndex = f.calls.length - 1;
  assert.equal(f.calls[reconnectIndex].message.type, 'SIDER_EMBED_REGISTER');
  await f.resolve(reconnectIndex, { ok: true, compatibility: true });
  assert.equal(f.ports.length, 2);
  assert.equal(f.frameMessages.length, 0);
  assert.equal(f.document.querySelector('#recovery-actions').hidden, true);
});

test('handshake requests require the exact ChatGPT frame origin, source and one response port', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  const port = responsePort();
  requestHandshake(f, port, { origin: 'chrome-extension://panel-test' });
  requestHandshake(f, port, { origin: 'https://chatgpt.com.evil.test' });
  requestHandshake(f, port, { source: f.window });
  requestHandshake(f, port, { data: { type: 'SIDER_EMBED_FRAME_READY' } });
  requestHandshake(f, null);
  requestHandshake(f, port, { ports: [port, responsePort()] });
  assert.deepEqual(port.messages, []);
  assert.equal(port.closed, 0);
  assert.equal(f.frameMessages.length, 0);
});

test('the ChatGPT child receives its bound bridge over the transferred MessagePort', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  const port = responsePort();
  requestHandshake(f, port, { data: { type: 'SIDER_EMBED_HELLO_REQUEST', bridgeId: 'attacker-chosen-bridge' } });
  assert.deepEqual(port.messages, [{ type: 'SIDER_EMBED_HELLO', bridgeId: f.calls[0].message.bridgeId, site: BUILTIN_AI_SITES[0] }]);
  assert.equal(port.closed, 1);
  assert.equal(f.frameMessages.length, 0);
});

test('a fully navigated ChatGPT document can request the bridge again without a URL parameter', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  const initialPort = responsePort();
  requestHandshake(f, initialPort);
  f.document.querySelector('iframe').dispatchEvent(new f.window.Event('load'));
  const navigationPort = responsePort();
  requestHandshake(f, navigationPort);
  assert.deepEqual(navigationPort.messages, initialPort.messages);
  assert.equal(navigationPort.closed, 1);
  assert.equal(f.frameMessages.length, 0);
});

test('an installation preview never responds to a ChatGPT handshake', async t => {
  const f = await fixture(t, { extension: false });
  const port = responsePort();
  requestHandshake(f, port);
  assert.deepEqual(port.messages, []);
  assert.equal(f.frameMessages.length, 0);
});
