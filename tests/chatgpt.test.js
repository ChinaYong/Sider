import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fillComposer, findComposer, getComposerText } from '../src/content/composer.js';
import { AI_WEB_SETTINGS_KEY, BUILTIN_AI_SITES, normalizeCustomAISite } from '../src/ai-web.js';

function page(html) {
  const dom = new JSDOM(html, { url: 'https://chatgpt.com/', pretendToBeVisual: true });
  // jsdom has no layout engine. Give attached elements browser-like geometry.
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return this.isConnected ? [{ x: 0, y: 0, width: 400, height: 80 }] : [];
  };
  return dom;
}

test('append preserves a textarea draft, emits input, and never submits or clicks Send', async () => {
  const dom = page('<main><form><textarea id="prompt-textarea">已有问题</textarea><button>Send</button></form></main>');
  const { document } = dom.window;
  const textarea = document.querySelector('textarea');
  let inputs = 0;
  let submissions = 0;
  let clicks = 0;
  textarea.addEventListener('input', () => inputs++);
  document.querySelector('form').addEventListener('submit', () => submissions++);
  document.querySelector('button').addEventListener('click', () => clicks++);
  const result = await fillComposer(document, '分析引用\n保留来源');
  assert.equal(result.ok, true);
  assert.equal(result.filled, true);
  assert.equal(textarea.value, '已有问题\n\n分析引用\n保留来源');
  assert.equal(textarea.selectionStart, textarea.value.length);
  assert.equal(inputs, 1);
  assert.equal(submissions, 0);
  assert.equal(clicks, 0);
  dom.window.close();
});

test('the native textarea setter bypasses a framework value tracker', async () => {
  const dom = page('<main><textarea id="prompt-textarea">草稿</textarea></main>');
  const { document, HTMLTextAreaElement } = dom.window;
  const textarea = document.querySelector('textarea');
  const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  let trackedWrites = 0;
  Object.defineProperty(textarea, 'value', {
    get() { return native.get.call(this); },
    set(value) { trackedWrites++; native.set.call(this, value); },
  });
  assert.equal((await fillComposer(document, '追加')).ok, true);
  assert.equal(trackedWrites, 0);
  assert.equal(textarea.value, '草稿\n\n追加');
  dom.window.close();
});

test('replace only occurs when explicitly requested', async () => {
  const dom = page('<main><textarea id="prompt-textarea">原草稿</textarea></main>');
  const result = await fillComposer(dom.window.document, '新问题', 'replace');
  assert.equal(result.ok, true);
  assert.equal(dom.window.document.querySelector('textarea').value, '新问题');
  dom.window.close();
});

test('a draft changed while expansion was prepared is preserved', async () => {
  const dom = page('<main><textarea id="prompt-textarea">刚刚修改的草稿</textarea></main>');
  const result = await fillComposer(dom.window.document, '已经展开的内容', 'replace', { expectedPrevious: '旧变量草稿' });
  assert.equal(result.ok, false);
  assert.equal(dom.window.document.querySelector('textarea').value, '刚刚修改的草稿');
  dom.window.close();
});

test('hidden and disabled editors are excluded from selection', () => {
  const dom = page('<main><textarea id="prompt-textarea" hidden>隐藏草稿</textarea><form><textarea disabled>禁用</textarea><textarea aria-disabled="true">禁用</textarea><textarea>可用</textarea></form></main>');
  assert.equal(findComposer(dom.window.document).value, '可用');
  dom.window.close();
});

test('an editor beneath a hidden ancestor is excluded', () => {
  const dom = page('<main><div style="display:none"><textarea id="prompt-textarea">隐藏</textarea></div><form><textarea>可用</textarea></form></main>');
  assert.equal(findComposer(dom.window.document).value, '可用');
  dom.window.close();
});

test('a canceled beforeinput leaves the existing draft intact', async () => {
  const dom = page('<main><textarea id="prompt-textarea">原草稿</textarea></main>');
  const textarea = dom.window.document.querySelector('textarea');
  textarea.addEventListener('beforeinput', (event) => event.preventDefault());
  const result = await fillComposer(dom.window.document, '引用');
  assert.equal(result.ok, false);
  assert.equal(textarea.value, '原草稿');
  dom.window.close();
});

test('read-back rejects a page that reverts an inserted value', async () => {
  const dom = page('<main><textarea id="prompt-textarea">原草稿</textarea></main>');
  const textarea = dom.window.document.querySelector('textarea');
  textarea.addEventListener('input', () => { textarea.value = '原草稿'; });
  const result = await fillComposer(dom.window.document, '引用');
  assert.equal(result.ok, false);
  assert.match(result.error, /未完整保留/);
  assert.equal(textarea.value, '原草稿');
  dom.window.close();
});

test('ProseMirror text preserves paragraph boundaries and blank paragraphs', () => {
  const dom = page('<main><div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p>第一段 <strong>强调</strong></p><p><br></p><p>第二段<br>下一行</p></div></main>');
  assert.equal(getComposerText(findComposer(dom.window.document)), '第一段 强调\n\n第二段\n下一行');
  dom.window.close();
});

test('contenteditable uses native editing, preserves draft paragraphs, and verifies the result', async () => {
  const dom = page('<main><form><div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p>旧段落一</p><p>旧段落二</p></div></form></main>');
  const { document } = dom.window;
  const editor = document.querySelector('.ProseMirror');
  let command;
  let input = 0;
  editor.addEventListener('input', () => input++);
  document.execCommand = (name, ui, text) => {
    command = name;
    assert.equal(document.getSelection().getRangeAt(0).commonAncestorContainer, editor);
    editor.replaceChildren(...text.split('\n').map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }));
    return true;
  };
  const result = await fillComposer(document, '引用内容');
  assert.equal(result.ok, true);
  assert.equal(command, 'insertText');
  assert.equal(input, 1);
  assert.equal(getComposerText(editor), '旧段落一\n旧段落二\n\n引用内容');
  dom.window.close();
});

test('unsupported rich editing returns an error without a cosmetic DOM rewrite', async () => {
  const dom = page('<main><div id="prompt-textarea" contenteditable="true"><p>原草稿</p></div></main>');
  const editor = dom.window.document.querySelector('#prompt-textarea');
  const original = editor.innerHTML;
  const result = await fillComposer(dom.window.document, '引用');
  assert.equal(result.ok, false);
  assert.equal(editor.innerHTML, original);
  dom.window.close();
});

test('waits for a composer added after the request', async () => {
  const dom = page('<main></main>');
  const pending = fillComposer(dom.window.document, '稍后加载的输入框', 'append', { timeoutMs: 500 });
  dom.window.setTimeout(() => {
    const editor = dom.window.document.createElement('textarea');
    editor.id = 'prompt-textarea';
    dom.window.document.querySelector('main').append(editor);
  }, 10);
  assert.equal((await pending).ok, true);
  assert.equal(dom.window.document.querySelector('textarea').value, '稍后加载的输入框');
  dom.window.close();
});

test('missing, empty, invalid, and concurrently edited composers do not report success', async () => {
  const dom = page('<main><textarea id="prompt-textarea">原草稿</textarea></main>');
  const { document } = dom.window;
  assert.equal((await fillComposer(document, '  ')).ok, false);
  assert.equal((await fillComposer(document, '引用', 'unknown')).ok, false);
  const [first, second] = await Promise.all([fillComposer(document, '一次'), fillComposer(document, '二次')]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(document.querySelector('textarea').value, '原草稿\n\n一次');
  document.querySelector('textarea').remove();
  assert.equal((await fillComposer(document, '引用', 'append', { timeoutMs: 10 })).ok, false);
  dom.window.close();
});

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    emit(...args) { for (const listener of listeners) listener(...args); },
  };
}

function chromeMock({ dnrGranted = true } = {}) {
  const values = {};
  const sessionValues = {};
  const sent = [];
  const opened = [];
  const behaviors = [];
  const injections = [];
  const accessRequests = [];
  const panelOptions = [];
  const ruleUpdates = [];
  const sessionRules = new Map();
  const control = { dnrGranted, chatGranted: true, originGranted: true, injectError: null, failRuleUpdates: false, cleanupGate: null, scriptError: false };
  const scripts = new Map();
  const source = { id: 1, windowId: 9, url: 'https://article.test/story', title: '来源', active: true, status: 'complete' };
  const chat = { id: 2, windowId: 9, url: 'https://chatgpt.com/', active: false, status: 'complete' };
  const tabs = new Map([[1, source], [2, chat]]);
  const selections = new Map([[1, { kind: 'selection', title: source.title, url: source.url, content: '网页引用', context: '' }]]);
  const api = {
    runtime: {
      id: 'sider-test',
      getURL(path) { return `chrome-extension://sider-test/${path.replace(/^\//, '')}`; },
      onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event(),
    },
    storage: { onChanged: event(), session: {
      async get(key) { return { [key]: sessionValues[key] }; },
      async set(data) { Object.assign(sessionValues, structuredClone(data)); api.storage.onChanged.emit(Object.fromEntries(Object.entries(data).map(([key,value]) => [key,{newValue:structuredClone(value)}])), 'session'); },
      async remove(key) { delete sessionValues[key]; api.storage.onChanged.emit({ [key]: {} }, 'session'); },
    }, local: {
      async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, values[name]])); },
      async set(data) { Object.assign(values, structuredClone(data)); api.storage.onChanged.emit(Object.fromEntries(Object.entries(data).map(([key,value]) => [key,{newValue:structuredClone(value)}])), 'local'); },
    } },
    tabs: {
      onCreated: event(), onActivated: event(), onUpdated: event(), onRemoved: event(),
      async get(id) { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id); },
      async query(query) {
        if (query.url === 'https://chatgpt.com/*') return [chat];
        return [...tabs.values()].filter((tab) => (!query.active || tab.active) && (query.windowId == null || tab.windowId === query.windowId) && (!query.lastFocusedWindow || tab.windowId === 9));
      },
      async update(id, changes) { Object.assign(tabs.get(id), changes); return tabs.get(id); },
      async create(properties) { const tab = { id: 3, windowId: 9, status: 'complete', ...properties }; tabs.set(tab.id, tab); return tab; },
      async sendMessage(tabId, message, options) {
        sent.push({ tabId, message, options });
        if (message.type === 'SIDER_CHAT_FILL') return { ok: true, filled: true };
        if (message.type === 'SIDER_PAGE_SELECTION_GET') return { ok: true, source: { url: tabs.get(tabId).url, title: tabs.get(tabId).title }, reference: selections.get(tabId) || null };
        if (message.type === 'SIDER_PAGE_CLEAR_SELECTION') { selections.delete(tabId); return { ok: true }; }
        if (message.type === 'SIDER_PAGE_CAPTURE') return { ok: true, reference: { kind: message.kind, title: '来源', url: tabs.get(tabId).url, content: '网页引用' } };
        return { ok: true };
      },
    },
    windows: { onRemoved: event(), async getLastFocused() { return { id: 9 }; }, async update() {} },
    action: { onClicked: event() },
    sidePanel: { async setOptions(options) { panelOptions.push(options); }, async setPanelBehavior(options) { behaviors.push(options); }, open(properties) { opened.push(properties); return Promise.resolve(); } },
    contextMenus: { onClicked: event(), async removeAll() {}, create() {} },
    commands: { onCommand: event() },
    scripting: { async executeScript(options) { injections.push(options); if (control.injectError) throw new Error(control.injectError); return []; }, async getRegisteredContentScripts() { return [...scripts.values()].map(script => structuredClone(script)); }, async registerContentScripts(entries) { if (control.scriptError) throw new Error('Script registration failed'); for (const entry of entries) scripts.set(entry.id, structuredClone(entry)); }, async unregisterContentScripts({ ids }) { for (const id of ids) scripts.delete(id); } },
    permissions: {
      onRemoved: event(),
      async contains(request) {
        if (request.permissions?.includes('declarativeNetRequestWithHostAccess')) return control.dnrGranted;
        if (request.origins?.includes('https://chatgpt.com/*')) return control.chatGranted;
        return request.origins ? control.originGranted : true;
      },
      async addHostAccessRequest(request) { accessRequests.push(request); },
    },
    declarativeNetRequest: {
      async getSessionRules() { return [...sessionRules.values()].map(rule => structuredClone(rule)); },
      async updateSessionRules(options) {
        ruleUpdates.push(structuredClone(options));
        if (control.cleanupGate && !options.addRules?.length) {
          const gate = control.cleanupGate;
          control.cleanupGate = null;
          await gate;
        }
        if (control.failRuleUpdates) throw new Error('模拟规则安装失败');
        for (const id of options.removeRuleIds || []) sessionRules.delete(id);
        for (const rule of options.addRules || []) sessionRules.set(rule.id, structuredClone(rule));
      },
    },
  };
  return { api, values, sessionValues, sent, opened, behaviors, injections, accessRequests, panelOptions, source, chat, tabs, selections, ruleUpdates, sessionRules, control, scripts };
}

let aiWorkerSequence = 0;
async function aiWorker(t) {
  const mock = chromeMock(); globalThis.chrome = mock.api;
  await import(`../src/background.js?ai-web=${++aiWorkerSequence}`);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const sender = { id: mock.api.runtime.id, url: mock.api.runtime.getURL('panel.html') };
  const send = (message, source = sender) => new Promise(resolve => listener(message, source, resolve));
  await send({ type: 'SIDER_EMBED_STATUS_GET', bridgeId: 'no-owner-yet-0001' });
  t.after(() => { delete globalThis.chrome; });
  return { ...mock, send };
}

test('AI settings are privileged, require the selected origin, and preserve existing reference settings', async t => {
  const f = await aiWorker(t);
  const source = { id: f.api.runtime.id, url: f.source.url, tab: f.source, frameId: 0 };
  assert.equal((await f.send({ type: 'SIDER_AI_WEB_SETTINGS_GET' }, source)).ok, false);
  f.values['sider.contextSettings.v1'] = { selectionTemplate: 'Keep me' };
  f.control.originGranted = false;
  const settings = { activeSiteId: 'gemini', customSites: [] };
  assert.equal((await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings })).ok, false);
  assert.equal(f.values[AI_WEB_SETTINGS_KEY], undefined);
  f.control.originGranted = true;
  assert.equal((await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings })).ok, true);
  assert.equal(f.values[AI_WEB_SETTINGS_KEY].activeSiteId, 'gemini');
  assert.equal(f.values['sider.contextSettings.v1'].selectionTemplate, 'Keep me');
  assert.ok([...f.scripts.values()].some(script => script.matches[0] === 'https://gemini.google.com/*'));
  const drop = [...f.scripts.values()].find(script => script.matches[0] === 'https://gemini.google.com/*' && script.world === 'MAIN');
  assert.deepEqual(drop.js, ['file-drop-main.js']); assert.equal(drop.runAt, 'document_start'); assert.equal(drop.allFrames, true);
});

test('Gemini pages can read only the saved default model settings', async t => {
  const f = await aiWorker(t);
  const saved = await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: { activeSiteId: 'gemini', customSites: [], geminiModel: 'pro', geminiExtendedThinking: true } });
  assert.equal(saved.ok, true);
  const source = { id: f.api.runtime.id, url: 'https://gemini.google.com/app', frameId: 0 };
  const result = await f.send({ type: 'SIDER_GEMINI_DEFAULTS_GET' }, source);
  assert.deepEqual(result, { ok: true, settings: { geminiModel: 'pro', geminiExtendedThinking: true } });
});

test('opening Gemini uses the persisted Spark entry URL', async t => {
  const f = await aiWorker(t);
  const saved = await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: { activeSiteId: 'gemini', customSites: [], geminiMode: 'spark' } });
  assert.equal(saved.ok, true);
  const opened = await f.send({ type: 'SIDER_CHAT_OPEN', siteId: 'gemini' });
  assert.equal(opened.ok, true);
  assert.equal(new URL(f.tabs.get(opened.tabId).url).pathname, '/spark');
});

test('different AI sites keep distinct compatibility rules and cannot use another site bridge', async t => {
  const f = await aiWorker(t);
  const chatBridge = 'ai-chat-owner-abcdef0123456789'; const geminiBridge = 'ai-gemini-owner-abcdef0123456789';
  await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId: chatBridge, siteId: 'chatgpt', tabId: 1, windowId: 9 });
  await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: { activeSiteId: 'gemini', customSites: [] } });
  await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId: geminiBridge, siteId: 'gemini', tabId: 1, windowId: 9 });
  assert.equal(f.sessionRules.size, 2);
  for (const rule of f.sessionRules.values()) {
    assert.deepEqual(rule.condition.topDomains, [f.api.runtime.id]); assert.deepEqual(rule.condition.resourceTypes, ['sub_frame']);
  }
  const request = { type: 'SIDER_ENHANCEMENT_REQUEST', embedded: true, bridgeId: geminiBridge, request: { type: 'SIDER_TAB_CONTEXT_GET' } };
  const wrong = await f.send(request, { id: f.api.runtime.id, url: `https://chatgpt.com/?sider_bridge=${geminiBridge}`, frameId: 1 });
  assert.equal(wrong.ok, false);
  const correct = await f.send(request, { id: f.api.runtime.id, url: `https://gemini.google.com/app?sider_bridge=${geminiBridge}`, documentId: 'gemini-current', frameId: 1 });
  assert.equal(correct.ok, true); assert.equal(correct.context.tabId, 1);
  await f.send({ type: 'SIDER_EMBED_UNREGISTER', bridgeId: geminiBridge });
  assert.equal(f.sessionRules.size, 1); assert.equal([...f.sessionRules.values()][0].condition.requestDomains[0], 'chatgpt.com');
});

test('lifecycle reconnection retains readiness for an already connected AI document', async t => {
  const f = await aiWorker(t); const bridgeId = 'existing-ai-document-abcdef0123456789';
  await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId, siteId: 'chatgpt', tabId: 1, windowId: 9 });
  const port = { name: 'sider-chat-bridge', sender: { id: f.api.runtime.id, url: `https://chatgpt.com/?sider_bridge=${bridgeId}`, documentId: 'existing-document', frameId: 1 }, onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} };
  f.api.runtime.onConnect.emit(port); port.onMessage.emit({ type: 'SIDER_CHAT_READY', bridgeId, embedded: true });
  await new Promise(resolve => setImmediate(resolve));
  port.onMessage.emit({ type: 'SIDER_ENHANCEMENT_READY', bridgeId, ready: true }); await new Promise(resolve => setImmediate(resolve));
  await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId, siteId: 'chatgpt', tabId: 1, windowId: 9, reuseSite: true });
  const status = await f.send({ type: 'SIDER_EMBED_STATUS_GET', bridgeId });
  assert.equal(status.connected, true); assert.equal(status.enhancementReady, true);
});

test('a custom AI port arriving during worker settings restoration waits for the registered origin', async t => {
  const mock = chromeMock(); globalThis.chrome = mock.api;
  const site = normalizeCustomAISite({ id: 'custom-startup-test-0001', name: 'Startup AI', url: 'https://startup-ai.test/chat' });
  const bridgeId = 'startup-owner-abcdef0123456789';
  mock.values[AI_WEB_SETTINGS_KEY] = { activeSiteId: site.id, customSites: [site] };
  mock.sessionValues.siderEmbedRegistrations = { [bridgeId]: { windowId: 9, tabId: 1, site } };
  const original = mock.api.storage.local.get; let release;
  mock.api.storage.local.get = key => key === AI_WEB_SETTINGS_KEY ? new Promise(resolve => { release = () => resolve({ [key]: mock.values[key] }); }) : original(key);
  await import(`../src/background.js?early-ai-web=${++aiWorkerSequence}`);
  let disconnected = false;
  const port = { name: 'sider-chat-bridge', sender: { id: mock.api.runtime.id, url: `${site.url}?sider_bridge=${bridgeId}`, documentId: 'early-custom-document', frameId: 1 }, onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() { disconnected = true; } };
  mock.api.runtime.onConnect.emit(port); port.onMessage.emit({ type: 'SIDER_CHAT_READY', bridgeId, embedded: true });
  release();
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const result = await new Promise(resolve => listener({ type: 'SIDER_EMBED_STATUS_GET', bridgeId }, { id: mock.api.runtime.id, url: mock.api.runtime.getURL('panel.html') }, resolve));
  assert.equal(disconnected, false); assert.equal(result.connected, true);
  t.after(() => { delete globalThis.chrome; });
});

test('failed custom script registration leaves saved AI settings intact', async t => {
  const f = await aiWorker(t);
  const site = normalizeCustomAISite({ id: 'custom-script-test-0001', name: 'My AI', url: 'https://my-ai.test/chat' });
  f.control.scriptError = true;
  const failed = await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: { activeSiteId: site.id, customSites: [site] } });
  assert.equal(failed.ok, false); assert.equal(f.values[AI_WEB_SETTINGS_KEY], undefined);
  assert.equal((await f.send({ type: 'SIDER_AI_WEB_SETTINGS_GET' })).settings.activeSiteId, 'chatgpt');
});

test('editing a custom website origin keeps an existing sidebars origin registered until it reloads', async t => {
  const f = await aiWorker(t);
  const site = normalizeCustomAISite({ id: 'custom-origin-test-0001', name: 'My AI', url: 'https://old-ai.test/chat' });
  const settings = { activeSiteId: site.id, customSites: [site] };
  await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings });
  const bridgeId = 'custom-site-owner-abcdef0123456789';
  await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId, siteId: site.id, tabId: 1, windowId: 9 });
  const next = normalizeCustomAISite({ ...site, url: 'https://new-ai.test/chat' });
  await f.send({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: { activeSiteId: site.id, customSites: [next] } });
  assert.ok([...f.scripts.values()].some(script => script.matches[0] === 'https://old-ai.test/*'));
  assert.ok([...f.scripts.values()].some(script => script.matches[0] === 'https://new-ai.test/*'));
  const reconnect = await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId, siteId: site.id, tabId: 1, windowId: 9, reuseSite: true });
  assert.equal(reconnect.site.origin, 'https://old-ai.test');
  const reload = await f.send({ type: 'SIDER_EMBED_REGISTER', bridgeId, siteId: site.id, tabId: 1, windowId: 9 });
  assert.equal(reload.site.origin, 'https://new-ai.test');
});

test('background isolates page content scripts from state mutation and ChatGPT filling', async () => {
  const mock = chromeMock();
  globalThis.chrome = mock.api;
  await import(`../src/background.js?boundary=${Date.now()}`);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const send = (message, sender) => new Promise((resolve) => listener(message, sender, resolve));
  const webpage = { id: 'sider-test', url: mock.source.url, tab: mock.source, frameId: 0 };
  const extension = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  for (const type of ['SIDER_CHAT_FILL', 'SIDER_STATE_PATCH', 'SIDER_REMOVE_REFERENCE', 'SIDER_REFERENCE_SELECTION', 'SIDER_ENABLE_SITE', 'SIDER_CHAT_READY', 'SIDER_EMBED_REGISTER', 'SIDER_EMBED_UNREGISTER']) {
    const result = await send({ type, text: '恶意页面内容', patch: { draft: '恶意草稿' } }, webpage);
    assert.equal(result.ok, false);
    assert.match(result.error, /拒绝/);
  }
  assert.equal(mock.sent.length, 0);
  assert.equal(Object.keys(mock.values).length, 0);

  const forged = await send({ type: 'SIDER_SELECTION_CHANGED', source: { url: mock.source.url }, reference: { kind: 'selection', url: 'https://other.test/', content: '伪造来源' } }, webpage);
  assert.equal(forged.ok, false);
  const raw = { kind: 'selection', url: mock.source.url, title: '来源', content: '引用内容' };
  mock.selections.set(1, raw);
  const added = await send({ type: 'SIDER_SELECTION_CHANGED', source: { url: mock.source.url }, reference: raw }, webpage);
  assert.equal(added.ok, true);
  assert.equal(added.context.selection.content, '引用内容');
  await send({ type: 'SIDER_OPEN_SOURCE_PANEL' }, webpage);
  assert.deepEqual(mock.opened, [{ tabId: 1 }]);
  await send({ type: 'SIDER_TAB_CONTEXT_GET', tabId: 1 }, extension);
  const filled = await send({ type: 'SIDER_CHAT_FILL', text: '可信提示词' }, extension);
  assert.equal(filled.ok, true);
  assert.equal(filled.embedded, false);
  assert.equal(filled.tabId, 2);
  assert.equal(mock.sent.at(-1).message.mode, 'append');
  assert.equal(mock.sent.at(-1).options.frameId, 0);
  delete globalThis.chrome;
});

test('background rejects default capture from a ChatGPT tab and opens the panel synchronously on shortcuts', async () => {
  const mock = chromeMock();
  globalThis.chrome = mock.api;
  await import(`../src/background.js?capture=${Date.now()}`);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const send = (message) => new Promise((resolve) => listener(message, { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') }, resolve));
  mock.source.active = false;
  mock.chat.active = true;
  const result = await send({ type: 'SIDER_CAPTURE', kind: 'page' });
  assert.equal(result.ok, false);
  assert.match(result.error, /切回/);
  mock.source.active = true;
  mock.chat.active = false;
  mock.api.commands.onCommand.emit('capture-selection', mock.source);
  assert.equal(mock.opened.length, 1);
  // Waiting on the same source queue flushes the shortcut and its source sync.
  await send({ type: 'SIDER_TAB_CONTEXT_GET', tabId: 1 });
  assert.equal(mock.sent[0].message.type, 'SIDER_PAGE_SELECTION_GET');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const before = mock.sent.length;
  const previousURL = mock.source.url;
  delete mock.source.url; // Chrome hides URL metadata for an ungranted active tab.
  const unauthorized = await send({ type: 'SIDER_CAPTURE', kind: 'page' });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.error, /授权/);
  assert.equal(unauthorized.code, 'SOURCE_ACCESS_REQUIRED');
  assert.equal(mock.sent.length, before); // The cached previous source must not be captured.
  mock.source.url = previousURL;
  delete globalThis.chrome;
});

test('toolbar actions open the panel synchronously and prepare the invoked source for later sidebar capture', async t => {
  const mock = chromeMock(); globalThis.chrome = mock.api;
  t.after(() => { delete globalThis.chrome; });
  await import(`../src/background.js?action-click=${Date.now()}`);
  assert.deepEqual(mock.behaviors, [{ openPanelOnActionClick: false }]);
  mock.api.action.onClicked.emit(mock.source);
  assert.deepEqual(mock.opened, [{ tabId: 1 }]);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const sender = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  const result = await new Promise(resolve => listener({ type: 'SIDER_TAB_CONTEXT_GET', tabId: 1 }, sender, resolve));
  assert.equal(result.ok, true);
  assert.equal(mock.injections[0].target.tabId, 1);
  assert.deepEqual(mock.injections[0].files, ['page-content.js']);
  assert.ok(mock.panelOptions.some(options => options.tabId === 1 && options.path === 'panel.html?sourceTab=1'));
  assert.ok(mock.panelOptions.some(options => options.tabId == null && options.enabled === false));
  assert.equal(mock.sent.at(-1).tabId, 1);
  mock.api.action.onClicked.emit(mock.chat);
  assert.equal(mock.injections.length, 1); // The ChatGPT tab isn't a source to inject.
});

test('an unexposed source URL can request site access in its own window without reading an older tab', async t => {
  const mock = chromeMock(); globalThis.chrome = mock.api;
  t.after(() => { delete globalThis.chrome; });
  await import(`../src/background.js?source-access=${Date.now()}`);
  mock.control.originGranted = false;
  const ungranted = { id: 30, windowId: 10, active: true, status: 'complete' };
  mock.tabs.set(30, ungranted);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const extension = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  const send = (message, sender = extension) => new Promise(resolve => listener(message, sender, resolve));
  const blocked = await send({ type: 'SIDER_CAPTURE', kind: 'page', windowId: 10 });
  assert.equal(blocked.code, 'SOURCE_ACCESS_REQUIRED');
  assert.equal(mock.sent.length, 0);
  const info = await send({ type: 'SIDER_SOURCE_INFO', windowId: 10 });
  assert.equal(info.ok, true); assert.equal(info.source.tabId, 30);
  assert.equal(info.source.url, null); assert.equal(info.source.needsAccess, true);
  const requested = await send({ type: 'SIDER_SOURCE_ACCESS_REQUEST', windowId: 10 });
  assert.equal(requested.requested, true);
  assert.deepEqual(mock.accessRequests, [{ tabId: 30 }]);
  assert.equal((await send({ type: 'SIDER_SOURCE_ACCESS_REQUEST', windowId: 10 }, { id: 'sider-test', url: mock.source.url, tab: mock.source })).ok, false);
  assert.equal(mock.accessRequests.length, 1);
  ungranted.url = 'https://new-site.test/article';
  const captured = await send({ type: 'SIDER_CAPTURE', kind: 'url', windowId: 10 });
  // Verify the selected window's tab, independent of the last focused window.
  assert.equal(mock.sent.at(-1).tabId, 30);
  assert.equal(captured.ok, true); assert.equal(captured.reference.url, ungranted.url);
});

test('missing scripting permission offers authorization while other injection errors retain their cause', async t => {
  const mock = chromeMock(); globalThis.chrome = mock.api;
  t.after(() => { delete globalThis.chrome; });
  await import(`../src/background.js?injection-errors=${Date.now()}`);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const sender = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  const send = () => new Promise(resolve => listener({ type: 'SIDER_CAPTURE', kind: 'page', windowId: 9 }, sender, resolve));
  mock.control.injectError = 'Cannot access contents of url. Extension manifest must request permission.';
  assert.equal((await send()).code, 'SOURCE_ACCESS_REQUIRED');
  mock.control.injectError = 'The tab was closed.';
  const closed = await send(); assert.match(closed.error, /tab was closed/); assert.equal(closed.code, undefined);
  assert.equal(mock.sent.length, 0);
});

test('embedded bridges validate sender origin and failed embeds fall back to a normal tab', async () => {
  const mock = chromeMock();
  globalThis.chrome = mock.api;
  await import(`../src/background.js?bridge=${Date.now()}`);
  let rejected = false;
  mock.api.runtime.onConnect.emit({ name: 'sider-chat-bridge', sender: { id: 'sider-test', url: 'https://evil.test/' }, disconnect() { rejected = true; } });
  assert.equal(rejected, true);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const extension = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  const send = (message) => new Promise((resolve) => listener(message, extension, resolve));
  const bridgeId = 'a14bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  assert.equal((await send({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId: 9 })).ok, true);
  const onMessage = event();
  const onDisconnect = event();
  let embeddedAttempts = 0;
  const port = {
    name: 'sider-chat-bridge', sender: { id: 'sider-test', url: `https://chatgpt.com/?sider_bridge=${bridgeId}`, frameId: 1 },
    onMessage, onDisconnect, disconnect() {},
    postMessage(message) {
      embeddedAttempts++;
      queueMicrotask(() => onMessage.emit({ type: 'SIDER_CHAT_RESULT', requestId: message.requestId, ok: false, error: '输入框不可用' }));
    },
  };
  mock.api.runtime.onConnect.emit(port);
  onMessage.emit({ type: 'SIDER_CHAT_READY', embedded: true, bridgeId });
  const result = await send({ type: 'SIDER_CHAT_FILL', text: '引用', bridgeId });
  assert.equal(embeddedAttempts, 1);
  assert.equal(result.ok, true);
  assert.equal(result.embedded, false);
  assert.equal(result.tabId, 2);
  await send({ type: 'SIDER_EMBED_UNREGISTER', bridgeId });
  onDisconnect.emit();
  delete globalThis.chrome;
});

test('verified sidebar fills use their port and never a sidebar in another browser window', async () => {
  const mock = chromeMock();
  globalThis.chrome = mock.api;
  await import(`../src/background.js?windows=${Date.now()}`);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const extension = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  const send = (message) => new Promise((resolve) => listener(message, extension, resolve));
  const currentBridge = 'c14bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  const otherBridge = 'e14bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  await send({ type: 'SIDER_EMBED_REGISTER', bridgeId: currentBridge, windowId: 9 });
  await send({ type: 'SIDER_EMBED_REGISTER', bridgeId: otherBridge, windowId: 10 });
  const received = [];
  function makePort(windowId, bridgeId) {
    const onMessage = event();
    const onDisconnect = event();
    return {
      name: 'sider-chat-bridge', sender: { id: 'sider-test', url: `https://chatgpt.com/?sider_bridge=${bridgeId}`, tab: { id: 1, windowId }, frameId: 1 },
      onMessage, onDisconnect, disconnect() {},
      postMessage(message) {
        received.push(windowId);
        queueMicrotask(() => onMessage.emit({ type: 'SIDER_CHAT_RESULT', requestId: message.requestId, ok: true, filled: true }));
      },
    };
  }
  const otherWindow = makePort(10, otherBridge);
  const currentWindow = makePort(9, currentBridge);
  mock.api.runtime.onConnect.emit(otherWindow);
  otherWindow.onMessage.emit({ type: 'SIDER_CHAT_READY', embedded: true, bridgeId: otherBridge });
  mock.api.runtime.onConnect.emit(currentWindow);
  currentWindow.onMessage.emit({ type: 'SIDER_CHAT_READY', embedded: true, bridgeId: currentBridge });
  const result = await send({ type: 'SIDER_CHAT_FILL', text: '本窗口引用', bridgeId: currentBridge });
  assert.equal(result.ok, true);
  assert.equal(result.embedded, true);
  assert.deepEqual(received, [9]);
  assert.equal(mock.sent.length, 0);
  const crossWindow = await send({ type: 'SIDER_CHAT_FILL', text: '不应进入另一窗口', bridgeId: otherBridge });
  assert.equal(crossWindow.embedded, false);
  assert.deepEqual(received, [9]);
  await send({ type: 'SIDER_EMBED_UNREGISTER', bridgeId: currentBridge });
  const unregistered = await send({ type: 'SIDER_CHAT_FILL', text: '未登记侧栏不得优先', bridgeId: currentBridge });
  assert.equal(unregistered.embedded, false);
  assert.deepEqual(received, [9]);
  await send({ type: 'SIDER_EMBED_UNREGISTER', bridgeId: otherBridge });
  currentWindow.onDisconnect.emit();
  otherWindow.onDisconnect.emit();
  delete globalThis.chrome;
});

test('missing embed or ChatGPT host permission produces an actionable error', async () => {
  const mock = chromeMock({ dnrGranted: false });
  globalThis.chrome = mock.api;
  await import(`../src/background.js?optional=${Date.now()}`);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const sender = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  const send = (message) => new Promise((resolve) => listener(message, sender, resolve));
  const bridgeId = 'f14bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  assert.equal(mock.sessionRules.size, 0);
  assert.equal(mock.ruleUpdates.length, 0);
  const ungranted = await send({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId: 9 });
  assert.equal(ungranted.ok, false);
  assert.match(ungranted.error, /尚未授权/);
  assert.equal(mock.ruleUpdates.length, 0);
  mock.control.dnrGranted = true;
  mock.control.chatGranted = false;
  const noHost = await send({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId: 9 });
  assert.equal(noHost.ok, false);
  assert.match(noHost.error, /chatgpt.com/);
  assert.equal(mock.ruleUpdates.length, 0);
  mock.control.chatGranted = true;
  assert.equal((await send({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId: 9 })).ok, true);
  assert.equal(mock.sessionRules.size, 1);
  await send({ type: 'SIDER_EMBED_UNREGISTER', bridgeId });
  assert.equal(mock.sessionRules.size, 0);
  delete globalThis.chrome;
});

test('compatibility uses one narrowly scoped session rule and removes it after the last owner closes', async () => {
  const mock = chromeMock();
  globalThis.chrome = mock.api;
  await import(`../src/background.js?rule=${Date.now()}`);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const sender = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  const send = (message) => new Promise((resolve) => listener(message, sender, resolve));
  const first = 'a24bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  const second = 'b24bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  await send({ type: 'SIDER_EMBED_REGISTER', bridgeId: first, windowId: 9 });
  await send({ type: 'SIDER_EMBED_REGISTER', bridgeId: second, windowId: 10 });
  assert.equal(mock.sessionRules.size, 1);
  const rule = [...mock.sessionRules.values()][0];
  assert.deepEqual(rule.condition, {
    urlFilter: '|https://chatgpt.com/',
    requestDomains: ['chatgpt.com'],
    topDomains: ['sider-test'],
    resourceTypes: ['sub_frame'],
  });
  assert.deepEqual(rule.action, {
    type: 'modifyHeaders',
    responseHeaders: [
      { header: 'content-security-policy', operation: 'remove' },
      { header: 'x-frame-options', operation: 'remove' },
    ],
  });
  assert.equal(mock.ruleUpdates.filter((update) => update.addRules.length).length, 1);
  await send({ type: 'SIDER_EMBED_UNREGISTER', bridgeId: first });
  assert.equal(mock.sessionRules.size, 1);
  await send({ type: 'SIDER_EMBED_UNREGISTER', bridgeId: second });
  assert.equal(mock.sessionRules.size, 0);
  assert.deepEqual(mock.ruleUpdates.at(-1), { removeRuleIds: [rule.id], addRules: [] });
  delete globalThis.chrome;
});

test('a rejected rule installation neither registers the bridge nor retries with broader rules', async () => {
  const mock = chromeMock();
  globalThis.chrome = mock.api;
  await import(`../src/background.js?rulefailure=${Date.now()}`);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const sender = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  const send = (message) => new Promise((resolve) => listener(message, sender, resolve));
  const bridgeId = 'c24bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  mock.control.failRuleUpdates = true;
  const failed = await send({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId: 9 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /规则安装失败/);
  assert.equal(mock.sessionRules.size, 0);
  assert.equal(mock.ruleUpdates.filter((update) => update.addRules.length).length, 1);
  let embeddedMessages = 0;
  const port = {
    name: 'sider-chat-bridge', sender: { id: 'sider-test', url: `https://chatgpt.com/?sider_bridge=${bridgeId}` },
    onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage() { embeddedMessages++; },
  };
  mock.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'SIDER_CHAT_READY', embedded: true, bridgeId });
  const fallback = await send({ type: 'SIDER_CHAT_FILL', text: '草稿', bridgeId });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.embedded, false);
  assert.equal(embeddedMessages, 0);
  port.onDisconnect.emit();
  delete globalThis.chrome;
});

test('worker startup leaves session rules intact and registration replaces an obsolete rule', async () => {
  const mock = chromeMock();
  let releaseCleanup;
  mock.control.cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  mock.sessionRules.set(731001, { id: 731001, stale: true });
  globalThis.chrome = mock.api;
  await import(`../src/background.js?initialization=${Date.now()}`);
  const listener = [...mock.api.runtime.onMessage.listeners][0];
  const sender = { id: 'sider-test', url: mock.api.runtime.getURL('panel.html') };
  const send = (message) => new Promise((resolve) => listener(message, sender, resolve));
  const bridgeId = 'd24bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  let settled = false;
  const registration = send({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId: 9 }).then((result) => { settled = true; return result; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.ok(mock.ruleUpdates.every(update => update.addRules.length > 0));
  releaseCleanup();
  assert.equal((await registration).ok, true);
  assert.equal(mock.ruleUpdates.length, 1);
  assert.equal(mock.ruleUpdates[0].addRules.length, 1);
  assert.equal(mock.sessionRules.get(731001).stale, undefined);
  assert.deepEqual(mock.sessionRules.get(731001).condition.resourceTypes, ['sub_frame']);
  await send({ type: 'SIDER_EMBED_UNREGISTER', bridgeId });
  delete globalThis.chrome;
});

test('iframe port navigation retains compatibility, while closing its owning panel removes it', async () => {
  const mock=chromeMock();globalThis.chrome=mock.api;
  await import(`../src/background.js?panel-lifecycle=${Date.now()}`);
  const listener=[...mock.api.runtime.onMessage.listeners][0];
  const extension={id:'sider-test',url:mock.api.runtime.getURL('panel.html')};
  const send=message=>new Promise(resolve=>listener(message,extension,resolve));
  const bridgeId='f34bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  await send({type:'SIDER_EMBED_REGISTER',bridgeId,windowId:9});
  const frame={name:'sider-chat-bridge',sender:{id:'sider-test',url:`https://chatgpt.com/?sider_bridge=${bridgeId}`},onMessage:event(),onDisconnect:event(),postMessage(){},disconnect(){}};
  mock.api.runtime.onConnect.emit(frame);frame.onMessage.emit({type:'SIDER_CHAT_READY',bridgeId,embedded:true});frame.onMessage.emit({type:'SIDER_ENHANCEMENT_READY',bridgeId,ready:true});
  assert.equal((await send({type:'SIDER_EMBED_STATUS_GET',bridgeId})).enhancementReady,true);
  const panel={name:'sider-panel-lifecycle',sender:extension,onMessage:event(),onDisconnect:event(),postMessage(){},disconnect(){}};
  mock.api.runtime.onConnect.emit(panel);panel.onMessage.emit({type:'SIDER_PANEL_ATTACH',bridgeId});
  await new Promise(resolve=>setImmediate(resolve));
  frame.onDisconnect.emit();
  const afterNavigation=await send({type:'SIDER_EMBED_STATUS_GET',bridgeId});
  assert.equal(afterNavigation.connected,false);assert.equal(afterNavigation.registered,true);assert.equal(mock.sessionRules.size,1);
  panel.onDisconnect.emit();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await send({type:'SIDER_EMBED_STATUS_GET',bridgeId})).registered,false);
  assert.equal(mock.sessionRules.size,0);delete globalThis.chrome;
});

test('worker restart restores live registrations and rules instead of deleting them', async () => {
  const mock=chromeMock();globalThis.chrome=mock.api;
  await import(`../src/background.js?worker-before=${Date.now()}`);
  const extension={id:'sider-test',url:mock.api.runtime.getURL('panel.html')};
  let listener=[...mock.api.runtime.onMessage.listeners][0];
  const send=message=>new Promise(resolve=>listener(message,extension,resolve));
  const bridgeId='a44bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  await send({type:'SIDER_EMBED_REGISTER',bridgeId,windowId:9});
  const before=mock.ruleUpdates.length;
  mock.api.runtime.onMessage.listeners.clear();mock.api.runtime.onConnect.listeners.clear();
  await import(`../src/background.js?worker-after=${Date.now()}`);
  listener=[...mock.api.runtime.onMessage.listeners][0];
  const restored=await send({type:'SIDER_EMBED_STATUS_GET',bridgeId});
  assert.equal(restored.registered,true);assert.equal(restored.compatibility,true);
  assert.equal(mock.ruleUpdates.length,before);
  await send({type:'SIDER_EMBED_UNREGISTER',bridgeId});delete globalThis.chrome;
});

test('embedded enhancement commands are limited and source context is bound to the owning tab', async () => {
  const mock=chromeMock();globalThis.chrome=mock.api;
  await import(`../src/background.js?enhancement-boundary=${Date.now()}`);
  const listener=[...mock.api.runtime.onMessage.listeners][0];
  const extension={id:'sider-test',url:mock.api.runtime.getURL('panel.html')};
  const send=(message,sender=extension)=>new Promise(resolve=>listener(message,sender,resolve));
  const bridgeId='b44bbf38-1629-4a5f-a5a1-a0a5d7fe2192';
  await send({type:'SIDER_EMBED_REGISTER',bridgeId,windowId:9,tabId:1});
  const frame={id:'sider-test',url:`https://chatgpt.com/?sider_bridge=${bridgeId}`,tab:{id:2,windowId:9}};
  const wrapper=request=>({type:'SIDER_ENHANCEMENT_REQUEST',bridgeId,embedded:true,request});
  assert.equal((await send(wrapper({type:'SIDER_CHAT_FILL',text:'不能填入其他会话'}),frame)).ok,false);
  assert.equal((await send({...wrapper({type:'SIDER_TAB_CONTEXT_GET'}),embedded:false},frame)).ok,false);
  assert.equal((await send(wrapper({type:'SIDER_TAB_CONTEXT_GET'}),{...frame,tab:{id:2,windowId:10}})).ok,false);
  assert.equal((await send(wrapper({type:'SIDER_TAB_CONTEXT_GET'}),{...frame,url:'https://evil.test/'})).ok,false);
  const initial=(await send({type:'SIDER_STATE_GET'})).state;
  const patched=await send(wrapper({type:'SIDER_CONTEXT_SETTINGS_PATCH',patch:{draft:'网页不应覆盖跨会话草稿',urlTemplate:'网页url为：{{url}}'}}),frame);
  assert.equal(patched.ok,true); assert.equal(patched.settings.urlTemplate,'网页url为：{{url}}');
  assert.equal((await send({type:'SIDER_STATE_GET'})).state.draft,initial.draft);
  assert.equal((await send(wrapper({type:'SIDER_STATE_GET'}),frame)).ok,false);
  const captured=await send(wrapper({type:'SIDER_TAB_ATTACHMENT_SET',kind:'page',enabled:true,tabId:9999,frameId:42}),frame);
  assert.equal(captured.ok,true);assert.equal(mock.sent.at(-1).tabId,1);assert.equal(mock.sent.at(-1).options.frameId,0);
  await send({type:'SIDER_EMBED_UNREGISTER',bridgeId});delete globalThis.chrome;
});
