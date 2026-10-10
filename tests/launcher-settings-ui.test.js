import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { installLauncherSettingsUI } from '../src/launcher-settings-ui.js';
import { LAUNCHER_SETTINGS_KEY, normalizeLauncherSettings } from '../src/launcher-settings.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const event = () => ({ listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } });
async function fixture(t, initial = {}) {
  const dom = new JSDOM(await readFile('src/panel.html', 'utf8'), { url: 'https://panel.test/?sourceTab=42' });
  const { window } = dom, { document } = window;
  let settings = normalizeLauncherSettings(initial), url = 'https://example.test/page', granted = true, hasAccess = true, saveError;
  const requests = [], reads = [], onChanged = event(), onUpdated = event();
  const chrome = {
    runtime: { id: 'test', async sendMessage(message) { reads.push(message); return { ok: true, source: { tabId: 42, url } }; } },
    storage: { onChanged, local: { async get() { return { [LAUNCHER_SETTINGS_KEY]: structuredClone(settings) }; }, async set(update) { if (saveError) throw new Error(saveError); const oldValue = settings; settings = structuredClone(update[LAUNCHER_SETTINGS_KEY]); onChanged.emit({ [LAUNCHER_SETTINGS_KEY]: { oldValue, newValue: settings } }, 'local'); } } },
    permissions: { onAdded: event(), onRemoved: event(), async contains() { return hasAccess; }, async request(value) { requests.push(value); return granted; } },
    commands: { async getAll() { return [{ name: 'open-side-panel', shortcut: 'Alt+Y' }]; } },
    tabs: { onUpdated, async create() {} },
  };
  installLauncherSettingsUI({ document, chrome, sourceTabId: 42 }); await settle();
  t.after(() => { window.dispatchEvent(new window.Event('pagehide')); dom.window.close(); });
  const selectMode = async value => { const input = document.querySelector('#launcher-mode'); input.value = value; input.dispatchEvent(new window.Event('change')); await settle(); };
  const open = async () => { const details = document.querySelector('#launcher-settings'); details.open = true; details.dispatchEvent(new window.Event('toggle')); await settle(); };
  return { window, document, settings: () => settings, requests, reads, selectMode, open,
    changeURL(value) { url = value; onUpdated.emit(42, { url }, {}); },
    access(value, approved) { hasAccess = value; granted = approved; },
    saveError(value) { saveError = value; },
  };
}

test('current site quick-add follows the selected mode, retains the inactive list and allows removal', async t => {
  const f = await fixture(t, { side: 'left', y: 0.2 }); await f.open();
  assert.ok(f.reads.every(message => message.tabId === 42));
  f.document.querySelector('#launcher-add-current').click(); await settle();
  assert.deepEqual(f.settings().blacklist, ['example.test']); assert.equal(f.document.querySelector('#launcher-add-current').disabled, true);
  await f.selectMode('whitelist'); f.document.querySelector('#launcher-add-current').click(); await settle();
  assert.deepEqual(f.settings().whitelist, ['example.test']); assert.deepEqual(f.settings().blacklist, ['example.test']);
  f.document.querySelector('#launcher-sites button').click(); await settle();
  assert.deepEqual(f.settings().whitelist, []); assert.equal(f.document.querySelector('#launcher-add-current').disabled, false);
  assert.equal(f.settings().side, 'left'); assert.equal(f.settings().y, 0.2);
});

test('manual entries normalize URLs, reject invalid input and refresh current site on owning-tab navigation', async t => {
  const f = await fixture(t); await f.open();
  const input = f.document.querySelector('#launcher-site-input'); input.value = 'https://Other.test:8443/article';
  f.document.querySelector('#launcher-add-site').click(); await settle(); assert.deepEqual(f.settings().blacklist, ['other.test']);
  input.value = 'chrome://settings'; f.document.querySelector('#launcher-add-site').click(); await settle();
  assert.match(f.document.querySelector('#launcher-status').textContent, /有效/); assert.deepEqual(f.settings().blacklist, ['other.test']);
  f.changeURL('http://next.test/page'); await settle();
  assert.match(f.document.querySelector('#launcher-current-site').textContent, /next.test/);
  f.document.querySelector('#launcher-add-current').click(); await settle(); assert.deepEqual(f.settings().blacklist, ['other.test', 'next.test']);
});

test('whitelist quick-add requests only the current origin synchronously and denial or save failure stays retryable', async t => {
  const f = await fixture(t, { mode: 'whitelist' }); f.access(false, false); await f.open();
  const add = f.document.querySelector('#launcher-add-current'); add.click();
  assert.deepEqual(f.requests, [{ origins: ['https://example.test/*'] }]); await settle();
  assert.deepEqual(f.settings().whitelist, []); assert.equal(add.disabled, false);
  f.access(false, true); f.saveError('保存失败'); add.click(); await settle();
  assert.match(f.document.querySelector('#launcher-status').textContent, /保存失败/); assert.equal(add.disabled, false);
  f.saveError(); add.click(); await settle(); assert.deepEqual(f.settings().whitelist, ['example.test']);
});
