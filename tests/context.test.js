import test from 'node:test';
import assert from 'node:assert/strict';
import { composeContextPrompt, createTabContext, normalizeContext, normalizeContextSettings, DEFAULT_CONTEXT_SETTINGS } from '../src/context.js';

function context() {
  return {
    ...createTabContext(12), url: 'https://example.com/article', title: '示例文章',
    selection: { content: '所选词汇', context: '包含所选词汇的段落', url: 'https://example.com/article' },
  };
}

test('current selection is prepended to a normal question only when composing a send', () => {
  const result = composeContextPrompt('这个词是什么意思？', context());
  assert.equal(result.text, '网页划词：\n所选词汇\n\n这个词是什么意思？');
  assert.deepEqual(result.errors, []);
  assert.equal(result.text, result.prefix + '这个词是什么意思？' + result.suffix);
  assert.equal(result.characterCount, result.text.length);
});

test('URL and body each appear once in their configured positions around the unchanged question', () => {
  const current = context();
  current.attachments = { url: true, page: { content: '完整的正文\n\n第二段', url: current.url } };
  const question = '  我的问题 {{url}}  \n';
  const result = composeContextPrompt(question, current, {
    selectionTemplate: '「{{selection}}」；背景：{{context}}', selectionPosition: 'append',
    urlTemplate: '网页url为：{{url}}', urlPosition: 'prepend',
    pageTemplate: '{{title}}\n{{page.content}}', pagePosition: 'append',
  });
  assert.equal(result.text, `网页url为：https://example.com/article\n\n${question}\n\n「所选词汇」；背景：包含所选词汇的段落\n\n示例文章\n完整的正文\n\n第二段`);
  assert.equal(result.text.split('完整的正文').length - 1, 1);
  assert.deepEqual(result.errors, []);
});

test('literal variables in the question or captured text are never expanded recursively', () => {
  const current = context();
  current.selection.content = '{{url}} $& <script>alert(1)</script>';
  const question = '解释 {{selection}}，保留 {{unknown}}';
  const result = composeContextPrompt(question, current);
  assert.equal(result.text, `网页划词：\n${current.selection.content}\n\n${question}`);
  assert.deepEqual(result.errors, []);
});

test('tabs with no selection send just the question and suppressed selection is not included', () => {
  const current = context();
  current.selectionIncluded = false;
  assert.equal(composeContextPrompt('问题', current).text, '问题');
  const other = createTabContext(13);
  other.url = 'https://other.test/';
  assert.equal(composeContextPrompt('新网页的问题', other).text, '新网页的问题');
});

test('a blank question is rejected even if full source material is available', () => {
  const result = composeContextPrompt(' \n\t', context());
  assert.match(result.errors.join(' '), /输入问题/);
});

test('unknown settings variables, missing body variables and missing selected content block send', () => {
  const unknown = composeContextPrompt('问题', context(), { selectionTemplate: '{{question}} {{r1.content}}' });
  assert.equal(unknown.errors.length, 2);
  const absent = composeContextPrompt('问题', context(), { selectionTemplate: '{{content}}' });
  assert.match(absent.errors.join(' '), /缺少内容/);
  const current = context(); current.selection.content = '';
  assert.match(composeContextPrompt('问题', current).errors.join(' '), /划词内容为空/);
});

test('empty enabled templates and invalid or mismatched source URLs block send', () => {
  assert.match(composeContextPrompt('问题', context(), { selectionTemplate: '' }).errors.join(' '), /追加格式不能为空/);
  const current = context(); current.selection.url = 'https://old.test/';
  assert.match(composeContextPrompt('问题', current).errors.join(' '), /来源与当前网页不一致/);
  current.url = 'javascript:alert(1)';
  assert.match(composeContextPrompt('问题', current).errors.join(' '), /地址无效/);
});

test('the retired send budget no longer blocks or truncates questions and other context blocks', () => {
  const current = context(); current.selection.content = '长'.repeat(60000);
  current.attachments.url = true;
  const question = '问题'.repeat(30000);
  const result = composeContextPrompt(question, current, { maxChars: 1000 });
  assert.deepEqual(result.errors, []);
  assert.equal(Object.hasOwn(result, 'overBudget'), false);
  assert.equal(Object.hasOwn(result, 'maxChars'), false);
  assert.ok(result.text.includes(current.selection.content));
  assert.equal(result.text, `${result.prefix}${question}${result.suffix}`);
  assert.equal(result.attachment, null); assert.equal(result.pageDelivery, null);
});

test('normalization keeps one current selection and body snapshot without numbered history', () => {
  const current = context(); current.references = [{ content: '不应迁移的历史' }];
  current.attachments.page = { content: '正文', context: '', url: current.url, extraction: { warnings: ['仅采集已加载内容'] } };
  const normalized = normalizeContext(current, 91);
  assert.equal(normalized.tabId, 91);
  assert.equal(normalized.selection.content, '所选词汇');
  assert.equal(normalized.attachments.page.extraction.warnings[0], '仅采集已加载内容');
  assert.equal(Object.hasOwn(normalized, 'references'), false);
  const settings = normalizeContextSettings({ urlTemplate: '网址 {{url}}', selectionPosition: 'invalid', maxChars: Infinity });
  assert.equal(settings.urlTemplate, '网址 {{url}}');
  assert.equal(settings.selectionPosition, 'prepend');
  assert.equal(Object.hasOwn(settings, 'maxChars'), false);
  assert.equal(settings.pageThreshold, DEFAULT_CONTEXT_SETTINGS.pageThreshold);
});

test('oversized restored source remains intact while composition refuses to send it', () => {
  const current = context(); current.selection.content = 'a'.repeat(1000001);
  const result = composeContextPrompt('问题', current);
  assert.ok(result.text.includes(current.selection.content));
  assert.match(result.errors.join(' '), /100 万字符/);
});

function pageContext(content) {
  const current = context(); current.selection = null;
  current.attachments.page = { kind: 'page', title: current.title, url: current.url, content, context: '', capturedAt: '2026-10-01T04:30:00Z' };
  return current;
}

test('attachment note uses the actual native upload name without altering file body or variable meaning', () => {
  const current = pageContext('完整正文');
  const settings = { pageMode: 'file', pageTemplate: '正文结构：{{content}}', pageAttachmentTemplate: '请读取 {{filename}}，来源 {{url}}' };
  const logical = composeContextPrompt('请分析', current, settings);
  const nativeName = '实际附件-sider-a19c08237eff9042.txt';
  const uploaded = composeContextPrompt('请分析', current, settings, { attachmentName: nativeName });
  assert.equal(uploaded.attachment.name, nativeName);
  assert.equal(uploaded.attachment.content, logical.attachment.content);
  assert.ok(uploaded.text.includes(nativeName));
  assert.ok(uploaded.attachment.content.endsWith('正文结构：完整正文'));
  assert.equal(uploaded.text.includes('完整正文'), false);
});

test('automatic page delivery changes to file only above the expanded block threshold', () => {
  for (const length of [9999, 10000, 10001]) {
    const body = '文'.repeat(length);
    const result = composeContextPrompt('总结观点', pageContext(body), { pageTemplate: '{{content}}' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.pageDelivery, length > 10000 ? 'file' : 'text');
    if (length > 10000) {
      assert.equal(result.text.includes(body), false);
      assert.equal(result.attachment.mimeType, 'text/plain');
      assert.ok(result.attachment.content.endsWith(body));
    } else {
      assert.equal(result.attachment, null); assert.ok(result.text.endsWith(body));
    }
  }
  const expanded = composeContextPrompt('问题', pageContext('短正文'), { pageThreshold: 5, pageTemplate: '完整正文格式：{{content}}' });
  assert.equal(expanded.pageDelivery, 'file');
  assert.ok(expanded.attachment.content.endsWith('完整正文格式：短正文'));
});

test('manual text sends the entire long body and manual file attaches even a short body', () => {
  const body = '长正文\n'.repeat(20000);
  const text = composeContextPrompt('请分析', pageContext(body), { pageMode: 'text', pageThreshold: 1, maxChars: 1000 });
  assert.equal(text.pageDelivery, 'text'); assert.equal(text.attachment, null);
  assert.ok(text.text.endsWith(body)); assert.deepEqual(text.errors, []);
  const file = composeContextPrompt('请分析', pageContext('简短正文'), { pageMode: 'file', pageThreshold: 1000000 });
  assert.equal(file.pageDelivery, 'file'); assert.equal(file.text.includes('简短正文'), false);
  assert.ok(file.attachment.content.endsWith('网页正文：\n简短正文'));
});

test('the page file preserves the full expanded body format and source metadata without the question', () => {
  const current = pageContext('第一段\n\n```js\nconst value = 1;\n```\n\n末尾');
  const result = composeContextPrompt('这句话只存在于问题中', current, { pageMode: 'file', pageTemplate: '文档标题：{{title}}\n引用地址：{{url}}\n\n{{page.content}}\n\n正文结束' });
  assert.equal(result.attachment.name, '示例文章-网页正文.txt');
  assert.ok(result.attachment.content.startsWith('标题：示例文章\n来源 URL：https://example.com/article\n采集时间：2026-10-01T04:30:00Z\n\n'));
  assert.ok(result.attachment.content.endsWith(`文档标题：示例文章\n引用地址：https://example.com/article\n\n${current.attachments.page.content}\n\n正文结束`));
  assert.equal(result.attachment.content.includes('这句话只存在于问题中'), false);
  assert.equal(result.characterCount, result.text.length);
  assert.equal(result.text, `${result.prefix}这句话只存在于问题中${result.suffix}`);
});

test('file message templates use filename and other contextual variables at the configured page position', () => {
  const current = pageContext('正文'); current.selection = context().selection;
  const result = composeContextPrompt('问题', current, {
    pageMode: 'file', pagePosition: 'prepend',
    pageAttachmentTemplate: '文件：{{filename}}\n来源：{{url}}\n标题：{{title}}\n相关划词：{{selection}}\n段落：{{selection.context}}',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.text, '网页划词：\n所选词汇\n\n文件：示例文章-网页正文.txt\n来源：https://example.com/article\n标题：示例文章\n相关划词：所选词汇\n段落：包含所选词汇的段落\n\n问题');
  assert.equal(result.suffix, '');
});

test('file body and message substitutions preserve source variables literally without recursion', () => {
  const current = pageContext('{{url}} $& {{filename}} <script>not executed</script>');
  current.title = '标题 {{url}}';
  const result = composeContextPrompt('问题 {{filename}}', current, { pageMode: 'file', pageTemplate: '{{content}}', pageAttachmentTemplate: '{{filename}}；{{title}}' });
  assert.deepEqual(result.errors, []);
  assert.ok(result.attachment.content.endsWith(current.attachments.page.content));
  assert.equal(result.text, '问题 {{filename}}\n\n标题 {{url}}-网页正文.txt；标题 {{url}}');
});

test('file mode respects existing body-variable semantics in selection and URL formats', () => {
  const current = pageContext('完整正文'); current.selection = context().selection; current.attachments.url = true;
  const result = composeContextPrompt('问题', current, { pageMode: 'file', selectionTemplate: '{{selection}}：{{content}}', urlTemplate: '{{url}}\n{{page.content}}' });
  assert.deepEqual(result.errors, []);
  assert.ok(result.text.startsWith('所选词汇：完整正文\n\n问题'));
  assert.ok(result.text.includes('https://example.com/article\n完整正文'));
  assert.ok(result.attachment.content.endsWith('网页正文：\n完整正文'));
});

test('invalid file formats block composition instead of producing an uploadable partial attachment', () => {
  for (const template of ['{{content}}', '{{page.content}}', '{{unknown}}', '{{selection}}', '']) {
    const result = composeContextPrompt('问题', pageContext('正文'), { pageMode: 'file', pageAttachmentTemplate: template });
    assert.ok(result.errors.length > 0, template); assert.equal(result.attachment, null);
  }
  const badBody = composeContextPrompt('问题', pageContext('正文'), { pageMode: 'file', pageTemplate: '{{question}}' });
  assert.match(badBody.errors.join(' '), /未知变量/); assert.equal(badBody.attachment, null);
  const blankQuestion = composeContextPrompt('', pageContext('正文'), { pageMode: 'file' });
  assert.match(blankQuestion.errors.join(' '), /输入问题/); assert.equal(blankQuestion.attachment, null);
  const text = composeContextPrompt('问题', pageContext('正文'), { pageMode: 'text', pageAttachmentTemplate: '{{content}}' });
  assert.deepEqual(text.errors, []);
});

test('file names are deterministic, short and safe for path characters even with unusual titles', () => {
  const current = pageContext('完整正文');
  current.title = '../目录\\文档:*?"<>|\u0000\u202e ' + '🦊'.repeat(100);
  const first = composeContextPrompt('第一个问题', current, { pageMode: 'file' });
  const second = composeContextPrompt('另一个问题', current, { pageMode: 'file' });
  assert.equal(first.attachment.name, second.attachment.name);
  assert.equal(first.attachment.content, second.attachment.content);
  assert.ok(first.attachment.name.length <= 120);
  assert.equal(/[\\/:*?"<>|\u0000-\u001f\u202e]/.test(first.attachment.name), false);
  assert.match(first.attachment.name, /-网页正文\.txt$/);
  assert.equal(first.attachment.name.startsWith('.'), false);
  const empty = pageContext('正文'); empty.title = '';
  assert.equal(composeContextPrompt('问题', empty, { pageMode: 'file' }).attachment.name, '示例文章-网页正文.txt');
});

test('attachment settings migration ignores the old send limit and retains existing custom formats', () => {
  const migrated = normalizeContextSettings({ maxChars: 1000, pageTemplate: '全文 {{content}}', selectionTemplate: '解释 {{selection}}', pagePosition: 'prepend' });
  assert.equal(Object.hasOwn(migrated, 'maxChars'), false);
  assert.equal(migrated.pageThreshold, 10000); assert.equal(migrated.pageMode, 'auto');
  assert.equal(migrated.pageTemplate, '全文 {{content}}'); assert.equal(migrated.selectionTemplate, '解释 {{selection}}'); assert.equal(migrated.pagePosition, 'prepend');
  const changed = normalizeContextSettings({ pageThreshold: '24000', pageMode: 'file', pageAttachmentTemplate: '阅读 {{filename}}' });
  assert.equal(changed.pageThreshold, 24000); assert.equal(changed.pageMode, 'file'); assert.equal(changed.pageAttachmentTemplate, '阅读 {{filename}}');
  for (const pageThreshold of [Infinity, NaN, 0, -1]) assert.equal(normalizeContextSettings({ pageThreshold }).pageThreshold, 10000);
  assert.equal(normalizeContextSettings({ pageMode: 'invalid' }).pageMode, 'auto');
});
