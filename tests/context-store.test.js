import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_CONTEXT_PREFIX, CONTEXT_SETTINGS_KEY, DEFAULT_CONTEXT_SETTINGS } from '../src/context.js';
import { UNIFIED_TEMPLATES_KEY, templateSettings } from '../src/prompt-templates.js';
import { getTabContext, updateTabSelection, setTabAttachment, applyTabDefaults, requestTabPage, invalidateTabSource, clearTabSelection, resetTabContext, removeTabContext, getContextSettings, patchContextSettings } from '../src/context-store.js';

let sessionData = {}, localData = {}, failSessionWrite = false, failLocalWrite = false;
const source = { url: 'https://example.com/article', title: '文章一' };
const selected = content => ({ kind: 'selection', ...source, content, context: `段落：${content}`, capturedAt: '2026-09-30T10:00:00Z' });
globalThis.chrome = { storage: {
  session: {
    get: async key => structuredClone({ [key]: sessionData[key] }),
    set: async update => { if (failSessionWrite) { failSessionWrite = false; throw new Error('QUOTA_BYTES exceeded'); } sessionData = structuredClone({ ...sessionData, ...update }); },
    remove: async key => { delete sessionData[key]; },
  },
  local: {
    get: async key => structuredClone(Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, localData[name]]))),
    set: async update => { if (failLocalWrite) { failLocalWrite = false; throw new Error('QUOTA_BYTES exceeded'); } localData = structuredClone({ ...localData, ...update }); },
  },
} };
function resetStorage() { sessionData = {}; localData = {}; failSessionWrite = false; failLocalWrite = false; }

test('three tabs maintain independent current selections and visiting an empty tab inherits nothing', async () => {
  resetStorage();
  await updateTabSelection(1, source, selected('网页一的词'));
  await resetTabContext(2, { url: 'https://other.test/', title: '网页二' });
  await updateTabSelection(3, { url: 'https://third.test/', title: '网页三' }, { content: '网页三的词' });
  assert.equal((await getTabContext(1)).selection.content, '网页一的词');
  assert.equal((await getTabContext(2)).selection, null);
  assert.equal((await getTabContext(3)).selection.content, '网页三的词');
});

test('new selection replaces the current selection without growing history', async () => {
  resetStorage();
  await updateTabSelection(1, source, selected('旧词'));
  await setTabAttachment(1, 'url', true);
  await updateTabSelection(1, source, selected('新词'));
  const current = await getTabContext(1);
  assert.equal(current.selection.content, '新词');
  assert.equal(current.attachments.url, true);
  assert.equal(Object.hasOwn(current, 'references'), false);
  assert.equal(Object.keys(sessionData).length, 1);
});

test('a repeated live-selection read preserves revision and the initial snapshot timestamp', async () => {
  resetStorage();
  const first = await updateTabSelection(1, source, selected('词'));
  const second = await updateTabSelection(1, source, { ...selected('词'), capturedAt: '2026-09-30T11:00:00Z' });
  assert.equal(second.revision, first.revision);
  assert.equal(second.selection.capturedAt, first.selection.capturedAt);
  const changedTitle = await updateTabSelection(1, { ...source, title: '更新标题' }, { ...selected('词'), title: '更新标题' });
  assert.equal(changedTitle.title, '更新标题');
  assert.equal(changedTitle.revision, first.revision + 1);
});

test('navigation in the same tab resets old selection and URL/body attachments', async () => {
  resetStorage();
  await updateTabSelection(1, source, selected('旧词'));
  await setTabAttachment(1, 'url', true);
  await setTabAttachment(1, 'page', { ...source, content: '旧正文' });
  const previous = await getTabContext(1);
  const next = await updateTabSelection(1, { url: 'https://example.com/new', title: '新网页' }, null);
  assert.equal(next.selection, null);
  assert.deepEqual(next.attachments, { url: false, page: null });
  assert.equal(next.revision, previous.revision + 1);
});

test('repeated resets after a populated context preserve revision and do not write unchanged state', async () => {
  resetStorage();
  await updateTabSelection(1, source, selected('词'));
  await setTabAttachment(1, 'url', true);
  await setTabAttachment(1, 'page', { ...source, content: '正文' });
  const cleared = await resetTabContext(1, source);
  assert.equal(cleared.revision, 4);
  const repeated = await resetTabContext(1, source);
  assert.deepEqual(repeated, cleared);
  failSessionWrite = true;
  assert.deepEqual(await resetTabContext(1, source), cleared);
  await assert.rejects(updateTabSelection(1, { url: 'https://example.com/new' }, { content: '新词' }), /QUOTA/);
  const navigated = await updateTabSelection(1, { url: 'https://example.com/new' }, { content: '新词' });
  assert.equal(navigated.revision, cleared.revision + 1);
});

test('concurrent source updates and attachment toggles do not lose each other', async () => {
  resetStorage();
  await updateTabSelection(1, source, selected('词'));
  await Promise.all([
    setTabAttachment(1, 'url', true),
    setTabAttachment(1, 'page', { ...source, content: '正文' }),
    updateTabSelection(1, source, selected('更新的词')),
  ]);
  const current = await getTabContext(1);
  assert.equal(current.selection.content, '更新的词');
  assert.equal(current.attachments.url, true);
  assert.equal(current.attachments.page.content, '正文');
  assert.equal(current.revision, 4);
});

test('cancel controls remove only the chosen current context', async () => {
  resetStorage();
  await updateTabSelection(1, source, selected('词'));
  await setTabAttachment(1, 'url', true);
  await setTabAttachment(1, 'page', { ...source, content: '正文' });
  await clearTabSelection(1);
  assert.equal((await getTabContext(1)).attachments.page.content, '正文');
  await setTabAttachment(1, 'url', false);
  await setTabAttachment(1, 'page', null);
  assert.deepEqual((await getTabContext(1)).attachments, { url: false, page: null });
});

test('invalid, mismatched or oversized new captures reject without changing the saved state', async () => {
  resetStorage();
  await updateTabSelection(1, source, selected('原词'));
  const initial = await getTabContext(1);
  await assert.rejects(setTabAttachment(1, 'page', { url: 'https://old.test/', content: '旧正文' }), /来源/);
  await assert.rejects(updateTabSelection(1, source, selected('x'.repeat(1000001))), /100 万字符/);
  await assert.rejects(updateTabSelection(1, { url: 'javascript:alert(1)' }, selected('词')), /HTTP/);
  await assert.rejects(setTabAttachment(2, 'url', true), /HTTP/);
  assert.deepEqual(await getTabContext(1), initial);
});

test('storage quota failure leaves the previous context intact and does not poison later queued writes', async () => {
  resetStorage();
  await updateTabSelection(1, source, selected('原词'));
  const initial = await getTabContext(1);
  failSessionWrite = true;
  await assert.rejects(setTabAttachment(1, 'page', { ...source, content: '新正文' }), /QUOTA/);
  assert.deepEqual(await getTabContext(1), initial);
  const next = await setTabAttachment(1, 'url', true);
  assert.equal(next.attachments.page, null);
  assert.equal(next.attachments.url, true);
  assert.equal(next.revision, initial.revision + 1);
});

test('closing a tab deletes only its session context while legacy local history stays untouched', async () => {
  resetStorage(); localData['sider.state.v1'] = { references: [{ content: '保留的历史数据' }] };
  await updateTabSelection(1, source, selected('词'));
  await updateTabSelection(2, source, selected('另一个词'));
  await removeTabContext(1);
  assert.equal(sessionData[`${TAB_CONTEXT_PREFIX}1`], undefined);
  assert.equal((await getTabContext(2)).selection.content, '另一个词');
  assert.equal(localData['sider.state.v1'].references[0].content, '保留的历史数据');
});

test('settings changes merge atomically and settings write failure preserves the last saved format', async () => {
  resetStorage();
  await Promise.all([patchContextSettings({ urlTemplate: '网页url为：{{url}}' }), patchContextSettings({ selectionPosition: 'append' })]);
  const settings = await getContextSettings();
  assert.equal(settings.urlTemplate, '网页url为：{{url}}');
  assert.equal(settings.selectionPosition, 'append');
  failLocalWrite = true;
  await assert.rejects(patchContextSettings({ pageTemplate: '正文 {{content}}' }), /QUOTA/);
  assert.deepEqual(await getContextSettings(), settings);
  await assert.rejects(patchContextSettings({ pageThreshold: 0 }), /附件阈值/);
  await assert.rejects(patchContextSettings({ urlPosition: 'unknown' }), /追加位置/);
  assert.deepEqual(templateSettings(localData[UNIFIED_TEMPLATES_KEY]), settings);
});

test('old send budgets migrate to attachment defaults without changing saved formats or the raw record on read', async () => {
  resetStorage();
  const legacy = { selectionTemplate: '自定义划词：{{selection}}', selectionPosition: 'append', urlTemplate: '网页url为：{{url}}', urlPosition: 'prepend', pageTemplate: '原有正文：{{content}}', pagePosition: 'prepend', maxChars: 64000 };
  localData[CONTEXT_SETTINGS_KEY] = structuredClone(legacy);
  const settings = await getContextSettings();
  assert.equal(settings.selectionTemplate, legacy.selectionTemplate);
  assert.equal(settings.selectionPosition, 'append');
  assert.equal(settings.urlTemplate, legacy.urlTemplate);
  assert.equal(settings.urlPosition, 'prepend');
  assert.equal(settings.pageTemplate, legacy.pageTemplate);
  assert.equal(settings.pagePosition, 'prepend');
  assert.equal(settings.pageMode, 'auto');
  assert.equal(settings.pageThreshold, 10000);
  assert.equal(settings.pageAttachmentTemplate, DEFAULT_CONTEXT_SETTINGS.pageAttachmentTemplate);
  assert.equal(Object.hasOwn(settings, 'maxChars'), false);
  assert.deepEqual(localData[CONTEXT_SETTINGS_KEY], legacy);
  const updated = await patchContextSettings({ pageMode: 'file' });
  assert.equal(updated.pageMode, 'file');
  assert.equal(updated.pageThreshold, 10000);
  assert.equal(updated.pageTemplate, legacy.pageTemplate);
  assert.equal(Object.hasOwn(templateSettings(localData[UNIFIED_TEMPLATES_KEY]), 'maxChars'), false);
});

test('concurrent attachment settings updates merge modes, integer thresholds and file templates', async () => {
  resetStorage();
  await Promise.all([
    patchContextSettings({ pageMode: 'file' }),
    patchContextSettings({ pageThreshold: 4321 }),
    patchContextSettings({ pageAttachmentTemplate: '结合附件 {{filename}} 和网页 {{url}} 回答' }),
    patchContextSettings({ selectionTemplate: '用户划词：{{selection}}' }),
  ]);
  const settings = await getContextSettings();
  assert.equal(settings.pageMode, 'file');
  assert.equal(settings.pageThreshold, 4321);
  assert.equal(settings.pageAttachmentTemplate, '结合附件 {{filename}} 和网页 {{url}} 回答');
  assert.equal(settings.selectionTemplate, '用户划词：{{selection}}');
  assert.equal(Object.hasOwn(settings, 'maxChars'), false);
});

test('invalid attachment settings reject atomically and do not poison later valid writes', async () => {
  resetStorage();
  const initial = await patchContextSettings({ pageMode: 'text', pageThreshold: 5678, pageAttachmentTemplate: '附件 {{filename}}' });
  for (const threshold of [0, -1, 1.5, 1000001, Infinity, NaN, '10000', null, true]) {
    await assert.rejects(patchContextSettings({ pageThreshold: threshold, urlTemplate: '不可写入的格式' }), /附件阈值/);
    assert.deepEqual(await getContextSettings(), initial);
  }
  for (const mode of ['unknown', '', null, 1]) await assert.rejects(patchContextSettings({ pageMode: mode }), /发送方式/);
  for (const template of [null, 123, {}, []]) await assert.rejects(patchContextSettings({ pageAttachmentTemplate: template }), /附件格式/);
  for (const patch of [null, 123, []]) await assert.rejects(patchContextSettings(patch), /设置格式/);
  assert.deepEqual(templateSettings(localData[UNIFIED_TEMPLATES_KEY]), initial);
  assert.equal((await patchContextSettings({ pageMode: 'auto', pageThreshold: 1 })).pageThreshold, 1);
  assert.equal((await patchContextSettings({ pageThreshold: 1000000 })).pageThreshold, 1000000);
});

test('obsolete maxChars patches are ignored and never become an attachment threshold or hard limit', async () => {
  resetStorage();
  const saved = await patchContextSettings({ pageThreshold: 23456 });
  for (const maxChars of [999, 64000, -1, 'invalid']) {
    const next = await patchContextSettings({ maxChars });
    assert.deepEqual(next, saved);
    assert.equal(Object.hasOwn(templateSettings(localData[UNIFIED_TEMPLATES_KEY]), 'maxChars'), false);
  }
});

test('failed attachment settings persistence retains the previous mode and lets the queue recover', async () => {
  resetStorage();
  const initial = await patchContextSettings({ pageMode: 'auto', pageThreshold: 10000 });
  failLocalWrite = true;
  await assert.rejects(patchContextSettings({ pageMode: 'file', pageAttachmentTemplate: '新附件：{{filename}}' }), /QUOTA/);
  assert.deepEqual(await getContextSettings(), initial);
  const updated = await patchContextSettings({ pageMode: 'text' });
  assert.equal(updated.pageMode, 'text');
  assert.equal(updated.pageAttachmentTemplate, initial.pageAttachmentTemplate);
});

test('old settings retain custom formats and initialize only the former automatic selection default', async () => {
  resetStorage();
  const legacy = { selectionTemplate: '原格式 {{selection}}', urlPosition: 'prepend' };
  localData[CONTEXT_SETTINGS_KEY] = structuredClone(legacy);
  const settings = await getContextSettings();
  assert.equal(settings.defaultSelection, true); assert.equal(settings.defaultUrl, false); assert.equal(settings.defaultPage, false);
  assert.equal(settings.selectionTemplate, legacy.selectionTemplate); assert.equal(settings.urlPosition, legacy.urlPosition);
  assert.deepEqual(localData[CONTEXT_SETTINGS_KEY], legacy);
});

test('default patches validate booleans atomically and failed writes retain the saved choices', async () => {
  resetStorage();
  const before = await patchContextSettings({ defaultSelection: false, defaultUrl: true });
  for (const key of ['defaultSelection', 'defaultUrl', 'defaultPage']) {
    for (const value of ['false', 0, null, {}, []]) {
      await assert.rejects(patchContextSettings({ [key]: value, pageTemplate: '不应保存' }), /默认勾选/);
      assert.deepEqual(await getContextSettings(), before);
    }
  }
  failLocalWrite = true;
  await assert.rejects(patchContextSettings({ defaultPage: true }), /QUOTA/);
  assert.deepEqual(await getContextSettings(), before);
  await Promise.all([patchContextSettings({ defaultPage: true }), patchContextSettings({ defaultUrl: false })]);
  const next = await getContextSettings();
  assert.equal(next.defaultSelection, false); assert.equal(next.defaultPage, true); assert.equal(next.defaultUrl, false);
});

test('settings change metadata reports only defaults changed in that atomic save', async () => {
  resetStorage();
  const first = await patchContextSettings({ defaultUrl: true }, { includeChanges: true });
  assert.deepEqual(first.changedDefaults, ['url']);
  const formatOnly = await patchContextSettings({ defaultUrl: true, urlTemplate: '网址 {{url}}' }, { includeChanges: true });
  assert.deepEqual(formatOnly.changedDefaults, []);
  assert.equal(formatOnly.settings.urlTemplate, '网址 {{url}}');
});

test('initial defaults apply once and explicit cancellation survives polling and unchanged selection reads', async () => {
  resetStorage(); await patchContextSettings({ defaultUrl: true, defaultPage: true });
  await updateTabSelection(1, source, selected('词'));
  const settings = await getContextSettings();
  const first = await applyTabDefaults(1, settings);
  assert.equal(first.attachments.url, true); assert.equal(first.pageRequested, true);
  await setTabAttachment(1, 'selection', false); await setTabAttachment(1, 'url', false); await setTabAttachment(1, 'page', false);
  const cancelled = await getTabContext(1);
  await updateTabSelection(1, source, selected('词'));
  assert.deepEqual(await applyTabDefaults(1, settings), cancelled);
  const newSelection = await updateTabSelection(1, source, selected('新词'));
  assert.equal(newSelection.selectionIncluded, false);
  assert.equal(newSelection.attachments.url, false); assert.equal(newSelection.pageRequested, false);
});

test('new selections honor a disabled default while explicit inclusion survives the same selection and title updates', async () => {
  resetStorage(); await patchContextSettings({ defaultSelection: false });
  assert.equal((await updateTabSelection(1, source, selected('词'))).selectionIncluded, false);
  await setTabAttachment(1, 'selection', true);
  const same = await updateTabSelection(1, { ...source, title: '新标题' }, { ...selected('词'), title: '新标题' });
  assert.equal(same.selectionIncluded, true);
  assert.equal((await updateTabSelection(1, source, selected('新词'))).selectionIncluded, true);
  await assert.rejects(setTabAttachment(2, 'selection', true), /划词/);
  await assert.rejects(setTabAttachment(1, 'selection', 'true'), /划词/);
});

test('legacy session choices and body snapshots survive default initialization', async () => {
  resetStorage();
  sessionData[`${TAB_CONTEXT_PREFIX}1`] = { tabId: 1, revision: 9, ...source, selection: selected('词'), selectionIncluded: false, attachments: { url: true, page: { ...source, content: '旧快照' } } };
  const restored = await getTabContext(1);
  const initialized = await applyTabDefaults(1, await getContextSettings());
  assert.deepEqual(initialized, restored);
  assert.equal(initialized.selectionIncluded, false); assert.equal(initialized.attachments.url, true);
  assert.equal(initialized.attachments.page.content, '旧快照'); assert.equal(initialized.pageRequested, true);
});

test('authorization clears source material but preserves temporary cancellation when the source becomes available', async () => {
  resetStorage(); const settings = await patchContextSettings({ defaultPage: true, defaultUrl: true });
  await updateTabSelection(1, source, selected('词')); await applyTabDefaults(1, settings);
  await setTabAttachment(1, 'page', false); await setTabAttachment(1, 'url', false);
  const unavailable = await invalidateTabSource(1);
  assert.equal(unavailable.url, ''); assert.equal(unavailable.selection, null);
  await updateTabSelection(1, source, null);
  const restored = await applyTabDefaults(1, settings);
  assert.equal(restored.pageRequested, false); assert.equal(restored.attachments.url, false);
  await requestTabPage(1, '提取失败');
  const failed = await getTabContext(1);
  assert.equal(failed.pageRequested, true); assert.equal(failed.pageError, '提取失败'); assert.equal(failed.attachments.page, null);
});
