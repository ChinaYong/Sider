import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTabContext, normalizeContextSettings } from '../src/context.js';

const extensionOrigin = 'chrome-extension://handshake-test';
const bridgeId = 'bound-bridge-id-0001';
const settle = () => new Promise(resolve => setImmediate(resolve));
let instance = 0;

function event() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    emit(...args) { for (const listener of listeners) listener(...args); },
  };
}

async function fixture(t, { url = 'https://chatgpt.com/c/conversation', ancestors = [extensionOrigin], topLevel = false, referrer = '' } = {}) {
  const { window } = new JSDOM('<main><form><div data-composer-body><textarea id="prompt-textarea"></textarea></div><button data-testid="send-button">Send</button></form></main>', { url, pretendToBeVisual: true });
  Object.defineProperty(window.location, 'ancestorOrigins', { value: ancestors });
  Object.defineProperty(window.document, 'referrer', { value: referrer });
  window.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{ width: 320, height: 60 }] : []; };
  const parentMessages = [];
  const parent = { postMessage(...args) { parentMessages.push(args); } };
  if (!topLevel) Object.defineProperty(window, 'parent', { value: parent });
  const channels = [];
  class MockMessageChannel {
    constructor() {
      const port = () => ({ closed: 0, onmessage: null, close() { this.closed++; } });
      this.port1 = port(); this.port2 = port();
      this.port1.postMessage = data => queueMicrotask(() => { if (!this.port2.closed) this.port2.onmessage?.({ data }); });
      this.port2.postMessage = data => queueMicrotask(() => { if (!this.port1.closed) this.port1.onmessage?.({ data }); });
      channels.push(this);
    }
  }
  const runtimePorts = [];
  const runtimeMessages = [];
  const chrome = {
    runtime: {
      id: 'handshake-test',
      getURL(path) { return `${extensionOrigin}/${path.replace(/^\//, '')}`; },
      onMessage: event(),
      connect({ name }) {
        const port = { name, messages: [], onMessage: event(), onDisconnect: event(), postMessage(message) { this.messages.push(message); } };
        runtimePorts.push(port); return port;
      },
      async sendMessage(message) {
        runtimeMessages.push(message);
        return { ok: true, context: createTabContext(13), settings: normalizeContextSettings(), needsAccess: false };
      },
    },
    storage: { onChanged: event() },
  };
  const names = ['window', 'document', 'location', 'chrome', 'MessageChannel', 'setTimeout', 'clearTimeout', '__siderChatInitialized'];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const timers = new Map(); let sequence = 0;
  Object.assign(globalThis, { window, document: window.document, location: window.location, chrome, MessageChannel: MockMessageChannel, __siderChatInitialized: false });
  globalThis.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  t.after(() => {
    window.dispatchEvent(new window.Event('pagehide'));
    window.close();
    for (const name of names) if (original.get(name)) Object.defineProperty(globalThis, name, original.get(name)); else delete globalThis[name];
  });
  await import(`../src/content/chatgpt.js?handshake=${++instance}`);
  await settle();
  return {
    window, parentMessages, channels, runtimePorts, runtimeMessages, timers,
    async reply(message, index = channels.length - 1) { channels[index].port2.postMessage(message); await settle(); },
    async tick(delay) {
      const [id, timer] = [...timers].find(([, entry]) => entry.delay === delay) || [];
      if (timer) { timers.delete(id); timer.fn(); await settle(); }
    },
  };
}

test('a queryless direct ChatGPT iframe starts a channel to its exact extension parent and binds the reply', async t => {
  const f = await fixture(t);
  assert.equal(f.parentMessages.length, 1);
  assert.deepEqual(f.parentMessages[0], [{ type: 'SIDER_EMBED_HELLO_REQUEST' }, extensionOrigin, [f.channels[0].port2]]);
  assert.equal(f.window.document.querySelector('#sider-enhancement'), null);
  await f.reply({ type: 'SIDER_EMBED_HELLO', bridgeId });
  assert.ok(f.runtimePorts[0].messages.some(message => message.type === 'SIDER_CHAT_READY' && message.bridgeId === bridgeId && message.embedded));
  assert.ok(f.runtimeMessages.some(message => message.type === 'SIDER_ENHANCEMENT_REQUEST' && message.bridgeId === bridgeId));
  assert.ok(f.window.document.querySelector('#sider-enhancement'));
  assert.equal(f.channels[0].port1.closed, 1);
  assert.equal([...f.timers.values()].some(timer => timer.delay === 5000), false);
});

test('invalid channel greetings close the response port without binding or enhancing', async t => {
  const f = await fixture(t);
  await f.reply({ type: 'SIDER_EMBED_HELLO', bridgeId: 'invalid bridge' });
  assert.equal(f.channels[0].port1.closed, 1);
  assert.equal(f.window.document.querySelector('#sider-enhancement'), null);
  assert.equal(f.runtimeMessages.some(message => message.type === 'SIDER_ENHANCEMENT_REQUEST'), false);
  assert.equal(f.runtimePorts[0].messages.some(message => message.bridgeId), false);
});

test('a channel reply cannot replace the bridge identity already supplied by the panel URL', async t => {
  const f = await fixture(t, { url: `https://chatgpt.com/?sider_bridge=${bridgeId}` });
  await f.reply({ type: 'SIDER_EMBED_HELLO', bridgeId: 'different-bridge-id-0002' });
  assert.equal(f.channels[0].port1.closed, 1);
  assert.ok(f.runtimePorts[0].messages.some(message => message.bridgeId === bridgeId));
  assert.equal(f.runtimePorts[0].messages.some(message => message.bridgeId && message.bridgeId !== bridgeId), false);
  assert.ok(f.runtimeMessages.filter(message => message.type === 'SIDER_ENHANCEMENT_REQUEST').every(message => message.bridgeId === bridgeId));
});

test('a top-level ChatGPT tab with an extension referrer neither requests a parent bridge nor enhances', async t => {
  const f = await fixture(t, { topLevel: true, ancestors: [], referrer: `${extensionOrigin}/panel.html`, url: `https://chatgpt.com/?sider_bridge=${bridgeId}` });
  assert.equal(f.channels.length, 0);
  assert.equal(f.parentMessages.length, 0);
  assert.equal(f.window.document.querySelector('#sider-enhancement'), null);
  assert.equal(f.runtimePorts[0].messages.find(message => message.type === 'SIDER_CHAT_READY').embedded, false);
});

test('a nested ChatGPT iframe never targets the extension origin through its ChatGPT parent', async t => {
  const f = await fixture(t, { ancestors: ['https://chatgpt.com', extensionOrigin], referrer: `${extensionOrigin}/panel.html`, url: `https://chatgpt.com/?sider_bridge=${bridgeId}` });
  assert.equal(f.channels.length, 0);
  assert.equal(f.parentMessages.length, 0);
  assert.equal(f.window.document.querySelector('#sider-enhancement'), null);
  assert.equal(f.runtimePorts[0].messages.find(message => message.type === 'SIDER_CHAT_READY').embedded, false);
});

test('handshake timeout closes the owned port and ignores a late response', async t => {
  const f = await fixture(t);
  await f.tick(5000);
  assert.equal(f.channels[0].port1.closed, 1);
  f.channels[0].port1.onmessage({ data: { type: 'SIDER_EMBED_HELLO', bridgeId } });
  await settle();
  assert.equal(f.window.document.querySelector('#sider-enhancement'), null);
  assert.equal(f.runtimeMessages.some(message => message.type === 'SIDER_ENHANCEMENT_REQUEST'), false);
});

test('pagehide closes a pending handshake and prevents a late binding', async t => {
  const f = await fixture(t);
  f.window.dispatchEvent(new f.window.Event('pagehide'));
  assert.equal(f.channels[0].port1.closed, 1);
  assert.equal([...f.timers.values()].some(timer => timer.delay === 5000), false);
  f.channels[0].port1.onmessage({ data: { type: 'SIDER_EMBED_HELLO', bridgeId } });
  await settle();
  assert.equal(f.window.document.querySelector('#sider-enhancement'), null);
});

test('background reconnection creates a fresh channel and preserves the bound bridge', async t => {
  const f = await fixture(t);
  await f.reply({ type: 'SIDER_EMBED_HELLO', bridgeId });
  f.runtimePorts[0].onDisconnect.emit();
  await f.tick(1500);
  assert.equal(f.channels.length, 2);
  assert.equal(f.parentMessages.length, 2);
  assert.deepEqual(f.parentMessages[1], [{ type: 'SIDER_EMBED_HELLO_REQUEST' }, extensionOrigin, [f.channels[1].port2]]);
  await f.reply({ type: 'SIDER_EMBED_HELLO', bridgeId });
  assert.ok(f.runtimePorts[1].messages.some(message => message.type === 'SIDER_CHAT_READY' && message.bridgeId === bridgeId));
  assert.equal(f.channels[1].port1.closed, 1);
  assert.equal(f.window.document.querySelectorAll('#sider-enhancement').length, 1);
});
