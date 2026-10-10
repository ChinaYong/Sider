import test from 'node:test';
import assert from 'node:assert/strict';
import { installLauncherBackground } from '../src/launcher-background.js';
import { LAUNCHER_SETTINGS_KEY } from '../src/launcher-settings.js';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
function fixture() {
  let settings, origins = ['https://example.test/*', 'file:///*'];
  const scripts = new Map([['sider-selection-site', { id: 'sider-selection-site' }], ['sider-ai-site', { id: 'sider-ai-site' }]]);
  const registrations = [], removed = [], injections = [], messages = [];
  const chrome = {
    storage: { onChanged: event(), local: { async get() { return { [LAUNCHER_SETTINGS_KEY]: settings }; } } },
    permissions: { onAdded: event(), onRemoved: event(), async getAll() { return { origins }; }, async contains({ origins: requested }) { return origins.includes(requested[0]) || origins.includes('https://*/*'); } },
    tabs: { async query() { return [{ id: 1, url: 'https://example.test/page' }, { id: 2, url: 'https://other.test/page' }, { id: 3 }]; }, async sendMessage(tabId, message) { messages.push({ tabId, ...message }); } },
    scripting: {
      async getRegisteredContentScripts({ ids }) { return ids.flatMap(id => scripts.has(id) ? [scripts.get(id)] : []); },
      async registerContentScripts(items) { registrations.push(...items); items.forEach(item => scripts.set(item.id, item)); },
      async unregisterContentScripts({ ids }) { removed.push(...ids); ids.forEach(id => scripts.delete(id)); },
      async executeScript(value) { injections.push(value); },
    },
  };
  const launcher = installLauncherBackground(chrome);
  return { chrome, launcher, scripts, registrations, removed, injections, messages,
    changeSettings(value) { const oldValue = settings; settings = value; chrome.storage.onChanged.emit({ [LAUNCHER_SETTINGS_KEY]: { oldValue, newValue: value } }, 'local'); },
    revoke() { origins = []; chrome.permissions.onRemoved.emit({ origins: ['https://example.test/*'] }); },
    grantAll() { origins = ['https://*/*', 'http://*/*']; chrome.permissions.onAdded.emit({ origins }); },
  };
}

test('launcher registration uses granted web origins only and leaves collection/AI registrations alone', async () => {
  const f = fixture(); await f.launcher.sync();
  assert.equal(f.registrations.length, 1);
  assert.deepEqual(f.registrations[0].matches, ['https://example.test/*']);
  assert.equal(f.registrations[0].allFrames, false);
  assert.ok(f.injections.every(item => item.target.tabId === 1 && item.target.frameIds[0] === 0));
  assert.equal(f.messages.findLast(item => item.tabId === 2).allowed, false);
  f.changeSettings({ floating: false }); await f.launcher.sync();
  assert.equal(f.scripts.has('sider-floating-launcher'), false);
  assert.equal(f.scripts.has('sider-selection-site'), true); assert.equal(f.scripts.has('sider-ai-site'), true);
  f.changeSettings({ floating: true, side: 'left', y: 0.4 }); await f.launcher.sync();
  assert.equal(f.scripts.has('sider-floating-launcher'), true);
  const count = f.registrations.length;
  f.changeSettings({ floating: true, side: 'right', y: 0.3 }); await f.launcher.sync();
  assert.equal(f.registrations.length, count);
});

test('grant and revoke synchronize future injection and hide an existing UI even when tab URL is withheld', async () => {
  const f = fixture(); await f.launcher.sync(); f.grantAll(); await f.launcher.sync();
  assert.deepEqual(f.scripts.get('sider-floating-launcher').matches, ['http://*/*', 'https://*/*']);
  assert.equal(f.messages.findLast(item => item.tabId === 2).allowed, true);
  f.revoke(); await f.launcher.sync();
  assert.equal(f.scripts.has('sider-floating-launcher'), false);
  assert.ok([1, 2, 3].every(tabId => f.messages.findLast(item => item.tabId === tabId).allowed === false));
});

test('list changes inject newly eligible existing tabs without changing permission or collection registrations', async () => {
  const f = fixture(); await f.launcher.sync(); f.grantAll(); await f.launcher.sync();
  f.changeSettings({ mode: 'whitelist', whitelist: [] }); await f.launcher.sync();
  const count = f.injections.length;
  await f.launcher.inject({ id: 1, url: 'https://example.test/page' }); assert.equal(f.injections.length, count);
  f.changeSettings({ mode: 'whitelist', whitelist: ['other.test'] }); await f.launcher.sync();
  assert.ok(f.injections.slice(count).length > 0);
  assert.ok(f.injections.slice(count).every(item => item.target.tabId === 2));
  assert.ok(f.scripts.has('sider-selection-site')); assert.ok(f.scripts.has('sider-ai-site'));
  assert.deepEqual(f.scripts.get('sider-floating-launcher').matches, ['http://*/*', 'https://*/*']);
});
