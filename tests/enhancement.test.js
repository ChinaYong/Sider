import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createReference } from '../src/core.js';
import { createTabContext, normalizeContext, normalizeContextSettings, CONTEXT_SETTINGS_KEY } from '../src/context.js';
import { installEnhancement } from '../src/content/enhancement.js';
import { BUILTIN_AI_SITES, normalizeCustomAISite } from '../src/ai-web.js';
import { createWebAdapter } from '../src/content/adapters.js';
import { presetTemplates, templateSettings, PRESET_IDS, UNIFIED_TEMPLATES_KEY } from '../src/prompt-templates.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 130));
const waitUntil = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'enhancement did not reach the expected completion state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const selection = (text = '当前选中的词汇') => createReference({ kind: 'selection', title: '当前网页', url: 'https://example.com/article', content: text, context: '附近的原文段落' }, { alias: 'r1' });
const page = (text = '完整的网页正文') => createReference({ kind: 'page', title: '当前网页', url: 'https://example.com/article', content: text }, { alias: 'r2' });
const customSite = normalizeCustomAISite({ id: 'custom-test-ai-0001', name: 'Custom AI', url: 'https://custom-ai.test/chat' });

test('initial owner-source metadata arriving during send preparation is not treated as a source switch', async t => {
  const f = fixture(t); await pause(); await f.seed({ attachments: { url: true } });
  const original = f.chrome.runtime.sendMessage;
  let preparing = false, hydrated = false;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.type === 'SIDER_TEMPLATE_CONTEXT_GET') preparing = true;
    const result = await original(message);
    if (preparing && message.request.type === 'SIDER_TAB_CONTEXT_GET') {
      hydrated = true;
      return { ...result, referenceSource: { ownerTabId: f.context.tabId, tabId: f.context.tabId, epoch: 0, title: f.context.title, status: 'ready', error: '' } };
    }
    return result;
  };
  f.editor.value = '导航后立即提问'; assert.equal(f.send(), true);
  await waitUntil(() => f.submitted.length === 1);
  assert.equal(hydrated, true); assert.match(f.submitted[0], /导航后立即提问/);
  assert.match(f.submitted[0], /https:\/\/example\.com\/article/);
});

function openTemplates(f, from = f.editor.value.length, to = from) {
  f.editor.focus(); f.editor.setSelectionRange(from, to);
  f.root.querySelector('[data-pane="templates"]').dispatchEvent(new f.window.Event('pointerdown', { bubbles: true }));
  f.click('[data-pane="templates"]');
}
async function createTemplate(f, text, directSend = false) {
  if (f.root.querySelector('.popover').hidden) openTemplates(f);
  [...f.root.querySelectorAll('#pane-body button')].find(button => button.textContent === '新增预设').click();
  f.root.querySelector('#template-name').value = '测试预设'; f.root.querySelector('#template-text').value = text;
  f.root.querySelector('#template-action').value = directSend ? 'send' : 'append';
  [...f.root.querySelectorAll('#pane-body button')].find(button => button.textContent === '保存预设').click(); await pause();
  f.click('#close-pane');
}

test('page preview reads the cache, copies exact Markdown, and clears stale source content', async t => {
  const f = fixture(t); await f.seed({ attachments: { page: page('# 标题\n\n中文\n  代码\n\n尾标记') } });
  let copied; Object.defineProperty(f.window.navigator, 'clipboard', { value: { async writeText(text) { copied = text; } } });
  const before = f.calls.length; f.click('[aria-label="查看网页正文"]'); [...f.root.querySelectorAll('#pane-body button')].find(button => button.textContent === '查看正文快照').click();
  assert.equal(f.calls.length, before); assert.equal(f.root.querySelector('.page-body').textContent, f.context.attachments.page.content);
  [...f.root.querySelectorAll('#pane-body button')].find(button => button.textContent === '复制正文').click(); await pause(); assert.equal(copied, f.context.attachments.page.content);
  await f.seed({ url: 'https://other.test/', attachments: { page: null }, pageRequested: false });
  assert.ok(!f.root.querySelector('.page-body')?.textContent.includes('尾标记')); assert.equal(f.submitted.length, 0);
});

test('a manual template replaces the saved selection and expands original values only once', async t => {
  const f = fixture(t); await pause(); await createTemplate(f, '读 {{title}} {{url}}');
  await f.seed({ title: '标题 {{filename}}' }); f.editor.value = '前缀旧词后缀';
  openTemplates(f, 2, 4); f.click('#pane-body [data-template-id]:not([data-template-id^="preset-"])'); await pause();
  assert.equal(f.editor.value, '前缀旧词后缀\n\n读 标题 {{filename}} https://example.com/article'); assert.deepEqual(f.submitted, []);
});

test('direct full-body templates share a capture, preserve the distinct preset file and clear temporary choices', async t => {
  const manager = attachmentFixture(); const f = fixture(t, { attachmentManager: manager }); await pause();
  await f.seed({ attachments: { page: page() } }, { pageMode: 'file' });
  await createTemplate(f, '总结\n{{content}}', true); f.editor.value = '前缀后缀';
  const before = f.calls.filter(call => call.request.refreshPage).length;
  openTemplates(f, 2); f.click('#pane-body [data-template-id]:not([data-template-id^="preset-"])'); await waitUntil(() => f.submitted.length === 1);
  assert.equal(f.submitted.length, 1); assert.ok(f.submitted[0].startsWith('前缀后缀')); assert.ok(f.submitted[0].includes('总结\n完整的网页正文')); assert.equal(manager.calls.length, 1);
  await waitUntil(() => !f.context.pageRequested); assert.equal(f.settings.pageMode, 'file');
  assert.ok(Object.values(f.context.templateSelections).every(value => value === false));
  assert.equal(f.calls.filter(call => call.request.refreshPage).length - before, 1);
});

test('editing inline body or updating its source body restores the normal file reference behavior', async t => {
  const manager = attachmentFixture(); const f = fixture(t, { attachmentManager: manager }); await pause();
  await f.seed({ attachments: { page: page() } }, { pageMode: 'file' }); await createTemplate(f, '{{page.content}}');
  openTemplates(f); f.click('#pane-body [data-template-id]:not([data-template-id^="preset-"])'); await pause();
  await f.seed({ attachments: { page: page('来源更新后的正文') } }); f.send(); await pause();
  assert.equal(manager.calls.length, 1); assert.ok(manager.calls[0].content.includes('来源更新后的正文')); assert.ok(f.submitted[0].includes('完整的网页正文'));
});

test('source or session changes during template expansion protect the new draft and prevent a direct send', async t => {
  const f = fixture(t); await pause(); await createTemplate(f, '{{content}}', true); f.editor.value = '旧问题';
  let release; const original = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => { if (message.request.type === 'SIDER_TEMPLATE_CONTEXT_GET') await new Promise(resolve => { release = resolve; }); return original(message); };
  openTemplates(f); f.click('#pane-body [data-template-id]:not([data-template-id^="preset-"])'); await waitUntil(() => Boolean(release));
  f.editor.dataset.conversationId = 'next'; f.edit('新会话草稿'); release(); await pause();
  assert.equal(f.editor.value, '新会话草稿'); assert.equal(f.submitted.length, 0);
});

test('missing page metadata blocks direct templates before they modify or send the draft', async t => {
  const f = fixture(t); await pause(); await createTemplate(f, '{{page.author}}', true); f.editor.value = '保留草稿';
  openTemplates(f); f.click('#pane-body [data-template-id]:not([data-template-id^="preset-"])'); await pause();
  assert.equal(f.editor.value, '保留草稿'); assert.equal(f.submitted.length, 0); assert.match(f.root.querySelector('.status').textContent, /page.author/);
});

function grokBanner(f) {
  const banner = f.window.document.createElement('span'); banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite');
  banner.textContent = 'Your network or security software is blocking Grok’s real-time connection. Try another network.';
  f.window.document.body.append(banner); return banner;
}

test('a known Grok connection failure blocks repeated native sends without capturing references or losing the draft', async t => {
  const f = fixture(t, { site: normalizeCustomAISite({ id: 'custom-grok-fixture', name: 'Grok', url: 'https://grok.com/' }) }); await pause();
  const banner = grokBanner(f); f.editor.value = '保留问题'; await pause();
  const count = f.calls.length;
  assert.equal(f.send('keydown'), true); assert.equal(f.send('click'), true); await pause();
  assert.equal(f.calls.length, count); assert.deepEqual(f.submitted, []); assert.equal(f.editor.value, '保留问题');
  assert.match(f.root.querySelector('.status').textContent, /实时连接失败/);
  banner.remove(); await pause(); f.send(); await pause(); assert.equal(f.submitted.length, 1);
});

test('Grok failing during reference preparation stops the final replay and retains the original question', async t => {
  const f = fixture(t, { site: normalizeCustomAISite({ id: 'custom-grok-fixture', name: 'Grok', url: 'https://grok.com/' }) }); await pause();
  await f.seed({ attachments: { url: true } }); f.editor.value = '原问题';
  let release; const original = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => { if (message.request?.refreshPage) await new Promise(resolve => { release = resolve; }); return original(message); };
  f.send(); await waitUntil(() => Boolean(release)); grokBanner(f); release();
  await waitUntil(() => /实时连接失败/.test(f.root.querySelector('.status').textContent));
  assert.deepEqual(f.submitted, []); assert.equal(f.editor.value, '原问题'); assert.match(f.root.querySelector('.status').textContent, /实时连接失败/);
});

test('a custom-site text drop cancels in-flight reference preparation and preserves the updated draft', async t => {
  const f = fixture(t, { site: customSite }); await pause(); await f.seed({ attachments: { url: true } }); f.editor.value = '问题';
  let release; const original = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => { if (message.request?.refreshPage) await new Promise(resolve => { release = resolve; }); return original(message); };
  f.send(); await pause(); assert.equal(f.drop('拖入文字'), true); await pause(); release(); await pause();
  assert.deepEqual(f.submitted, []); assert.equal(f.editor.value, '问题拖入文字');
  f.chrome.runtime.sendMessage = original;
  f.send(); await pause(); assert.equal(f.submitted.length, 1); assert.match(f.submitted[0], /问题拖入文字/);
});

test('any custom website tolerates a brief sender replacement and Enter waits once for its real control', async t => {
  const f = fixture(t, { site: customSite }); await pause(); await f.seed({ attachments: { url: true } });
  f.editor.value = '通用控件等待';
  const button = f.window.document.querySelector('button'); button.remove(); await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.root.querySelector('.status').hidden, true);
  assert.equal(f.send('keydown'), true);
  f.window.document.querySelector('form').append(button);
  await pause(); await pause();
  assert.equal(f.submitted.length, 1); assert.match(f.submitted[0], /通用控件等待/); assert.match(f.submitted[0], /example.com/);
});

test('a prolonged custom-site sender gap blocks sending and keeps the original draft', async t => {
  const f = fixture(t, { site: customSite }); await pause(); f.editor.value = '保留草稿';
  f.window.document.querySelector('button').remove(); await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.send('keydown'), true); await waitUntil(() => /发送控件/.test(f.root.querySelector('.status').textContent));
  assert.deepEqual(f.submitted, []); assert.equal(f.editor.value, '保留草稿'); assert.match(f.root.querySelector('.status').textContent, /发送控件/);
});

test('custom AI auto mode sends the complete body as text and clearly reports the attachment fallback', async t => {
  const f = fixture(t, { site: customSite }); await pause();
  const text = '完整正文'.repeat(4000) + '正文尾部必须完整';
  await f.seed({ pageRequested: true, attachments: { page: page(text) } }, { pageMode: 'auto', pageThreshold: 100 });
  f.editor.value = '请概括';
  assert.equal(f.root.querySelector('[data-chip="page"] .excerpt').textContent, '网页正文');
  assert.equal(f.send(), true); await pause();
  assert.equal(f.submitted.length, 1); assert.ok(f.submitted[0].includes(text));
  assert.match(f.root.querySelector('.status').textContent, /完整文本/);
  f.send(); await pause();
  assert.equal(f.submitted[1], '请概括', 'later sends use cleared preset choices');
});

test('custom AI forced attachment mode blocks send and retains the question and selected body', async t => {
  const f = fixture(t, { site: customSite }); await pause();
  await f.seed({ pageRequested: true, attachments: { page: page() } }, { pageMode: 'file' });
  f.editor.value = '原问题'; f.send(); await pause();
  assert.deepEqual(f.submitted, []); assert.equal(f.editor.value, '原问题');
  assert.equal(f.context.pageRequested, true); assert.match(f.root.querySelector('.status').textContent, /尚未支持附件/);
});

test('changing a session identifier in a reused native editor cancels an in-flight send', async t => {
  const f = fixture(t); await pause(); f.editor.value = '旧会话问题';
  let release; const original = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => { if (message.request?.refreshPage) await new Promise(resolve => { release = resolve; }); return original(message); };
  f.send(); await pause();
  f.editor.dataset.conversationId = 'new-conversation'; f.editor.value = '新会话草稿';
  release(); await pause();
  assert.deepEqual(f.submitted, []); assert.equal(f.editor.value, '新会话草稿');
});

test('native generation clicks and Enter do not start reference preparation or alter the next draft', async t => {
  const f = fixture(t); await pause();
  await f.seed({ attachments: { url: true } });
  f.editor.value = '下一条草稿';
  const button = f.window.document.querySelector('button');
  button.setAttribute('aria-label', 'Stop response');
  await pause();
  assert.equal(f.root.querySelector('.status').hidden, true);
  const freshRequests = () => f.calls.filter(message => message.request?.refreshPage).length;
  const before = freshRequests();
  assert.equal(f.send('click'), false);
  assert.equal(f.send('keydown'), false);
  await pause();
  assert.equal(freshRequests(), before);
  assert.equal(f.editor.value, '下一条草稿');
  assert.deepEqual(f.submitted, []);
});

test('a sender becoming Stop during reference preparation is never replayed and restores only its own draft write', async t => {
  const f = fixture(t); await pause();
  await f.seed({ attachments: { url: true } });
  f.editor.value = '保留原问题';
  let release;
  const original = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request?.refreshPage) await new Promise(resolve => { release = resolve; });
    return original(message);
  };
  assert.equal(f.send(), true);
  await pause();
  let clicks = 0;
  const button = f.window.document.querySelector('button');
  button.setAttribute('aria-label', 'Stop generating');
  button.addEventListener('click', () => { clicks++; });
  release();
  const deadline = Date.now() + 2000;
  while (!/发送按钮尚未就绪/.test(f.root.querySelector('.status').textContent) && Date.now() < deadline) await pause();
  assert.equal(clicks, 0);
  assert.deepEqual(f.submitted, []);
  assert.equal(f.editor.value, '保留原问题');
  assert.match(f.root.querySelector('.status').textContent, /发送按钮尚未就绪/);
});

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
  let textDrop;
  const addListener = window.document.addEventListener.bind(window.document);
  window.document.addEventListener = (type, callback, options) => {
    if ((type === 'click' || type === 'keydown') && callback.name === 'nativeSend') sendListeners.set(type, callback);
    if (type === 'drop' && callback.name === 'drop') textDrop = callback;
    addListener(type, callback, options);
  };
  let templates = presetTemplates(settings);
  const result = () => ({ ok: true, context: structuredClone(context), templates: structuredClone(templates), settings: structuredClone(settings), needsAccess });
  function mapChoices() {
    context.templateSelections = { ...(context.templateSelections || {}), [PRESET_IDS.selection]: context.selectionIncluded, [PRESET_IDS.url]: context.attachments.url, [PRESET_IDS.page]: context.pageRequested };
  }
  const chrome = {
    runtime: { getURL: () => 'chrome-extension://sider-test/', async sendMessage(message) {
      calls.push(structuredClone(message));
      const inner = message.request;
      if (inner.type === 'SIDER_PROMPT_TEMPLATES_GET') return { ok: true, templates: structuredClone(templates) };
      if (inner.type === 'SIDER_PROMPT_TEMPLATES_SAVE') { templates = structuredClone(inner.templates); settings = normalizeContextSettings(templateSettings(templates)); return result(); }
      if (inner.type === 'SIDER_TEMPLATE_CONTEXT_GET') {
        if (inner.needPage && (needsAccess || context.pageError)) return { ok: false, error: context.pageError || '当前网页尚未授权。' };
        return { ...result(), ...(inner.needPage ? { variablePage: context.attachments.page || page() } : {}) };
      }
      if (inner.type === 'SIDER_TAB_CONTEXT_GET') return result();
      if (inner.type === 'SIDER_TAB_TEMPLATES_CLEAR') {
        if (inner.expectedContext.tabId === context.tabId && inner.expectedContext.url === context.url && inner.expectedContext.revision === context.revision) {
          for (const id of Object.keys(context.templateSelections)) context.templateSelections[id] = false;
          context.explicitTemplates = []; context.selectionIncluded = false; context.attachments = { url: false, page: null }; context.pageRequested = false; context.pageError = ''; context.revision++;
        }
        return result();
      }
      if (inner.type === 'SIDER_TAB_TEMPLATE_SET') {
        if (needsAccess && inner.enabled) return { ok: false, code: 'SOURCE_ACCESS_REQUIRED', error: '当前网页尚未授权。' };
        const preset = Object.entries(PRESET_IDS).find(([, id]) => id === inner.id)?.[0];
        context.templateSelections ||= {}; context.templateSelections[inner.id] = inner.enabled;
        if (preset === 'selection') context.selectionIncluded = inner.enabled;
        if (preset === 'url') context.attachments.url = inner.enabled;
        if (preset === 'page') { context.pageRequested = inner.enabled; context.pageError = ''; context.attachments.page = inner.enabled ? page() : null; }
        context.revision++; return result();
      }
      if (inner.type === 'SIDER_TAB_SELECTION_CLEAR') {
        context = normalizeContext({ ...context, selection: null, selectionIncluded: true, revision: context.revision + 1 }, context.tabId); return result();
      }
      if (inner.type === 'SIDER_TAB_ATTACHMENT_SET') {
        if (!['url', 'page'].includes(inner.kind)) return { ok: false, error: '网页引用选项无效。' };
        if (needsAccess && inner.enabled) return { ok: false, code: 'SOURCE_ACCESS_REQUIRED', error: '当前网页尚未授权。' };
        const update = inner.kind === 'url' ? { attachments: { ...context.attachments, url: inner.enabled } }
            : { attachments: { ...context.attachments, page: inner.enabled ? page() : null }, pageRequested: inner.enabled, pageError: '' };
        context = normalizeContext({ ...context, ...update, revision: context.revision + 1 }, context.tabId); mapChoices();
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
  const api = installEnhancement({ document: window.document, chrome, bridgeId: 'test-bridge-0001', ...options, ...(options.site ? { adapter: createWebAdapter(window.document, options.site) } : {}) });
  t.after(() => { api.dispose(); window.close(); });
  return {
    window, chrome, api, root: api.root, calls, editor, submitted,
    get context() { return structuredClone(context); }, get settings() { return structuredClone(settings); },
    async seed(next = {}, nextSettings = {}) {
      context = normalizeContext({ ...context, ...next, attachments: { ...context.attachments, ...next.attachments }, revision: context.revision + 1 }, next.tabId || context.tabId);
      settings = normalizeContextSettings({ ...settings, ...nextSettings });
      templates = [...presetTemplates(settings), ...templates.filter(item => !item.preset)]; mapChoices(); await api.refresh();
    },
    changeSource(next) { context = normalizeContext({ ...context, ...next, revision: context.revision + 1 }, next.tabId || context.tabId); mapChoices(); },
    localSettings(next) { settings = normalizeContextSettings({ ...settings, ...next }); templates = [...presetTemplates(settings), ...templates.filter(item => !item.preset)]; for (const listener of listeners) listener({ [UNIFIED_TEMPLATES_KEY]: { newValue: structuredClone(templates) } }, 'local'); },
    async setNeedsAccess(value) { needsAccess = value; await api.refresh(); },
    click(selector) { api.root.querySelector(selector).click(); },
    drop(text) {
      let prevented = false;
      textDrop?.({ type: 'drop', isTrusted: true, target: editor, dataTransfer: { types: ['text/plain'], getData: type => type === 'text/plain' ? text : '' }, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
      return prevented;
    },
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
  assert.equal(f.context.selectionIncluded, false);
  assert.equal(f.calls.at(-1).request.type, 'SIDER_TAB_TEMPLATE_SET');
  assert.equal(f.root.querySelector('.status.error'), null);
  assert.equal(f.editor.value, '这个词是什么意思？');
  assert.equal(f.root.querySelector('#expand'), null);
  assert.equal(f.root.querySelector('[data-pane="variables"]'), null);
  assert.equal(f.submitted.length, 0);
});

test('URL and body are removable current-page choices and never edit or send the question', async t => {
  const f = fixture(t); await pause(); f.editor.value = '我的问题';
  f.click('[data-pane="templates"]'); f.click('[aria-label="发送时引用 网页链接"]'); await pause();
  assert.equal(f.root.querySelector('[data-chip="url"] .excerpt').textContent, '网页链接');
  f.click('[aria-label="发送时引用 网页正文"]'); await pause();
  assert.equal(f.root.querySelector('[data-chip="page"] .excerpt').textContent, '网页正文');
  assert.equal(f.editor.value, '我的问题');
  assert.equal(f.root.querySelectorAll('textarea').length, 0);
  f.click('[aria-label="取消 URL 引用"]'); f.click('[aria-label="取消正文引用"]'); await pause();
  assert.equal(f.root.querySelector('[data-chip="url"]'), null);
  assert.equal(f.root.querySelector('[data-chip="page"]'), null);
  assert.equal(f.submitted.length, 0);
  assert.ok(f.calls.every(message => message.type === 'SIDER_ENHANCEMENT_REQUEST' && message.bridgeId === 'test-bridge-0001' && !Object.hasOwn(message.request, 'tabId')));
});

test('background refresh preserves template controls and focused cancellation buttons', async t => {
 const f = fixture(t); await f.seed({ selection: selection(), attachments: { url: true, page: page() } });
 const cancel = f.root.querySelector('[data-chip="page"] button'); cancel.focus(); await f.api.refresh();
 assert.equal(f.root.activeElement, cancel);
 f.click('[data-pane="templates"]');
 const checkbox = f.root.querySelector('[aria-label="发送时引用 网页正文"]'); checkbox.focus();
 await f.seed({ title: '新页面标题', attachments: { url: false, page: null }, pageRequested: false, selectionIncluded: false, selection: null });
 assert.equal(f.root.querySelector('[aria-label="发送时引用 网页正文"]'), checkbox);
 assert.equal(f.root.activeElement, checkbox); assert.equal(checkbox.checked, false);
 assert.equal(f.root.querySelector('.source-title').textContent, '新页面标题'); assert.deepEqual(f.submitted, []);
});

test('refresh cannot enable another body request while its reference control is pending', async t => {
  const f = fixture(t); await f.api.refresh();
  let release, started = 0;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const original = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.type === 'SIDER_TAB_TEMPLATE_SET' && message.request.id === PRESET_IDS.page) { started++; await gate; }
    return original(message);
  };
  f.click('[data-pane="templates"]');
  const entry = f.root.querySelector('[aria-label="发送时引用 网页正文"]');
  f.click('[aria-label="发送时引用 网页正文"]');
  assert.equal(entry.disabled, true);
  await f.seed({ title: '采集中仍可更新标题', selection: selection('新的划词'), pageRequested: true });
  await f.api.refresh();
  assert.equal(f.root.querySelector('[aria-label="发送时引用 网页正文"]'), entry);
  assert.equal(entry.parentElement.querySelector('input').checked, true);
  assert.equal(entry.disabled, true);
  f.click('[aria-label="发送时引用 网页正文"]');
  assert.equal(started, 1);
  release(); await pause();
  assert.ok(f.context.attachments.page);
  assert.equal(f.root.querySelector('.popover').hidden, false);
  assert.deepEqual(f.submitted, []);
});

test('body chip keeps its pending cancel action disabled across refresh and delivery-label changes', async t => {
  const f = fixture(t); await f.seed({ attachments: { url: true, page: page() } });
  let release, started = 0;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const original = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.type === 'SIDER_TAB_TEMPLATE_SET' && message.request.id === PRESET_IDS.page && !message.request.enabled) { started++; await gate; }
    return original(message);
  };
  const cancel = f.root.querySelector('[aria-label="取消正文引用"]');
  f.click('[aria-label="取消正文引用"]');
  await f.seed({}, { pageMode: 'file' }); await f.api.refresh();
  assert.equal(f.root.querySelector('[aria-label="取消正文引用"]'), cancel);
  assert.equal(cancel.disabled, true);
  assert.equal(f.root.querySelector('[data-chip="page"] .excerpt').textContent, '网页正文 · 附件');
  f.click('[aria-label="取消正文引用"]');
  assert.equal(started, 1);
  release(); await pause(); await f.api.refresh();
  assert.equal(f.root.querySelector('[data-chip="page"]'), null);
  assert.ok(f.root.querySelector('[data-chip="url"]'));
  assert.deepEqual(f.submitted, []);
});

test('each template edits its own format and position without changing the question', async t => {
 const f = fixture(t); await f.seed({ selection: selection(), attachments: { url: true, page: page() } });
 f.click('[data-pane="templates"]'); f.click('[aria-label="编辑预设 划词"]');
 f.root.querySelector('#template-text').value = '请结合划词「{{selection}}」回答';
 f.root.querySelector('#template-position').value = 'prepend';
 [...f.root.querySelectorAll('#pane-body button')].find(button => button.textContent === '保存预设').click(); await pause();
 f.editor.value = '这个词是什么意思？'; f.send(); await pause();
 assert.equal(f.submitted.length, 1); assert.ok(f.submitted[0].startsWith('请结合划词「当前选中的词汇」回答\n\n这个词是什么意思？'));
 assert.ok(f.submitted[0].includes('完整的网页正文')); assert.equal(f.root.querySelector('[data-pane="settings"]'), null);
});

test('Enter and button sends clear preset choices and later questions use no previous selection', async t => {
  const f = fixture(t); await f.seed({ selection: selection('Tabbit') });
  f.editor.value = '是什么？'; f.send('keydown'); await pause();
  const first = f.submitted[0];
  assert.match(first, /网页划词：\nTabbit/);
  assert.ok(Object.values(f.context.templateSelections).every(value => value === false));
  assert.equal(f.context.selection.content, 'Tabbit');
  assert.equal(f.root.querySelector('.chip'), null);
  f.send('keydown'); await pause();
  assert.equal(f.submitted[1], '是什么？');
  f.edit('如何使用？'); f.send('click'); await pause();
  assert.equal(f.submitted[2], '如何使用？');
  f.edit('全新的问题'); f.send('click'); await pause();
  assert.equal(f.submitted[3], '全新的问题');
});

test('automatic deselection restores a plain question on retry instead of resending stale context', async t => {
  const f = fixture(t); await f.seed({ selection: selection() });
  f.editor.value = '解释一下'; f.send(); await pause();
  f.send(); await pause();
  assert.equal(f.submitted[1], '解释一下');
});

test('preset reset failure after dispatch preserves the sent prompt and never resends', async t => {
  const f = fixture(t); await f.seed({ selection: selection() });
  const sendMessage = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = message => message.request.type === 'SIDER_TAB_TEMPLATES_CLEAR'
    ? Promise.resolve({ ok: false, error: '存储失败' }) : sendMessage(message);
  f.editor.value = '解释一下'; f.send(); await pause();
  assert.equal(f.submitted.length, 1); assert.equal(f.editor.value, f.submitted[0]);
  assert.equal(f.context.templateSelections[PRESET_IDS.selection], true);
  assert.match(f.root.querySelector('.status.error').textContent, /取消预设勾选失败.*存储失败/);
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

test('invalid template variables stay in the edit form without touching the question', async t => {
 const f=fixture(t); await pause(); f.editor.value='保留问题'; f.click('[data-pane="templates"]'); f.click('[aria-label="编辑预设 划词"]');
 f.root.querySelector('#template-text').value='{{不存在的变量}}'; [...f.root.querySelectorAll('#pane-body button')].find(button=>button.textContent==='保存预设').click(); await pause();
 assert.equal(f.editor.value,'保留问题'); assert.equal(f.submitted.length,0); assert.match(f.root.querySelector('#template-error').textContent,/未知变量/);
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

test('native send waits for the latest body and repeated input starts only one capture', async t => {
  const f = fixture(t); await f.seed({ attachments: { page: page('开启引用时的旧正文') } });
  const original = f.chrome.runtime.sendMessage;
  let release, captures = 0, latest = '发送前动态加载的新正文';
  const gate = new Promise(resolve => { release = resolve; });
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.type === 'SIDER_TEMPLATE_CONTEXT_GET' && message.request.refreshPage) {
      captures++;
      await gate;
      f.changeSource({ attachments: { ...f.context.attachments, page: page(latest) } });
    }
    return original(message);
  };
  f.editor.value = '总结一下'; assert.equal(f.send(), true); await pause();
  assert.equal(captures, 1); assert.equal(f.submitted.length, 0); assert.equal(f.editor.value, '总结一下');
  assert.equal(f.send('keydown'), true); assert.equal(f.send(), true); await pause();
  assert.equal(captures, 1); assert.equal(f.submitted.length, 0);
  release(); await pause();
  assert.equal(f.submitted.length, 1);
  assert.ok(f.submitted[0].includes(latest)); assert.equal(f.submitted[0].includes('开启引用时的旧正文'), false);
  assert.equal(captures, 1);
  latest = '下一次发送时的新正文'; f.edit('第二个问题'); f.send('keydown'); await pause();
  assert.equal(captures, 2); assert.equal(f.submitted.length, 2);
  assert.ok(f.submitted[1].includes(latest)); assert.equal(f.submitted[1].includes('发送前动态加载的新正文'), false);
});

test('failed fresh extraction blocks native send without falling back to the cached body', async t => {
  const f = fixture(t); await f.seed({ attachments: { page: page('不能退回使用的旧正文') } });
  const original = f.chrome.runtime.sendMessage;
  let failed = true;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.type === 'SIDER_TEMPLATE_CONTEXT_GET' && message.request.refreshPage) {
      f.changeSource({ pageRequested: true, pageError: failed ? '最新网页正文提取失败。' : '', attachments: { ...f.context.attachments, page: failed ? null : page('恢复后的最新正文') } });
    }
    return original(message);
  };
  f.editor.value = '原来的问题'; f.send(); await pause();
  assert.equal(f.submitted.length, 0); assert.equal(f.editor.value, '原来的问题');
  assert.match(f.root.querySelector('.status').textContent, /提取失败/);
  failed = false; f.send(); await pause();
  assert.equal(f.submitted.length, 1); assert.ok(f.submitted[0].includes('恢复后的最新正文'));
  assert.equal(f.submitted[0].includes('不能退回使用的旧正文'), false);
});

test('editing the question during fresh extraction stops sending and preserves the new draft', async t => {
  const f = fixture(t); await f.seed({ attachments: { page: page() } });
  const original = f.chrome.runtime.sendMessage;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.refreshPage) await gate;
    return original(message);
  };
  f.editor.value = '旧问题'; f.send(); await pause();
  f.edit('采集期间修改的新问题'); release(); await pause();
  assert.equal(f.editor.value, '采集期间修改的新问题'); assert.equal(f.submitted.length, 0);
});

test('changing conversations during fresh extraction leaves the new conversation draft untouched', async t => {
  const f = fixture(t); await f.seed({ attachments: { page: page() } });
  const original = f.chrome.runtime.sendMessage;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.refreshPage) await gate;
    return original(message);
  };
  f.editor.value = '旧会话的问题'; f.send(); await pause();
  f.window.history.pushState({}, '', '/c/new-conversation'); f.edit('新会话的草稿');
  release(); await pause();
  assert.equal(f.editor.value, '新会话的草稿'); assert.equal(f.submitted.length, 0);
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
  f.click('[data-pane="templates"]'); f.click('#pane-body [data-template-id="preset-page"]'); await pause();
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

test('attachment operation status persists and repeated sends show progress without arming notice expiry', async t => {
  const manager = attachmentFixture({ pending: true });
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('完整正文'.repeat(4000)) } });
  const originalTimeout = f.window.setTimeout.bind(f.window);
  let noticeTimers = 0;
  f.window.setTimeout = (callback, delay, ...args) => {
    if (delay === 6500) noticeTimers++;
    return originalTimeout(callback, delay === 6500 ? 30 : delay, ...args);
  };
  f.editor.value = '请分析'; f.send(); await pause();
  const status = f.root.querySelector('.status');
  assert.match(status.textContent, /正在准备预设附件/);
  assert.equal(status.hidden, false);
  f.send('keydown'); await pause();
  assert.equal(status.hidden, false);
  assert.equal(noticeTimers, 0);
  assert.equal(manager.calls.length, 1);
  assert.equal(f.calls.filter(call => call.request?.refreshPage).length, 1);
  manager.release(); await pause();
  assert.equal(f.submitted.length, 1);
  assert.equal(status.hidden, true);
});

test('native asynchronous draft clearing after replay cannot leave a cancellation progress message', async t => {
  const f = fixture(t); await f.seed({ attachments: { url: true } });
  f.window.document.querySelector('form').addEventListener('submit', () => queueMicrotask(() => f.edit('')));
  f.editor.value = '原生发送后清空'; f.send(); await pause();
  assert.equal(f.submitted.length, 1);
  assert.match(f.submitted[0], /原生发送后清空/);
  assert.equal(f.editor.value, '');
  assert.equal(f.root.querySelector('.status').hidden, true);
  assert.doesNotMatch(f.root.querySelector('.status').textContent, /正在取消/);
});

test('an attempted Gemini attachment failure in auto mode blocks sending without a text fallback', async t => {
  const manager = attachmentFixture({ failure: 'Gemini 正文附件上传失败：Native error.' });
  const f = fixture(t, { site: BUILTIN_AI_SITES[1], attachmentManager: manager });
  await f.seed({ attachments: { page: page('完整正文'.repeat(4000)) } }, { pageMode: 'auto' });
  f.editor.value = '原问题'; f.send(); await pause();
  assert.deepEqual(f.submitted, []);
  assert.equal(f.editor.value, '原问题');
  assert.equal(f.context.pageRequested, true);
  assert.match(f.root.querySelector('.status').textContent, /Native error/);
  assert.doesNotMatch(f.root.querySelector('.status').textContent, /改用完整/);
});

test('concurrent body cancellation and upload rejection report cleanup once and allow text only after cleanup', async t => {
  const manager = attachmentFixture({ pending: true });
  let clearCount = 0, blocked = true;
  manager.clear = async () => {
    clearCount++;
    await pause();
    if (blocked) throw new Error('取消正文附件超时，无法确认已清理。');
  };
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('完整正文'.repeat(4000)) } });
  f.editor.value = '保留草稿'; f.send(); await pause();
  f.click('[aria-label="取消正文引用"]'); await pause(); await pause();
  assert.equal(clearCount, 1);
  assert.equal((f.root.querySelector('.status').textContent.match(/取消正文附件超时/g) || []).length, 1);
  assert.equal(f.editor.value, '保留草稿');
  assert.deepEqual(f.submitted, []);
  f.send('keydown'); await pause(); await pause();
  assert.equal(clearCount, 2);
  assert.deepEqual(f.submitted, []);
  blocked = false;
  f.send('keydown'); await pause(); await pause();
  assert.equal(clearCount, 3);
  assert.deepEqual(f.submitted, ['保留草稿']);
});

function claudeFixture(t, options = {}) {
  const states = [];
  const f = fixture(t, { site: BUILTIN_AI_SITES[2], ...options, onReady: state => states.push(state) });
  const send = f.window.document.querySelector('[data-testid="send-button"]');
  const voice = f.window.document.createElement('button');
  voice.type = 'button'; voice.setAttribute('aria-label', 'Dictate'); voice.hidden = true;
  send.after(voice);
  return { ...f, states, sendButton: send, voice };
}

test('Claude typing and clearing tolerate brief native control gaps without status or readiness flicker', async t => {
  const f = claudeFixture(t); await pause();
  f.sendButton.hidden = true; f.edit('新的问题'); await pause();
  assert.equal(f.root.querySelector('.status').hidden, true);
  assert.equal(f.states.at(-1).ready, true);
  f.sendButton.hidden = false; await pause();
  f.sendButton.hidden = true; f.edit(''); await pause();
  assert.equal(f.root.querySelector('.status').hidden, true);
  f.voice.hidden = false; await pause();
  assert.ok(f.states.every(state => state.ready));
  assert.equal(f.root.querySelector('.status').hidden, true);
});

test('Claude persistent missing controls expire the original grace even with repeated input', async t => {
  const f = claudeFixture(t); await pause();
  f.sendButton.hidden = true; f.edit('问题一'); await pause();
  f.edit('问题二'); await pause(); f.edit('问题三'); await pause(); await pause(); await pause();
  assert.equal(f.states.at(-1).ready, false);
  assert.equal(f.root.querySelector('.status').hidden, false);
  assert.match(f.root.querySelector('.status').textContent, /没有找到可用的发送控件/);
  assert.equal(f.send('keydown'), true);
  assert.equal(f.editor.value, '问题三');
  assert.deepEqual(f.submitted, []);
});

test('Claude Enter during a gap waits for a real target and sends references once', async t => {
  const f = claudeFixture(t); await f.api.refresh();
  await f.seed({ attachments: { url: true } });
  f.sendButton.hidden = true; f.edit('带引用的问题');
  assert.equal(f.send('keydown'), true);
  assert.equal(f.send('keydown'), true);
  await pause();
  assert.equal(f.calls.filter(call => call.request?.refreshPage).length, 0);
  assert.deepEqual(f.submitted, []);
  f.sendButton.hidden = false; await pause();
  assert.equal(f.calls.filter(call => call.request?.refreshPage).length, 1);
  assert.equal(f.submitted.length, 1);
  assert.match(f.submitted[0], /带引用的问题/);
  assert.match(f.submitted[0], /https:\/\/example.com\/article/);
});

test('Claude Enter grace times out without capture or sending and can be retried when the target returns', async t => {
  const f = claudeFixture(t); await pause();
  f.sendButton.hidden = true; f.edit('等待失败的草稿'); f.send('keydown');
  await pause(); await pause(); await pause(); await pause(); await pause();
  assert.deepEqual(f.submitted, []);
  assert.equal(f.editor.value, '等待失败的草稿');
  assert.equal(f.calls.filter(call => call.request?.refreshPage).length, 0);
  assert.match(f.root.querySelector('.status').textContent, /发送控件/);
  f.sendButton.hidden = false; f.send('keydown'); await pause();
  assert.deepEqual(f.submitted, ['等待失败的草稿']);
});

test('Claude grace preserves Shift Enter, modifiers and IME instead of capturing newline input', async t => {
  const f = claudeFixture(t); await pause();
  f.sendButton.hidden = true; f.edit('输入法草稿');
  for (const overrides of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(f.send('keydown', overrides), false);
  }
  assert.equal(f.calls.filter(call => call.request?.refreshPage).length, 0);
  assert.equal(f.editor.value, '输入法草稿');
});

for (const change of ['question', 'reference', 'session', 'editor']) test(`Claude waiting for Send cancels on ${change} change and protects the current draft`, async t => {
  const f = claudeFixture(t); await f.api.refresh();
  f.sendButton.hidden = true; f.edit('原问题'); f.send('keydown');
  let current = f.editor;
  if (change === 'question') f.edit('用户新草稿');
  if (change === 'reference') await f.seed({ attachments: { url: true } });
  if (change === 'session') { f.editor.dataset.conversationId = 'new'; f.editor.value = '新会话草稿'; }
  if (change === 'editor') { current = f.editor.cloneNode(); current.value = '新输入框草稿'; f.editor.replaceWith(current); }
  await pause();
  f.sendButton.hidden = false; await pause();
  assert.deepEqual(f.submitted, []);
  assert.equal(f.calls.filter(call => call.request?.refreshPage).length, 0);
  assert.equal(current.value, change === 'question' ? '用户新草稿' : change === 'session' ? '新会话草稿' : change === 'editor' ? '新输入框草稿' : '原问题');
});

test('Claude ambiguity and explicit selector errors bypass the grace immediately', async t => {
  const f = claudeFixture(t); await pause();
  const second = f.sendButton.cloneNode(true); f.sendButton.after(second); await pause();
  assert.equal(f.states.at(-1).ready, false);
  assert.match(f.root.querySelector('.status').textContent, /多个匹配/);
  for (const selector of ['[', '#missing']) {
    const configured = claudeFixture(t, { site: { ...BUILTIN_AI_SITES[2], selectors: { send: selector } } });
    assert.equal(configured.states.at(-1).ready, false);
    assert.equal(configured.root.querySelector('.status').hidden, false);
  }
});

test('disposing a Claude grace removes pending readiness timers', async t => {
  const f = claudeFixture(t); await pause();
  f.sendButton.hidden = true; f.edit('草稿'); await pause();
  const count = f.states.length;
  f.api.dispose(); await pause(); await pause(); await pause(); await pause();
  assert.equal(f.states.length, count);
  assert.equal(f.api.host.isConnected, false);
});

test('fresh body determines attachment delivery and stays unchanged throughout upload checks', async t => {
  const manager = attachmentFixture({ pending: true });
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('开启时的短正文') } });
  const original = f.chrome.runtime.sendMessage;
  const latest = '发送时展开的新正文。'.repeat(1600) + 'FRESH-END';
  let captures = 0;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.refreshPage) {
      captures++;
      f.changeSource({ attachments: { ...f.context.attachments, page: { ...page(latest), capturedAt: '2026-10-03T12:00:00Z' } } });
    }
    return original(message);
  };
  f.editor.value = '总结最新内容'; f.send(); await pause();
  assert.equal(captures, 1); assert.equal(manager.calls.length, 1); assert.equal(f.submitted.length, 0);
  assert.ok(manager.calls[0].content.includes(latest)); assert.equal(manager.calls[0].content.includes('开启时的短正文'), false);
  await f.api.refresh(); f.send('keydown'); await pause();
  assert.equal(captures, 1); assert.equal(manager.calls.length, 1);
  manager.release(); await pause();
  assert.equal(f.submitted.length, 1); assert.equal(captures, 1);
  assert.ok(f.submitted[0].includes('-预设.txt')); assert.equal(f.submitted[0].includes(latest), false);
});

test('fresh extraction failure clears a previously prepared owned attachment', async t => {
  const manager = attachmentFixture();
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('旧正文'.repeat(6000)) } });
  f.editor.value = '第一个问题'; f.send(); await pause();
  assert.equal(f.submitted.length, 1); assert.equal(manager.calls.length, 1);
  const cleared = manager.cleared, original = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => {
    if (message.request.refreshPage) f.changeSource({ pageRequested: true, pageError: '新正文提取失败。', attachments: { ...f.context.attachments, page: null } });
    return original(message);
  };
  f.edit('第二个问题'); f.send(); await pause();
  assert.equal(f.submitted.length, 1); assert.equal(f.editor.value, '第二个问题');
  assert.equal(manager.cleared, cleared + 1);
});

test('long body uploads separately while question, selection and URL use the native message', async t => {
  const manager = attachmentFixture();
  const f = fixture(t, { attachmentManager: manager });
  const body = '完整网页正文。'.repeat(2500) + 'END-OF-PAGE';
  await f.seed({ selection: selection('Tabbit'), attachments: { url: true, page: page(body) } });
  assert.equal(f.root.querySelector('[data-chip="page"] .excerpt').textContent, '网页正文 · 附件');
  f.editor.value = '分析这个词与网页的关系'; f.send('keydown'); await pause();
  assert.equal(manager.calls.length, 1);
  assert.ok(manager.calls[0].content.endsWith(`${body}\n\n【网页引用资料结束】`));
  assert.equal(manager.calls[0].content.includes('分析这个词与网页的关系'), false);
  assert.equal(f.submitted.length, 1);
  assert.ok(f.submitted[0].includes('网页划词：\nTabbit'));
  assert.ok(f.submitted[0].includes('网页 URL：https://example.com/article'));
  assert.ok(f.submitted[0].includes(manager.calls[0].name));
  assert.equal(f.submitted[0].includes('END-OF-PAGE'), false);
  assert.ok(Object.values(f.context.templateSelections).every(value => value === false));
  f.send(); await pause();
  assert.equal(manager.calls.length, 1, 'later sends do not upload deselected presets');
  assert.equal(f.submitted[1], '分析这个词与网页的关系');
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

test('the message names the unique actual attachment and later sends omit its deselected body', async t => {
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
  assert.equal(f.submitted[1], '请总结');
});

test('upload failure preserves both the question and selected body without a partial send', async t => {
  const manager = attachmentFixture({ failure: '附件上传失败。' });
  const f = fixture(t, { attachmentManager: manager });
  await f.seed({ attachments: { page: page('正文'.repeat(9000)) } });
  f.editor.value = '总结一下'; f.send(); await pause();
  assert.equal(f.editor.value, '总结一下'); assert.equal(f.submitted.length, 0);
  assert.ok(f.context.attachments.page);
  assert.equal(f.context.templateSelections[PRESET_IDS.page], true);
  assert.equal(f.calls.some(call => call.request.type === 'SIDER_TAB_TEMPLATES_CLEAR'), false);
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
  assert.ok(f.submitted[0].startsWith('保留全文\n\n【网页引用资料】'));
  assert.ok(f.submitted[0].endsWith(`网页正文：\n${body}\n\n【网页引用资料结束】`));
});

test('one template entrance contains three editable presets and no reference/settings buttons', async t => {
 const f = fixture(t); await f.seed({ selection: selection(), selectionIncluded: false }, { defaultSelection: false });
 f.editor.value = '保留原问题'; f.click('[data-pane="templates"]');
 assert.equal(f.root.querySelector('[data-pane="references"]'), null); assert.equal(f.root.querySelector('[data-pane="settings"]'), null);
 assert.equal(f.root.querySelectorAll('.template-row').length, 3);
 f.click('[aria-label="编辑预设 划词"]'); assert.equal(f.root.querySelector('#template-default').checked, false);
 f.root.querySelector('#template-default').checked = true;
 [...f.root.querySelectorAll('#pane-body button')].find(button => button.textContent === '保存预设').click(); await pause();
 assert.equal(f.settings.defaultSelection, true); assert.equal(f.editor.value, '保留原问题'); assert.deepEqual(f.submitted, []);
});

test('selection close uses the clear operation accepted by the previous background', async t => {
  const f = fixture(t); await f.seed({ selection: selection(), attachments: { url: true, page: page() } });
  f.editor.value = '取消后继续提问';
  f.click('[aria-label="取消划词"]'); await pause(); await f.api.refresh();
  assert.equal(f.context.selectionIncluded, false);
  assert.equal(f.root.querySelector('.selection-chip'), null);
  assert.ok(f.root.querySelector('[data-chip="url"]'));
  assert.ok(f.root.querySelector('[data-chip="page"]'));
  assert.equal(f.root.querySelector('.status.error'), null);
  assert.deepEqual(f.calls.filter(message => !['SIDER_TAB_CONTEXT_GET', 'SIDER_PROMPT_TEMPLATES_GET'].includes(message.request.type)).map(message => message.request), [{ type: 'SIDER_TAB_TEMPLATE_SET', id: PRESET_IDS.selection, enabled: false }]);
  assert.equal(f.editor.value, '取消后继续提问');
  assert.deepEqual(f.submitted, []);
  f.send(); await pause();
  assert.equal(f.submitted.length, 1);
  assert.ok(f.submitted[0].includes('取消后继续提问'));
  assert.ok(f.submitted[0].includes('完整的网页正文'));
  assert.ok(!f.submitted[0].includes(selection().content));
});

test('failed default body shows retry and cancellation while blocking a partial native send', async t => {
  const f = fixture(t); await f.seed({ pageRequested: true, pageError: '没有取得网页正文。' }, { defaultPage: true });
  f.editor.value = '需要正文才能回答';
  assert.equal(f.root.querySelector('[data-chip="page"] .excerpt').textContent, '网页正文 · 未就绪');
  assert.equal(f.root.querySelector('#page-retry').hidden, false);
  f.send(); await pause();
  assert.deepEqual(f.submitted, []); assert.equal(f.editor.value, '需要正文才能回答');
  f.click('#page-retry'); await pause();
  assert.equal(f.root.querySelector('#page-retry').hidden, true);
  assert.equal(f.root.querySelector('[data-chip="page"] .excerpt').textContent, '网页正文');
  f.send(); await pause();
  assert.equal(f.submitted.length, 1);
  assert.ok(f.submitted[0].startsWith('需要正文才能回答\n\n【网页引用资料】'));
  assert.ok(f.submitted[0].endsWith('网页正文：\n完整的网页正文\n\n【网页引用资料结束】'));
  await f.seed({ attachments: { page: null }, pageRequested: true, pageError: '提取失败。' });
  f.editor.value = '取消后直接提问';
  f.click('[aria-label="取消正文引用"]'); await pause();
  f.send(); await pause();
  assert.equal(f.submitted.at(-1), '取消后直接提问');
});

test('withheld default body offers authorization and can be cancelled without sending the draft', async t => {
  const f = fixture(t); await f.seed({ pageRequested: true, pageError: '当前网页尚未授权。' }, { defaultPage: true });
  await f.setNeedsAccess(true); f.editor.value = '等待授权的问题';
  assert.equal(f.root.querySelector('#source-access').hidden, false);
  assert.equal(f.root.querySelector('#page-retry').hidden, true);
  f.send(); await pause();
  assert.deepEqual(f.submitted, []); assert.equal(f.editor.value, '等待授权的问题');
  f.click('[aria-label="取消正文引用"]'); await pause();
  assert.equal(f.context.pageRequested, false);
  assert.equal(f.editor.value, '等待授权的问题');
});
