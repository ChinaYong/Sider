import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSourcePicker } from '../src/content/source-picker.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const { window } = new JSDOM('<button id="outside">外部</button>');
  let source = { ownerTabId: 1, tabId: 1, title: '当前文章', status: 'ready' }, busy = false;
  const calls = [], errors = [];
  const tabs = [
    { tabId: 1, windowId: 9, title: '当前文章', url: 'https://example.test/a', disabledReason: '' },
    { tabId: 2, windowId: 9, title: '另一篇文章', url: 'https://example.test/b', disabledReason: '' },
    { tabId: 3, windowId: 27, title: '跨窗口资料', url: 'https://second.test/material', disabledReason: '' },
    { tabId: 4, windowId: 27, title: '设置', url: 'chrome://settings/', disabledReason: '浏览器内部页面不支持引用' },
  ];
  const picker = createSourcePicker({ document: window.document, getSource: () => source, isBusy: () => busy,
    listTabs: async () => ({ tabs, ownerWindowId: 9 }), selectTab: async tabId => {
      calls.push(tabId); source = { ...source, tabId, title: tabs.find(tab => tab.tabId === tabId).title };
    }, onError: error => errors.push(error), ...overrides });
  window.document.body.append(picker.element);
  t.after(() => { picker.dispose(); window.close(); });
  return { window, picker, calls, errors, tabs, trigger: picker.element.querySelector('.source-trigger'),
    search: picker.element.querySelector('input'), setSource(value) { source = { ...source, ...value }; picker.sync(); },
    setBusy(value) { busy = value; picker.sync(); } };
}

test('search filters title and URL across windows and updates do not replace the focused input', async t => {
  const f = fixture(t); f.trigger.click(); await settle();
  assert.equal(f.window.document.activeElement, f.search);
  assert.equal(f.picker.element.querySelectorAll('[role="option"]').length, 4);
  assert.equal(f.picker.element.querySelector('#source-tab-4').disabled, true);
  f.search.value = 'SECOND.TEST'; f.search.dispatchEvent(new f.window.Event('input'));
  assert.equal(f.picker.element.querySelectorAll('[role="option"]').length, 1);
  assert.match(f.picker.element.querySelector('[role="option"]').textContent, /跨窗口资料/);
  f.setSource({ title: '实时更新标题' }); await f.picker.refresh();
  assert.equal(f.window.document.activeElement, f.search); assert.equal(f.search.value, 'SECOND.TEST');
  f.search.value = '不存在'; f.search.dispatchEvent(new f.window.Event('input'));
  assert.match(f.picker.element.querySelector('[role="status"]').textContent, /没有匹配/);
});

test('keyboard selection, escape and quick return retain predictable focus', async t => {
  const f = fixture(t); f.trigger.click(); await settle();
  f.search.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(f.search.getAttribute('aria-activedescendant'), 'source-tab-2');
  f.search.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
  assert.deepEqual(f.calls, [2]); assert.equal(f.picker.isOpen(), false);
  assert.equal(f.window.document.activeElement, f.trigger);
  const back = f.picker.element.querySelector('.source-back'); assert.equal(back.hidden, false);
  back.click(); await settle(); assert.deepEqual(f.calls, [2, 1]); assert.equal(back.hidden, true);
  f.trigger.click(); await settle();
  f.search.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(f.picker.isOpen(), false); assert.equal(f.window.document.activeElement, f.trigger);
});

test('busy actions cannot switch sources and closing outside does not steal focus', async t => {
  const f = fixture(t); f.trigger.click(); await settle(); f.setBusy(true);
  f.picker.element.querySelector('#source-tab-2').click(); await settle(); assert.deepEqual(f.calls, []);
  assert.equal(f.trigger.disabled, true); assert.equal(f.search.disabled, true);
  f.setBusy(false); const outside = f.window.document.querySelector('#outside'); outside.focus();
  outside.dispatchEvent(new f.window.Event('pointerdown', { bubbles: true, composed: true }));
  assert.equal(f.picker.isOpen(), false); assert.equal(f.window.document.activeElement, outside);
});

test('closed-source display keeps quick return and a failed selection remains retryable', async t => {
  let attempts = 0;
  const f = fixture(t, { selectTab: async () => { if (!attempts++) throw new Error('所选标签页已关闭'); } });
  f.setSource({ tabId: 3, title: '跨窗口资料', status: 'closed', error: '来源标签页已关闭' });
  assert.match(f.trigger.textContent, /已关闭/); assert.equal(f.picker.element.querySelector('.source-back').hidden, false);
  f.trigger.click(); await settle(); f.picker.element.querySelector('#source-tab-2').click(); await settle();
  assert.equal(f.picker.isOpen(), true); assert.equal(f.errors.length, 1);
  assert.equal(f.picker.element.querySelector('#source-tab-2').disabled, false);
  f.picker.element.querySelector('#source-tab-2').click(); await settle(); assert.equal(f.picker.isOpen(), false);
});

test('missing access exposes authorization inside the preset picker and busy work disables it', t => {
  let grants = 0;
  const f = fixture(t, { requestAccess: () => { grants++; } });
  f.setSource({ tabId: 3, status: 'needs-access', error: '来源网站需要访问权限' });
  const grant = f.picker.element.querySelector('.source-grant');
  assert.equal(grant.hidden, false); grant.click(); assert.equal(grants, 1);
  f.setBusy(true); grant.click(); assert.equal(grants, 1);
  f.setBusy(false); f.setSource({ status: 'ready', error: '' }); assert.equal(grant.hidden, true);
});
