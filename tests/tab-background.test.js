import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_CONTEXT_PREFIX, CONTEXT_SETTINGS_KEY, composeContextPrompt } from '../src/context.js';

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
  const pageGates = new Map();
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
        if (message.type === 'SIDER_PAGE_CAPTURE' && message.kind === 'page') {
          const snapshot = { ok: true, reference: { kind: 'page', ...source, content: pages.get(tabId), context: '' } };
          const gate = pageGates.get(tabId);
          if (gate) { pageGates.delete(tabId); gate.reached.resolve(); await gate.release.promise; }
          return snapshot;
        }
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
    gateNextPage(tabId) { const gate = { reached: deferred(), release: deferred() }; pageGates.set(tabId, gate); return gate; },
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

test('clearing a selection clears the owning source frame, survives polling and restart, and respects defaults for a fresh selection', async () => {
  for (const defaultSelection of [true, false]) {
    const f = await fixture(); await Promise.all([1, 3].map(f.register));
    f.local[CONTEXT_SETTINGS_KEY] = { defaultSelection };
    await f.select(1, 'A 的待取消划词'); await f.select(3, 'C 的保留划词');
    await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'selection', enabled: true });
    await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true });
    const before = await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
    const other = structuredClone(f.session[`${TAB_CONTEXT_PREFIX}3`]);
    const captures = f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length;

    const cleared = await f.wrapped(1, { type: 'SIDER_TAB_SELECTION_CLEAR', tabId: 3 });
    assert.equal(cleared.ok, true, cleared.error); assert.equal(cleared.context.selection, null);
    assert.deepEqual(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CLEAR_SELECTION'), [
      { tabId: 1, message: { type: 'SIDER_PAGE_CLEAR_SELECTION' }, options: { frameId: 0 } },
    ]);
    assert.equal(f.selections.has(1), false); assert.equal(f.selections.get(3).content, 'C 的保留划词');
    assert.deepEqual(cleared.context.attachments, before.context.attachments);
    assert.equal(cleared.context.pageRequested, true);
    assert.deepEqual(f.session[`${TAB_CONTEXT_PREFIX}3`], other);

    for (let count = 0; count < 2; count++) {
      const polled = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
      assert.equal(polled.ok, true, polled.error); assert.equal(polled.context.selection, null);
      assert.equal(polled.context.revision, cleared.context.revision);
      assert.deepEqual(polled.context.attachments, before.context.attachments);
    }
    await f.restart();
    const restored = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
    assert.equal(restored.ok, true, restored.error); assert.equal(restored.context.selection, null);
    assert.equal(restored.context.revision, cleared.context.revision);
    assert.deepEqual(restored.context.attachments, before.context.attachments);
    assert.deepEqual(f.session[`${TAB_CONTEXT_PREFIX}3`], other);
    assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length, captures);

    await f.select(1, 'A 的重新划词');
    const fresh = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
    assert.equal(fresh.ok, true, fresh.error); assert.equal(fresh.context.selection.content, 'A 的重新划词');
    assert.equal(fresh.context.selectionIncluded, defaultSelection);
    assert.equal(composeContextPrompt('问题', fresh.context, fresh.settings).text.includes('A 的重新划词'), defaultSelection);
    assert.deepEqual(fresh.context.attachments, before.context.attachments);
  }
});

test('clearing a selection still succeeds when the owning source page is unavailable', async () => {
  const f = await fixture(); await Promise.all([1, 3].map(f.register));
  await f.select(1, 'A 的待取消划词'); await f.select(3, 'C 的保留划词');
  const before = await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true });
  const other = structuredClone(f.session[`${TAB_CONTEXT_PREFIX}3`]);
  f.tabs.delete(1);

  const cleared = await f.wrapped(1, { type: 'SIDER_TAB_SELECTION_CLEAR' });
  assert.equal(cleared.ok, true, cleared.error); assert.equal(cleared.context.selection, null);
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}1`].selection, null);
  assert.deepEqual(cleared.context.attachments, before.context.attachments);
  assert.deepEqual(f.session[`${TAB_CONTEXT_PREFIX}3`], other);
  assert.deepEqual(f.sent.at(-1), { tabId: 1, message: { type: 'SIDER_PAGE_CLEAR_SELECTION' }, options: { frameId: 0 } });
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
  assert.equal(result.context.url, ''); assert.equal(result.context.selection, null); assert.deepEqual(result.context.attachments, { url: true, page: null });
  assert.match(composeContextPrompt('问题', result.context).errors.join(' '), /地址无效/);
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

test('all eight default combinations compose exactly their requested current-page references', async () => {
  for (let mask = 0; mask < 8; mask++) {
    const f = await fixture(); await f.register(1);
    f.local[CONTEXT_SETTINGS_KEY] = { defaultSelection: Boolean(mask & 1), defaultUrl: Boolean(mask & 2), defaultPage: Boolean(mask & 4) };
    await f.select(1, '当前划词');
    assert.equal(f.sent.some(item => item.message.type === 'SIDER_PAGE_CAPTURE'), false);
    const result = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
    assert.equal(result.ok, true, result.error);
    const composed = composeContextPrompt('问题', result.context, result.settings);
    assert.deepEqual(composed.errors, []);
    assert.equal(composed.text.includes('网页划词：'), Boolean(mask & 1));
    assert.equal(composed.text.includes('网页 URL：'), Boolean(mask & 2));
    assert.equal(composed.text.includes('A 的完整正文'), Boolean(mask & 4));
    assert.equal(result.context.defaultsInitialized, true);
  }
});

test('defaults capture only on entering the sidebar and polling preserves a snapshot and temporary cancellation', async () => {
  const f = await fixture(); await f.register(1);
  f.local[CONTEXT_SETTINGS_KEY] = { defaultUrl: true, defaultPage: true };
  await f.select(1, '词');
  await f.api.tabs.onUpdated.emit(1, { status: 'complete' }, structuredClone(f.tabs.get(1)));
  await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  const captures = () => f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length;
  assert.equal(captures(), 1);
  f.pages.set(1, '不应自动替换的后续正文');
  for (let count = 0; count < 3; count++) {
    const read = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
    assert.equal(read.context.attachments.page.content, 'A 的完整正文');
  }
  assert.equal(captures(), 1);
  for (const kind of ['selection', 'url', 'page']) await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind, enabled: false });
  await f.restart();
  const cancelled = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(cancelled.context.selectionIncluded, false); assert.equal(cancelled.context.attachments.url, false); assert.equal(cancelled.context.pageRequested, false);
  assert.equal(captures(), 1);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}1`].attachments.page.content, '不应自动替换的后续正文');
  assert.equal(captures(), 2);
});

test('saving changed defaults updates only the owning current tab and future pages', async () => {
  const f = await fixture(); await Promise.all([1, 2, 3].map(f.register));
  await f.select(1, 'A 的词'); await f.select(2, 'B 的词');
  await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' }); await f.wrapped(2, { type: 'SIDER_TAB_CONTEXT_GET' });
  const saved = await f.wrapped(1, { type: 'SIDER_CONTEXT_SETTINGS_PATCH', patch: { defaultSelection: false, defaultUrl: true, defaultPage: true } });
  assert.equal(saved.context.selectionIncluded, false); assert.equal(saved.context.attachments.url, true); assert.equal(saved.context.attachments.page.content, 'A 的完整正文');
  const other = await f.wrapped(2, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(other.context.selectionIncluded, true); assert.equal(other.context.attachments.url, false); assert.equal(other.context.pageRequested, false);
  const future = await f.wrapped(3, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(future.context.attachments.url, true); assert.equal(future.context.attachments.page.content, 'C 的完整正文');
  for (const kind of ['url', 'page']) await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind, enabled: false });
  const formatOnly = await f.wrapped(1, { type: 'SIDER_CONTEXT_SETTINGS_PATCH', patch: { defaultSelection: false, defaultUrl: true, defaultPage: true, urlTemplate: '网址 {{url}}' } });
  assert.equal(formatOnly.context.attachments.url, false); assert.equal(formatOnly.context.pageRequested, false);
  await f.select(2, 'B 的新词');
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}2`].selectionIncluded, false);
});

test('default body capture failure persists across reads and supports retry and cancellation', async () => {
  const f = await fixture(); await f.register(1);
  f.local[CONTEXT_SETTINGS_KEY] = { defaultPage: true }; f.pages.set(1, '');
  const first = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(first.ok, true); assert.equal(first.context.pageRequested, true); assert.match(first.context.pageError, /网页正文/);
  assert.ok(composeContextPrompt('需要正文的问题', first.context, first.settings).errors.length);
  const captures = () => f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length;
  await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' }); await f.restart(); await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(captures(), 1);
  f.pages.set(1, '重试取得的完整正文');
  const retry = await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  assert.equal(retry.context.pageError, ''); assert.equal(retry.context.attachments.page.content, '重试取得的完整正文');
  assert.deepEqual(composeContextPrompt('问题', retry.context, retry.settings).errors, []); assert.equal(captures(), 2);
  f.pages.set(1, '');
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  const cancel = await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: false });
  assert.equal(composeContextPrompt('普通问题', cancel.context, cancel.settings).text, '普通问题');
  assert.deepEqual(composeContextPrompt('普通问题', cancel.context, cancel.settings).errors, []);
  await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' }); assert.equal(captures(), 3);
});

test('default body waits for authorization and preserves cancellation through repeated reads and granting access', async () => {
  const f = await fixture(); await f.register(1); f.local[CONTEXT_SETTINGS_KEY] = { defaultPage: true };
  const source = structuredClone(f.tabs.get(1)); delete f.tabs.get(1).url; delete f.tabs.get(1).title;
  const first = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(first.needsAccess, true); assert.equal(first.context.pageRequested, true); assert.match(first.context.pageError, /访问权限/);
  assert.ok(composeContextPrompt('问题', first.context, first.settings).errors.length);
  const repeated = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(repeated.context.revision, first.context.revision); assert.equal(f.sent.length, 0);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: false });
  const cancelled = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.deepEqual(composeContextPrompt('普通问题', cancelled.context).errors, []);
  Object.assign(f.tabs.get(1), source);
  const granted = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(granted.needsAccess, false); assert.equal(granted.context.pageRequested, false);
  assert.equal(f.sent.some(item => item.message.type === 'SIDER_PAGE_CAPTURE'), false);
});

test('granting missing source access retries the requested default body once', async () => {
  const f = await fixture(); await f.register(1); f.local[CONTEXT_SETTINGS_KEY] = { defaultPage: true };
  const source = structuredClone(f.tabs.get(1)); delete f.tabs.get(1).url;
  await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  Object.assign(f.tabs.get(1), source);
  const granted = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(granted.context.pageError, ''); assert.equal(granted.context.attachments.page.content, 'A 的完整正文');
  await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length, 1);
});

test('a same-URL reload during default capture rejects the old document and reapplies defaults afterwards', async () => {
  const f = await fixture(); await f.register(1); f.local[CONTEXT_SETTINGS_KEY] = { defaultPage: true };
  const gate = f.gateNextPage(1);
  const reading = f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' }); await gate.reached.promise;
  f.tabs.get(1).status = 'loading';
  await f.api.tabs.onUpdated.emit(1, { status: 'loading' }, structuredClone(f.tabs.get(1)));
  gate.release.resolve();
  const stale = await reading; assert.equal(stale.ok, false); assert.match(stale.error, /跳转/);
  f.tabs.get(1).status = 'complete'; f.pages.set(1, '刷新后的新正文');
  await f.api.tabs.onUpdated.emit(1, { status: 'complete' }, structuredClone(f.tabs.get(1)));
  const fresh = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(fresh.ok, true, fresh.error); assert.equal(fresh.context.attachments.page.content, '刷新后的新正文');
});

test('explicit selection menu, shortcut and webpage button override the disabled selection default', async () => {
  const f = await fixture(); await f.register(1); f.local[CONTEXT_SETTINGS_KEY] = { defaultSelection: false };
  const tab = f.tabs.get(1);
  await f.select(1, '右键划词'); await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  let included = f.waitForSession(data => data[`${TAB_CONTEXT_PREFIX}1`]?.selectionIncluded === true);
  await f.api.contextMenus.onClicked.emit({ menuItemId: 'sider-quote-selection', editable: false, frameId: 0, selectionText: '右键划词' }, structuredClone(tab)); await included;
  await f.select(1, '快捷键划词');
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}1`].selectionIncluded, false);
  included = f.waitForSession(data => data[`${TAB_CONTEXT_PREFIX}1`]?.selectionIncluded === true);
  await f.api.commands.onCommand.emit('capture-selection', structuredClone(tab)); await included;
  await f.select(1, '网页按钮划词');
  const opened = await f.send({ type: 'SIDER_OPEN_SOURCE_PANEL' }, { id: f.api.runtime.id, url: tab.url, tab: structuredClone(tab), frameId: 0 });
  assert.equal(opened.ok, true, opened.error); assert.equal(opened.context.selectionIncluded, true);
  const repeat = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' }); assert.equal(repeat.context.selectionIncluded, true);
  await f.select(1, null);
  const empty = await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'selection', enabled: true });
  assert.equal(empty.ok, false); assert.match(empty.error, /划词/);
});

test('unsupported pages ignore automatic defaults and keep ordinary questions usable', async () => {
  for (const url of ['chrome://settings/', 'https://chatgpt.com/']) {
    const f = await fixture(); await f.register(1);
    f.local[CONTEXT_SETTINGS_KEY] = { defaultSelection: true, defaultUrl: true, defaultPage: true };
    f.tabs.get(1).url = url;
    const result = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
    assert.equal(result.ok, true); assert.equal(result.context.pageRequested, false);
    assert.equal(composeContextPrompt('普通问题', result.context, result.settings).text, '普通问题');
    assert.deepEqual(composeContextPrompt('普通问题', result.context, result.settings).errors, []);
    assert.equal(f.sent.length, 0);
  }
});
