import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { LAUNCHER_SETTINGS_KEY } from '../src/launcher-settings.js';

const bundle = await build({ entryPoints: ['src/content/launcher.js'], bundle: true, format: 'iife', write: false });
const script = bundle.outputFiles[0].text;

async function fixture(t, initial) {
  const dom = new JSDOM('<!doctype html><title>网页</title><p>原正文</p>', { url: 'https://example.test/', pretendToBeVisual: true, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  let settings = initial;
  const changes = [], messages = [], sent = [], saves = [];
  let response = { ok: true }, capture, sendError;
  const original = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function(options) { const root = original.call(this, options); this.testShadow = root; return root; };
  window.Element.prototype.setPointerCapture = id => { capture = id; };
  window.Element.prototype.hasPointerCapture = id => capture === id;
  window.Element.prototype.releasePointerCapture = () => { capture = undefined; };
  window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function() { this.open = false; };
  let saveError;
  const changed = value => { const oldValue = settings; settings = value; changes.forEach(fn => fn({ [LAUNCHER_SETTINGS_KEY]: { oldValue, newValue: value } }, 'local')); };
  const listeners = list => ({ addListener(fn) { list.push(fn); }, removeListener(fn) { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); } });
  window.chrome = {
    runtime: { id: 'test-extension', onMessage: listeners(messages), sendMessage(message) { sent.push(message); if (sendError) throw new Error(sendError); return Promise.resolve(response); } },
    storage: { onChanged: listeners(changes), local: {
      async get() { return { [LAUNCHER_SETTINGS_KEY]: settings }; },
      async set(value) { if (saveError) throw new Error(saveError); saves.push(value); changed(value[LAUNCHER_SETTINGS_KEY]); },
    } },
  };
  const host = () => window.document.querySelector('#sider-floating-launcher');
  const button = () => host()?.testShadow.querySelector('button');
  const pointer = (type, x, y) => {
    const event = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 }); button().dispatchEvent(event);
  };
  window.eval(script); await new Promise(resolve => setImmediate(resolve));
  return { window, host, button, sent, saves, changed, pointer, messages, setSaveError: value => { saveError = value; }, setSendError: value => { sendError = value; }, setResponse: value => { response = value; }, inject: () => window.eval(script) };
}

test('floating button installs once, toggles without selection, and reports failures', async t => {
  const f = await fixture(t); f.inject();
  assert.ok(f.host()); assert.equal(f.messages.length, 1);
  assert.equal(f.window.getSelection().isCollapsed, true);
  f.button().click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent.filter(message => message.type === 'SIDER_TOGGLE_PANEL').map(message => message.opened), [false]);
  f.setResponse({ ok: false, error: '需要重新加载' }); f.button().click(); await new Promise(resolve => setImmediate(resolve));
  const status = f.host().testShadow.querySelector('[role=status]');
  assert.equal(status.hidden, false); assert.equal(status.textContent, '需要重新加载');
});

test('a fresh extension context replaces leftover launchers and retires old callbacks', async t => {
  const f = await fixture(t), oldHost = f.host(), oldButton = f.button(), oldMessage = f.messages[0];
  const leftover = oldHost.cloneNode(); f.window.document.documentElement.append(leftover);
  delete f.window.__siderFloatingLauncherInstalled;
  f.inject(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.window.document.querySelectorAll('#sider-floating-launcher').length, 1);
  assert.notEqual(f.host(), oldHost); assert.equal(oldHost.isConnected, false); assert.equal(leftover.isConnected, false);
  assert.equal(f.messages.length, 1);
  oldMessage({ type: 'SIDER_LAUNCHER_ACCESS', allowed: true });
  oldButton.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.filter(message => message.type === 'SIDER_TOGGLE_PANEL').length, 0);
  assert.equal(oldHost.isConnected, false);
  f.button().click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.filter(message => message.type === 'SIDER_TOGGLE_PANEL').length, 1);
});

test('a fresh disabled context removes stale DOM without showing a new launcher', async t => {
  const f = await fixture(t), leftover = f.host().cloneNode();
  f.window.document.documentElement.append(leftover);
  f.changed({ floating: false });
  delete f.window.__siderFloatingLauncherInstalled;
  f.inject(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.host(), null); assert.equal(leftover.isConnected, false);
});

test('an invalidated runtime removes its launcher before sending and cannot restore it', async t => {
  const f = await fixture(t), oldMessage = f.messages[0];
  f.window.chrome.runtime.id = undefined;
  f.button().click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.host(), null); assert.equal(f.messages.length, 0);
  assert.equal(f.sent.filter(message => message.type === 'SIDER_TOGGLE_PANEL').length, 0);
  f.changed({ floating: true }); oldMessage({ type: 'SIDER_LAUNCHER_ACCESS', allowed: true });
  f.window.dispatchEvent(new f.window.Event('resize'));
  assert.equal(f.host(), null);
});

test('synchronous and asynchronous context invalidation retire the launcher instead of showing a raw error', async t => {
  for (const failure of ['throw', 'reject']) {
    const f = await fixture(t), oldHost = f.host();
    if (failure === 'throw') f.setSendError('Extension context invalidated.');
    else f.setResponse(Promise.reject(new Error('Extension context invalidated.')));
    f.button().click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.host(), null); assert.equal(f.messages.length, 0);
    assert.equal(oldHost.testShadow.querySelector('.status').hidden, true);
  }
});

test('context invalidation while saving a close choice removes the obsolete dialog', async t => {
  const f = await fixture(t), root = f.host().testShadow;
  root.querySelector('.dismiss-button').click();
  f.setSaveError('Extension context invalidated.');
  root.querySelector('[data-scope=global]').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.host(), null); assert.equal(root.querySelector('dialog').open, false);
});

test('drag snaps left, saves once and suppresses mouse click while allowing keyboard activation', async t => {
  const f = await fixture(t);
  const x = parseFloat(f.host().style.left) + 20, y = parseFloat(f.host().style.top) + 20;
  f.pointer('pointerdown', x, y); f.pointer('pointermove', 30, 180); f.pointer('pointerup', 30, 180);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.host().style.left, '8px'); assert.equal(f.host().dataset.side, 'left');
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0][LAUNCHER_SETTINGS_KEY].side, 'left');
  f.button().dispatchEvent(new f.window.MouseEvent('click', { detail: 1 })); await Promise.resolve();
  assert.equal(f.sent.filter(message => message.type === 'SIDER_TOGGLE_PANEL').length, 0);
  f.button().click(); await Promise.resolve(); assert.equal(f.sent.filter(message => message.type === 'SIDER_TOGGLE_PANEL').length, 1);
});

test('blacklist and whitelist immediately filter the current site while retaining panel state', async t => {
  const f = await fixture(t, { blacklist: ['example.test'] }); assert.equal(f.host(), null);
  f.changed({ mode: 'whitelist', whitelist: ['other.test'] }); assert.equal(f.host(), null);
  f.changed({ mode: 'whitelist', whitelist: ['example.test'] }); assert.ok(f.host());
  f.messages[0]({ type: 'SIDER_PANEL_STATE_CHANGED', opened: true });
  f.changed({ mode: 'whitelist', whitelist: [] }); assert.equal(f.host(), null);
  f.changed({ mode: 'blacklist', blacklist: [] }); assert.equal(f.button().getAttribute('aria-expanded'), 'true');
});

test('close chooser cancels with focus restoration and temporary hiding survives reinjection and setting updates', async t => {
  const f = await fixture(t), root = f.host().testShadow;
  root.querySelector('.dismiss-button').click(); assert.equal(root.querySelector('dialog').open, true);
  assert.equal(f.sent.filter(item => item.type === 'SIDER_TOGGLE_PANEL').length, 0);
  const cancel = new f.window.Event('cancel', { cancelable: true }); root.querySelector('dialog').dispatchEvent(cancel);
  assert.equal(root.querySelector('dialog').open, false); assert.equal(root.activeElement, root.querySelector('.dismiss-button'));
  root.querySelector('.dismiss-button').click(); root.querySelector('[data-scope=once]').click();
  assert.equal(f.host(), null); assert.equal(f.saves.length, 0);
  f.inject(); f.changed({ floating: true, side: 'left' }); f.messages[0]({ type: 'SIDER_LAUNCHER_ACCESS', allowed: true });
  assert.equal(f.host(), null);
  const refreshed = await fixture(t); assert.ok(refreshed.host());
});

test('global close preserves lists and position; failed persistence leaves a retryable chooser', async t => {
  const f = await fixture(t, { side: 'left', y: 0.3, whitelist: ['other.test'] });
  const root = f.host().testShadow; root.querySelector('.dismiss-button').click();
  f.setSaveError('保存失败'); root.querySelector('[data-scope=global]').click(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.host()); assert.equal(root.querySelector('dialog').open, true);
  assert.match(root.querySelector('dialog [role=status]').textContent, /保存失败/);
  assert.equal(root.querySelector('[data-scope=global]').disabled, false);
  f.setSaveError(); root.querySelector('[data-scope=global]').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.host(), null);
  assert.equal(f.saves[0][LAUNCHER_SETTINGS_KEY].floating, false);
  assert.deepEqual(Array.from(f.saves[0][LAUNCHER_SETTINGS_KEY].whitelist), ['other.test']);
  assert.equal(f.saves[0][LAUNCHER_SETTINGS_KEY].side, 'left');
});

test('site close adds a blacklist entry or removes a whitelist entry without disabling other sites', async t => {
  for (const mode of ['blacklist', 'whitelist']) {
    const f = await fixture(t, { mode, whitelist: ['example.test', 'other.test'], blacklist: ['blocked.test'] });
    const root = f.host().testShadow; root.querySelector('.dismiss-button').click(); root.querySelector('[data-scope=site]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.host(), null);
    const saved = f.saves[0][LAUNCHER_SETTINGS_KEY]; assert.equal(saved.floating, true);
    assert.deepEqual(Array.from(saved[mode]), mode === 'blacklist' ? ['blocked.test', 'example.test'] : ['other.test']);
  }
});

test('native open and close notifications update the toggle action and override late results', async t => {
  const f = await fixture(t);
  f.messages[0]({ type: 'SIDER_PANEL_STATE_CHANGED', opened: true });
  assert.equal(f.button().getAttribute('aria-expanded'), 'true');
  assert.equal(f.button().getAttribute('aria-label'), '关闭 Sider 侧栏');
  f.setResponse({ ok: true, opened: true });
  f.button().click();
  f.messages[0]({ type: 'SIDER_PANEL_STATE_CHANGED', opened: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.findLast(message => message.type === 'SIDER_TOGGLE_PANEL').opened, true);
  assert.equal(f.button().getAttribute('aria-expanded'), 'false');
  f.setResponse({ ok: true, opened: true }); f.button().click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.findLast(message => message.type === 'SIDER_TOGGLE_PANEL').opened, false);
  assert.equal(f.button().getAttribute('aria-expanded'), 'true');
});

test('cancel and resize keep launcher on screen without saving an unfinished drag', async t => {
  const f = await fixture(t, { floating: true, side: 'right', y: 0.9 });
  const start = f.host().style.top;
  f.pointer('pointerdown', 980, 680); f.pointer('pointermove', 30, 120); f.pointer('pointercancel', 30, 120);
  assert.equal(f.host().style.top, start); assert.equal(f.saves.length, 0);
  f.window.innerWidth = 320; f.window.innerHeight = 200; f.window.dispatchEvent(new f.window.Event('resize'));
  assert.equal(f.host().style.left, '272px'); assert.ok(parseFloat(f.host().style.top) <= 152);
});

test('disabled settings and revoked access remove the UI; re-enabling restores it with the new position', async t => {
  const f = await fixture(t, { floating: false, side: 'right', y: 0.5 }); assert.equal(f.host(), null);
  f.changed({ floating: true, side: 'left', y: 0.2 }); assert.ok(f.host()); assert.equal(f.host().style.left, '8px');
  f.messages[0]({ type: 'SIDER_LAUNCHER_ACCESS', allowed: false }); assert.equal(f.host(), null);
  f.changed({ floating: true, side: 'right', y: 0.8 }); assert.equal(f.host(), null);
  f.messages[0]({ type: 'SIDER_LAUNCHER_ACCESS', allowed: true }); assert.ok(f.host()); assert.equal(f.host().dataset.side, 'right');
  f.changed({ floating: false }); assert.equal(f.host(), null);
});
