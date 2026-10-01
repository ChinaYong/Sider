import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createReference } from '../src/core.js';
import { createTabContext, normalizeContext, normalizeContextSettings, CONTEXT_SETTINGS_KEY } from '../src/context.js';
import { installEnhancement } from '../src/content/enhancement.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 130));
const selection = (text = '当前选中的词汇') => createReference({ kind: 'selection', title: '当前网页', url: 'https://example.com/article', content: text, context: '附近的原文段落' }, { alias: 'r1' });
const page = (text = '完整的网页正文') => createReference({ kind: 'page', title: '当前网页', url: 'https://example.com/article', content: text }, { alias: 'r2' });

function fixture(t, options = {}) {
  const { window } = new JSDOM('<main><form><div data-composer-body><textarea id="prompt-textarea"></textarea></div><button data-testid="send-button">Send</button></form></main>', { url: 'https://chatgpt.com/', pretendToBeVisual: true });
  window.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{ width: 300, height: 60 }] : []; };
  let context = normalizeContext({ ...createTabContext(1), url: 'https://example.com/article', title: '当前网页' }, 1);
  let settings = normalizeContextSettings();
  let needsAccess = false;
  const submitted = [];
  const calls = [];
  const listeners = new Set();
  const sendListeners = new Map();
  const addListener = window.document.addEventListener.bind(window.document);
  window.document.addEventListener = (type, callback, options) => {
    if ((type === 'click' || type === 'keydown') && callback.name === 'nativeSend') sendListeners.set(type, callback);
    addListener(type, callback, options);
  };
  const result = () => ({ ok: true, context: structuredClone(context), settings: structuredClone(settings), needsAccess });
  const chrome = {
    runtime: { getURL: () => 'chrome-extension://sider-test/', async sendMessage(message) {
      calls.push(structuredClone(message));
      const inner = message.request;
      if (inner.type === 'SIDER_TAB_CONTEXT_GET') return result();
      if (inner.type === 'SIDER_TAB_SELECTION_CLEAR') {
        context = normalizeContext({ ...context, selectionIncluded: false, revision: context.revision + 1 }, context.tabId); return result();
      }
      if (inner.type === 'SIDER_TAB_ATTACHMENT_SET') {
        if (needsAccess && inner.enabled) return { ok: false, code: 'SOURCE_ACCESS_REQUIRED', error: '当前网页尚未授权。' };
        context = normalizeContext({ ...context, attachments: { ...context.attachments, [inner.kind]: inner.kind === 'url' ? inner.enabled : inner.enabled ? page() : null }, revision: context.revision + 1 }, context.tabId);
        return result();
      }
      if (inner.type === 'SIDER_CONTEXT_SETTINGS_PATCH') { settings = normalizeContextSettings({ ...settings, ...inner.patch }); return result(); }
      return { ok: false, error: '测试不支持此操作' };
    } },
    storage: { onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } } },
  };
  const editor = window.document.querySelector('textarea');
  const sendButton = window.document.querySelector('[data-testid="send-button"]');
  window.document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); submitted.push(editor.value); });
  const api = installEnhancement({ document: window.document, chrome, bridgeId: 'test-bridge-0001', ...options });
  t.after(() => { api.dispose(); window.close(); });
  return {
    window, chrome, api, root: api.root, calls, editor, submitted,
    get context() { return structuredClone(context); }, get settings() { return structuredClone(settings); },
    async seed(next = {}, nextSettings = {}) {
      context = normalizeContext({ ...context, ...next, attachments: { ...context.attachments, ...next.attachments }, revision: context.revision + 1 }, next.tabId || context.tabId);
      settings = normalizeContextSettings({ ...settings, ...nextSettings }); await api.refresh();
    },
    changeSource(next) { context = normalizeContext({ ...context, ...next, revision: context.revision + 1 }, next.tabId || context.tabId); },
    localSettings(next) { settings = normalizeContextSettings({ ...settings, ...next }); for (const listener of listeners) listener({ [CONTEXT_SETTINGS_KEY]: { newValue: structuredClone(settings) } }, 'local'); },
    async setNeedsAccess(value) { needsAccess = value; await api.refresh(); },
    click(selector) { api.root.querySelector(selector).click(); },
    // jsdom cannot manufacture trusted browser input. Call the registered
    // capture handler with the same browser-event fields; native replay still
    // goes through the real DOM button and form. Browser integration tests
    // separately exercise actual trusted clicks and key presses.
    send(kind = 'click', overrides = {}) {
      let prevented = false;
      const event = { type: kind, isTrusted: true, target: kind === 'click' ? sendButton : editor, key: 'Enter', preventDefault() { prevented = true; }, stopImmediatePropagation() {}, ...overrides };
      sendListeners.get(kind)(event);
      return prevented;
    },
    edit(text) { editor.value = text; editor.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' })); },
  };
}

test('live selection replaces the preview and remains outside the native question', async t => {
  const f = fixture(t); await pause(); f.editor.value = '这个词是什么意思？';
  await f.seed({ selection: selection() });
  assert.equal(f.root.querySelector('.selection-chip .excerpt').textContent, '当前选中的词汇');
  assert.equal(f.editor.value, '这个词是什么意思？');
  await f.seed({ selection: selection('<img src=x onerror=alert(1)>') });
  assert.equal(f.root.querySelectorAll('.selection-chip').length, 1);
  assert.equal(f.root.querySelector('img'), null);
  assert.ok(f.root.querySelector('.chips').textContent.includes('<img'));
  f.click('[aria-label="取消划词"]'); await pause();
  assert.equal(f.root.querySelector('.selection-chip'), null);
  assert.equal(f.editor.value, '这个词是什么意思？');
  assert.equal(f.root.querySelector('#expand'), null);
  assert.equal(f.root.querySelector('[data-pane="variables"]'), null);
  assert.equal(f.submitted.length, 0);
});

test('URL and body are removable current-page choices and never edit or send the question', async t => {
  const f = fixture(t); await pause(); f.editor.value = '我的问题';
  f.click('[data-pane="references"]'); f.click('[data-attachment="url"]'); await pause();
  assert.equal(f.root.querySelector('[data-chip="url"] .excerpt').textContent, 'URL');
  f.click('[data-pane="references"]'); f.click('[data-attachment="page"]'); await pause();
  assert.equal(f.root.querySelector('[data-chip="page"] .excerpt').textContent, '正文');
  assert.equal(f.editor.value, '我的问题');
  assert.equal(f.root.querySelectorAll('textarea').length, 0);
  f.click('[aria-label="取消 URL 引用"]'); f.click('[aria-label="取消正文引用"]'); await pause();
  assert.equal(f.root.querySelector('[data-chip="url"]'), null);
  assert.equal(f.root.querySelector('[data-chip="page"]'), null);
  assert.equal(f.submitted.length, 0);
  assert.ok(f.calls.every(message => message.type === 'SIDER_ENHANCEMENT_REQUEST' && message.bridgeId === 'test-bridge-0001' && !Object.hasOwn(message.request, 'tabId')));
});

test('settings alone contain variables and control prefix, suffix, and exact native send text', async t => {
  const f = fixture(t); await f.seed({ selection: selection(), attachments: { url: true, page: page() } });
  f.click('[data-pane="settings"]');
  f.root.querySelector('#selection-template').value = '请结合划词「{{selection}}」回答';
  f.root.querySelector('#selection-position').value = 'prepend';
  f.root.querySelector('#url-template').value = '网页url为：{{url}}';
  f.root.querySelector('#url-position').value = 'append';
  f.root.querySelector('#page-template').value = '网页正文：\n{{content}}';
  f.click('#save-settings'); await pause();
  f.editor.value = '这个词是什么意思？';
  assert.equal(f.send('click'), true); await pause();
  assert.deepEqual(f.submitted, ['请结合划词「当前选中的词汇」回答\n\n这个词是什么意思？\n\n网页url为：https://example.com/article\n\n网页正文：\n完整的网页正文']);
  assert.equal(f.root.querySelector('.popover').hidden, true);
});

test('Enter adds current selection once; retries and plain question edits do not duplicate it', async t => {
  const f = fixture(t); await f.seed({ selection: selection('Tabbit') });
  f.editor.value = '是什么？'; f.send('keydown'); await pause();
  const first = f.submitted[0];
  f.send('keydown'); await pause();
  assert.equal(f.submitted[1], first);
  f.edit(first.replace('是什么？', '如何使用？')); f.send('click'); await pause();
  assert.equal(f.submitted[2], first.replace('是什么？', '如何使用？'));
  assert.equal(f.submitted[2].split('网页划词：').length - 1, 1);
  f.edit('全新的问题'); f.send('click'); await pause();
  assert.equal(f.submitted[3], '网页划词：\nTabbit\n\n全新的问题');
});

test('cancelled references restore a plain question on retry instead of resending stale context', async t => {
  const f = fixture(t); await f.seed({ selection: selection() });
  f.editor.value = '解释一下'; f.send(); await pause();
  f.click('[aria-label="取消划词"]'); await pause();
  f.send(); await pause();
  assert.equal(f.submitted[1], '解释一下');
});

test('Shift Enter, IME, and synthetic sends are not intercepted; ordinary questions replay unchanged', async t => {
  const f = fixture(t); await pause(); f.editor.value = '普通问题 {{url}}';
  assert.equal(f.send(), true); await pause();
  assert.deepEqual(f.submitted, ['普通问题 {{url}}']);
  await f.seed({ selection: selection() });
  assert.equal(f.send('keydown', { shiftKey: true }), false);
  assert.equal(f.send('keydown', { isComposing: true }), false);
  assert.equal(f.send('keydown', { keyCode: 229 }), false);
  assert.equal(f.send('click', { isTrusted: false }), false);
  assert.equal(f.editor.value, '普通问题 {{url}}');
  assert.equal(f.submitted.length, 1);
});

test('invalid format variables preserve the plain question and block send', async t => {
  const f = fixture(t);
  await f.seed({ selection: selection() }, { selectionTemplate: '{{不存在的变量}}' });
  f.editor.value = '总结一下';
  f.send(); await pause();
  assert.equal(f.editor.value, '总结一下'); assert.equal(f.submitted.length, 0);
  assert.ok(f.root.querySelector('.status').classList.contains('error'));
});

test('source changes during preparation restore the question and prevent a stale native send', async t => {
  const f = fixture(t); await f.seed({ selection: selection('旧词汇') });
  const original = f.chrome.runtime.sendMessage;
  let checks = 0;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.type === 'SIDER_TAB_CONTEXT_GET' && ++checks === 2) f.changeSource({ selection: selection('新词汇') });
    return original(message);
  };
  f.editor.value = '解释一下'; f.send(); await pause();
  assert.equal(f.editor.value, '解释一下'); assert.equal(f.submitted.length, 0);
  assert.match(f.root.querySelector('.status').textContent, /已变化/);
  f.send(); await pause();
  assert.ok(f.submitted[0].includes('新词汇')); assert.equal(f.submitted[0].includes('旧词汇'), false);
});

test('native draft edits while current context is loading are preserved', async t => {
  const f = fixture(t); await f.seed({ selection: selection() });
  const original = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.type === 'SIDER_TAB_CONTEXT_GET') { f.edit('用户继续修改的问题'); }
    return original(message);
  };
  f.editor.value = '旧问题'; f.send(); await pause();
  assert.equal(f.editor.value, '用户继续修改的问题'); assert.equal(f.submitted.length, 0);
});

test('permission failure offers an owner-panel permission request without changing the question', async t => {
  const f = fixture(t); await f.setNeedsAccess(true);
  f.editor.value = '我的问题';
  const messages = []; f.window.parent.postMessage = (...args) => messages.push(args);
  f.click('[data-pane="references"]'); f.click('[data-attachment="page"]'); await pause();
  assert.equal(f.editor.value, '我的问题'); assert.equal(f.submitted.length, 0);
  assert.equal(f.root.querySelector('#source-access').hidden, false);
  f.click('#source-access'); await pause();
  assert.deepEqual(messages, [[{ type: 'SIDER_SOURCE_ACCESS_REQUEST', bridgeId: 'test-bridge-0001' }, 'chrome-extension://sider-test']]);
  assert.equal(f.send(), true); await pause();
  assert.deepEqual(f.submitted, ['我的问题']);
});

test('immediate native send fetches a new selection even before its preview refresh arrives', async t => {
  const f = fixture(t); await pause();
  assert.equal(f.root.querySelector('.selection-chip'), null);
  f.changeSource({ selection: selection('刚划定的词汇') });
  f.editor.value = '是什么意思？'; f.send(); await pause();
  assert.deepEqual(f.submitted, ['网页划词：\n刚划定的词汇\n\n是什么意思？']);
});

test('per-tab context updates replace preview without mixing drafts, and hydration reattaches the toolbar', async t => {
  const f = fixture(t); await f.seed({ selection: selection('网页一') }); f.editor.value = '原版草稿';
  await f.seed({ tabId: 2, selection: null, attachments: { url: false, page: null } });
  assert.equal(f.root.querySelector('.selection-chip'), null);
  await f.seed({ tabId: 3, selection: selection('网页三') });
  assert.equal(f.root.querySelector('.selection-chip .excerpt').textContent, '网页三');
  assert.equal(f.editor.value, '原版草稿');
  const old = f.window.document.querySelector('[data-composer-body]');
  const replacement = f.window.document.createElement('div'); replacement.dataset.composerBody = '';
  replacement.innerHTML = '<textarea id="prompt-textarea">新会话的问题</textarea>'; old.replaceWith(replacement); await pause();
  assert.equal(f.api.host.previousElementSibling, replacement.closest('form'));
  assert.equal(replacement.querySelector('textarea').value, '新会话的问题'); assert.equal(f.submitted.length, 0);
});

test('settings changed during preparation block stale formatting and keep question edits', async t => {
  const f = fixture(t); await f.seed({ selection: selection() });
  const original = f.chrome.runtime.sendMessage; let checks = 0;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.type === 'SIDER_TAB_CONTEXT_GET' && ++checks === 2) f.localSettings({ selectionTemplate: '新格式：{{selection}}' });
    return original(message);
  };
  f.editor.value = '解释一下'; f.send(); await pause();
  assert.equal(f.editor.value, '解释一下'); assert.equal(f.submitted.length, 0);
  f.send(); await pause(); assert.equal(f.submitted[0], '新格式：当前选中的词汇\n\n解释一下');
});

function attachmentFixture({ pending = false, failure = null, nativeName = null } = {}) {
  const calls = [];
  let ready = null, release, cleared = 0;
  const gate = pending ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const matches = spec => ready?.name === spec?.name && ready?.content === spec?.content;
  return {
    calls, release: () => release?.(), get cleared() { return cleared; },
    async prepare(spec, { signal, isCurrent }) {
      if (matches(spec)) return { name: nativeName || spec.name };
      calls.push(spec);
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('正文附件准备已取消。')), { once: true }))]);
      if (signal.aborted || !isCurrent()) throw new Error('正文附件准备已取消。');
      if (failure) throw new Error(failure);
      ready = spec;
      return { name: nativeName || spec.name };
    },
    isReady: matches,
    async clear() { cleared++; ready = null; },
    reconcile() {}, dispose() {}, isOwnedRemoveButton() { return false; },
  };
}

test('long body uploads separately while question, selection and URL use the native message', async t => {
  const manager = attachmentFixture();
  const f = fixture(t, { attachmentManager: manager });
  const body = '完整网页正文。'.repeat(2500) + 'END-OF-PAGE';
  await f.seed({ selection: selection('Tabbit'), attachments: { url: true, page: page(body) } });
  assert.equal(f.root.querySelector('[data-chip="page"] .excerpt').textContent, '正文 · 附件');
  f.editor.value = '分析这个词与网页的关系'; f.send('keydown'); await pause();
  assert.equal(manager.calls.length, 1);
  assert.ok(manager.calls[0].content.endsWith(body));
  assert.equal(manager.calls[0].content.includes('分析这个词与网页的关系'), false);
  assert.equal(f.submitted.length, 1);
  assert.ok(f.submitted[0].includes('网页划词：\nTabbit'));
  assert.ok(f.submitted[0].includes('网页 URL：https://example.com/article'));
  assert.ok(f.submitted[0].includes(manager.calls[0].name));
  assert.equal(f.submitted[0].includes('END-OF-PAGE'), false);
  f.send(); await pause();
  assert.equal(manager.calls.length, 1, 'retry reuses the ready native attachment');
  assert.equal(f.submitted[1], f.submitted[0]);
});

test('send waits for upload completion and repeated Enter does not start another upload', async t => {
  const manager = attachmentFixture({ pending: true });
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('正文'.repeat(9000)) } });
  f.editor.value = '总结一下'; f.send(); await pause();
  assert.equal(f.editor.value, '总结一下'); assert.equal(f.submitted.length, 0);
  f.send('keydown'); await pause();
  assert.equal(manager.calls.length, 1); assert.equal(f.submitted.length, 0);
  manager.release(); await pause();
  assert.equal(f.submitted.length, 1);
});

test('the message names the unique actual attachment and retries still reuse its logical body', async t => {
  const nativeName = '当前网页-sider-ef43bd890c173a2f-网页正文.txt';
  const manager = attachmentFixture({ nativeName });
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('长正文'.repeat(5000)) } });
  f.editor.value = '请总结'; f.send(); await pause();
  assert.equal(f.submitted.length, 1);
  assert.ok(f.submitted[0].includes(`《${nativeName}》`));
  assert.equal(f.submitted[0].includes(`《${manager.calls[0].name}》`), false);
  f.send(); await pause();
  assert.equal(manager.calls.length, 1);
  assert.equal(f.submitted[1], f.submitted[0]);
});

test('upload failure preserves both the question and selected body without a partial send', async t => {
  const manager = attachmentFixture({ failure: '附件上传失败。' });
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('正文'.repeat(9000)) } });
  f.editor.value = '总结一下'; f.send(); await pause();
  assert.equal(f.editor.value, '总结一下'); assert.equal(f.submitted.length, 0);
  assert.ok(f.context.attachments.page);
  assert.match(f.root.querySelector('.status').textContent, /上传失败/);
});

test('editing the question during upload cancels preparation without overwriting new text', async t => {
  const manager = attachmentFixture({ pending: true });
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('正文'.repeat(9000)) } });
  f.editor.value = '旧问题'; f.send(); await pause();
  f.edit('用户修改后的问题'); await pause();
  manager.release(); await pause();
  assert.equal(f.editor.value, '用户修改后的问题'); assert.equal(f.submitted.length, 0);
  assert.ok(manager.cleared > 0);
});

test('cancelling body while uploading prevents send and clears only the owned attachment', async t => {
  const manager = attachmentFixture({ pending: true });
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { url: true, page: page('正文'.repeat(9000)) } });
  f.editor.value = '总结一下'; f.send(); await pause();
  f.click('[aria-label="取消正文引用"]'); await pause(); manager.release(); await pause();
  assert.equal(f.editor.value, '总结一下'); assert.equal(f.submitted.length, 0);
  assert.equal(f.context.attachments.page, null); assert.equal(f.context.attachments.url, true);
  assert.ok(manager.cleared > 0);
});

test('source changes during upload abort the old attachment and preserve the plain question', async t => {
  const manager = attachmentFixture({ pending: true });
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('旧正文'.repeat(6000)) } });
  f.editor.value = '解释一下'; f.send(); await pause();
  await f.seed({ attachments: { page: page('新正文') } }); await pause();
  manager.release(); await pause();
  assert.equal(f.editor.value, '解释一下'); assert.equal(f.submitted.length, 0);
  assert.ok(manager.cleared > 0);
});

test('manual text mode sends full body beyond the removed legacy character limit', async t => {
  const f = fixture(t);
  const body = '全文'.repeat(26000) + 'FULL-PAGE-END';
  await f.seed({ attachments: { page: page(body) } }, { pageMode: 'text', maxChars: 1000 });
  f.editor.value = '保留全文'; f.send(); await pause();
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0], `保留全文\n\n网页正文：\n${body}`);
});
