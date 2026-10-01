import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = await build({
  entryPoints: ['src/content/page.js'], bundle: true, write: false,
  format: 'iife', platform: 'browser', logLevel: 'silent',
});
const script = bundle.outputFiles[0].text;

function environment(t, storedOrigins = [], deferredStorage = false) {
  const dom = new JSDOM('<!doctype html><title>选区页面</title><p>正文前缀，目标文字，正文后缀。</p><input type="password" value="secret">', {
    url: 'https://example.com/page', pretendToBeVisual: true, runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const listeners = [];
  const sent = [];
  let focused = true;
  window.document.hasFocus = () => focused;
  let resolveStorage;
  const storage = deferredStorage ? new Promise(resolve => { resolveStorage = resolve; }) : Promise.resolve({ siderEnabledOrigins: storedOrigins });
  window.chrome = {
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      async sendMessage(message) { sent.push(message); return { ok: true }; },
    },
    storage: { local: { get() { return storage; } } },
  };
  window.Range.prototype.getBoundingClientRect = () => ({ right: 180, bottom: 50 });
  // Keep the closed root private in production while allowing assertions in this harness.
  const originalAttachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function attachShadow(options) {
    const root = originalAttachShadow.call(this, options);
    this.testShadow = root;
    return root;
  };
  function selectText(value = '目标文字', element = window.document.querySelector('p')) {
    const text = element.firstChild;
    const range = window.document.createRange();
    const start = text.nodeValue.indexOf(value);
    range.setStart(text, start);
    range.setEnd(text, start + value.length);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }
  function request(message) {
    let response;
    const handled = listeners[0](message, {}, result => { response = result; });
    return { handled, response };
  }
  return {
    window, listeners, sent, selectTarget: () => selectText(), selectText, request,
    setFocused: value => { focused = value; },
    inject: () => window.eval(script),
    resolveStorage: () => resolveStorage?.({ siderEnabledOrigins: storedOrigins }),
    button: () => window.document.querySelector('#sider-selection-tools')?.testShadow.querySelector('button'),
  };
}

test('content script installs once and snapshots the selection present at injection', t => {
  const env = environment(t);
  env.selectTarget();
  env.inject();
  env.inject();
  assert.equal(env.listeners.length, 1);
  assert.equal(env.button(), undefined);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].type, 'SIDER_SELECTION_CHANGED');
  assert.equal(env.sent[0].reference.content, '目标文字');
  env.setFocused(false);
  env.window.getSelection().removeAllRanges();
  const { response } = env.request({ type: 'SIDER_PAGE_CAPTURE', kind: 'selection' });
  assert.equal(response.ok, true);
  assert.equal(response.reference.content, '目标文字');
  assert.equal(response.reference.kind, 'selection');
  assert.equal(env.request({ type: 'UNRELATED_COMMAND' }).response, undefined);
});

test('authorized origin opens the sidebar with its current selection instead of creating history', async t => {
  const env = environment(t, ['https://example.com']);
  env.selectTarget();
  env.inject();
  await new Promise(resolve => setImmediate(resolve));
  const button = env.button();
  assert.ok(button);
  assert.equal(button.style.display, 'block');
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.textContent, '在侧栏提问');
  assert.equal(env.sent.at(-1).type, 'SIDER_OPEN_SOURCE_PANEL');
  assert.equal(env.sent.at(-2).type, 'SIDER_SELECTION_CHANGED');
  assert.equal(env.sent.at(-2).reference.content, '目标文字');
  assert.deepEqual(JSON.parse(JSON.stringify(env.sent.at(-2).source)), { url: 'https://example.com/page', title: '选区页面' });
  assert.ok(env.sent.every(message => message.type !== 'SIDER_ADD_REFERENCE'));
  assert.equal(button.style.display, 'none');
  assert.equal(button.disabled, false);
});

test('explicit disable wins over a delayed initial stored-site setting', async t => {
  const env = environment(t, ['https://example.com'], true);
  env.selectTarget();
  env.inject();
  const disabled = env.request({ type: 'SIDER_ENABLE_SELECTION', enabled: false }).response;
  assert.equal(disabled.enabled, false);
  env.resolveStorage();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.button(), undefined);
  const enabled = env.request({ type: 'SIDER_ENABLE_SELECTION', enabled: true }).response;
  assert.equal(enabled.enabled, true);
  assert.equal(env.button().style.display, 'block');
  env.request({ type: 'SIDER_ENABLE_SELECTION', enabled: false });
  assert.equal(env.button().style.display, 'none');
});

test('focused password fields cannot retrieve a previously cached page selection', t => {
  const env = environment(t);
  env.selectTarget();
  env.inject();
  env.window.getSelection().removeAllRanges();
  env.window.document.querySelector('input').focus();
  const { response } = env.request({ type: 'SIDER_PAGE_CAPTURE', kind: 'selection' });
  assert.equal(response.ok, false);
  assert.match(response.error, /输入框/);
  assert.equal(env.request({ type: 'SIDER_PAGE_SELECTION_GET' }).response.reference, null);
  assert.equal(env.sent.at(-1).reference, null);
});

test('an empty page initially publishes no selection and later selections replace the single snapshot', async t => {
  const env = environment(t);
  env.inject();
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].reference, null);
  env.selectTarget();
  env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(env.sent.at(-1).reference.content, '目标文字');
  env.selectText('正文后缀');
  env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(env.sent.at(-1).reference.content, '正文后缀');
  assert.equal(env.request({ type: 'SIDER_PAGE_SELECTION_GET' }).response.reference.content, '正文后缀');
  assert.equal(env.sent.filter(message => message.type === 'SIDER_SELECTION_CHANGED').length, 3);
});

test('moving focus to the sidebar preserves a quote, but deselecting in the focused source page clears it', async t => {
  const env = environment(t);
  env.selectTarget();
  env.inject();
  env.setFocused(false);
  env.window.getSelection().removeAllRanges();
  env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(env.sent.length, 1);
  assert.equal(env.request({ type: 'SIDER_PAGE_SELECTION_GET' }).response.reference.content, '目标文字');
  env.setFocused(true);
  env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(env.sent.at(-1).reference, null);
  assert.equal(env.request({ type: 'SIDER_PAGE_SELECTION_GET' }).response.reference, null);
});

test('a replacement selected immediately before sidebar focus does not fall back to the old quote', t => {
  const env = environment(t);
  env.selectTarget();
  env.inject();
  env.selectText('正文后缀');
  env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
  env.setFocused(false);
  env.window.getSelection().removeAllRanges();
  const response = env.request({ type: 'SIDER_PAGE_SELECTION_GET' }).response;
  assert.equal(response.reference.content, '正文后缀');
  assert.equal(env.sent.at(-1).reference.content, '正文后缀');
});

test('selecting hidden content clears the previous readable quote and never publishes hidden text', async t => {
  const env = environment(t);
  env.selectTarget();
  env.inject();
  const hidden = env.window.document.createElement('p');
  hidden.hidden = true;
  hidden.textContent = '隐藏内容';
  env.window.document.body.append(hidden);
  env.setFocused(false);
  env.selectText('隐藏内容', hidden);
  env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(env.sent.at(-1).reference, null);
  assert.ok(env.sent.every(message => !message.reference?.content.includes('隐藏')));
  assert.equal(env.request({ type: 'SIDER_PAGE_SELECTION_GET' }).response.reference, null);
});

test('removing the selection chip clears both the cached and DOM selection without bringing it back', async t => {
  const env = environment(t);
  env.selectTarget();
  env.inject();
  env.setFocused(false);
  assert.equal(env.request({ type: 'SIDER_PAGE_CLEAR_SELECTION' }).response.ok, true);
  assert.equal(env.window.getSelection().isCollapsed, true);
  assert.equal(env.sent.at(-1).reference, null);
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(env.request({ type: 'SIDER_PAGE_SELECTION_GET' }).response.reference, null);
  env.selectText('正文后缀');
  env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(env.sent.at(-1).reference.content, '正文后缀');
});

test('same-document navigation clears the old selection and publishes the new page identity', async t => {
  const env = environment(t);
  env.selectTarget();
  env.inject();
  env.setFocused(false);
  env.window.history.pushState({}, '', '/another-page');
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(env.sent.at(-1).source.url, 'https://example.com/another-page');
  assert.equal(env.sent.at(-1).reference, null);
  assert.equal(env.window.getSelection().isCollapsed, true);
  assert.equal(env.request({ type: 'SIDER_PAGE_SELECTION_GET' }).response.reference, null);
  env.selectText('正文后缀');
  env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(env.sent.at(-1).reference.url, 'https://example.com/another-page');
  assert.equal(env.sent.at(-1).reference.content, '正文后缀');
});
