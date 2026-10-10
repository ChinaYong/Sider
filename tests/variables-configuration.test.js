import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { expandVariables, VARIABLES } from '../src/variables.js';
import { exportConfiguration, validateConfiguration, configurationStorage } from '../src/configuration.js';
import { CONTEXT_SETTINGS_KEY, composeContextPrompt, normalizeContextSettings } from '../src/context.js';
import { PROMPT_TEMPLATES_KEY, validatePromptTemplates, pageAlreadyInline } from '../src/prompt-templates.js';
import { captureComposerSelection } from '../src/content/composer.js';
import { LAUNCHER_SETTINGS_KEY, normalizeLauncherSettings } from '../src/launcher-settings.js';

const context = { tabId: 1, url: 'https://example.test/article', title: '标题 {{url}}', selection: { content: '词', context: '段落' }, attachments: { page: { url: 'https://example.test/article', title: '标题', content: '# 原文\n包含 {{filename}}\n尾标记', capturedAt: '2026-10-05T06:00:00Z', metadata: { author: '作者', publishedAt: '2026-10-01' } } } };

test('all applicable variables expand once using one time and complete original values', () => {
  const text = VARIABLES.filter(item => item.places.includes('shortcut')).map(item => `{{${item.name}}}`).join('|');
  const result = expandVariables(text, context, { now: new Date(2026, 9, 5, 14, 3, 9), templateName: '测试预设' });
  assert.deepEqual(result.errors, []);
  assert.ok(result.text.includes('标题 {{url}}')); assert.ok(result.text.includes('{{filename}}'));
  assert.ok(result.text.includes('2026-10-05|14:03:09|2026-10-05 14:03:09')); assert.ok(result.text.includes(context.attachments.page.content));
  assert.match(expandVariables('{{filename}}', context).errors[0], /未知变量/);
  assert.match(expandVariables('{{page.author}}', context, { page: { content: 'body' } }).errors[0], /页面须提供作者/);
});

test('body deduplication requires preserved full content and matching editor, source, tab, and session', () => {
  const editor = {}; const proof = { editor, session: 'session', tabId: 1, url: context.url, content: context.attachments.page.content };
  const question = '总结\n' + proof.content;
  assert.equal(pageAlreadyInline(proof, question, context, editor, 'session'), true);
  for (const next of [{ ...proof, url: 'https://other.test/' }, { ...proof, tabId: 2 }, { ...proof, session: 'next' }, { ...proof, editor: {} }, { ...proof, content: '原文' }]) assert.equal(pageAlreadyInline(next, question, context, editor, 'session'), false);
  assert.equal(pageAlreadyInline(proof, question.replace('尾标记', '已编辑'), context, editor, 'session'), false);
  const compiled = composeContextPrompt(question, context, { pageMode: 'file' }, { skipPage: true });
  assert.equal(compiled.attachment, null); assert.equal(compiled.text, '网页划词：\n词\n\n' + question); assert.deepEqual(compiled.errors, []);
});

test('configuration roundtrip replaces every supported key and excludes cached private content', () => {
  const stored = { [CONTEXT_SETTINGS_KEY]: normalizeContextSettings({ defaultPage: true }), [PROMPT_TEMPLATES_KEY]: [{ id: 'template-12345', name: '总结', text: '{{page.content}}', directSend: false }], 'sider.tabContext.1': context, siderEmbedRegistrations: [{ bridgeId: 'private' }], 'sider.state.v1': { draft: '私有草稿' } };
  const backup = exportConfiguration(stored);
  assert.equal(JSON.stringify(backup).includes('私有草稿'), false); assert.equal(JSON.stringify(backup).includes('尾标记'), false);
  assert.deepEqual(validateConfiguration(JSON.parse(JSON.stringify(backup))).configuration, backup.configuration);
  assert.equal(Object.keys(configurationStorage(backup)).length, 5);
  stored[LAUNCHER_SETTINGS_KEY] = { floating: false, side: 'left', y: 0.25 };
  assert.deepEqual(configurationStorage(exportConfiguration(stored))[LAUNCHER_SETTINGS_KEY], normalizeLauncherSettings(stored[LAUNCHER_SETTINGS_KEY]));
  delete backup.configuration.launcher;
  assert.deepEqual(validateConfiguration(backup).configuration.launcher, normalizeLauncherSettings());
  backup.configuration.launcher = { floating: true, side: 'right', y: 2 };
  assert.throws(() => validateConfiguration(backup), /悬浮球设置/);
});

test('malformed and incomplete configuration cannot normalize into an implicit merge', () => {
  const fresh = () => exportConfiguration({});
  const wrong = fresh(); wrong.version = 4; assert.throws(() => validateConfiguration(wrong), /版本/);
  const missing = fresh(); delete missing.configuration.templates; assert.throws(() => validateConfiguration(missing), /缺少/);
  const invalid = fresh(); invalid.configuration.templates[2].threshold = '100'; assert.throws(() => validateConfiguration(invalid), /无效/);
  const unknown = fresh(); unknown.configuration.templates[1].text = '{{bad}}'; assert.throws(() => validateConfiguration(unknown), /未知变量/);
  const selector = fresh(); selector.configuration.aiWeb.builtinOverrides = { chatgpt: { selectors: { send: '[broken' } } }; assert.throws(() => validateConfiguration(selector), /选择器无效/);
  const duplicate = { id: 'template-12345', name: '预设', text: '{{url}}', directSend: false };
  assert.throws(() => validatePromptTemplates([duplicate, duplicate]), /重复/);
  const invalidURL = fresh(); invalidURL.configuration.aiWeb.customSites = [{ id: 'custom-12345678', name: '无效网站', url: 'javascript:alert(1)' }]; assert.throws(() => validateConfiguration(invalidURL), /HTTP/);
});

test('textarea and rich editor selections retain offsets across paragraphs', () => {
  const { window } = new JSDOM('<textarea>前缀旧词后缀</textarea><div contenteditable="true" tabindex="0"><p>第一段</p><p>第二段</p></div>');
  const textarea = window.document.querySelector('textarea'); textarea.focus(); textarea.setSelectionRange(2, 4); assert.deepEqual(captureComposerSelection(textarea), { from: 2, to: 4 });
  const editor = window.document.querySelector('div'); editor.focus();
  const range = window.document.createRange(); range.setStart(editor.lastChild.firstChild, 1); range.setEnd(editor.lastChild.firstChild, 3);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  assert.deepEqual(captureComposerSelection(editor), { from: 5, to: 7 }); window.close();
});
