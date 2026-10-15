import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { installFontSettingsUI } from '../src/font-settings-ui.js';
import { FONT_SETTINGS_KEY, DEFAULT_FONT_FAMILY, fontFamily } from '../src/font-settings.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, initial = { font: 'system', customFont: '' }) {
  const { window } = new JSDOM(await readFile('src/panel.html', 'utf8')); const { document } = window;
  let stored = initial, error, hold;
  const listeners = new Set(), writes = [];
  const emit = value => { stored = value; for (const fn of listeners) fn({ [FONT_SETTINGS_KEY]: { newValue: stored } }, 'local'); };
  const chrome = { storage: { onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } }, local: {
    async get() { return { [FONT_SETTINGS_KEY]: stored }; },
    async set(value) { if (hold) await hold; if (error) throw new Error(error); writes.push(value); emit(value[FONT_SETTINGS_KEY]); },
  } } };
  const watcher = installFontSettingsUI({ document, chrome }); await watcher.ready; await settle();
  t.after(() => { watcher.dispose(); window.close(); });
  const $ = selector => document.querySelector(selector);
  const choose = value => { $('#extension-font').value = value; $('#extension-font').dispatchEvent(new window.Event('change')); };
  return { window, $, choose, emit, writes, stored: () => stored, fail(value) { error = value; }, hold(value) { hold = value; } };
}

test('presets save immediately, synchronize across panels and reset to system default', async t => {
  const f = await fixture(t, { font: 'yahei', customFont: '' });
  assert.equal(f.$('#extension-font').value, 'yahei');
  f.choose('mono'); await settle(); assert.equal(f.stored().font, 'mono');
  assert.equal(f.$('html').style.getPropertyValue('--sider-font-family'), fontFamily(f.stored()));
  f.emit({ font: 'noto-serif', customFont: '' }); assert.equal(f.$('#extension-font').value, 'noto-serif');
  f.$('#extension-font-reset').click(); await settle();
  assert.deepEqual(f.stored(), { font: 'system', customFont: '' });
  assert.equal(f.$('html').style.getPropertyValue('--sider-font-family'), DEFAULT_FONT_FAMILY);
});

test('custom preview does not save until apply; blank names and failed saves preserve drafts', async t => {
  const f = await fixture(t); f.choose('custom');
  assert.equal(f.$('#extension-font-custom').hidden, false);
  f.$('#extension-font-apply').click(); await settle(); assert.equal(f.writes.length, 0);
  assert.match(f.$('#extension-font-status').textContent, /字体名称/);
  f.$('#extension-font-name').value = 'LXGW WenKai'; f.$('#extension-font-name').dispatchEvent(new f.window.Event('input'));
  assert.match(f.$('#extension-font-preview').style.fontFamily, /LXGW WenKai/);
  assert.equal(f.$('html').style.getPropertyValue('--sider-font-family'), DEFAULT_FONT_FAMILY);
  f.fail('保存失败'); f.$('#extension-font-apply').click(); await settle();
  assert.equal(f.$('#extension-font-name').value, 'LXGW WenKai'); assert.equal(f.$('#extension-font').value, 'custom');
  assert.match(f.$('#extension-font-status').textContent, /保存失败/);
  f.fail(); f.$('#extension-font-name').dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
  assert.deepEqual(f.stored(), { font: 'custom', customFont: 'LXGW WenKai' });
  assert.equal(f.writes.length, 1);
});

test('slow saves disable controls and failed preset saves restore the saved selection', async t => {
  const f = await fixture(t); let release; f.hold(new Promise(resolve => { release = resolve; }));
  f.choose('yahei'); assert.equal(f.$('#extension-font').disabled, true); assert.equal(f.$('#extension-font-reset').disabled, true);
  f.fail('不可写入'); release(); await settle();
  assert.equal(f.$('#extension-font').disabled, false); assert.equal(f.$('#extension-font').value, 'system');
  assert.equal(f.$('html').style.getPropertyValue('--sider-font-family'), DEFAULT_FONT_FAMILY);
});
