import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { installAIWebSettings } from '../src/ai-web-settings.js';
import { normalizeAIWebSettings, selectedAISite } from '../src/ai-web.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const testCatalog = { models: ['flash-lite', 'flash', 'pro', 'argon'].map(id => ({ id, label: id, available: true,
  levels: [{ id: 1, label: '低' }, { id: 4, label: '中' }, { id: 2, label: '高' }] })) };
const chatgptCatalog = { versions: [{ id: 'latest', label: 'GPT New', available: true, presets: [
  { slug: 'new-instant', effort: null, label: 'Instant', available: true },
  { slug: 'new-thinking', effort: 'standard', label: 'Medium', available: true },
  { slug: 'new-thinking', effort: 'extended', label: 'High', available: false },
] }] };
async function fixture(t, settings = normalizeAIWebSettings(), pickSendButton = async () => ({ ok: true, selector: 'button[data-action="deliver"]' })) {
  const html = await readFile(new URL('../src/panel.html', import.meta.url), 'utf8');
  const { window } = new JSDOM(html);
  t.after(() => window.close());
  const document = window.document;
  const dialog = document.querySelector('#ai-settings-dialog');
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  const messages = [], picked = [], catalogListeners = [];
  const chrome = {
    runtime: { id: 'settings-test', async sendMessage(message) { messages.push(message); if (message.type === 'SIDER_GEMINI_CATALOG_GET') return { ok: true, catalog: testCatalog }; if (message.type === 'SIDER_CHATGPT_CATALOG_GET') return { ok: true, catalog: chatgptCatalog }; if (message.type === 'SIDER_AI_WEB_SETTINGS_SAVE') settings = message.settings; return { ok: true, settings }; } },
    storage: { onChanged: { addListener(listener) { catalogListeners.push(listener); } } },
    permissions: { async request() { return true; } },
  };
  installAIWebSettings({ document, chrome, pickSendButton: async site => { picked.push(site); return pickSendButton(site); } });
  document.querySelector('#ai-settings-toggle').click(); await settle();
  return { window, document, dialog, messages, picked, publishCatalog: catalog => catalogListeners.forEach(listener => listener({ 'sider.geminiCatalog.v1': { newValue: catalog } }, 'session')), publishChatGPTCatalog: catalog => catalogListeners.forEach(listener => listener({ 'sider.chatgptCatalog.v1': { newValue: catalog } }, 'session')), $: selector => document.querySelector(selector) };
}

test('ChatGPT choices follow the live catalog, preserve edits and can return to the website default', async t => {
  const f = await fixture(t);
  assert.equal(f.$('#ai-chatgpt-model').value, 'site-default');
  assert.equal(f.$('#ai-chatgpt-preset').disabled, true);
  assert.equal(f.$('#ai-chatgpt-preset option[value="preset:new-thinking:extended"]'), null);
  f.$('#ai-chatgpt-model').value = 'version:latest'; f.$('#ai-chatgpt-model').dispatchEvent(new f.window.Event('change'));
  assert.equal(f.$('#ai-chatgpt-preset option[value="preset:new-thinking:extended"]').disabled, true);
  f.$('#ai-chatgpt-preset').value = 'preset:new-thinking:standard'; f.$('#ai-chatgpt-preset').dispatchEvent(new f.window.Event('change'));
  const updated = structuredClone(chatgptCatalog); updated.versions[0].label = 'Renamed'; updated.versions[0].presets[1].label = 'Balanced';
  f.publishChatGPTCatalog(updated);
  assert.equal(f.$('#ai-chatgpt-model').value, 'version:latest');
  assert.equal(f.$('#ai-chatgpt-preset').value, 'preset:new-thinking:standard');
  assert.equal(f.$('#ai-chatgpt-preset option[value="preset:new-thinking:standard"]').textContent, 'Balanced');
  f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.chatgptModel, 'version:latest');
  assert.equal(f.messages.at(-1).settings.chatgptPreset, 'preset:new-thinking:standard');
  f.$('#ai-settings-toggle').click(); await settle(); f.publishChatGPTCatalog(null);
  assert.equal(f.$('#ai-chatgpt-model').value, '__missing__');
  f.$('#ai-chatgpt-model').value = 'site-default'; f.$('#ai-chatgpt-model').dispatchEvent(new f.window.Event('change'));
  f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.chatgptModel, 'site-default');
  assert.equal(f.messages.at(-1).settings.chatgptPreset, 'site-default');
});

test('reference visibility defaults to showing unavailable tabs, cancels unsaved edits and persists after saving', async t => {
  const f = await fixture(t);
  const toggle = f.$('#reference-hide-unavailable-tabs');
  assert.equal(toggle.checked, false);
  toggle.click(); f.$('#ai-close-settings').click();
  assert.equal(f.dialog.open, true);
  f.$('#settings-discard-close').click();
  f.$('#ai-settings-toggle').click(); await settle();
  assert.equal(toggle.checked, false);
  toggle.click(); f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.hideUnavailableTabs, true);
  f.$('#ai-settings-toggle').click(); await settle();
  assert.equal(toggle.checked, true);
  toggle.click(); f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.hideUnavailableTabs, false);
});

test('Gemini Spark switch is persisted and defaults to the normal interface', async t => {
  const f = await fixture(t);
  const toggle = f.$('#ai-gemini-spark');
  assert.equal(toggle.checked, false);
  assert.equal(f.$('#ai-gemini-model').value, 'id:flash-lite');
  assert.equal(f.$('#ai-gemini-thinking').value, 'level:1');
  assert.deepEqual([...f.$('#ai-gemini-model').options].map(option => option.value), ['id:flash-lite', 'id:flash', 'id:pro', 'id:argon']);
  toggle.click();
  f.$('#ai-gemini-model').value = 'id:pro'; f.$('#ai-gemini-model').dispatchEvent(new f.window.Event('change'));
  f.$('#ai-gemini-thinking').value = 'level:4'; f.$('#ai-gemini-thinking').dispatchEvent(new f.window.Event('change'));
  f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.geminiMode, 'spark');
  assert.equal(f.messages.at(-1).settings.geminiModel, 'id:pro');
  assert.equal(f.messages.at(-1).settings.geminiThinkingLevel, 'level:4');
  assert.equal(Object.hasOwn(f.messages.at(-1).settings, 'geminiExtendedThinking'), false);
  assert.equal(toggle.checked, true);
  f.$('#ai-settings-toggle').click(); await settle();
  assert.equal(f.$('#ai-gemini-thinking').value, 'level:4');
});

test('legacy extended thinking is shown as High and Argon persists with the new field', async t => {
  const f = await fixture(t, { activeSiteId: 'gemini', customSites: [], geminiExtendedThinking: true });
  assert.equal(f.$('#ai-gemini-thinking').value, 'level:2');
  f.$('#ai-gemini-model').value = 'id:argon'; f.$('#ai-gemini-model').dispatchEvent(new f.window.Event('change'));
  f.$('#ai-save-settings').click(); await settle();
  f.$('#ai-settings-toggle').click(); await settle();
  assert.equal(f.$('#ai-gemini-model').value, 'id:argon');
  assert.equal(f.$('#ai-gemini-thinking').value, 'level:2');
});

test('live catalog updates model-specific levels without silently replacing a saved model', async t => {
  const f = await fixture(t);
  f.publishCatalog({ models: [
    { id: 'new-model', label: '新模型', available: true, levels: [{ id: 7, label: '新等级' }] },
    { id: 'locked', label: '升级模型', available: false, levels: [{ id: 1, label: '标准' }] },
  ] });
  assert.equal(f.$('#ai-gemini-model').value, '__missing__');
  assert.equal(f.$('#ai-gemini-model option[value="id:locked"]').disabled, true);
  f.$('#ai-gemini-model').value = 'id:new-model'; f.$('#ai-gemini-model').dispatchEvent(new f.window.Event('change'));
  assert.equal(f.$('#ai-gemini-thinking').value, '__missing__');
  f.$('#ai-gemini-thinking').value = 'level:7'; f.$('#ai-gemini-thinking').dispatchEvent(new f.window.Event('change'));
  f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.geminiModel, 'id:new-model');
  assert.equal(f.messages.at(-1).settings.geminiThinkingLevel, 'level:7');
});

test('missing catalog disables choices but retains unrelated saved settings', async t => {
  const f = await fixture(t);
  f.publishCatalog(null);
  assert.equal(f.$('#ai-gemini-model').disabled, true);
  assert.match(f.$('#ai-gemini-catalog-status').textContent, /打开或刷新/);
  f.$('#ai-gemini-spark').click(); f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.messages.at(-1).settings.geminiModel, 'flash-lite');
  assert.equal(f.messages.at(-1).settings.geminiThinkingLevel, 'low');
});

test('per-site settings collapse independently and configuring another site preserves the active website', async t => {
  const f = await fixture(t);
  const menu = f.$('#ai-site-settings');
  const gemini = f.$('[data-site-id="gemini"]');
  const claude = f.$('[data-site-id="claude"]');
  assert.equal(menu.open, true);
  assert.equal(gemini.open, false);
  assert.ok(gemini.contains(f.$('#ai-gemini-spark')));
  menu.open = true; gemini.open = true; claude.open = true;
  f.$('#ai-gemini-model').value = 'id:pro'; f.$('#ai-gemini-model').dispatchEvent(new f.window.Event('change'));
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
  assert.equal(saved.geminiModel, 'id:pro');
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

test('category navigation retains unfinished edits and Save returns to the editor before writing', async t => {
  const f = await fixture(t);
  f.$('#ai-edit-site').click(); f.$('#ai-selector-send').value = '#draft-send';
  f.$('#settings-tab-appearance').click();
  assert.equal(f.$('#settings-ai').hidden, true);
  assert.equal(f.$('#settings-appearance').hidden, false);
  f.$('#settings-tab-appearance').dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(f.document.activeElement.id, 'settings-tab-launcher');
  assert.equal(f.$('#settings-tab-launcher').getAttribute('aria-selected'), 'true');
  f.$('#ai-save-settings').click(); await settle();
  assert.equal(f.$('#settings-ai').hidden, false);
  assert.equal(f.$('#ai-selector-send').value, '#draft-send');
  assert.equal(f.document.activeElement.id, 'ai-apply-site');
  assert.equal(f.messages.some(message => message.type === 'SIDER_AI_WEB_SETTINGS_SAVE'), false);
});

test('Escape retains pending settings until explicit discard, and unchanged settings close directly', async t => {
  const f = await fixture(t);
  f.$('#reference-hide-unavailable-tabs').click();
  const cancel = new f.window.Event('cancel', { cancelable: true }); f.dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true); assert.equal(f.dialog.open, true);
  assert.equal(f.$('#settings-discard').hidden, false);
  f.$('#settings-keep-editing').click();
  assert.equal(f.$('#reference-hide-unavailable-tabs').checked, true);
  f.$('#ai-settings-toggle').click(); await settle();
  assert.equal(f.$('#reference-hide-unavailable-tabs').checked, true);
  f.$('#reference-hide-unavailable-tabs').click();
  f.$('#ai-close-settings').click(); assert.equal(f.dialog.open, false);
});
