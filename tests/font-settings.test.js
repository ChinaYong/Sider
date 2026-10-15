import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FONT_SETTINGS_KEY, DEFAULT_FONT_FAMILY, normalizeFontSettings, validateFontSettings, fontFamily, installFontSettings } from '../src/font-settings.js';
import { CONFIGURATION_KEYS, exportConfiguration, validateConfiguration, configurationStorage, configurationSummary } from '../src/configuration.js';

test('font configuration roundtrips, old backups default and invalid fonts block import', () => {
  const settings = { font: 'custom', customFont: '  霞鹜文楷  ' };
  const backup = exportConfiguration({ [FONT_SETTINGS_KEY]: settings });
  assert.ok(CONFIGURATION_KEYS.includes(FONT_SETTINGS_KEY));
  assert.deepEqual(configurationStorage(backup)[FONT_SETTINGS_KEY], { font: 'custom', customFont: '霞鹜文楷' });
  assert.match(configurationSummary(exportConfiguration({}), backup), /扩展字体：系统默认 → 霞鹜文楷/);
  delete backup.configuration.font;
  assert.deepEqual(validateConfiguration(backup).configuration.font, normalizeFontSettings());
  for (const value of [null, [], { font: 'unknown', customFont: '' }, { font: 'custom', customFont: '' }, { font: 'custom', customFont: 'a'.repeat(101) }, { font: 'custom', customFont: 'bad\nname' }]) {
    backup.configuration.font = value;
    assert.throws(() => validateConfiguration(backup), /字体设置/);
  }
});

test('custom names are one escaped CSS string with fallback and malformed storage uses default', () => {
  assert.equal(fontFamily({ font: 'custom', customFont: 'Font "Quoted"\\Name; color:red' }), '"Font \\"Quoted\\"\\\\Name; color:red", ' + DEFAULT_FONT_FAMILY);
  assert.equal(fontFamily({ font: 'custom', customFont: '' }), DEFAULT_FONT_FAMILY);
  assert.deepEqual(normalizeFontSettings({ font: 'invalid', customFont: 123 }), { font: 'system', customFont: '' });
  assert.deepEqual(validateFontSettings({ font: 'system', customFont: '' }), normalizeFontSettings());
});

test('live storage updates win over an old initial read, remain scoped and dispose safely', async t => {
  const { window } = new JSDOM('<div id="host"></div><p>Native website</p>'); t.after(() => window.close());
  const host = window.document.querySelector('#host'), listeners = new Set();
  let resolve;
  const chrome = { storage: { local: { get: () => new Promise(done => { resolve = done; }) }, onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } } } };
  const watcher = installFontSettings({ element: host, chrome });
  const emit = (font, area = 'local') => { for (const fn of listeners) fn({ [FONT_SETTINGS_KEY]: { newValue: { font, customFont: '' } } }, area); };
  emit('mono'); resolve({ [FONT_SETTINGS_KEY]: { font: 'yahei', customFont: '' } }); await watcher.ready;
  assert.equal(host.style.getPropertyValue('--sider-font-family'), fontFamily({ font: 'mono' }));
  emit('yahei', 'session'); assert.match(host.style.getPropertyValue('--sider-font-family'), /Consolas/);
  assert.equal(window.document.documentElement.style.length, 0);
  window.dispatchEvent(new window.Event('pagehide')); assert.equal(listeners.size, 0);
  watcher.dispose(); emit('yahei'); assert.match(host.style.getPropertyValue('--sider-font-family'), /Consolas/);
});

test('disposing before the initial font read completes leaves the removed UI untouched', async t => {
  const { window } = new JSDOM('<div></div>'); t.after(() => window.close());
  const element = window.document.querySelector('div'); let resolve;
  const watcher = installFontSettings({ element, chrome: { storage: { local: { get: () => new Promise(done => { resolve = done; }) } } } });
  watcher.dispose(); resolve({ [FONT_SETTINGS_KEY]: { font: 'mono', customFont: '' } }); await watcher.ready;
  assert.equal(element.style.getPropertyValue('--sider-font-family'), DEFAULT_FONT_FAMILY);
});
