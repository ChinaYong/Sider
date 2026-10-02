import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

let instance = 0;
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { extension = true, sourceTab = '13', permissionsGranted = true } = {}) {
  const html = await readFile(new URL('../src/panel.html', import.meta.url), 'utf8');
  const { window } = new JSDOM(html, { url: `https://panel.test/${sourceTab === null ? '' : '?sourceTab=' + sourceTab}` });
  const names = ['window','document','chrome','setTimeout','clearTimeout','setInterval','clearInterval'];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = []; const ports = []; const permissions = []; const timers = new Map(); let sequence = 0;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const frameMessages = [];
  const frame = window.document.querySelector('iframe');
  // Model the stable WindowProxy across iframe navigations. Any DOMWindow
  // message would reproduce the startup about:blank origin mismatch.
  const frameWindow = { postMessage(...args) { frameMessages.push(args); } };
  Object.defineProperty(frame, 'contentWindow', { value: frameWindow, configurable: true });
  const chrome = {
    runtime: {
      id: 'panel-test',
      sendMessage(message) { return new Promise(resolve => calls.push({ message, resolve })); },
      connect({ name }) { const listeners = []; const messages = []; const port = { name, messages, postMessage(message) { messages.push(message); }, onDisconnect: { addListener(fn) { listeners.push(fn); } }, disconnect() { for(const fn of listeners) fn(); } }; ports.push(port); return port; },
    },
    windows: { async getCurrent() { return { id: 7 }; } },
    tabs: { async get(id) { return { id, windowId: 7 }; } },
    permissions: { async request(details) { permissions.push(details); return permissionsGranted; } },
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
  assert.equal(f.document.querySelector('#enable-embed'), null);
  assert.equal(f.document.querySelector('#prompt-input'), null);
  await f.resolve(0, { ok: true, compatibility: true });
  assert.equal(new URL(frame.src).hostname, 'chatgpt.com');
  assert.equal(new URL(frame.src).searchParams.get('sider_bridge'), f.calls[0].message.bridgeId);
  assert.equal(frame.hidden, false);
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
  assert.match(status.title, /可继续使用 ChatGPT/);
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

test('a frame load alone cannot report a working ChatGPT connection', async t => {
  const f = await fixture(t);
  await f.resolve(0, { ok: true, compatibility: true });
  f.document.querySelector('iframe').dispatchEvent(new f.window.Event('load'));
  assert.equal(f.document.querySelector('#loading-screen').hidden, false);
  await f.resolve(1, { ok: true, compatibility: true, connected: false, enhancementReady: false });
  assert.equal(f.document.querySelector('#loading-screen').hidden, false);
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
  assert.equal(f.document.querySelector('#loading-screen').hidden, false);
  await f.resolve(2, { ok: false, error: '重试失败' });
  assert.match(f.document.querySelector('#loading-detail').textContent, /重试失败/);
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
  assert.deepEqual(port.messages, [{ type: 'SIDER_EMBED_HELLO', bridgeId: f.calls[0].message.bridgeId }]);
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
