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

test('loaded folded explanations and main-region notes survive article recognition', () => {
  const dom = page('<nav>站点导航</nav><main><h1>使用说明</h1><p>只适用于版本 2，其他版本不支持。</p><details><summary>例外情况</summary><p>离线模式下需要先下载配置。</p></details><aside role="note">提示：配置文件不能为空。</aside><footer>注释：测试环境使用独立目录。</footer></main><aside>无关推荐</aside>');
  const before = dom.window.document.documentElement.outerHTML;
  const extracted = extractPage(dom.window.document);
  for (const fact of ['只适用于版本 2', '先下载配置', '配置文件不能为空', '使用独立目录']) assert.ok(extracted.content.includes(fact), fact);
  assert.match(extracted.content, /折叠内容/);
  assert.ok(extracted.extraction.warnings.some(warning => warning.includes('折叠')));
  assert.doesNotMatch(extracted.content, /站点导航|无关推荐/);
  assert.equal(dom.window.document.documentElement.outerHTML, before);
});

test('complex tables retain links, inline code and row and column relationships', () => {
  const dom = page('<main><table><tr><th>模式</th><th>限制（MB）</th><th>文档</th></tr><tr><td rowspan="2">离线</td><td>10</td><td><a href="/offline">使用指南</a></td></tr><tr><td colspan="2"><code>limit = 20</code>，仅限测试</td></tr></table></main>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /限制（MB）/);
  assert.match(extracted.content, /\[使用指南\]\(https:\/\/example.com\/offline\)/);
  assert.match(extracted.content, /`limit = 20`/);
  assert.match(extracted.content, /跨 2 行/);
  assert.match(extracted.content, /跨 2 列/);
  assert.match(extracted.content, /沿用第 2 行第 1 列/);
});

test('highlighted code and code inside tables keep indentation and safe fences', () => {
  const code = 'if (ready) {\n  console.log(`value`);\n}\n```embedded fence```';
  const dom = page(`<main><pre data-language="js"><span>${code}</span></pre><table><tr><td>示例</td><td><pre><code class="language-python">if ready:\n    run()</code></pre></td></tr></table></main>`);
  const extracted = extractPage(dom.window.document);
  assert.ok(extracted.content.includes('````js\n' + code + '\n````'));
  assert.match(extracted.content, /```python\nif ready:\n    run\(\)\n```/);
});

test('page metadata comes from article JSON-LD without including script text', () => {
  const dom = page('<main><p>文章正文，包含需要分析的原始资料。</p></main><script>PRIVATE_SCRIPT_TEXT</script>');
  const data = dom.window.document.createElement('script');
  data.type = 'application/ld+json';
  data.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: '原始文章标题', author: { '@type': 'Person', name: '作者甲' }, datePublished: '2026-10-01T12:00:00+08:00' });
  dom.window.document.body.append(data);
  const before = dom.window.document.documentElement.outerHTML;
  const extracted = extractPage(dom.window.document);
  assert.equal(extracted.title, '原始文章标题');
  assert.equal(extracted.metadata.author, '作者甲');
  assert.equal(extracted.metadata.publishedAt, '2026-10-01T12:00:00+08:00');
  assert.doesNotMatch(extracted.content, /PRIVATE_SCRIPT_TEXT|schema\.org|datePublished/);
  assert.equal(dom.window.document.documentElement.outerHTML, before);
});

test('main-region recovery resolves links and includes omitted factual qualifications', () => {
  const dom = page('<main><p>正文内容，供用户阅读的公开信息。</p><details><summary>展开更多</summary><p>COLLAPSED_UNEXPANDED_TEXT <a href="/limits">完整限制条件</a></p></details></main>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /正文内容/);
  assert.match(extracted.content, /\[完整限制条件\]\(https:\/\/example.com\/limits\)/);
  assert.equal(extracted.extraction.method, 'main-region');
  assert.ok(extracted.extraction.warnings.some(warning => warning.includes('主区域')));
});

test('excluded subtrees do not trigger a style read for every descendant', () => {
  const dom = page('<main><p>正文。</p><section hidden>' + '<div><span>隐藏资料</span></div>'.repeat(200) + '</section></main>');
  const getStyle = dom.window.getComputedStyle.bind(dom.window);
  let reads = 0;
  dom.window.getComputedStyle = (...args) => { reads += 1; return getStyle(...args); };
  const extracted = extractPage(dom.window.document);
  assert.doesNotMatch(extracted.content, /隐藏资料/);
  assert.ok(reads < 20, `style reads: ${reads}`);
});

test('table captions and multiline cells survive and zero rowspans end at their row group', () => {
  const dom = page('<main><table><caption>容量限制，单位 MB</caption><tbody><tr><td rowspan="0">离线</td><td>10<br>仅限测试</td></tr><tr><td>20</td></tr></tbody><tbody><tr><td>在线</td><td>30</td></tr></tbody></table></main>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /容量限制，单位 MB/);
  assert.match(extracted.content, /跨 2 行/);
  assert.match(extracted.content, /10[^]*仅限测试/);
  assert.match(extracted.content, /第 2 行：[^]*沿用第 1 行第 1 列/);
  assert.match(extracted.content, /第 3 行：在线 \| 30/);
});

test('head metadata survives visibility cleanup even when JSON-LD is invalid', () => {
  const dom = page('<article><p>文章内容。</p></article><script type="application/ld+json">INVALID_JSON</script>');
  const { document } = dom.window;
  for (const [name, content] of [['author', '作者乙'], ['article:published_time', '2026-09-29']]) {
    const meta = document.createElement('meta');
    meta.setAttribute(name.includes(':') ? 'property' : 'name', name);
    meta.content = content;
    document.head.append(meta);
  }
  const extracted = extractPage(document);
  assert.equal(extracted.metadata.author, '作者乙');
  assert.equal(extracted.metadata.publishedAt, '2026-09-29');
  assert.doesNotMatch(extracted.content, /INVALID_JSON/);
});

test('headed tables tolerate HTML whitespace and escape literal pipes without losing captions', () => {
  const dom = page('<main><table><caption>参数说明</caption><tr>\n<th>参数</th>\n<th>表达式</th>\n</tr><tr>\n<td>选项</td>\n<td><code>a | b</code></td>\n</tr></table></main>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /参数说明/);
  assert.match(extracted.content, /\| 参数 \| 表达式 \|\n\| --- \| --- \|/);
  assert.ok(extracted.content.includes('`a \\| b`'));
  assert.doesNotMatch(extracted.content, /<table|<th|<td/);
});

test('highlight wrappers preserve their language and safe fence length', () => {
  const dom = page('<main><div class="highlight-source-js">\n<pre><code>const text = "```";\n  run();</code></pre></div></main>');
  const extracted = extractPage(dom.window.document);
  assert.ok(extracted.content.includes('````js\nconst text = "```";\n  run();\n````'));
});

test('literal pipes in unheaded tables cannot be mistaken for extra columns', () => {
  const dom = page('<main><table><tr><td>a | b</td><td>10</td></tr></table></main>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /第 1 列：a \| b/);
  assert.match(extracted.content, /第 2 列：10/);
});
