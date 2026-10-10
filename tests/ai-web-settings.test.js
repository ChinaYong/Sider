import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { installAIWebSettings } from '../src/ai-web-settings.js';
import { normalizeAIWebSettings, selectedAISite } from '../src/ai-web.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, settings = normalizeAIWebSettings(), pickSendButton = async () => ({ ok: true, selector: 'button[data-action="deliver"]' })) {
  const html = await readFile(new URL('../src/panel.html', import.meta.url), 'utf8');
  const { window } = new JSDOM(html);
  t.after(() => window.close());
  const document = window.document;
  const dialog = document.querySelector('#ai-settings-dialog');
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  const messages = [], picked = [];
  const chrome = {
    runtime: { id: 'settings-test', async sendMessage(message) { messages.push(message); return message.type === 'SIDER_AI_WEB_SETTINGS_GET' ? { ok: true, settings } : { ok: true, settings: message.settings }; } },
    permissions: { async request() { return true; } },
  };
  installAIWebSettings({ document, chrome, pickSendButton: async site => { picked.push(site); return pickSendButton(site); } });
  document.querySelector('#ai-settings-toggle').click(); await settle();
  return { window, document, dialog, messages, picked, $: selector => document.querySelector(selector) };
}

test('Gemini Spark switch is persisted and defaults to the normal interface', async t => {
  const f = await fixture(t);
  const toggle = f.$('#ai-gemini-spark');
  assert.equal(toggle.checked, false);
  assert.equal(f.$('#ai-gemini-model').value, 'flash-lite');
  assert.equal(f.$('#ai-gemini-thinking').checked, false);
  toggle.click();
  f.$('#ai-gemini-model').value = 'pro'; f.$('#ai-gemini-model').dispatchEvent(new f.window.Event('change'));
  f.$('#ai-gemini-thinking').click();
  f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.geminiMode, 'spark');
  assert.equal(f.messages.at(-1).settings.geminiModel, 'pro');
  assert.equal(f.messages.at(-1).settings.geminiExtendedThinking, true);
  assert.equal(toggle.checked, true);
});

test('per-site settings collapse independently and configuring another site preserves the active website', async t => {
  const f = await fixture(t);
  const menu = f.$('#ai-site-settings');
  const gemini = f.$('[data-site-id="gemini"]');
  const claude = f.$('[data-site-id="claude"]');
  assert.equal(menu.open, false);
  assert.equal(gemini.open, false);
  assert.ok(gemini.contains(f.$('#ai-gemini-spark')));
  menu.open = true; gemini.open = true; claude.open = true;
  f.$('#ai-gemini-model').value = 'pro'; f.$('#ai-gemini-model').dispatchEvent(new f.window.Event('change'));
  gemini.open = false;
  claude.querySelector('button').click();
  assert.ok(claude.contains(f.$('#ai-custom-fields')));
  f.$('#ai-selector-send').value = '#claude-send';
  claude.open = false; menu.open = false;
  f.$('#ai-save-settings').click(); await settle();
  assert.equal(menu.open, true); assert.equal(claude.open, true);
  assert.equal(f.messages.some(message => message.type === 'SIDER_AI_WEB_SETTINGS_SAVE'), false);
  f.$('#ai-apply-site').click();
  assert.equal(f.$('#ai-active-site').value, 'chatgpt');
  assert.equal(f.$('[data-site-id="gemini"]').open, false);
  assert.equal(f.$('[data-site-id="claude"]').open, true);
  f.$('#ai-save-settings').click(); await settle();
  const saved = f.messages.at(-1).settings;
  assert.equal(saved.activeSiteId, 'chatgpt');
  assert.equal(saved.builtinOverrides.claude.selectors.send, '#claude-send');
  assert.equal(saved.geminiModel, 'pro');
});

test('builtin send-button calibration saves selectors while site identity and the existing custom sites remain intact', async t => {
  const custom = { id: 'custom-fixture-0001', name: 'Custom', url: 'https://my-ai.test' };
  const f = await fixture(t, { activeSiteId: 'chatgpt', customSites: [custom] });
  assert.equal(f.$('#ai-edit-site').hidden, false); assert.equal(f.$('#ai-remove-site').hidden, true);
  f.$('#ai-edit-site').click(); assert.equal(f.$('#ai-site-url').readOnly, true);
  f.$('#ai-pick-send').click(); await settle();
  assert.equal(f.picked[0].id, 'chatgpt'); assert.equal(f.dialog.open, true);
  assert.equal(f.$('#ai-selector-send').value, 'button[data-action="deliver"]');
  f.$('#ai-apply-site').click(); f.$('#ai-save-settings').click(); await settle();
  const saved = f.messages.at(-1).settings;
  assert.equal(selectedAISite(saved).selectors.send, 'button[data-action="deliver"]');
  assert.equal(saved.customSites.length, 1); assert.equal(f.dialog.open, false);
});

test('custom website point selection uses the loaded custom identity and reset restores automatic identification', async t => {
  const f = await fixture(t, { activeSiteId: 'custom-fixture-0001', customSites: [{ id: 'custom-fixture-0001', name: 'Custom', url: 'https://my-ai.test', selectors: { composer: '#prompt' } }] });
  f.$('#ai-edit-site').click(); f.$('#ai-pick-send').click(); await settle();
  assert.equal(f.picked[0].origin, 'https://my-ai.test'); assert.equal(f.$('#ai-site-url').readOnly, false);
  f.$('#ai-reset-send').click(); f.$('#ai-apply-site').click(); f.$('#ai-save-settings').click(); await settle();
  const saved = f.messages.at(-1).settings;
  assert.equal(saved.customSites[0].selectors.send, ''); assert.equal(saved.customSites[0].selectors.composer, '#prompt');
});

test('cancelled or failed selection retains manual selectors and draft website fields', async t => {
  for (const result of [{ ok: false, cancelled: true }, { ok: false, error: 'Website not loaded' }]) {
    const f = await fixture(t, normalizeAIWebSettings(), async () => result);
    f.$('#ai-edit-site').click(); f.$('#ai-selector-send').value = '#original';
    f.$('#ai-pick-send').click(); await settle();
    assert.equal(f.$('#ai-selector-send').value, '#original'); assert.equal(f.$('#ai-site-name').value, 'ChatGPT');
    assert.equal(f.dialog.open, true); assert.equal(f.messages.some(message => message.type === 'SIDER_AI_WEB_SETTINGS_SAVE'), false);
  }
});

test('page closure during selection neither reopens the dialog nor applies the late result', async t => {
  let resolve;
  const f = await fixture(t, normalizeAIWebSettings(), () => new Promise(callback => { resolve = callback; }));
  f.$('#ai-edit-site').click(); f.$('#ai-selector-send').value = '#original'; f.$('#ai-pick-send').click();
  assert.equal(f.dialog.open, false);
  f.window.dispatchEvent(new f.window.Event('pagehide'));
  resolve({ ok: true, selector: '#late' }); await settle();
  assert.equal(f.dialog.open, false); assert.equal(f.$('#ai-selector-send').value, '#original');
});

test('switching websites preserves an unfinished editor and reveals it for completion', async t => {
  const f = await fixture(t);
  f.$('#ai-edit-site').click();
  f.$('#ai-selector-send').value = '#unsaved-send';
  f.$('#ai-site-settings').open = false;
  f.$('#ai-active-site').value = 'gemini';
  f.$('#ai-active-site').dispatchEvent(new f.window.Event('change'));
  assert.equal(f.$('#ai-active-site').value, 'chatgpt');
  assert.equal(f.$('#ai-custom-fields').hidden, false);
  assert.equal(f.$('#ai-site-settings').open, true);
  assert.equal(f.$('#ai-selector-send').value, '#unsaved-send');
  assert.equal(f.document.activeElement, f.$('#ai-apply-site'));
  f.$('#ai-apply-site').click();
  f.$('#ai-active-site').value = 'gemini';
  f.$('#ai-active-site').dispatchEvent(new f.window.Event('change'));
  f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.activeSiteId, 'gemini');
  assert.equal(f.messages.at(-1).settings.builtinOverrides.chatgpt.selectors.send, '#unsaved-send');
});

test('removing a website cannot discard an unfinished editor and cancelling returns focus', async t => {
  const f = await fixture(t, { activeSiteId: 'custom-fixture-0001', customSites: [{ id: 'custom-fixture-0001', name: 'Custom', url: 'https://my-ai.test' }] });
  f.$('#ai-edit-site').focus(); f.$('#ai-edit-site').click();
  f.$('#ai-site-name').value = '未完成修改';
  f.$('#ai-remove-site').click();
  assert.equal(f.$('#ai-custom-fields').hidden, false);
  assert.equal(f.$('#ai-site-name').value, '未完成修改');
  assert.equal(f.$('#ai-active-site').value, 'custom-fixture-0001');
  f.$('#ai-cancel-edit').click();
  assert.equal(f.document.activeElement, f.$('#ai-edit-site'));
  f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.customSites[0].name, 'Custom');
});
