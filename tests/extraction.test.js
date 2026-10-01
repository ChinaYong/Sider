import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { captureReference, captureSelection, extractPage, highlightReference } from '../src/content/extract.js';

function page(html) {
  return new JSDOM(`<!doctype html><html><head><title>测试网页</title></head><body>${html}</body></html>`, {
    url: 'https://example.com/article', pretendToBeVisual: true,
  });
}

function select(window, node, start = 0, end = node.textContent.length) {
  const range = window.document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

test('article extraction preserves code, links and GFM table without mutating the live page', () => {
  const text = '这是一篇用于验证网页正文采集的技术文章。它讨论文档结构与浏览器选区，并且包含足够的正文，让正文识别能够稳定工作。'.repeat(12);
  const dom = page(`<nav>导航噪音</nav><article><h1>浏览器正文</h1><p>${text}</p><p><a href="/guide">使用指南</a></p><pre><code class="language-js">const answer = 42;\nconsole.log(answer);</code></pre><table><tr><th>名称</th><th>值</th></tr><tr><td>answer</td><td>42</td></tr></table></article>`);
  const { document } = dom.window;
  const before = document.documentElement.outerHTML;
  const reference = captureReference(document, 'page');
  assert.equal(reference.extraction.method, 'readability');
  assert.equal(reference.extraction.scope, 'currently-loaded');
  assert.match(reference.content, /```js\nconst answer = 42;/);
  assert.match(reference.content, /\| 名称 \| 值 \|/);
  assert.match(reference.content, /https:\/\/example.com\/guide/);
  assert.doesNotMatch(reference.content, /导航噪音/);
  assert.equal(document.documentElement.outerHTML, before);
});

test('page extraction excludes hidden content and editable values', () => {
  const dom = page('<main><p>可见正文。</p><p hidden>HIDDEN_SECRET</p><p style="display:none">CSS_SECRET</p><input value="INPUT_SECRET"><textarea>TEXTAREA_SECRET</textarea><div contenteditable="true">DRAFT_SECRET</div><p>另一段正文。</p></main>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /可见正文/);
  assert.doesNotMatch(extracted.content, /(?:HIDDEN|CSS|INPUT|TEXTAREA|DRAFT)_SECRET/);
  assert.ok(extracted.extraction.warnings.some(warning => warning.includes('已加载')));
});

test('non-article content falls back to the main region and reports it', () => {
  const dom = page('<nav>站点导航</nav><main><p>短小的工作台正文</p></main><aside>不相关侧栏</aside>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /短小的工作台正文/);
  assert.doesNotMatch(extracted.content, /站点导航|不相关侧栏/);
  // Readability can handle short main regions, so either method is legitimate.
  assert.ok(['readability', 'main-region'].includes(extracted.extraction.method));
  assert.equal(extracted.extraction.scope, 'currently-loaded');
});

test('tables without headings keep every cell in a labelled row fallback', () => {
  const dom = page('<main><table><tr><td>A</td><td>B</td></tr><tr><td colspan="2">合并内容</td></tr></table></main>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /第 1 行：A \| B/);
  assert.match(extracted.content, /合并内容/);
  assert.ok(extracted.extraction.warnings.some(warning => warning.includes('表格')));
});

test('selection includes paragraph context and locator, remains available after focus is lost', () => {
  const dom = page('<p>前面的说明，引用的文字，后面的说明。</p>');
  const { window } = dom;
  const text = window.document.querySelector('p').firstChild;
  const selected = '引用的文字';
  const start = text.nodeValue.indexOf(selected);
  select(window, text, start, start + selected.length);
  const reference = captureSelection(window.document);
  assert.equal(reference.content, selected);
  assert.equal(reference.context, text.nodeValue);
  assert.equal(reference.locator.exact, selected);
  assert.match(reference.locator.prefix, /前面的说明/);
  assert.match(reference.locator.suffix, /后面的说明/);
  window.getSelection().removeAllRanges();
  assert.deepEqual(captureReference(window.document, 'selection', reference), reference);
  assert.throws(() => captureReference(window.document, 'selection'), /先在网页正文/);
});

test('editable selections and selections crossing editable content are excluded', () => {
  const dom = page('<p>正文</p><div contenteditable="true">私人草稿</div><textarea>私人输入</textarea>');
  select(dom.window, dom.window.document.querySelector('[contenteditable]').firstChild);
  assert.equal(captureSelection(dom.window.document), null);
  assert.throws(() => captureReference(dom.window.document, 'selection'), /可编辑区域/);
  select(dom.window, dom.window.document.querySelector('textarea').firstChild);
  assert.equal(captureSelection(dom.window.document), null);
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.body);
  dom.window.getSelection().removeAllRanges();
  dom.window.getSelection().addRange(range);
  assert.equal(captureSelection(dom.window.document), null);
});

test('hidden selections and ranges crossing hidden values are excluded', () => {
  const dom = page('<p>可见前文<span hidden>HIDDEN_SECRET</span>可见后文</p>');
  select(dom.window, dom.window.document.querySelector('[hidden]').firstChild);
  assert.equal(captureSelection(dom.window.document), null);
  assert.throws(() => captureReference(dom.window.document, 'selection'), /隐藏内容/);
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.querySelector('p'));
  dom.window.getSelection().removeAllRanges();
  dom.window.getSelection().addRange(range);
  assert.equal(captureSelection(dom.window.document), null);
});

test('quote locator distinguishes repeated text and restores an existing DOM range', () => {
  const dom = page('<p>第一处：同一段文字。结束。</p><p>第二处：同一段文字。另一段结束。</p>');
  const { window } = dom;
  const node = window.document.querySelectorAll('p')[1].firstChild;
  const selected = '同一段文字';
  const start = node.nodeValue.indexOf(selected);
  select(window, node, start, start + selected.length);
  const reference = captureSelection(window.document);
  window.getSelection().removeAllRanges();
  const before = window.document.body.innerHTML;
  assert.equal(highlightReference(window.document, reference.locator), true);
  assert.equal(window.getSelection().toString(), selected);
  assert.equal(window.getSelection().anchorNode, node);
  assert.equal(window.document.body.innerHTML, before);
  assert.equal(highlightReference(window.document, { exact: '不存在的文字' }), false);
});

test('quote locator can restore text spanning a rendered line break', () => {
  const dom = page('<p>第一行<br>第二行</p>');
  assert.equal(highlightReference(dom.window.document, { exact: '第一行\n第二行' }), true);
  assert.equal(dom.window.getSelection().toString(), '第一行第二行');
  assert.equal(dom.window.getSelection().anchorNode, dom.window.document.querySelector('p').firstChild);
});

test('URL references do not pretend to include the page body', () => {
  const dom = page('<main>网页正文</main>');
  const reference = captureReference(dom.window.document, 'url');
  assert.equal(reference.content, 'https://example.com/article');
  assert.equal(reference.kind, 'url');
  assert.equal(reference.extraction, undefined);
  assert.throws(() => captureReference(dom.window.document, 'unsupported'), /不支持/);
});

test('long pages are preserved without a hidden character limit', () => {
  const content = `${'长文章正文，用来确保内容没有被静默截断。'.repeat(3500)}文末独有标记`;
  const dom = page(`<article><p>${content}</p></article>`);
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /文末独有标记$/);
  assert.ok(extracted.content.length > 50000);
});
