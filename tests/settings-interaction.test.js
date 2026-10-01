import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTabContext, normalizeContextSettings } from '../src/context.js';
import { installEnhancement } from '../src/content/enhancement.js';

function fixture(t) {
  const { window } = new JSDOM('<main id="app"><form><div data-composer-body><textarea id="prompt-textarea"></textarea></div><button data-testid="send-button">Send</button></form></main>', { url: 'https://chatgpt.com/', pretendToBeVisual: true });
  const document = window.document;
  window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 300, height: 60 }] : []; };
  const editor = document.querySelector('#prompt-textarea');
  const form = document.querySelector('form');
  const app = document.querySelector('#app');
  editor.value = '原版输入框中的问题';
  let settings = normalizeContextSettings();
  const context = { ...createTabContext(1), url: 'https://example.com/article', title: '当前网页' };
  const calls = [];
  const appEvents = [];
  const formEvents = [];
  let nativeSubmits = 0;
  const response = () => ({ ok: true, context: structuredClone(context), settings: structuredClone(settings), needsAccess: false });
  const chrome = {
    runtime: {
      getURL: () => 'chrome-extension://settings-test/',
      async sendMessage(message) {
        calls.push(structuredClone(message));
        if (message.request.type === 'SIDER_CONTEXT_SETTINGS_PATCH') settings = normalizeContextSettings({ ...settings, ...message.request.patch });
        return response();
      },
    },
    storage: { onChanged: { addListener() {}, removeListener() {} } },
  };
  // Native composers often treat every pointer/focus event inside their form
  // as an instruction to focus the editor. Shadow events are retargeted to
  // the host, so inspecting event.target cannot identify a settings textarea.
  form.addEventListener('pointerdown', event => {
    if (event.target === editor) return;
    formEvents.push(event.type); event.preventDefault(); editor.focus();
  }, true);
  for (const type of ['focusin', 'click']) form.addEventListener(type, event => {
    if (event.target === editor) return;
    formEvents.push(event.type); editor.focus();
  });
  // React's delegated bubble listeners must not process enhancement edits.
  // A global capture listener is intentionally not used here: ancestor form
  // capture is addressed by placing the host outside the composer form.
  for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'change', 'click']) app.addEventListener(type, event => {
    if (event.target === editor || event.target === document.querySelector('[data-testid="send-button"]')) return;
    appEvents.push(event.type);
    if (type === 'keydown' || type === 'beforeinput') event.preventDefault();
    editor.focus();
  });
  form.addEventListener('keydown', event => {
    if (event.target === editor && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', event => { event.preventDefault(); nativeSubmits++; });
  const api = installEnhancement({ document, chrome, bridgeId: 'settings-bridge-0001' });
  t.after(() => { api.dispose(); window.close(); });
  const root = api.root;
  const $ = selector => root.querySelector(selector);
  function clickControl(element) {
    const pointer = new window.Event('pointerdown', { bubbles: true, cancelable: true, composed: true });
    element.dispatchEvent(pointer);
    if (!pointer.defaultPrevented) element.focus();
    element.dispatchEvent(new window.Event('pointerup', { bubbles: true, composed: true }));
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    return !pointer.defaultPrevented;
  }
  function typeText(element, value, key = 'x') {
    const keydown = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true });
    element.dispatchEvent(keydown);
    const beforeInput = new window.InputEvent('beforeinput', { data: value, inputType: key === 'Enter' ? 'insertLineBreak' : 'insertText', bubbles: true, cancelable: true, composed: true });
    element.dispatchEvent(beforeInput);
    if (!keydown.defaultPrevented && !beforeInput.defaultPrevented) {
      element.value += value;
      element.dispatchEvent(new window.InputEvent('input', { data: value, inputType: beforeInput.inputType, bubbles: true, composed: true }));
    }
    element.dispatchEvent(new window.KeyboardEvent('keyup', { key, bubbles: true, composed: true }));
    return !keydown.defaultPrevented && !beforeInput.defaultPrevented;
  }
  return { window, document, api, root, $, editor, form, calls, appEvents, formEvents, clickControl, typeText, get nativeSubmits() { return nativeSubmits; }, get settings() { return structuredClone(settings); } };
}

test('settings textareas retain focus and accept typing despite native composer focus handlers', async t => {
  const f = fixture(t); await f.api.refresh();
  f.clickControl(f.$('[data-pane="settings"]'));
  const input = f.$('#selection-template');
  assert.ok(f.clickControl(input), 'native pointerdown must not cancel focusing the settings field');
  assert.equal(f.root.activeElement, input, 'native composer must not steal settings focus');
  const previous = input.value;
  assert.ok(f.typeText(input, '\n自定义格式：{{selection}}'));
  assert.equal(input.value, `${previous}\n自定义格式：{{selection}}`);
  assert.equal(f.root.activeElement, input);
  assert.equal(f.editor.value, '原版输入框中的问题');
  assert.deepEqual(f.formEvents, []);
  assert.deepEqual(f.appEvents, []);
  assert.equal(f.nativeSubmits, 0);
});

test('template Enter and attachment settings edits save without submitting or modifying the native question', async t => {
  const f = fixture(t); await f.api.refresh();
  f.clickControl(f.$('[data-pane="settings"]'));
  const template = f.$('#url-template');
  f.clickControl(template); template.value = '网页url为：{{url}}';
  assert.ok(f.typeText(template, '\n', 'Enter'), 'Enter must keep its textarea default behavior');
  assert.equal(f.root.activeElement, template);
  const select = f.$('#url-position');
  assert.ok(f.clickControl(select));
  assert.equal(f.root.activeElement, select);
  select.value = 'prepend'; select.dispatchEvent(new f.window.Event('change', { bubbles: true, composed: true }));
  assert.equal(f.root.activeElement, select);
  const mode = f.$('#page-mode');
  const threshold = f.$('#page-threshold');
  assert.equal(mode.value, 'auto');
  assert.equal(threshold.disabled, false);
  f.clickControl(threshold); threshold.value = '64000';
  threshold.dispatchEvent(new f.window.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }));
  assert.equal(f.root.activeElement, threshold);
  assert.ok(f.clickControl(mode)); mode.value = 'file';
  mode.dispatchEvent(new f.window.Event('change', { bubbles: true, composed: true }));
  assert.equal(f.root.activeElement, mode);
  assert.equal(threshold.disabled, true);
  const attachmentTemplate = f.$('#page-attachment-template');
  assert.ok(f.clickControl(attachmentTemplate)); attachmentTemplate.value = '请结合附件 {{filename}} 回答。';
  assert.ok(f.typeText(attachmentTemplate, '\n', 'Enter'));
  assert.ok(f.typeText(attachmentTemplate, '来源：{{url}}'));
  assert.equal(f.root.activeElement, attachmentTemplate);
  f.clickControl(f.$('#save-settings'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.settings.urlTemplate, '网页url为：{{url}}\n');
  assert.equal(f.settings.urlPosition, 'prepend');
  assert.equal(f.settings.pageMode, 'file');
  assert.equal(f.settings.pageThreshold, 64000);
  assert.equal(f.settings.pageAttachmentTemplate, '请结合附件 {{filename}} 回答。\n来源：{{url}}');
  assert.equal(Object.hasOwn(f.settings, 'maxChars'), false);
  assert.equal(f.$('.popover').hidden, true);
  assert.equal(f.editor.value, '原版输入框中的问题');
  assert.equal(f.nativeSubmits, 0);
  assert.equal(f.calls.filter(message => message.request.type === 'SIDER_CONTEXT_SETTINGS_PATCH').length, 1);
  assert.deepEqual(f.formEvents, []);
  assert.deepEqual(f.appEvents, []);
  // Event isolation applies only to extension controls. Normal ChatGPT Enter
  // remains available to the site's native composer handlers.
  f.editor.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(f.nativeSubmits, 1);
});

test('context refresh preserves unsaved settings and focus, and Escape still closes the settings', async t => {
  const f = fixture(t); await f.api.refresh();
  f.clickControl(f.$('[data-pane="settings"]'));
  const template = f.$('#page-template'); f.clickControl(template); template.value = '还未保存的格式：{{content}}';
  f.$('#page-position').value = 'prepend';
  f.$('#page-mode').value = 'text';
  f.$('#page-threshold').value = '12345';
  f.$('#page-attachment-template').value = '未保存的附件格式：{{filename}}';
  await f.api.refresh(); await f.api.refresh();
  assert.equal(f.$('#page-template'), template);
  assert.equal(template.value, '还未保存的格式：{{content}}');
  assert.equal(f.$('#page-position').value, 'prepend');
  assert.equal(f.$('#page-mode').value, 'text');
  assert.equal(f.$('#page-threshold').value, '12345');
  assert.equal(f.$('#page-attachment-template').value, '未保存的附件格式：{{filename}}');
  assert.equal(f.root.activeElement, template);
  template.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
  assert.equal(f.$('.popover').hidden, true);
  assert.equal(f.calls.some(message => message.request.type === 'SIDER_CONTEXT_SETTINGS_PATCH'), false);
  assert.equal(f.editor.value, '原版输入框中的问题');
});

test('native popover opens once, closes on outside click, and leaves the top layer on disposal', async t => {
  const f = fixture(t); await f.api.refresh();
  const popup = f.$('.popover');
  // jsdom has no top-layer implementation. Model just the public platform
  // contract here; browser integration covers real hit testing and rendering.
  let opened = false;
  const transitions = [];
  const matches = popup.matches.bind(popup);
  popup.matches = selector => selector === ':popover-open' ? opened : matches(selector);
  popup.showPopover = () => { assert.equal(opened, false); opened = true; transitions.push('open'); };
  popup.hidePopover = () => { assert.equal(opened, true); opened = false; transitions.push('close'); };
  f.clickControl(f.$('[data-pane="references"]'));
  assert.equal(opened, true);
  assert.equal(popup.hidden, false);
  f.clickControl(f.$('[data-pane="settings"]'));
  assert.equal(opened, true);
  assert.ok(f.$('#selection-template'));
  assert.deepEqual(transitions, ['open'], 'switching panes must not open an already-open popover');
  f.document.body.dispatchEvent(new f.window.Event('pointerdown', { bubbles: true, composed: true }));
  assert.equal(opened, false);
  assert.equal(popup.hidden, true);
  f.clickControl(f.$('[data-pane="settings"]'));
  assert.equal(opened, true);
  f.api.dispose();
  assert.equal(opened, false);
  assert.equal(f.api.host.isConnected, false);
  assert.deepEqual(transitions, ['open', 'close', 'open', 'close']);
});
