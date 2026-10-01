import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_CONTEXT_PREFIX, CONTEXT_SETTINGS_KEY } from '../src/context.js';

function event() {
  const listeners = new Set();
  return {
    listeners, addListener(listener) { listeners.add(listener); }, removeListener(listener) { listeners.delete(listener); },
    emit(...args) { return Promise.all([...listeners].map(listener => listener(...args))); },
  };
}
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function browserModel() {
  const tabs = new Map(['A', 'B', 'C'].map((name, index) => [index + 1, {
    id: index + 1, windowId: 9, url: `https://example.test/${name}`, title: `网页 ${name}`, active: index === 0, status: 'complete',
  }]));
  const selections = new Map();
  const pages = new Map([[1, 'A 的完整正文'], [2, 'B 的完整正文'], [3, 'C 的完整正文']]);
  const local = { 'sider.state.v1': { version: 1, references: [{ content: '原有历史数据' }] } };
  const session = {};
  const rules = new Map();
  const selectionGates = new Map();
  const sent = [], injections = [], panelOptions = [];
  const api = {
    runtime: { id: 'sider-test', getURL: path => `chrome-extension://sider-test/${path.replace(/^\//, '')}`, onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event() },
    storage: { onChanged: event() },
    tabs: {
      onCreated: event(), onActivated: event(), onUpdated: event(), onRemoved: event(),
      async get(id) { if (!tabs.has(id)) throw new Error('Tab closed'); return structuredClone(tabs.get(id)); },
      async query(query) { return [...tabs.values()].filter(tab => (!query.active || tab.active) && (query.windowId === undefined || tab.windowId === query.windowId)).map(tab => structuredClone(tab)); },
      async sendMessage(tabId, message, options) {
        sent.push({ tabId, message: structuredClone(message), options });
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('Tab closed');
        const source = { url: tab.url, title: tab.title };
        if (message.type === 'SIDER_PAGE_SELECTION_GET') {
          const snapshot = structuredClone({ ok: true, source, reference: selections.get(tabId) || null });
          const gate = selectionGates.get(tabId);
          if (gate) { selectionGates.delete(tabId); gate.reached.resolve(); await gate.release.promise; }
          return snapshot;
        }
        if (message.type === 'SIDER_PAGE_CLEAR_SELECTION') { selections.delete(tabId); return { ok: true, source }; }
        if (message.type === 'SIDER_PAGE_CAPTURE' && message.kind === 'page') return { ok: true, reference: { kind: 'page', ...source, content: pages.get(tabId), context: '' } };
        throw new Error(`Unexpected source request: ${message.type}`);
      },
    },
    windows: { onRemoved: event(), async getLastFocused() { return { id: 9 }; } },
    action: { onClicked: event() }, commands: { onCommand: event() }, contextMenus: { onClicked: event() },
    sidePanel: { async setOptions(options) { panelOptions.push(options); }, async setPanelBehavior() {}, async open() {} },
    scripting: { async executeScript(options) { injections.push(options); if (!tabs.get(options.target.tabId)?.url) throw new Error('Missing host permission'); return []; } },
    permissions: { onRemoved: event(), async contains() { return true; } },
    declarativeNetRequest: {
      async getSessionRules() { return [...rules.values()].map(rule => structuredClone(rule)); },
      async updateSessionRules(update) { for (const id of update.removeRuleIds || []) rules.delete(id); for (const rule of update.addRules || []) rules.set(rule.id, structuredClone(rule)); },
    },
  };
  function area(data, name) {
    return {
      async get(key) { return structuredClone({ [key]: data[key] }); },
      async set(update) {
        const changes = {};
        for (const [key, value] of Object.entries(update)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
        await api.storage.onChanged.emit(changes, name);
      },
      async remove(key) { const oldValue = data[key]; delete data[key]; await api.storage.onChanged.emit({ [key]: { oldValue } }, name); },
    };
  }
  api.storage.local = area(local, 'local'); api.storage.session = area(session, 'session');
  function waitForSession(predicate) {
    if (predicate(session)) return Promise.resolve();
    return new Promise(resolve => {
      const listener = (_changes, area) => { if (area === 'session' && predicate(session)) { api.storage.onChanged.removeListener(listener); resolve(); } };
      api.storage.onChanged.addListener(listener);
    });
  }
  return { api, tabs, selections, pages, local, session, rules, sent, injections, panelOptions, waitForSession,
    gateNextSelection(tabId) { const gate = { reached: deferred(), release: deferred() }; selectionGates.set(tabId, gate); return gate; },
  };
}

let sequence = 0;
async function fixture() {
  const model = browserModel(); globalThis.chrome = model.api;
  const extension = { id: model.api.runtime.id, url: model.api.runtime.getURL('panel.html') };
  let listener;
  async function loadWorker() {
    await import(`../src/background.js?tab-model=${++sequence}`);
    listener = [...model.api.runtime.onMessage.listeners][0];
  }
  const send = (message, sender = extension) => new Promise(resolve => listener(message, sender, resolve));
  const bridge = tabId => `tab-owner-${tabId}-abcdef0123456789`;
  const frame = tabId => ({ id: model.api.runtime.id, url: `https://chatgpt.com/?sider_bridge=${bridge(tabId)}`, documentId: `frame-${tabId}`, frameId: 1 });
  const wrapped = (tabId, request) => send({ type: 'SIDER_ENHANCEMENT_REQUEST', bridgeId: bridge(tabId), embedded: true, request }, frame(tabId));
  async function register(tabId) { assert.equal((await send({ type: 'SIDER_EMBED_REGISTER', bridgeId: bridge(tabId), tabId, windowId: 9 })).ok, true); }
  async function select(tabId, content) {
    const tab = model.tabs.get(tabId);
    const reference = content === null ? null : { kind: 'selection', title: tab.title, url: tab.url, content, context: `附近段落：${content}` };
    if (reference) model.selections.set(tabId, reference); else model.selections.delete(tabId);
    return send({ type: 'SIDER_SELECTION_CHANGED', source: { url: tab.url, title: tab.title }, reference }, { id: model.api.runtime.id, url: tab.url, tab: structuredClone(tab), frameId: 0 });
  }
  async function connect(tabId) {
    const messages = [];
    const port = { name: 'sider-chat-bridge', sender: frame(tabId), onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage(message) { messages.push(message); } };
    await model.api.runtime.onConnect.emit(port);
    await port.onMessage.emit({ type: 'SIDER_CHAT_READY', bridgeId: bridge(tabId), embedded: true });
    return { port, messages };
  }
  async function restart() {
    for (const surface of [model.api.runtime.onMessage, model.api.runtime.onConnect, model.api.runtime.onInstalled, model.api.runtime.onStartup, model.api.storage.onChanged, model.api.tabs.onCreated, model.api.tabs.onActivated, model.api.tabs.onUpdated, model.api.tabs.onRemoved, model.api.windows.onRemoved, model.api.permissions.onRemoved, model.api.action.onClicked, model.api.commands.onCommand, model.api.contextMenus.onClicked]) surface.listeners.clear();
    await loadWorker();
  }
  await loadWorker();
  return { ...model, send, bridge, frame, wrapped, register, select, connect, restart };
}

test('three source tabs in one window expose only their current selection through their own panel', async () => {
  const f = await fixture();
  await Promise.all([1, 2, 3].map(f.register));
  await f.select(1, 'A 的旧词'); await f.select(1, 'A 的最新词');
  await f.select(2, null); await f.select(3, 'C 的词');
  const [a, b, c] = await Promise.all([1, 2, 3].map(tabId => f.wrapped(tabId, { type: 'SIDER_TAB_CONTEXT_GET', tabId: tabId === 1 ? 3 : 1 })));
  assert.equal(a.context.tabId, 1); assert.equal(a.context.selection.content, 'A 的最新词');
  assert.equal(b.context.tabId, 2); assert.equal(b.context.selection, null);
  assert.equal(c.context.tabId, 3); assert.equal(c.context.selection.content, 'C 的词');
  assert.equal(Object.hasOwn(a.context, 'references'), false);
  assert.deepEqual(f.local['sider.state.v1'], { version: 1, references: [{ content: '原有历史数据' }] });
});

test('URL/body attachment and cancellation commands cannot target another panel tab', async () => {
  const f = await fixture(); await Promise.all([1, 2, 3].map(f.register));
  await f.select(1, 'A 的词'); await f.select(3, 'C 的词');
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true, tabId: 3 });
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true, tabId: 3 });
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}1`].attachments.page.content, 'A 的完整正文');
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}3`].attachments.url, false);
  assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').at(-1).tabId, 1);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: false, tabId: 3 });
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: false, tabId: 3 });
  await f.wrapped(1, { type: 'SIDER_TAB_SELECTION_CLEAR', tabId: 3 });
  const a = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  const c = await f.wrapped(3, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(a.context.selection, null); assert.deepEqual(a.context.attachments, { url: false, page: null });
  assert.equal(c.context.selection.content, 'C 的词');
  assert.deepEqual(f.local['sider.state.v1'].references, [{ content: '原有历史数据' }]);
});

test('navigation clears stored context before a new GET and ignores stale old-document selections', async () => {
  const f = await fixture(); await f.register(1); await f.select(1, '旧页面词');
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true });
  const oldTab = structuredClone(f.tabs.get(1));
  const cleared = f.waitForSession(data => data[`${TAB_CONTEXT_PREFIX}1`]?.url === 'https://example.test/new' && data[`${TAB_CONTEXT_PREFIX}1`]?.selection === null);
  Object.assign(f.tabs.get(1), { url: 'https://example.test/new', title: '新网页', status: 'loading' }); f.selections.delete(1);
  await f.api.tabs.onUpdated.emit(1, { url: f.tabs.get(1).url, status: 'loading' }, structuredClone(f.tabs.get(1)));
  await cleared;
  assert.deepEqual(f.session[`${TAB_CONTEXT_PREFIX}1`].attachments, { url: false, page: null });
  const stale = await f.send({ type: 'SIDER_SELECTION_CHANGED', source: { url: oldTab.url }, reference: { kind: 'selection', url: oldTab.url, content: '旧通知' } }, { id: 'sider-test', url: oldTab.url, tab: oldTab, frameId: 0 });
  assert.equal(stale.ok, false); assert.match(stale.error, /旧页面划词已忽略/);
  const loading = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(loading.ok, false); assert.match(loading.error, /正在加载/);
  f.tabs.get(1).status = 'complete';
  await f.api.tabs.onUpdated.emit(1, { status: 'complete' }, structuredClone(f.tabs.get(1)));
  const fresh = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(fresh.ok, true, fresh.error); assert.equal(fresh.context.selection, null);
});

test('a delayed source GET cannot persist old material after navigation or unblock a queued stale notification', async () => {
  const f = await fixture(); await f.register(1); await f.select(1, '旧词');
  const oldTab = structuredClone(f.tabs.get(1));
  const gate = f.gateNextSelection(1);
  const read = f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' }); await gate.reached.promise;
  const cleared = f.waitForSession(data => data[`${TAB_CONTEXT_PREFIX}1`]?.url === 'https://example.test/new' && data[`${TAB_CONTEXT_PREFIX}1`]?.selection === null);
  Object.assign(f.tabs.get(1), { url: 'https://example.test/new', title: '新网页', status: 'loading' }); f.selections.delete(1);
  await f.api.tabs.onUpdated.emit(1, { url: f.tabs.get(1).url, status: 'loading' }, structuredClone(f.tabs.get(1)));
  const stale = f.send({ type: 'SIDER_SELECTION_CHANGED', source: { url: oldTab.url }, reference: { kind: 'selection', url: oldTab.url, content: '过期词' } }, { id: 'sider-test', url: oldTab.url, tab: oldTab, frameId: 0 });
  gate.release.resolve();
  const [readResult, staleResult] = await Promise.all([read, stale]); await cleared;
  assert.equal(readResult.ok, false); assert.match(readResult.error, /正在跳转/);
  assert.equal(staleResult.ok, false); assert.equal(f.session[`${TAB_CONTEXT_PREFIX}1`].selection, null);
});

test('withheld source metadata clears previous material and returns needsAccess without falling back to another tab', async () => {
  const f = await fixture(); await f.register(1); await f.select(1, '旧词'); await f.select(3, '另一个网页的词');
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true });
  delete f.tabs.get(1).url; delete f.tabs.get(1).title;
  const sentBefore = f.sent.length;
  const result = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', tabId: 3 });
  assert.equal(result.ok, true); assert.equal(result.needsAccess, true); assert.equal(result.context.tabId, 1);
  assert.equal(result.context.url, ''); assert.equal(result.context.selection, null); assert.deepEqual(result.context.attachments, { url: false, page: null });
  assert.equal(f.sent.length, sentBefore);
  const repeated = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(repeated.context.revision, result.context.revision);
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}3`].selection.content, '另一个网页的词');
});

test('ChatGPT and browser-internal source pages keep plain questions usable while refusing webpage attachments', async () => {
  for (const url of ['https://chatgpt.com/', 'chrome://settings/']) {
    const f = await fixture(); await f.register(1); await f.select(1, '之前普通网页的词');
    await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true });
    await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
    const cleared = f.waitForSession(data => data[`${TAB_CONTEXT_PREFIX}1`]?.url === '' && data[`${TAB_CONTEXT_PREFIX}1`]?.selection === null);
    Object.assign(f.tabs.get(1), { url, title: '不支持采集的页面', status: 'loading' }); f.selections.delete(1);
    await f.api.tabs.onUpdated.emit(1, { url, status: 'loading' }, structuredClone(f.tabs.get(1)));
    await cleared;
    const sourceMessagesBefore = f.sent.length;
    const result = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
    assert.equal(result.ok, true, result.error); assert.equal(result.needsAccess, false);
    assert.equal(result.context.url, ''); assert.equal(result.context.selection, null);
    assert.deepEqual(result.context.attachments, { url: false, page: null });
    const repeated = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
    assert.equal(repeated.context.revision, result.context.revision);
    for (const kind of ['url', 'page']) {
      const enabled = await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind, enabled: true });
      assert.equal(enabled.ok, false); assert.match(enabled.error, /不支持网页引用/);
    }
    assert.equal(f.sent.length, sourceMessagesBefore);
  }
});

test('closing a source tab removes its session context and only its owning registration', async () => {
  const f = await fixture(); await Promise.all([1, 3].map(f.register)); await f.select(1, 'A 的词'); await f.select(3, 'C 的词');
  const removedContext = f.waitForSession(data => !Object.hasOwn(data, `${TAB_CONTEXT_PREFIX}1`));
  const removedOwner = f.waitForSession(data => !Object.hasOwn(data.siderEmbedRegistrations || {}, f.bridge(1)));
  f.tabs.delete(1); f.selections.delete(1); await f.api.tabs.onRemoved.emit(1, { windowId: 9, isWindowClosing: false });
  await Promise.all([removedContext, removedOwner]);
  assert.equal((await f.send({ type: 'SIDER_EMBED_STATUS_GET', bridgeId: f.bridge(1) })).registered, false);
  assert.equal((await f.send({ type: 'SIDER_EMBED_STATUS_GET', bridgeId: f.bridge(3) })).registered, true);
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}3`].selection.content, 'C 的词');
  assert.equal(f.rules.size, 1);
});

test('selection storage notifications reach only the owning ChatGPT port while settings notify every owner', async () => {
  const f = await fixture(); await Promise.all([1, 2, 3].map(f.register));
  const ports = await Promise.all([1, 2, 3].map(f.connect));
  await f.select(1, 'A 的词');
  assert.deepEqual(ports.map(port => port.messages.length), [1, 0, 0]);
  await f.select(3, 'C 的词');
  assert.deepEqual(ports.map(port => port.messages.length), [1, 0, 1]);
  await f.wrapped(1, { type: 'SIDER_CONTEXT_SETTINGS_PATCH', patch: { urlTemplate: '网页url为：{{url}}' } });
  assert.deepEqual(ports.map(port => port.messages.length), [2, 1, 2]);
  assert.equal(f.local[CONTEXT_SETTINGS_KEY].urlTemplate, '网页url为：{{url}}');
  assert.ok(ports.every(port => port.messages.every(message => message.type === 'SIDER_TAB_CONTEXT_CHANGED')));
});

test('service-worker restart restores the source tab binding and ignores forged requested tab IDs', async () => {
  const f = await fixture(); await Promise.all([1, 3].map(f.register)); await f.select(1, 'A 的词'); await f.select(3, 'C 的词');
  const beforeRules = structuredClone([...f.rules.values()]);
  await f.restart();
  const result = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', tabId: 3 });
  assert.equal(result.ok, true); assert.equal(result.context.tabId, 1); assert.equal(result.context.selection.content, 'A 的词');
  assert.equal(f.session.siderEmbedRegistrations[f.bridge(1)].tabId, 1);
  assert.deepEqual([...f.rules.values()], beforeRules);
});
