import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTabContext, normalizeContextSettings } from '../src/context.js';
import { presetTemplates, templateSettings } from '../src/prompt-templates.js';
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
  let failSave = false; let templates = presetTemplates(settings);
  const context = { ...createTabContext(1), url: 'https://example.com/article', title: '当前网页' };
  const calls = [];
  const appEvents = [];
  const formEvents = [];
  let nativeSubmits = 0;
  const response = () => ({ ok: true, context: structuredClone(context), settings: structuredClone(settings), templates: structuredClone(templates), needsAccess: false });
  const chrome = {
    runtime: {
      getURL: () => 'chrome-extension://settings-test/',
      async sendMessage(message) {
        calls.push(structuredClone(message));
        if (message.request.type === 'SIDER_PROMPT_TEMPLATES_SAVE') {
          if (failSave) { failSave = false; return { ok: false, error: '设置保存失败。' }; }
          templates = structuredClone(message.request.templates); settings = normalizeContextSettings(templateSettings(templates));
        }
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
  return { window, document, api, root, $, editor, form, calls, appEvents, formEvents, clickControl, typeText, failNextSave() { failSave = true; }, get nativeSubmits() { return nativeSubmits; }, get settings() { return structuredClone(settings); } };
}


const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function editPreset(f, name = '划词') { await f.api.refresh(); f.clickControl(f.$('[data-pane="templates"]')); f.clickControl(f.$('[aria-label="编辑预设 ' + name + '"]')); }
const save = f => f.clickControl([...f.root.querySelectorAll('button')].find(button => button.textContent === '保存预设'));

test('template fields retain focus and accept typing despite native composer focus handlers', async t => {
 const f = fixture(t); await editPreset(f); const input = f.$('#template-text'); f.clickControl(input);
 assert.ok(f.typeText(input, '\n自定义 {{selection}}')); assert.equal(f.root.activeElement, input);
 assert.equal(f.editor.value, '原版输入框中的问题'); assert.deepEqual(f.formEvents, []); assert.deepEqual(f.appEvents, []); assert.equal(f.nativeSubmits, 0);
});
test('Enter and advanced attachment edits save without submitting the question', async t => {
 const f = fixture(t); await editPreset(f, '网页正文'); const input = f.$('#template-text'); f.clickControl(input); assert.ok(f.typeText(input, '\n', 'Enter'));
 f.$('#template-delivery').value = 'file'; f.$('#template-delivery').dispatchEvent(new f.window.Event('change'));
 f.$('#template-attachment-text').value = '附件 {{filename}}'; f.$('#template-position').value = 'prepend'; save(f); await pause();
 assert.equal(f.settings.pageMode, 'file'); assert.equal(f.settings.pagePosition, 'prepend'); assert.equal(f.settings.pageAttachmentTemplate, '附件 {{filename}}'); assert.equal(f.nativeSubmits, 0);
});
test('refresh preserves unsaved template edits, checked defaults, and focus', async t => {
 const f = fixture(t); await editPreset(f); f.$('#template-name').value = '未保存名称'; f.$('#template-default').checked = false; f.clickControl(f.$('#template-text'));
 await f.api.refresh(); assert.equal(f.$('#template-name').value, '未保存名称'); assert.equal(f.$('#template-default').checked, false); assert.equal(f.root.activeElement, f.$('#template-text'));
 f.document.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(f.$('.popover').hidden, true);
});
test('failed saves keep the editor open and preserve last saved defaults', async t => {
 const f = fixture(t); await editPreset(f); f.$('#template-default').checked = false; f.failNextSave(); save(f); await pause();
 assert.equal(f.$('#template-default').checked, false); assert.equal(f.$('.popover').hidden, false); assert.equal(f.settings.defaultSelection, true); assert.match(f.$('#template-error').textContent, /保存失败/);
});
test('unknown variables, empty text, and body variables in attachment notes block storage', async t => {
 const f = fixture(t); await editPreset(f, '网页正文');
 const before = f.calls.filter(call => call.request.type === 'SIDER_PROMPT_TEMPLATES_SAVE').length;
 for (const [text, note] of [['{{bad}}', '{{filename}}'], ['', '{{filename}}'], ['{{content}}', '{{content}}']]) {
  f.$('#template-text').value = text; f.$('#template-attachment-text').value = note; save(f); await pause();
  assert.ok(f.$('#template-error').textContent); assert.equal(f.calls.filter(call => call.request.type === 'SIDER_PROMPT_TEMPLATES_SAVE').length, before);
 }
 assert.equal(f.nativeSubmits, 0);
});
test('valid templates save without collecting their referenced values first', async t => {
 const f = fixture(t); await editPreset(f); f.$('#template-text').value = '{{page.author}} {{selection}}'; save(f); await pause();
 assert.equal(f.settings.selectionTemplate, '{{page.author}} {{selection}}'); assert.equal(f.calls.some(call => call.request.type === 'SIDER_TEMPLATE_CONTEXT_GET'), false);
});
test('text mode folds attachment fields and validates them when enabled', async t => {
 const f = fixture(t); await editPreset(f); const mode = f.$('#template-delivery');
 assert.equal(f.$('#template-attachment-text').parentElement.hidden, true);
 f.$('#template-attachment-text').value = '{{content}}'; save(f); await pause();
 f.clickControl(f.$('[aria-label="编辑预设 划词"]')); f.$('#template-delivery').value = 'auto'; f.$('#template-delivery').dispatchEvent(new f.window.Event('change'));
 save(f); await pause(); assert.match(f.$('#template-error').textContent, /附件说明/);
});
test('presets cannot be deleted and restore all defaults', async t => {
 const f = fixture(t); await editPreset(f, '网页正文'); assert.equal([...f.root.querySelectorAll('button')].some(button => button.textContent === '删除'), false);
 [...f.root.querySelectorAll('button')].find(button => button.textContent === '恢复默认').click(); await pause();
 assert.equal(f.$('#template-delivery').value, 'auto'); assert.equal(f.$('#template-threshold').value, '10000'); assert.equal(f.nativeSubmits, 0);
});
