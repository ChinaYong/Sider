import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_CONTEXT_PREFIX, CONTEXT_SETTINGS_KEY, composeContextPrompt } from '../src/context.js';
import { AI_WEB_SETTINGS_KEY } from '../src/ai-web.js';
import { PROMPT_TEMPLATES_KEY, UNIFIED_TEMPLATES_KEY, PRESET_IDS, newTemplate } from '../src/prompt-templates.js';
import { REFERENCE_SESSIONS_KEY } from '../src/reference-sessions.js';
import { expandVariables } from '../src/variables.js';

test('source picker lists all accessible windows and marks unsupported pages without changing the active tab', async () => {
  const f = await fixture(); await f.register(1);
  f.tabs.get(2).windowId = 27;
  f.tabs.set(4, { id: 4, windowId: 27, index: 2, url: 'chrome://settings/', title: '设置' });
  f.tabs.set(5, { id: 5, windowId: 9, index: 3, url: 'https://chatgpt.com/', title: 'ChatGPT' });
  const result = await f.wrapped(1, { type: 'SIDER_SOURCE_TABS_LIST' });
  assert.equal(result.ok, true); assert.equal(result.ownerWindowId, 9);
  assert.deepEqual(result.tabs.map(tab => tab.tabId), [1, 3, 5, 2, 4]);
  assert.match(result.tabs.find(tab => tab.tabId === 4).disabledReason, /内部/);
  assert.match(result.tabs.find(tab => tab.tabId === 5).disabledReason, /AI/);
  assert.equal(result.tabs.find(tab => tab.tabId === 2).disabledReason, '');
  assert.equal(f.tabs.get(1).active, true); assert.equal(f.opened.length, 0);
  assert.equal((await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 4 })).ok, false);
  assert.equal((await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: -1 })).ok, false);
});

test('borrowing a cross-window source keeps sidebar choices and does not mutate the borrowed sidebar context', async () => {
  const f = await fixture(); await f.register(1); await f.register(2);
  await f.select(1, 'A 的划词'); await f.select(2, 'B 的划词');
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true });
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  await f.wrapped(2, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: false });
  const beforeA = (await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' })).context;
  const beforeB = structuredClone(f.session[TAB_CONTEXT_PREFIX + 2]);
  f.tabs.get(2).windowId = 27;
  const switched = await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  assert.equal(switched.ok, true, switched.error);
  assert.equal(switched.context.tabId, 2); assert.equal(switched.referenceSource.ownerTabId, 1);
  assert.equal(switched.context.selection.content, 'B 的划词');
  assert.deepEqual(switched.context.templateSelections, beforeA.templateSelections);
  assert.deepEqual(f.session[TAB_CONTEXT_PREFIX + 2], beforeB);
  assert.equal(f.session.siderEmbedRegistrations[f.bridge(1)].tabId, 1);
  const variables = expandVariables('{{title}}|{{url}}|{{selection}}|{{content}}', switched.context);
  assert.deepEqual(variables.errors, []);
  assert.equal(variables.text, '网页 B|https://example.test/B|B 的划词|B 的完整正文');
  const refreshed = await f.wrapped(1, { type: 'SIDER_TEMPLATE_CONTEXT_GET', ids: [PRESET_IDS.page], refreshPage: true });
  assert.equal(refreshed.variablePage.content, 'B 的完整正文');
  assert.deepEqual(f.session[TAB_CONTEXT_PREFIX + 2], beforeB);
  assert.equal((await f.wrapped(2, { type: 'SIDER_TAB_CONTEXT_GET' })).context.attachments.url, false);
  const returned = await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 1 });
  assert.equal(returned.context.selection.content, 'A 的划词');
  assert.deepEqual(returned.context.templateSelections, beforeA.templateSelections);
});

test('reference choices, cancellations and selected source survive worker restart and successful-send clearing', async () => {
  const f = await fixture(); await f.register(1);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true });
  await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  await f.restart();
  const result = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', tabId: 3 });
  assert.equal(result.ok, true); assert.equal(result.context.tabId, 2); assert.equal(result.context.attachments.url, true);
  const expectedContext = { tabId: 2, url: result.context.url, revision: result.context.revision, referenceEpoch: result.referenceSource.epoch };
  const cleared = await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATES_CLEAR', expectedContext });
  assert.equal(cleared.ok, true); assert.equal(cleared.referenceSource.tabId, 2);
  assert.ok(Object.values(cleared.context.templateSelections).every(enabled => !enabled));
  const poll = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', knownContext: { tabId: 2, revision: cleared.context.revision, referenceEpoch: cleared.referenceSource.epoch } });
  assert.equal(poll.contextUnchanged, true);
  await f.restart();
  const restored = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(restored.referenceSource.tabId, 2); assert.equal(restored.context.attachments.url, false);
});

test('a closed borrowed source clears material, retains choices and leaves its consumer sidebar registered', async () => {
  const f = await fixture(); await f.register(1); await f.register(2);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true });
  const switched = await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  f.tabs.delete(2); await f.api.tabs.onRemoved.emit(2);
  await f.waitForSession(data => data[REFERENCE_SESSIONS_KEY]?.[1]?.status === 'closed');
  const result = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(result.ok, true); assert.equal(result.referenceSource.status, 'closed');
  assert.equal(result.context.url, ''); assert.equal(result.context.selection, null); assert.equal(result.context.attachments.page, null);
  assert.deepEqual(result.context.templateSelections, switched.context.templateSelections);
  assert.match(result.referenceSource.error, /已关闭/);
  assert.equal((await f.send({ type: 'SIDER_EMBED_STATUS_GET', bridgeId: f.bridge(1) })).registered, true);
  const returned = await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 1 });
  assert.equal(returned.ok, true); assert.equal(returned.context.url, 'https://example.test/A');
  f.tabs.delete(1); await f.api.tabs.onRemoved.emit(1);
  await f.waitForSession(data => !data[REFERENCE_SESSIONS_KEY]?.[1]);
});

test('late selection and page reads cannot overwrite a later reference switch or clear its choices', async () => {
  const f = await fixture(); await f.register(1);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  const selectionGate = f.gateNextSelection(2);
  const oldRead = f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  await selectionGate.reached.promise;
  const latest = await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 3 });
  selectionGate.release.resolve(); assert.equal((await oldRead).code, 'REFERENCE_CHANGED');
  assert.equal(latest.context.tabId, 3);
  await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  const pageGate = f.gateNextPage(2);
  const oldPage = f.wrapped(1, { type: 'SIDER_TEMPLATE_CONTEXT_GET', ids: [PRESET_IDS.page], refreshPage: true });
  await pageGate.reached.promise;
  const expected = (await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' })).context;
  const epoch = f.session[REFERENCE_SESSIONS_KEY][1].epoch;
  const switched = await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 3 });
  pageGate.release.resolve(); assert.equal((await oldPage).code, 'REFERENCE_CHANGED');
  const staleClear = await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATES_CLEAR', referenceEpoch: epoch,
    expectedContext: { tabId: 2, url: expected.url, revision: expected.revision, referenceEpoch: epoch } });
  assert.equal(staleClear.ok, true); assert.equal(staleClear.context.tabId, 3);
  assert.deepEqual(staleClear.context.templateSelections, switched.context.templateSelections);
  assert.equal(staleClear.context.attachments.page.content, 'C 的完整正文');
});

test('borrowed source notifications reach its consumers and navigation invalidates pending reads while preserving choices', async () => {
  const f = await fixture(); await f.register(1); await f.register(2); await f.register(3);
  await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  const a = await f.connect(1), b = await f.connect(2), c = await f.connect(3);
  await f.select(2, '新划词');
  assert.ok(a.messages.some(message => message.type === 'SIDER_TAB_CONTEXT_CHANGED'));
  assert.ok(b.messages.some(message => message.type === 'SIDER_TAB_CONTEXT_CHANGED'));
  assert.equal(c.messages.length, 0);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: true });
  const before = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  const gate = f.gateNextSelection(2), pending = f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  await gate.reached.promise;
  Object.assign(f.tabs.get(2), { url: 'https://example.test/B-new', title: '新标题', status: 'loading' });
  await f.api.tabs.onUpdated.emit(2, { status: 'loading', url: f.tabs.get(2).url }, f.tabs.get(2));
  await f.waitForSession(data => data[REFERENCE_SESSIONS_KEY]?.[1]?.epoch > before.referenceSource.epoch);
  gate.release.resolve(); assert.equal((await pending).code, 'REFERENCE_CHANGED');
  f.selections.delete(2); f.tabs.get(2).status = 'complete';
  const after = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(after.context.title, '新标题'); assert.equal(after.context.selection, null);
  assert.deepEqual(after.context.templateSelections, before.context.templateSelections);
});

test('access denial and authorization target the selected source and stale authorization requests fail', async () => {
  const f = await fixture(); await f.register(1);
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async options => { if (options.target.tabId === 2) throw new Error('Missing host permission'); return execute(options); };
  const result = await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  assert.equal(result.ok, true); assert.equal(result.needsAccess, true); assert.equal(result.context.url, '');
  assert.equal(result.referenceSource.title, '网页 B');
  const info = await f.send({ type: 'SIDER_SOURCE_INFO', tabId: 1, bridgeId: f.bridge(1) });
  assert.equal(info.source.tabId, 2); assert.equal(info.source.url, 'https://example.test/B');
  await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 3 });
  const stale = await f.send({ type: 'SIDER_SOURCE_ACCESS_REQUEST', tabId: 1, bridgeId: f.bridge(1), expectedSource: { tabId: 2, referenceEpoch: info.source.referenceEpoch } });
  assert.equal(stale.code, 'REFERENCE_CHANGED');
  f.api.scripting.executeScript = execute;
  const recovered = await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  assert.equal(recovered.referenceSource.status, 'ready'); assert.equal(recovered.context.title, '网页 B');
});

test('borrowed-source preset edits apply defaults only to that sidebar and metadata capture stays demand driven', async () => {
  const f = await fixture(); await f.register(1); await f.register(2);
  await f.wrapped(2, { type: 'SIDER_TAB_CONTEXT_GET' });
  const before = structuredClone(f.session[TAB_CONTEXT_PREFIX + 2]);
  await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  const previous = (await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_GET' })).templates;
  const custom = newTemplate({ id: 'borrowed-custom-001', name: '来源信息', text: '{{title}}', defaultIncluded: true });
  const saved = await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates: [...previous, custom], expected: previous });
  assert.equal(saved.context.templateSelections[custom.id], true);
  assert.deepEqual(f.session[TAB_CONTEXT_PREFIX + 2], before);
  const count = f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length;
  const ordinary = await f.wrapped(1, { type: 'SIDER_TEMPLATE_CONTEXT_GET', ids: [custom.id] });
  assert.equal(ordinary.context.title, '网页 B');
  assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length, count);
  const page = await f.wrapped(1, { type: 'SIDER_TEMPLATE_CONTEXT_GET', ids: [], needPage: true });
  assert.equal(page.variablePage.content, 'B 的完整正文'); assert.equal(page.context.pageRequested, false);
  assert.deepEqual(f.session[TAB_CONTEXT_PREFIX + 2], before);
});

test('failed fresh capture of a borrowed body clears its cached material and a later retry recovers', async () => {
  const f = await fixture(); await f.register(1);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  const send = f.api.tabs.sendMessage;
  let fail = true;
  f.api.tabs.sendMessage = async (tabId, message, ...rest) => {
    if (tabId === 2 && message.type === 'SIDER_PAGE_CAPTURE' && fail) throw new Error('fixture 正文采集失败');
    return send(tabId, message, ...rest);
  };
  const failed = await f.wrapped(1, { type: 'SIDER_TEMPLATE_CONTEXT_GET', ids: [PRESET_IDS.page], refreshPage: true });
  assert.equal(failed.ok, false); assert.match(failed.error, /正文采集失败/);
  const after = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(after.context.attachments.page, null); assert.match(after.context.pageError, /正文采集失败/);
  assert.equal(after.context.templateSelections[PRESET_IDS.page], true);
  fail = false;
  const retry = await f.wrapped(1, { type: 'SIDER_TEMPLATE_CONTEXT_GET', ids: [PRESET_IDS.page], refreshPage: true });
  assert.equal(retry.ok, true); assert.equal(retry.variablePage.content, 'B 的完整正文'); assert.equal(retry.context.pageError, '');
});

test('revoking a borrowed source permission invalidates material without changing choices and granting it recovers', async () => {
  const f = await fixture(); await f.register(1);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  const before = await f.wrapped(1, { type: 'SIDER_REFERENCE_SOURCE_SET', tabId: 2 });
  const execute = f.api.scripting.executeScript;
  f.api.permissions.contains = async request => !request.origins?.includes('https://example.test/*');
  f.api.scripting.executeScript = async options => { if (options.target.tabId === 2) throw new Error('Missing host permission'); return execute(options); };
  await f.api.permissions.onRemoved.emit({ origins: ['https://example.test/*'] });
  await f.waitForSession(data => data[REFERENCE_SESSIONS_KEY]?.[1]?.status === 'needs-access');
  const denied = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(denied.needsAccess, true); assert.equal(denied.context.url, ''); assert.equal(denied.context.attachments.page, null);
  assert.deepEqual(denied.context.templateSelections, before.context.templateSelections);
  f.api.permissions.contains = async () => true; f.api.scripting.executeScript = execute;
  const recovered = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(recovered.referenceSource.status, 'ready'); assert.equal(recovered.context.attachments.page.content, 'B 的完整正文');
});

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
  const sent = [], injections = [], panelOptions = [], opened = [], closed = [], menus = [];
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
    action: { onClicked: event() }, commands: { onCommand: event() }, contextMenus: { onClicked: event(), async removeAll() { menus.length = 0; }, create(menu) { menus.push(menu); } },
    sidePanel: { onOpened: event(), onClosed: event(), async setOptions(options) { panelOptions.push(options); }, async setPanelBehavior() {}, async open(options) { opened.push(options); }, async close(options) { closed.push(options); } },
    scripting: { async executeScript(options) { injections.push(options); if (!tabs.get(options.target.tabId)?.url) throw new Error('Missing host permission'); return []; } },
    permissions: { onRemoved: event(), async contains() { return true; } },
    declarativeNetRequest: {
      async getSessionRules() { return [...rules.values()].map(rule => structuredClone(rule)); },
      async updateSessionRules(update) { for (const id of update.removeRuleIds || []) rules.delete(id); for (const rule of update.addRules || []) rules.set(rule.id, structuredClone(rule)); },
    },
  };
  function area(data, name) {
    return {
      async get(key) { return structuredClone(Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, data[name]]))); },
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
  return { api, tabs, selections, pages, local, session, rules, sent, injections, panelOptions, opened, closed, menus, waitForSession,
    gateNextSelection(tabId) { const gate = { reached: deferred(), release: deferred() }; selectionGates.set(tabId, gate); return gate; },
    gateNextPage(tabId) { const gate = { reached: deferred(), release: deferred() }; pageGates.set(tabId, gate); return gate; },
  };
}

let sequence = 0;

test('custom defaults apply only to the saving tab and cancelled choices survive polls and worker restart', async () => {
 const f = await fixture(); await f.register(1); await f.register(2);
 const previous = (await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_GET' })).templates;
 const custom = newTemplate({ id: 'custom-default-001', name: '默认提示', text: '固定文本', defaultIncluded: false });
 await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates: [...previous, custom], expected: previous });
 await f.wrapped(2, { type: 'SIDER_TAB_CONTEXT_GET' });
 const changed = [...previous, { ...custom, defaultIncluded: true }];
 const result = await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates: changed, expected: [...previous, custom] });
 assert.equal(result.context.templateSelections[custom.id], true);
 assert.equal((await f.wrapped(2, { type: 'SIDER_TAB_CONTEXT_GET' })).context.templateSelections[custom.id], false);
 await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATE_SET', id: custom.id, enabled: false }); await f.restart();
 assert.equal((await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' })).context.templateSelections[custom.id], false);
});

test('preset capture depends on edited variables; custom body metadata shares one fresh collection', async () => {
 const f = await fixture(); await f.register(1);
 const previous = (await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_GET' })).templates;
 const templates = [...previous.map(item => item.preset === 'page' ? { ...item, text: '只引用 {{title}}', delivery: 'text', defaultIncluded: true } : item), newTemplate({ id: 'custom-meta-001', name: '资料时间', text: '{{page.capturedAt}}' }), newTemplate({ id: 'custom-body-001', name: '完整正文', text: '{{content}}' })];
 await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates, expected: previous });
 assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length, 0);
 const captures = f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length;
 const response = await f.wrapped(1, { type: 'SIDER_TEMPLATE_CONTEXT_GET', ids: ['custom-meta-001', 'custom-body-001'], refreshPage: true });
 assert.equal(response.ok, true); assert.equal(response.variablePage.content, 'A 的完整正文');
 assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length - captures, 1);
 assert.equal(response.context.pageRequested, false);
});

test('a newly created default attaches on the saving page and fresh pages while existing pages keep their choices', async () => {
 const f = await fixture(); await Promise.all([1,2,3].map(f.register));
 await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' }); await f.wrapped(2, { type: 'SIDER_TAB_CONTEXT_GET' });
 const previous = (await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_GET' })).templates;
 const item = newTemplate({ id: 'custom-new-default-001', name: '新增默认项', text: '固定提示', defaultIncluded: true, action: 'send' });
 const saved = await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates: [...previous, item], expected: previous });
 assert.equal(saved.context.templateSelections[item.id], true);
 assert.equal((await f.wrapped(2, { type: 'SIDER_TAB_CONTEXT_GET' })).context.templateSelections[item.id], false);
 assert.equal((await f.wrapped(3, { type: 'SIDER_TAB_CONTEXT_GET' })).context.templateSelections[item.id], true);
 assert.equal(f.sent.some(request => request.message.type === 'SIDER_PAGE_CAPTURE'), false);
});

test('manual and default selection dependencies stay checked and wait without capture', async () => {
 const f = await fixture(); await f.register(1);
 const previous = (await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_GET' })).templates;
 const item = newTemplate({ id: 'custom-selection-001', name: '选择与正文', text: '{{selection}} {{content}}', defaultIncluded: true });
 const templates = [...previous, item];
 await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates, expected: previous });
 assert.equal(f.sent.filter(call => call.message.type === 'SIDER_PAGE_CAPTURE').length, 0);
 const result = await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATE_SET', id: item.id, enabled: true });
 assert.equal(result.ok, true); assert.equal(result.context.templateSelections[item.id],true); assert.equal(result.context.pageRequested,false);
 assert.equal(f.sent.filter(call => call.message.type === 'SIDER_PAGE_CAPTURE').length,0);
 await f.select(1,'新的划词'); const ready=await f.wrapped(1,{type:'SIDER_TAB_CONTEXT_GET'}); assert.equal(ready.context.templateSelections[item.id],true);
 assert.equal(ready.context.attachments.page.content,'A 的完整正文');
});

test('send completion clears every preset only in the bound tab and survives polling and reopening', async () => {
 const f = await fixture(); await f.register(1); await f.register(2); await f.select(1, '保留的划词');
 const previous = (await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_GET' })).templates;
 const item = newTemplate({ id: 'send-reset-custom-001', name: '默认自建预设', text: '{{content}}', defaultIncluded: true });
 const templates = [...previous, item];
 await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates, expected: previous });
 await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATE_SET', id: PRESET_IDS.url, enabled: true });
 const before = (await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATE_SET', id: PRESET_IDS.page, enabled: true })).context;
 const other = (await f.wrapped(2, { type: 'SIDER_TAB_CONTEXT_GET' })).context;
 const calls = f.sent.length;
 const cleared = await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATES_CLEAR', expectedContext: before, tabId: 2 });
 assert.equal(cleared.ok, true); assert.equal(cleared.context.revision, before.revision + 1);
 assert.ok(Object.values(cleared.context.templateSelections).every(value => value === false));
 assert.deepEqual(cleared.context.explicitTemplates, []); assert.equal(cleared.context.pageRequested, false);
 assert.deepEqual(cleared.context.attachments, { url: false, page: null }); assert.equal(cleared.context.selection.content, '保留的划词');
 assert.equal(f.sent.length, calls); assert.deepEqual(f.local[UNIFIED_TEMPLATES_KEY], templates);
 assert.deepEqual(f.session[`${TAB_CONTEXT_PREFIX}2`], other);
 await f.register(1); const polled = (await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' })).context;
 assert.deepEqual(polled, cleared.context);
 await f.select(1, '之后的新划词'); assert.ok(Object.values((await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' })).context.templateSelections).every(value => value === false));
 await f.register(3); assert.equal((await f.wrapped(3, { type: 'SIDER_TAB_CONTEXT_GET' })).context.templateSelections[item.id], true);
});

test('delayed or failed send resets preserve newer choices and stored context', async () => {
 const f = await fixture(); await f.register(1);
 const old = (await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' })).context;
 const current = (await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATE_SET', id: PRESET_IDS.url, enabled: true })).context;
 assert.deepEqual((await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATES_CLEAR', expectedContext: old })).context, current);
 const set = f.api.storage.session.set;
 f.api.storage.session.set = async () => { throw new Error('取消勾选存储失败'); };
 const failed = await f.wrapped(1, { type: 'SIDER_TAB_TEMPLATES_CLEAR', expectedContext: current });
 f.api.storage.session.set = set;
 assert.equal(failed.ok, false); assert.match(failed.error, /取消勾选存储失败/);
 assert.deepEqual(f.session[`${TAB_CONTEXT_PREFIX}1`], current);
});

test('template saves reject stale previews and leave all templates intact on storage failure', async () => {
 const f = await fixture(); await f.register(1);
 const previous = (await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_GET' })).templates;
 const templates = previous.map(item => item.preset === 'url' ? { ...item, name: '新名称' } : item);
 const stale = await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates, expected: [] });
 assert.equal(stale.ok, false); assert.deepEqual(f.local[UNIFIED_TEMPLATES_KEY], previous);
 const set = f.api.storage.local.set; f.api.storage.local.set = async change => { if (change[UNIFIED_TEMPLATES_KEY]) throw new Error('预设保存失败'); return set(change); };
 const failed = await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates, expected: previous });
 assert.equal(failed.ok, false); assert.match(failed.error, /预设保存失败/); assert.deepEqual(f.local[UNIFIED_TEMPLATES_KEY], previous);
});

test('unchanged revision replies omit the large body while changes and send preparation return complete data', async () => {
  const f = await fixture(); await f.register(1);
  f.pages.set(1, '长正文'.repeat(20000));
  const initial = await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  const knownContext = { tabId: 1, revision: initial.context.revision };
  const unchanged = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', knownContext });
  assert.equal(unchanged.contextUnchanged, true); assert.equal(unchanged.context, undefined);
  assert.ok(JSON.stringify(unchanged).length < 1000);
  const captures = f.sent.filter(call => call.message.type === 'SIDER_PAGE_CAPTURE').length;
  assert.equal(captures, 1);
  await f.select(1, '新划词');
  const changed = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', knownContext });
  assert.equal(changed.context.selection.content, '新划词'); assert.equal(changed.context.attachments.page.content.length, 60000);
  const send = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', knownContext: { tabId: 1, revision: changed.context.revision }, refreshPage: true });
  assert.equal(send.context.attachments.page.content.length, 60000); assert.equal(f.sent.filter(call => call.message.type === 'SIDER_PAGE_CAPTURE').length, 2);
});

test('template body capture with references disabled leaves the tab choices unchanged', async () => {
  const f = await fixture(); await f.register(1);
  const before = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  const start = f.sent.filter(call => call.message.type === 'SIDER_PAGE_CAPTURE').length;
  const result = await f.wrapped(1, { type: 'SIDER_TEMPLATE_CONTEXT_GET', needPage: true, refreshPage: true });
  assert.equal(result.ok, true); assert.equal(result.variablePage.content, 'A 的完整正文');
  assert.equal(result.context.pageRequested, false); assert.equal(result.context.attachments.page, null);
  assert.equal(result.context.revision, before.context.revision);
  assert.equal(f.sent.filter(call => call.message.type === 'SIDER_PAGE_CAPTURE').length - start, 1);
});

test('direct body templates and active body references share exactly one fresh snapshot', async () => {
  const f = await fixture(); await f.register(1); await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  f.pages.set(1, '更新后的正文');
  const start = f.sent.filter(call => call.message.type === 'SIDER_PAGE_CAPTURE').length;
  const result = await f.wrapped(1, { type: 'SIDER_TEMPLATE_CONTEXT_GET', needPage: true, refreshPage: true });
  assert.equal(result.variablePage.content, '更新后的正文'); assert.equal(result.context.attachments.page.content, result.variablePage.content);
  assert.equal(f.sent.filter(call => call.message.type === 'SIDER_PAGE_CAPTURE').length - start, 1);
});

test('configuration import replaces sites and templates together while preserving session context and legacy data', async () => {
  const f = await fixture(); await f.register(1); await f.select(1, '当前划词');
  const oldTemplate = { id: 'template-old-1234', name: '旧预设', text: '{{url}}', directSend: false };
  f.local[PROMPT_TEMPLATES_KEY] = [oldTemplate];
  const templates = (await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_GET' })).templates;
  f.local[UNIFIED_TEMPLATES_KEY] = [...templates, newTemplate({ id: oldTemplate.id, name: oldTemplate.name, text: oldTemplate.text })];
  f.local[AI_WEB_SETTINGS_KEY] = { activeSiteId: 'chatgpt', customSites: [{ id: 'custom-old-1234', name: '旧网站', url: 'https://old.test/' }] };
  const { backup: before } = await f.send({ type: 'SIDER_CONFIGURATION_EXPORT' });
  const backup = structuredClone(before); backup.configuration.templates = structuredClone(templates); backup.configuration.aiWeb.customSites = [];
  backup.configuration.templates.find(item => item.preset === 'selection').defaultIncluded = false;
  const session = structuredClone(f.session), legacy = structuredClone(f.local['sider.state.v1']);
  const imported = await f.send({ type: 'SIDER_CONFIGURATION_IMPORT', backup, expected: before.configuration });
  assert.equal(imported.ok, true, imported.error);
  assert.deepEqual(f.local[PROMPT_TEMPLATES_KEY], [oldTemplate]); assert.deepEqual(f.local[AI_WEB_SETTINGS_KEY].customSites, []);
  assert.equal(f.local[UNIFIED_TEMPLATES_KEY].find(item => item.preset === 'selection').defaultIncluded, false); assert.deepEqual(f.session, session); assert.deepEqual(f.local['sider.state.v1'], legacy);
});

test('configuration rejection, changed preview, permission denial, and storage failure retain all existing keys', async () => {
  const f = await fixture();
  const { backup: before } = await f.send({ type: 'SIDER_CONFIGURATION_EXPORT' });
  const local = structuredClone(f.local);
  const invalid = structuredClone(before); delete invalid.configuration.templates;
  assert.equal((await f.send({ type: 'SIDER_CONFIGURATION_IMPORT', backup: invalid, expected: before.configuration })).ok, false);
  const next = structuredClone(before); next.configuration.templates.find(item => item.preset === 'url').defaultIncluded = true;
  assert.equal((await f.send({ type: 'SIDER_CONFIGURATION_IMPORT', backup: next, expected: {} })).ok, false);
  f.api.permissions.contains = async () => false;
  assert.equal((await f.send({ type: 'SIDER_CONFIGURATION_IMPORT', backup: next, expected: before.configuration })).ok, false);
  f.api.permissions.contains = async () => true;
  const save = f.api.storage.local.set;
  f.api.storage.local.set = async changes => { if (changes[AI_WEB_SETTINGS_KEY]) throw new Error('模拟存储失败'); return save(changes); };
  const failed = await f.send({ type: 'SIDER_CONFIGURATION_IMPORT', backup: next, expected: before.configuration });
  assert.equal(failed.ok, false); assert.match(failed.error, /模拟存储失败/); assert.deepEqual(f.local, local);
});

test('builtin button overrides persist across worker restart without changing an already loaded sidebar configuration', async () => {
  const f = await fixture();
  const initial = { activeSiteId: 'chatgpt', customSites: [], builtinOverrides: { chatgpt: { selectors: { send: '#first-button' } } } };
  assert.equal((await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: initial })).ok, true);
  await f.register(1);
  const changed = { ...initial, builtinOverrides: { chatgpt: { selectors: { send: '#new-button' } } } };
  assert.equal((await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: changed })).ok, true);
  await f.restart();
  const old = await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId: f.bridge(1), windowId: 9, tabId: 1, siteId: 'chatgpt', reuseSite: true });
  assert.equal(old.site.selectors.send, '#first-button');
  const next = await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId: f.bridge(1), windowId: 9, tabId: 1, siteId: 'chatgpt' });
  assert.equal(next.site.selectors.send, '#new-button');
});
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
  async function connectPanel(tabId) {
    const messages = [];
    const port = { name: 'sider-panel-lifecycle', sender: extension, onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage(message) { messages.push(message); } };
    await model.api.runtime.onConnect.emit(port);
    await port.onMessage.emit({ type: 'SIDER_PANEL_ATTACH', bridgeId: bridge(tabId) });
    return { port, messages };
  }
  async function restart() {
    model.api.sidePanel.onOpened.listeners.clear(); model.api.sidePanel.onClosed.listeners.clear();
    for (const surface of [model.api.runtime.onMessage, model.api.runtime.onConnect, model.api.runtime.onInstalled, model.api.runtime.onStartup, model.api.storage.onChanged, model.api.tabs.onCreated, model.api.tabs.onActivated, model.api.tabs.onUpdated, model.api.tabs.onRemoved, model.api.windows.onRemoved, model.api.permissions.onRemoved, model.api.action.onClicked, model.api.commands.onCommand, model.api.contextMenus.onClicked]) surface.listeners.clear();
    await loadWorker();
  }
  await loadWorker();
  return { ...model, send, bridge, frame, wrapped, register, select, connect, connectPanel, restart };
}

test('changing enhancement readiness notifies only the bound panel and disconnecting the frame reports loss', async () => {
  const f = await fixture(); await f.register(1); await f.register(2);
  const first = await f.connectPanel(1), second = await f.connectPanel(2);
  const chat = await f.connect(1);
  await chat.port.onMessage.emit({ type: 'SIDER_ENHANCEMENT_READY', bridgeId: f.bridge(2), ready: true });
  assert.deepEqual(first.messages, []); assert.deepEqual(second.messages, []);
  await chat.port.onMessage.emit({ type: 'SIDER_ENHANCEMENT_READY', bridgeId: f.bridge(1), ready: true });
  assert.equal(first.messages.at(-1).ready, true); assert.deepEqual(second.messages, []);
  await chat.port.onMessage.emit({ type: 'SIDER_ENHANCEMENT_READY', bridgeId: f.bridge(1), ready: false, detail: 'Native WebSocket connection failed.' });
  assert.equal(first.messages.at(-1).ready, false); assert.match(first.messages.at(-1).detail, /WebSocket/);
  await chat.port.onDisconnect.emit();
  assert.equal(first.messages.at(-1).ready, false); assert.deepEqual(second.messages, []);
  assert.equal((await f.send({ type: 'SIDER_EMBED_STATUS_GET', bridgeId: f.bridge(1) })).connected, false);
});

test('a previous website cannot publish readiness after the same panel changes its origin', async () => {
  const f = await fixture(); await f.register(1); const panel = await f.connectPanel(1), chat = await f.connect(1);
  const switched = await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId: f.bridge(1), tabId: 1, windowId: 9, siteId: 'claude' });
  assert.equal(switched.ok, true);
  await chat.port.onMessage.emit({ type: 'SIDER_ENHANCEMENT_READY', bridgeId: f.bridge(1), ready: true });
  assert.deepEqual(panel.messages, []);
  assert.equal((await f.send({ type: 'SIDER_EMBED_STATUS_GET', bridgeId: f.bridge(1) })).enhancementReady, false);
});

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
    assert.equal(fresh.context.selectionIncluded, false);
    assert.equal(composeContextPrompt('问题', fresh.context, fresh.settings).text.includes('A 的重新划词'), false);
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
  assert.equal(f.local[UNIFIED_TEMPLATES_KEY].find(item => item.preset === 'url').text, '网页url为：{{url}}');
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

test('send preparation refreshes a cached body once while ordinary reads retain that snapshot', async () => {
  const f = await fixture(); await f.register(1); await f.register(2);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  await f.wrapped(2, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  f.pages.set(1, '发送时已加载的最新正文');
  const fresh = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', refreshPage: true });
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal(fresh.context.attachments.page.content, '发送时已加载的最新正文');
  f.pages.set(1, '本次发送之后才出现的内容');
  for (let count = 0; count < 3; count++) {
    const read = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
    assert.equal(read.context.attachments.page.content, '发送时已加载的最新正文');
  }
  assert.equal(f.sent.filter(item => item.tabId === 1 && item.message.type === 'SIDER_PAGE_CAPTURE').length, 2);
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}2`].attachments.page.content, 'B 的完整正文');
  const nextSend = await f.send({ type: 'SIDER_TAB_CONTEXT_GET', tabId: 1, refreshPage: true });
  assert.equal(nextSend.context.attachments.page.content, '本次发送之后才出现的内容');
  assert.equal(f.sent.filter(item => item.tabId === 1 && item.message.type === 'SIDER_PAGE_CAPTURE').length, 3);
});

test('send preparation never enables an unselected or temporarily cancelled body', async () => {
  const f = await fixture(); await f.register(1);
  await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', refreshPage: true });
  assert.equal(f.sent.some(item => item.message.type === 'SIDER_PAGE_CAPTURE'), false);
  f.local[CONTEXT_SETTINGS_KEY] = { defaultPage: true };
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: false });
  const cancelled = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', refreshPage: true });
  assert.equal(cancelled.context.pageRequested, false);
  assert.equal(cancelled.context.attachments.page, null);
  assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length, 1);
});

test('send preparation waits for fresh capture and queued polls do not capture again', async () => {
  const f = await fixture(); await f.register(1);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  f.pages.set(1, '延迟取得的新正文');
  const gate = f.gateNextPage(1);
  let completed = false;
  const preparing = f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', refreshPage: true }).then(result => { completed = true; return result; });
  await gate.reached.promise;
  assert.equal(completed, false);
  const polling = f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  gate.release.resolve();
  for (const result of await Promise.all([preparing, polling])) {
    assert.equal(result.ok, true, result.error);
    assert.equal(result.context.attachments.page.content, '延迟取得的新正文');
  }
  assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length, 2);
});

test('failed send-time extraction clears the old body and the next send can recover', async () => {
  const f = await fixture(); await f.register(1);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  f.pages.set(1, '');
  const failed = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', refreshPage: true });
  assert.equal(failed.context.pageRequested, true);
  assert.equal(failed.context.attachments.page, null);
  assert.ok(composeContextPrompt('保留的问题', failed.context, failed.settings).errors.length);
  await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length, 2);
  f.pages.set(1, '重新加载完成的正文');
  const recovered = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', refreshPage: true });
  assert.equal(recovered.context.pageError, '');
  assert.equal(recovered.context.attachments.page.content, '重新加载完成的正文');
  assert.deepEqual(composeContextPrompt('保留的问题', recovered.context, recovered.settings).errors, []);
});

test('navigation during send-time extraction rejects the old body', async () => {
  const f = await fixture(); await f.register(1);
  await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
  const gate = f.gateNextPage(1);
  const preparing = f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', refreshPage: true });
  await gate.reached.promise;
  Object.assign(f.tabs.get(1), { url: 'https://example.test/new', status: 'loading' });
  const cleared = f.waitForSession(data => data[`${TAB_CONTEXT_PREFIX}1`]?.url === 'https://example.test/new' && data[`${TAB_CONTEXT_PREFIX}1`]?.attachments.page === null);
  await f.api.tabs.onUpdated.emit(1, { status: 'loading', url: 'https://example.test/new' }, structuredClone(f.tabs.get(1)));
  gate.release.resolve();
  const result = await preparing;
  assert.equal(result.ok, false);
  assert.match(result.error, /跳转/);
  await cleared;
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}1`].attachments.page, null);
});

test('navigation to an unsupported source during fresh capture cannot become a partial send', async () => {
  for (const url of ['chrome://settings/', 'https://chatgpt.com/']) {
    const f = await fixture(); await f.register(1);
    await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
    const gate = f.gateNextPage(1);
    const preparing = f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET', refreshPage: true });
    await gate.reached.promise;
    Object.assign(f.tabs.get(1), { url, status: 'loading' });
    await f.api.tabs.onUpdated.emit(1, { status: 'loading', url }, structuredClone(f.tabs.get(1)));
    gate.release.resolve();
    const result = await preparing;
    assert.equal(result.ok, false);
    assert.match(result.error, /不支持/);
    const current = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
    assert.equal(current.context.attachments.page, null);
    assert.equal(composeContextPrompt('之后的普通问题', current.context, current.settings).text, '之后的普通问题');
  }
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
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}2`].selectionIncluded, true);
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

test('right-click installs a single open menu and preserves reference choices without capturing body', async () => {
  const f = await fixture(); await f.register(1); f.local[CONTEXT_SETTINGS_KEY] = { defaultSelection: false };
  await f.select(1, '选中文字'); await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  await f.api.runtime.onInstalled.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.menus.map(menu => [menu.id, menu.contexts]), [['sider-open-panel', ['all']]]);
  const tab = structuredClone(f.tabs.get(1));
  const captures = f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length;
  await f.api.contextMenus.onClicked.emit({ menuItemId: 'sider-open-panel', editable: true, frameId: 2 }, tab);
  assert.deepEqual(f.opened.at(-1), { tabId: 1 });
  assert.equal((await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' })).context.selectionIncluded, false);
  assert.equal(f.sent.filter(item => item.message.type === 'SIDER_PAGE_CAPTURE').length, captures);
  const opened = f.opened.length;
  await f.api.contextMenus.onClicked.emit({ menuItemId: 'sider-quote-page' }, tab);
  assert.equal(f.opened.length, opened);
});

test('floating opener calls sidePanel before asynchronous work and rejects nested or foreign senders', async () => {
  const f = await fixture(); await f.register(1); f.local[CONTEXT_SETTINGS_KEY] = { defaultSelection: false };
  await f.select(1, '保持未勾选'); await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  const tab = structuredClone(f.tabs.get(1));
  const sender = { id: f.api.runtime.id, url: tab.url, tab, frameId: 0 };
  const result = f.send({ type: 'SIDER_OPEN_PANEL', tabId: 2 }, sender);
  assert.deepEqual(f.opened.at(-1), { tabId: 1 });
  assert.equal((await result).ok, true);
  assert.equal((await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' })).context.selectionIncluded, false);
  const count = f.opened.length;
  assert.equal((await f.send({ type: 'SIDER_OPEN_PANEL' }, { ...sender, frameId: 1 })).ok, false);
  assert.equal((await f.send({ type: 'SIDER_OPEN_PANEL' }, { ...sender, id: 'foreign' })).ok, false);
  assert.equal(f.opened.length, count);
  f.api.sidePanel.open = async () => { throw new Error('打开失败'); };
  assert.deepEqual(await f.send({ type: 'SIDER_OPEN_PANEL' }, sender), { ok: false, error: '打开失败' });
});

test('floating toggle closes only its own panel, follows native close, and restores after worker restart', async () => {
  const f = await fixture();
  const sender = tabId => ({ id: f.api.runtime.id, url: f.tabs.get(tabId).url, tab: structuredClone(f.tabs.get(tabId)), frameId: 0 });
  const toggle = (tabId, opened = false) => f.send({ type: 'SIDER_TOGGLE_PANEL', tabId: 3, opened }, sender(tabId));
  const opening = toggle(1); assert.deepEqual(f.opened.at(-1), { tabId: 1 }); assert.equal((await opening).opened, true);
  await f.api.sidePanel.onOpened.emit({ tabId: 2, windowId: 9 });
  assert.deepEqual(await toggle(1), { ok: true, opened: false }); assert.deepEqual(f.closed, [{ tabId: 1 }]);
  assert.equal((await f.send({ type: 'SIDER_PANEL_STATE_GET' }, sender(2))).opened, true);
  await f.api.sidePanel.onClosed.emit({ tabId: 2, windowId: 9 });
  assert.equal((await toggle(2, true)).opened, true); // Native close supersedes a stale content hint.
  await new Promise(resolve => setImmediate(resolve)); await f.restart();
  assert.equal((await f.send({ type: 'SIDER_PANEL_STATE_GET' }, sender(2))).opened, true);
  assert.equal((await toggle(2)).opened, false);
  assert.equal((await toggle(2)).opened, true);
  f.api.sidePanel.close = async () => { throw new Error('关闭失败'); };
  assert.deepEqual(await toggle(2), { ok: false, error: '关闭失败' });
  assert.equal((await f.send({ type: 'SIDER_PANEL_STATE_GET' }, sender(2))).opened, true);
  assert.equal((await f.send({ type: 'SIDER_TOGGLE_PANEL' }, { ...sender(2), frameId: 1 })).ok, false);
});

test('selection shortcut and webpage button always attach even when the preset click action is send', async () => {
  const f = await fixture(); await f.register(1); f.local[CONTEXT_SETTINGS_KEY] = { defaultSelection: false };
  const presets = (await f.wrapped(1, { type: 'SIDER_PROMPT_TEMPLATES_GET' })).templates;
  f.local[UNIFIED_TEMPLATES_KEY] = presets.map(item => ({ ...item, action: 'send' }));
  const tab = f.tabs.get(1);
  await f.select(1, '快捷键划词');
  await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' });
  assert.equal(f.session[`${TAB_CONTEXT_PREFIX}1`].selectionIncluded, false);
  const included = f.waitForSession(data => data[`${TAB_CONTEXT_PREFIX}1`]?.selectionIncluded === true);
  await f.api.commands.onCommand.emit('capture-selection', structuredClone(tab)); await included;
  await f.select(1, '网页按钮划词');
  const opened = await f.send({ type: 'SIDER_OPEN_SOURCE_PANEL' }, { id: f.api.runtime.id, url: tab.url, tab: structuredClone(tab), frameId: 0 });
  assert.equal(opened.ok, true, opened.error); assert.equal(opened.context.selectionIncluded, true);
  const repeat = await f.wrapped(1, { type: 'SIDER_TAB_CONTEXT_GET' }); assert.equal(repeat.context.selectionIncluded, true);
  await f.select(1, null);
  const empty = await f.wrapped(1, { type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'selection', enabled: true });
  assert.equal(empty.ok, true); assert.equal(empty.context.selectionIncluded,true); assert.equal(empty.context.selection,null);
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
