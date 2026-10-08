import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BUILTIN_AI_SITES, GEMINI_MODE_SPARK, GEMINI_MODEL_PRO, GEMINI_NORMAL_URL, GEMINI_SPARK_URL, aiSiteURL, normalizeCustomAISite, normalizeAIWebSettings, normalizeGeminiDefaults, validateAIWebSettings, listAISites, siteForURL, selectedAISite } from '../src/ai-web.js';
import { createWebAdapter } from '../src/content/adapters.js';
import { installEnhancement } from '../src/content/enhancement.js';
import { createNativeAttachmentDriver } from '../src/content/attachment-drivers.js';

const custom = (patch = {}) => normalizeCustomAISite({ id: 'custom-fixture-0001', name: 'Fixture AI', url: 'https://my-ai.test/chat', ...patch });
function fixture(t, html, site = custom()) {
  const { window } = new JSDOM(html, { url: site.url, pretendToBeVisual: true });
  window.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{}] : []; };
  t.after(() => window.close());
  return { window, document: window.document, adapter: createWebAdapter(window.document, site) };
}

const deepseekSite = custom({ name: 'DeepSeek', url: 'https://chat.deepseek.com/' });
const deepseekArrow = '<svg><path d="M8.3125 0.980206C8.66767 1.05312"></path></svg>';
const deepseekMarkup = `<main><section><div id="shell" style="display:flex;flex-direction:column"><div><textarea></textarea></div><div><div role="button" class="ds-button ds-button--icon">Attach</div><div id="action" role="button" class="ds-button ds-button--primary ds-button--circle ds-button--disabled">${deepseekArrow}</div></div></div></section></main>`;
function mockArrow(path) {
  // jsdom does not implement SVG geometry; supply an arrow contour independently
  // of CSS classes and path strings. Browser fixtures use actual SVG geometry.
  const points = [[8, 1], [15, 8], [10, 8], [10, 16], [6, 16], [6, 8], [1, 8], [8, 1]];
  path.getTotalLength = () => points.length - 1;
  path.getPointAtLength = value => { const i = Math.min(Math.floor(value), points.length - 2), a = points[i], b = points[i + 1], p = value - i; return { x: a[0] + (b[0] - a[0]) * p, y: a[1] + (b[1] - a[1]) * p }; };
}

test('generic icon geometry identifies an unlabeled div sender and CSS disabled state without using Attach', t => {
  const f = fixture(t, deepseekMarkup, deepseekSite);
  const send = f.document.querySelector('#action'), editor = f.adapter.findComposer(); mockArrow(send.querySelector('path'));
  assert.equal(f.adapter.availability().ready, true);
  assert.equal(f.adapter.findMountAnchor().id, 'shell');
  assert.equal(f.adapter.findSendButton(), null);
  assert.equal(f.adapter.findSendButton({ includeDisabled: true }), send);
  assert.equal(f.adapter.isSendIntent({ type: 'click', target: send.querySelector('path') }, editor), false);
  send.classList.remove('ds-button--disabled');
  assert.equal(f.adapter.findSendButton(), send);
  assert.equal(f.adapter.isSendIntent({ type: 'click', target: send.querySelector('path') }, editor), true);
  assert.equal(f.adapter.isSendIntent({ type: 'click', target: f.document.querySelector('.ds-button--icon') }, editor), false);
  send.outerHTML = send.outerHTML;
  mockArrow(f.document.querySelector('#action path'));
  assert.notEqual(f.adapter.findSendButton(), send, 're-resolve framework replacements');
});

test('generic icon recognition works on any configured origin and stays strict on ambiguity and manual configuration', t => {
  const f = fixture(t, deepseekMarkup, deepseekSite);
  mockArrow(f.document.querySelector('path'));
  assert.equal(f.adapter.availability().ready, true);
  assert.equal(createWebAdapter(f.document, custom()).availability().ready, true);
  assert.equal(createWebAdapter(f.document, custom({ url: 'https://completely-different.test/' })).availability().ready, true);
  const manual = createWebAdapter(f.document, { ...deepseekSite, selectors: { send: '#missing' } });
  assert.equal(manual.availability().reason, 'configured-send-missing');
  const button = f.document.querySelector('#action');
  button.classList.remove('ds-button--disabled');
  f.document.querySelector('#shell').append(button.cloneNode(true));
  mockArrow(f.document.querySelector('#shell').lastElementChild.querySelector('path'));
  assert.equal(f.adapter.availability().reason, 'ambiguous');
  f.document.querySelector('#shell').lastElementChild.remove();
  button.querySelector('path').remove();
  assert.equal(f.adapter.findSendButton(), null, 'a different circle action is not Send');
  button.setAttribute('aria-label', 'Stop response');
  assert.equal(f.adapter.isSendIntent({ type: 'keydown', key: 'Enter', target: f.adapter.findComposer() }, f.adapter.findComposer()), false);
});

test('native transport banners on any website are reported separately from DOM readiness and recover when cleared', t => {
  const site = custom({ name: 'Grok', url: 'https://grok.com/' });
  const f = fixture(t, '<form><textarea>Question</textarea><button type="submit">Send</button></form><span role="status" aria-live="polite">Your network or security software is blocking Grok’s real-time connection. Try another network.</span>', site);
  const state = f.adapter.availability();
  assert.equal(state.ready, false); assert.equal(state.reason, 'site-connection-error');
  assert.match(state.detail, /无法.*确定/); assert.match(state.detail, /原站入口/);
  const banner = f.document.querySelector('[role=status]');
  banner.hidden = true;
  assert.equal(f.adapter.availability().ready, true);
  banner.hidden = false;
  assert.equal(createWebAdapter(f.document, custom()).availability().reason, 'site-connection-error', 'connection diagnostics are shared by all websites');
  banner.remove();
  f.document.querySelector('textarea').value = 'Your network or security software is blocking Grok';
  assert.equal(f.adapter.availability().ready, true, 'question text is not a diagnosis');
});

for (const control of [
  '<button>Go</button>',
  '<input type="submit" value="Go">',
  '<div role="button" title="Send message (Enter)"><span>↑</span></div>',
  '<div role="button" class="composer-send-action"><span>↑</span></div>',
  '<div tabindex="0" data-action="send"><span>↑</span></div>',
  '<div role="button"><svg class="icon-paper-plane"><path d="M0 0"></path></svg></div>',
]) test(`generic send recognition handles standard and custom controls: ${control.slice(0, 55)}`, t => {
  const f = fixture(t, `<form><textarea placeholder="Message"></textarea>${control}</form>`);
  assert.equal(f.adapter.availability().ready, true);
  const send = f.adapter.findSendButton(); assert.ok(send);
  assert.equal(f.adapter.isSendIntent({ type: 'click', target: send.querySelector('span,path') || send }, f.adapter.findComposer()), true);
});

test('native associated submit controls are found outside the editor form', t => {
  const f = fixture(t, '<form id="composer"><textarea></textarea></form><input form="composer" type="submit" value="Send">');
  assert.equal(f.adapter.findSendButton(), f.document.querySelector('input'));
  assert.equal(f.adapter.availability().ready, true);
});

test('text fields and other editable controls are never mistaken for associated send controls', t => {
  const f = fixture(t, '<form id="composer"><textarea></textarea></form><input form="composer" tabindex="0" value="Send">');
  assert.equal(f.adapter.findSendButton(), null);
  assert.equal(f.adapter.availability().reason, 'send-missing');
});

test('semantic send evidence outranks unrelated implicit submit controls but equal targets remain ambiguous', t => {
  const f = fixture(t, '<form><textarea></textarea><button>Settings</button><button title="Send">↑</button></form>');
  assert.equal(f.adapter.findSendButton(), f.document.querySelector('[title=Send]'));
  f.document.querySelector('form').append(f.adapter.findSendButton().cloneNode(true));
  assert.equal(f.adapter.availability().reason, 'ambiguous');
});

test('a named chat editor excludes an unrelated textarea without weakening explicit selector priority', t => {
  const f = fixture(t, '<textarea id="notes"></textarea><form><div contenteditable="plaintext-only" role="textbox"></div><button>Send</button></form>');
  assert.equal(f.adapter.findComposer().getAttribute('contenteditable'), 'plaintext-only');
  assert.equal(f.adapter.availability().ready, true);
  const manual = createWebAdapter(f.document, custom({ selectors: { composer: '#notes' } }));
  assert.equal(manual.findComposer().id, 'notes');
});

test('generic native generation is scoped to an observed composer and never replayed as Send', t => {
  const f = fixture(t, '<section><textarea></textarea><button title="Send message">↑</button></section>');
  assert.equal(f.adapter.availability().ready, true);
  const action = f.document.querySelector('button'); action.setAttribute('title', 'Stop response');
  assert.equal(f.adapter.availability().ready, true);
  assert.equal(f.adapter.findSendButton(), null);
  assert.equal(f.adapter.isSendIntent({ type: 'keydown', key: 'Enter', target: f.adapter.findComposer() }, f.adapter.findComposer()), false);
});

test('AI website settings default to ChatGPT and isolate site origins exactly', () => {
  assert.equal(normalizeAIWebSettings().activeSiteId, 'chatgpt');
  assert.equal(normalizeAIWebSettings().geminiMode, 'normal');
  assert.equal(normalizeAIWebSettings().geminiModel, 'flash-lite');
  assert.equal(normalizeAIWebSettings().geminiExtendedThinking, false);
  assert.deepEqual(listAISites().map(site => site.id), ['chatgpt', 'gemini', 'claude']);
  assert.equal(siteForURL('https://chatgpt.com.evil.test/'), null);
  assert.equal(siteForURL('http://chatgpt.com/'), null);
  const site = custom({ url: 'http://localhost:8181/chat' });
  const settings = validateAIWebSettings({ activeSiteId: site.id, customSites: [site] });
  assert.equal(siteForURL('http://localhost:8181/new', settings).id, site.id);
  assert.equal(siteForURL('http://localhost:8182/new', settings), null);
});

test('Gemini interface mode resolves the normal and Spark entry URLs without changing its origin', () => {
  const normal = selectedAISite({ activeSiteId: 'gemini', customSites: [] });
  const spark = validateAIWebSettings({ activeSiteId: 'gemini', customSites: [], geminiMode: GEMINI_MODE_SPARK });
  assert.equal(normal.url, GEMINI_NORMAL_URL);
  assert.equal(aiSiteURL(normal, { geminiMode: 'normal' }), GEMINI_NORMAL_URL);
  assert.equal(aiSiteURL(normal, spark), GEMINI_SPARK_URL);
  assert.equal(new URL(aiSiteURL(normal, spark)).origin, normal.origin);
  assert.equal(normalizeAIWebSettings({ activeSiteId: 'gemini', customSites: [], geminiMode: 'invalid' }).geminiMode, 'normal');
  assert.throws(() => validateAIWebSettings({ activeSiteId: 'gemini', customSites: [], geminiMode: 'invalid' }), /界面设置无效/);
  const defaults = validateAIWebSettings({ activeSiteId: 'gemini', customSites: [], geminiModel: GEMINI_MODEL_PRO, geminiExtendedThinking: true });
  assert.deepEqual(normalizeGeminiDefaults(defaults), { model: GEMINI_MODEL_PRO, extendedThinking: true });
  assert.equal(normalizeAIWebSettings({ activeSiteId: 'gemini', customSites: [], geminiModel: 'unknown' }).geminiModel, 'flash-lite');
  assert.throws(() => validateAIWebSettings({ activeSiteId: 'gemini', customSites: [], geminiModel: 'unknown' }), /默认模型设置无效/);
  assert.throws(() => validateAIWebSettings({ activeSiteId: 'gemini', customSites: [], geminiExtendedThinking: 'yes' }), /扩展思考设置无效/);
});

test('custom website validation rejects unsafe addresses, duplicate origins, reserved sites and corrupt persisted entries', () => {
  for (const url of ['javascript:alert(1)', 'https://user:pass@ai.test/', 'not a url', 'https://claude.ai/chat']) assert.throws(() => custom({ url }));
  assert.throws(() => validateAIWebSettings({ activeSiteId: 'custom-fixture-0001', customSites: [custom(), custom({ id: 'custom-fixture-0002' })] }), /唯一/);
  const saved = normalizeAIWebSettings({ activeSiteId: 'missing', customSites: [{ id: 'chatgpt', name: 'Fake', url: 'https://fake.test' }, custom()] });
  assert.equal(saved.activeSiteId, 'chatgpt'); assert.equal(saved.customSites.length, 1);
});

test('builtin selector overrides keep immutable site identity and preserve old settings without migration', () => {
  assert.deepEqual(normalizeAIWebSettings(), { activeSiteId: 'chatgpt', customSites: [], geminiMode: 'normal', geminiModel: 'flash-lite', geminiExtendedThinking: false });
  const settings = validateAIWebSettings({ activeSiteId: 'claude', customSites: [custom()], builtinOverrides: { claude: { url: 'https://evil.test', adapter: 'generic', selectors: { send: ' #picked ' } } } });
  const site = selectedAISite(settings);
  assert.equal(site.origin, 'https://claude.ai'); assert.equal(site.adapter, 'claude'); assert.equal(site.selectors.send, '#picked');
  assert.equal(normalizeAIWebSettings(settings).customSites.length, 1);
  assert.equal(BUILTIN_AI_SITES[2].selectors.send, '');
  assert.throws(() => validateAIWebSettings({ activeSiteId: 'chatgpt', customSites: [], builtinOverrides: { unknown: {} } }), /内置网站/);
  assert.throws(() => validateAIWebSettings({ activeSiteId: 'chatgpt', customSites: [], builtinOverrides: { chatgpt: { selectors: { send: 'x'.repeat(1001) } } } }), /过长/);
  assert.equal(normalizeAIWebSettings({ builtinOverrides: { claude: { sendShortcut: 'invalid' } } }).builtinOverrides, undefined);
});

test('configured native send selectors survive replacement, remain strict on ambiguity and never select Stop', t => {
  const site = selectedAISite({ activeSiteId: 'chatgpt', customSites: [], builtinOverrides: { chatgpt: { selectors: { send: 'button[data-action="deliver"]' } } } });
  const f = fixture(t, '<form><textarea id="prompt-textarea">Question</textarea><button data-action="deliver"><span>Go</span></button></form>', site);
  assert.equal(f.adapter.availability().ready, true);
  const old = f.adapter.findSendButton(); old.outerHTML = old.outerHTML;
  assert.notEqual(f.adapter.findSendButton(), old);
  f.document.querySelector('form').append(f.adapter.findSendButton().cloneNode(true));
  assert.match(f.adapter.availability().detail, /多个匹配/);
  f.document.querySelectorAll('button')[1].remove();
  f.document.querySelector('button').setAttribute('aria-label', 'Stop response');
  assert.equal(f.adapter.findSendButton(), null);
});

test('native drag upload targets the editor center and reaches both its ancestor and document listeners once', t => {
  const f = fixture(t, '<div class="input-area"><rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea></div>', BUILTIN_AI_SITES[1]);
  const editor = f.adapter.findComposer(); const scope = editor.closest('.input-area');
  editor.getBoundingClientRect = () => ({ left: 20, top: 40, width: 200, height: 80 });
  f.window.DragEvent = class extends f.window.MouseEvent { constructor(type, options) { super(type, options); this.dataTransfer = options.dataTransfer; } };
  const events = [], transfer = { files: [{ name: 'body.txt' }] };
  for (const node of [editor, scope, f.document]) node.addEventListener('drop', event => events.push({ node, target: event.target, x: event.clientX, y: event.clientY, transfer: event.dataTransfer }));
  createNativeAttachmentDriver(f.document, f.adapter).upload({ scope, editor, input: null, transfer });
  assert.equal(events.length, 3);
  for (const event of events) { assert.equal(event.target, editor); assert.equal(event.x, 120); assert.equal(event.y, 80); assert.equal(event.transfer, transfer); }
});

test('generic adapters require a unique editor and send target and never fall back from explicit selectors', t => {
  const f = fixture(t, '<main><form><textarea id="question"></textarea><textarea id="other"></textarea><button type="submit">Send</button></form></main>');
  assert.equal(f.adapter.availability().ready, false);
  assert.match(f.adapter.availability().detail, /多个匹配/);
  const configured = createWebAdapter(f.document, custom({ selectors: { composer: '#question', send: 'button[type=submit]' } }));
  assert.equal(configured.availability().ready, true);
  assert.equal(configured.findComposer().id, 'question');
  const missing = createWebAdapter(f.document, custom({ selectors: { composer: '#missing' } }));
  assert.equal(missing.findComposer(), null);
  const invalid = createWebAdapter(f.document, custom({ selectors: { composer: '[' } }));
  assert.match(invalid.availability().detail, /选择器无效/);
  const anchor = createWebAdapter(f.document, custom({ selectors: { composer: '#question', mount: '#missing' } }));
  assert.equal(anchor.availability().ready, false);
});

test('generic adapters ignore hidden editors and ambiguous submit controls', t => {
  const f = fixture(t, '<main><textarea hidden></textarea><form><textarea></textarea><button type="submit">Send</button><button type="submit">Other</button></form></main>');
  assert.ok(f.adapter.findComposer()); assert.equal(f.adapter.findSendButton(), null);
  assert.match(f.adapter.availability().detail, /多个匹配/);
});

test('configured send shortcuts retain newline and IME behavior', t => {
  const f = fixture(t, '<form><textarea></textarea><button type="submit">Send</button></form>', custom({ sendShortcut: 'ctrl-enter' }));
  const editor = f.adapter.findComposer();
  const event = { type: 'keydown', key: 'Enter', target: editor };
  assert.equal(f.adapter.isSendIntent(event, editor), false);
  assert.equal(f.adapter.isSendIntent({ ...event, ctrlKey: true }, editor), true);
  assert.equal(f.adapter.isSendIntent({ ...event, metaKey: true }, editor), true);
  assert.equal(f.adapter.isSendIntent({ ...event, ctrlKey: true, shiftKey: true }, editor), false);
  assert.equal(f.adapter.isSendIntent({ ...event, ctrlKey: true, isComposing: true }, editor), false);
});

test('a disabled native send button cannot turn unrelated document clicks into send intents', t => {
  const f = fixture(t, '<main><form><textarea>Draft</textarea><button type="submit" disabled>Send</button></form></main>');
  assert.equal(f.adapter.isSendIntent({ type: 'click', target: f.document.querySelector('main') }, f.adapter.findComposer()), false);
});

test('Gemini Quill clipboard nodes do not make the actual prompt editor ambiguous', t => {
  const f = fixture(t, '<div class="input-area"><rich-textarea><div class="ql-editor" contenteditable="true" role="textbox">First</div><div class="ql-clipboard" contenteditable="true"></div></rich-textarea><button class="send-button">Send</button></div>', BUILTIN_AI_SITES[1]);
  assert.equal(f.adapter.findComposer().className, 'ql-editor');
  assert.equal(f.adapter.availability().ready, true);
  assert.equal(f.adapter.findMountAnchor().className, 'input-area');
});

test('ChatGPT empty voice controls are ready but are never treated as Send', t => {
  const f = fixture(t, '<main><form><textarea id="pending-conversation-input"></textarea><button aria-label="Dictate"></button><button aria-label="Start Voice"></button></form></main>', BUILTIN_AI_SITES[0]);
  assert.deepEqual(f.adapter.availability(), { ready: true, detail: '' });
  assert.equal(f.adapter.findSendButton(), null);
  assert.equal(f.adapter.isSendIntent({ type: 'click', target: f.document.querySelector('button') }, f.adapter.findComposer()), false);
  f.adapter.findComposer().value = 'Question';
  assert.equal(f.adapter.availability().ready, false, 'a nonempty draft requires a native send target');
  const voice = f.document.querySelector('[aria-label="Start Voice"]');
  voice.id = 'composer-submit-button'; voice.setAttribute('aria-label', 'Send prompt');
  assert.deepEqual(f.adapter.availability(), { ready: true, detail: '' });
  assert.equal(f.adapter.findSendButton(), voice);
});

test('Gemini idle microphone remains ready and the bar mounts below its horizontal input shell', t => {
  const f = fixture(t, '<main><section><div id="glow" style="display:flex"><input-area-v2 style="display:flex"><div class="input-area"><rich-textarea><div class="ql-editor" role="textbox" contenteditable="true"></div></rich-textarea><button aria-label="语音输入 (^⇧D)"></button></div></input-area-v2></div></section></main>', BUILTIN_AI_SITES[1]);
  assert.deepEqual(f.adapter.availability(), { ready: true, detail: '' });
  assert.equal(f.adapter.findMountAnchor().id, 'glow');
  assert.equal(f.adapter.findSendButton(), null);
  f.adapter.findComposer().textContent = 'Question';
  assert.equal(f.adapter.availability().ready, false);
  const send = f.document.querySelector('button'); send.setAttribute('aria-label', '发送');
  assert.equal(f.adapter.findSendButton(), send);
  assert.equal(f.adapter.availability().ready, true);
});

test('a voice control cannot hide custom-selector failures or substitute a missing nonempty send target', t => {
  const f = fixture(t, '<main><form><textarea></textarea><button aria-label="Start Voice"></button></form></main>');
  assert.equal(f.adapter.availability().ready, false);
  const manual = createWebAdapter(f.document, { ...BUILTIN_AI_SITES[0], selectors: { send: '#missing' } });
  assert.equal(manual.availability().ready, false);
  const builtin = createWebAdapter(f.document, BUILTIN_AI_SITES[0]);
  f.document.querySelector('button').hidden = true;
  assert.equal(builtin.availability().ready, false, 'hidden controls do not prove that a composer is ready');
});

test('Gemini native controls are scoped to the composer instead of a neighboring send button', t => {
  const f = fixture(t, '<main><input-area-v2><div class="input-area"><rich-textarea><div class="ql-editor" contenteditable="true" role="textbox">Question</div></rich-textarea></div></input-area-v2><button aria-label="Send message">Other send</button></main>', BUILTIN_AI_SITES[1]);
  assert.equal(f.adapter.findSendButton(), null);
  assert.equal(f.adapter.availability().ready, false);
});

test('Claude mounts outside the constrained editable row and identifies its current send test ID', t => {
  const f = fixture(t, '<main><section><fieldset id="composer"><div style="height:48px;overflow:hidden"><div class="ProseMirror" role="textbox" contenteditable="true"></div><button data-testid="chat-input-send" disabled></button></div></fieldset></section></main>', BUILTIN_AI_SITES[2]);
  assert.equal(f.adapter.findMountAnchor().id, 'composer');
  assert.equal(f.adapter.availability().ready, true);
  assert.equal(f.adapter.findSendButton(), null);
  f.document.querySelector('button').disabled = false;
  assert.equal(f.adapter.findSendButton().dataset.testid, 'chat-input-send');
});

test('Claude hydrated empty voice controls remain ready until the send button appears', t => {
  const f = fixture(t, '<main><section><fieldset><div><div class="tiptap ProseMirror" data-testid="chat-input" role="textbox" contenteditable="true"></div><button data-testid="chat-input-send" aria-label="Send message" hidden></button><button aria-label="Dictate"></button><button aria-label="Use voice mode"></button><button aria-label="Microphone"></button></div></fieldset></section></main>', BUILTIN_AI_SITES[2]);
  const editor = f.adapter.findComposer(), send = f.document.querySelector('[data-testid="chat-input-send"]');
  assert.deepEqual(f.adapter.availability(), { ready: true, detail: '' });
  assert.equal(f.adapter.findSendButton(), null);
  assert.equal(f.adapter.isSendIntent({ type: 'click', target: f.document.querySelector('[aria-label="Use voice mode"]') }, editor), false);
  editor.textContent = 'Question';
  assert.equal(f.adapter.availability().ready, false, 'voice controls do not authorize a nonempty send');
  send.hidden = false;
  assert.equal(f.adapter.findSendButton(), send);
  assert.deepEqual(f.adapter.availability(), { ready: true, detail: '' });
  editor.textContent = ''; send.hidden = true;
  assert.deepEqual(f.adapter.availability(), { ready: true, detail: '' });
});

test('Gemini send controls changing to pause stay ready without becoming send intents', t => {
  const f = fixture(t, '<main><input-area-v2><rich-textarea><div class="ql-editor" role="textbox" contenteditable="true">Question</div></rich-textarea><button class="send-button" aria-label="发送"></button></input-area-v2></main>', BUILTIN_AI_SITES[1]);
  const editor = f.adapter.findComposer(), send = f.document.querySelector('button');
  const enter = { type: 'keydown', target: editor, key: 'Enter' };
  assert.equal(f.adapter.findSendButton(), send);
  assert.equal(f.adapter.isSendIntent(enter, editor), true);
  for (const label of ['暂停', '停止回复', '停止生成', 'Stop response', 'Stop generating', 'Pause response']) {
    send.setAttribute('aria-label', label);
    assert.deepEqual(f.adapter.availability(), { ready: true, detail: '' }, label);
    assert.equal(f.adapter.findSendButton({ includeDisabled: true }), null, label);
    assert.equal(f.adapter.isSendIntent({ type: 'click', target: send }, editor), false, label);
    assert.equal(f.adapter.isSendIntent(enter, editor), false, label);
  }
  const manual = createWebAdapter(f.document, { ...BUILTIN_AI_SITES[1], selectors: { send: '.send-button' } });
  assert.equal(manual.findSendButton(), null, 'a selector must never replay a pause click');
  send.setAttribute('aria-label', '发送');
  assert.equal(f.adapter.findSendButton(), send);
  assert.equal(f.adapter.isSendIntent(enter, editor), true);
});

test('native generation state requires a visible control in the current composer', t => {
  const f = fixture(t, '<main><input-area-v2><rich-textarea><div class="ql-editor" role="textbox" contenteditable="true">Question</div></rich-textarea><button data-test-id="stop-button" hidden></button></input-area-v2><button aria-label="Stop response"></button></main>', BUILTIN_AI_SITES[1]);
  assert.equal(f.adapter.availability().ready, false, 'hidden and transcript stop controls cannot mask a missing sender');
  f.document.querySelector('[data-test-id="stop-button"]').hidden = false;
  assert.deepEqual(f.adapter.availability(), { ready: true, detail: '' });
  assert.equal(f.adapter.findSendButton(), null);
  const manual = createWebAdapter(f.document, { ...BUILTIN_AI_SITES[1], selectors: { send: '#missing' } });
  assert.equal(manual.availability().ready, false, 'explicit configuration still needs its configured target');
  const generic = createWebAdapter(f.document, custom({ selectors: { mount: 'input-area-v2' } }));
  assert.equal(generic.availability().ready, false, 'unknown websites cannot infer a working adapter from a stop control');
});

for (const site of [BUILTIN_AI_SITES[0], BUILTIN_AI_SITES[2]]) test(`${site.name} generation controls remain ready and cannot be replayed as Send`, t => {
  const id = site.id === 'chatgpt' ? 'stop-button' : 'chat-input-stop';
  const f = fixture(t, `<main><form><textarea id="prompt-textarea">Next draft</textarea><button data-testid="${id}"></button><button aria-label="Send message"></button></form></main>`, site);
  assert.deepEqual(f.adapter.availability(), { ready: true, detail: '' });
  assert.equal(f.adapter.findSendButton(), null, 'do not prepare or queue another message during native generation');
  assert.equal(f.adapter.isSendIntent({ type: 'keydown', key: 'Enter', target: f.adapter.findComposer() }, f.adapter.findComposer()), false);
});

test('generation attribute changes clear a stale diagnostic and preserve the mounted reference bar', async t => {
  const f = fixture(t, '<main><input-area-v2><rich-textarea><div class="ql-editor" role="textbox" contenteditable="true">Next draft</div></rich-textarea><button id="action"></button></input-area-v2></main>', BUILTIN_AI_SITES[1]);
  const chrome = { runtime: { async sendMessage() { return { ok: true, context: { tabId: 1, revision: 0, attachments: {} }, settings: {}, needsAccess: false }; } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  const states = [];
  const api = installEnhancement({ document: f.document, chrome, bridgeId: 'generation-controls-0001', adapter: f.adapter, onReady: state => states.push(state) });
  t.after(() => api.dispose());
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(states.at(-1).ready, false);
  f.document.querySelector('button').setAttribute('data-test-id', 'stop-button');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(states.at(-1).ready, true);
  assert.equal(api.root.querySelector('.status').hidden, true);
  const host = api.host;
  assert.equal(host.hidden, false);
  f.document.querySelector('button').removeAttribute('data-test-id');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(states.at(-1).ready, false);
  f.document.querySelector('button').title = 'Stop response';
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(states.at(-1).ready, true);
  assert.equal(api.root.querySelector('.status').hidden, true);
  f.document.querySelector('button').title = '';
  f.document.querySelector('button').setAttribute('aria-label', '发送');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(api.host, host);
  assert.equal(api.host.hidden, false);
  assert.equal(states.at(-1).ready, true);
  assert.equal(f.adapter.readDraft(f.adapter.findComposer()), 'Next draft');
});

test('readiness changes clear only a stale adapter diagnostic, including an in-place microphone-to-send transition', async t => {
  const f = fixture(t, '<main><form><textarea id="prompt-textarea">Question</textarea><button aria-label="Start Voice"></button></form></main>', BUILTIN_AI_SITES[0]);
  const chrome = { runtime: { async sendMessage() { return { ok: true, context: { tabId: 1, revision: 0, attachments: {} }, settings: {}, needsAccess: false }; } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  const states = [];
  const api = installEnhancement({ document: f.document, chrome, bridgeId: 'native-controls-0001', adapter: f.adapter, onReady: state => states.push(state) });
  t.after(() => api.dispose());
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(states.at(-1).ready, false);
  assert.equal(api.root.querySelector('.status').hidden, false);
  f.document.querySelector('button').setAttribute('aria-label', 'Send prompt');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(states.at(-1).ready, true);
  assert.equal(api.root.querySelector('.status').hidden, true);
});

test('Claude hydration reattaches the same reference controls below the replacement composer', async t => {
  const f = fixture(t, '<main><section id="dock"><div id="static-composer-box"><div class="ProseMirror" role="textbox" contenteditable="true"></div><button aria-label="Send message"></button></div></section></main>', BUILTIN_AI_SITES[2]);
  const chrome = { runtime: { async sendMessage() { return { ok: true, context: { tabId: 1, revision: 0, attachments: {} }, settings: {}, needsAccess: false }; } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  const api = installEnhancement({ document: f.document, chrome, bridgeId: 'native-controls-0002', adapter: f.adapter });
  t.after(() => api.dispose());
  assert.equal(api.host.previousElementSibling.id, 'static-composer-box');
  f.document.querySelector('#dock').innerHTML = '<fieldset id="hydrated-composer"><div style="height:48px;overflow:hidden"><div class="ProseMirror" role="textbox" contenteditable="true"></div><button data-testid="chat-input-send" disabled></button></div></fieldset>';
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(api.host.isConnected, true);
  assert.equal(api.host.hidden, false);
  assert.equal(api.host.previousElementSibling.id, 'hydrated-composer');
  assert.equal(api.host.parentElement.id, 'dock');
  assert.equal(f.document.querySelectorAll('#sider-enhancement').length, 1);
});

test('reference controls render and open on a page that rejects HTML-string assignments', async t => {
  const f = fixture(t, '<main><form><textarea id="prompt-textarea"></textarea><button aria-label="Start Voice"></button></form></main>', BUILTIN_AI_SITES[0]);
  Object.defineProperty(f.window.ShadowRoot.prototype, 'innerHTML', { configurable: true, set() { throw new TypeError('TrustedHTML required'); } });
  const chrome = { runtime: { async sendMessage() { return { ok: true, context: { tabId: 1, revision: 0, attachments: {} }, settings: {}, needsAccess: false }; } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  const api = installEnhancement({ document: f.document, chrome, bridgeId: 'native-controls-0003', adapter: f.adapter });
  t.after(() => api.dispose());
  await new Promise(resolve => setTimeout(resolve, 40));
  api.root.querySelector('[data-pane="templates"]').click();
  assert.equal(api.root.querySelector('.popover').hidden, false);
  assert.equal(api.root.querySelector('#pane-title').textContent, '预设');
  api.root.querySelector('[aria-label="编辑预设 划词"]').click();
  assert.ok(api.root.querySelector('#template-text'));
  assert.equal(api.host.isConnected, true);
});

test('Claude rich-editor writes use native editing and reject a partial framework reconciliation', async t => {
  const f = fixture(t, '<form><div class="ProseMirror" role="textbox" contenteditable="true"><p>Original</p></div><button aria-label="Send message">Send</button></form>', BUILTIN_AI_SITES[2]);
  const editor = f.adapter.findComposer();
  f.document.execCommand = (_command, _ui, text) => { editor.textContent = text; return true; };
  assert.equal((await f.adapter.writeDraft('First\nSecond')).ok, true);
  assert.equal(f.adapter.readDraft(editor), 'First\nSecond');
  editor.addEventListener('input', () => { editor.textContent = 'Partial'; }, { once: true });
  assert.equal((await f.adapter.writeDraft('Complete text')).ok, false);
});

for (const site of BUILTIN_AI_SITES.slice(1)) test(`${site.name} attachment adapter waits for a positive native preview and protects user files`, async t => {
  const editorHTML = site.id === 'claude' ? '<div class="ProseMirror" role="textbox" contenteditable="true"></div>' : '<rich-textarea><div class="ql-editor" role="textbox" contenteditable="true"></div></rich-textarea>';
  const f = fixture(t, `<form>${editorHTML}<input type="file"><div id="files"></div><button aria-label="Send message">Send</button></form>`, site);
  const input = f.document.querySelector('input');
  let files = [];
  Object.defineProperty(input, 'files', { get: () => files, set: value => { files = value; } });
  f.window.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  const area = f.document.querySelector('#files');
  let owned;
  const card = name => {
    const node = f.document.createElement('div'); node.dataset.testid = 'file-attachment';
    const label = f.document.createElement('span'); label.textContent = name; node.append(label);
    const remove = f.document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${name}`); remove.onclick = () => node.remove(); node.append(remove); area.append(node);
    return node;
  };
  const user = card('user.txt');
  input.onchange = () => { owned = card(input.files[0].name); input.files = []; };
  const manager = f.adapter.createAttachmentManager({ timeoutMs: 400 });
  t.after(() => manager.dispose());
  const spec = { name: 'body.txt', content: 'Full body', mimeType: 'text/plain' };
  let done = false;
  const pending = manager.prepare(spec).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(done, false);
  const preview = f.document.createElement('button'); preview.type = 'button'; preview.setAttribute('aria-label', owned.querySelector('span').textContent); owned.append(preview);
  owned.setAttribute('aria-busy', 'true');
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(done, false, 'card-level upload state must block a visible preview');
  owned.removeAttribute('aria-busy');
  await pending;
  assert.equal(manager.isReady(spec), true);
  await manager.clear(); assert.equal(owned.isConnected, false); assert.equal(user.isConnected, true);
});
