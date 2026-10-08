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
  assert.equal(extracted.extraction.method, 'readability-supplemented');
  assert.ok(extracted.extraction.warnings.some(warning => warning.includes('补回')));
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

const articleProse = '正文事实：此功能适用于版本二，使用前需要加载配置。本文介绍功能原理、完整步骤和实际限制。'.repeat(24);

test('open shadow roots and nested slots preserve rendered facts once without modifying their hosts', () => {
  const dom = page(`<main><p>${articleProse}</p><code-example><span slot="note">SLOTTEDFACT</span><span>UNSLOTTEDNOISE</span></code-example></main>`);
  const { document } = dom.window;
  const host = document.querySelector('code-example');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>pre { color:red }</style><pre><code class="language-js">const SHADOWFACT = 1;\n  run();</code></pre><slot name="note"></slot><slot name="empty"><p>FALLBACKFACT</p></slot><nested-example></nested-example><button>COPYNOISE</button>';
  shadow.querySelector('nested-example').attachShadow({ mode: 'open' }).innerHTML = '<p>NESTEDFACT <a href="/limits">限制说明</a></p>';
  const before = document.documentElement.outerHTML;
  const shadowBefore = shadow.innerHTML;
  const extracted = extractPage(document);
  for (const fact of ['SHADOWFACT', 'SLOTTEDFACT', 'FALLBACKFACT', 'NESTEDFACT']) {
    assert.equal(extracted.content.split(fact).length - 1, 1, fact);
  }
  assert.match(extracted.content, /```js\nconst SHADOWFACT = 1;\n  run\(\);\n```/);
  assert.match(extracted.content, /https:\/\/example.com\/limits/);
  assert.doesNotMatch(extracted.content, /UNSLOTTEDNOISE|COPYNOISE|color:red/);
  assert.equal(document.documentElement.outerHTML, before);
  assert.equal(shadow.innerHTML, shadowBefore);
});

test('hidden and editable shadow hosts are skipped together with their descendants', () => {
  const dom = page('<main><p>VISIBLEFACT</p><code-example hidden></code-example><code-example contenteditable="true"></code-example><code-example></code-example></main>');
  const hosts = [...dom.window.document.querySelectorAll('code-example')];
  hosts[0].attachShadow({ mode: 'open' }).innerHTML = '<p>HIDDENSECRET</p>';
  hosts[1].attachShadow({ mode: 'open' }).innerHTML = '<p>DRAFTSECRET</p>';
  hosts[2].attachShadow({ mode: 'open' }).innerHTML = '<div hidden>INNERSECRET</div><aside role="note">SHADOWNOTE</aside><pre><code>VISIBLECODE</code></pre>';
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /VISIBLEFACT/);
  assert.match(extracted.content, /SHADOWNOTE/);
  assert.match(extracted.content, /VISIBLECODE/);
  assert.doesNotMatch(extracted.content, /HIDDENSECRET|DRAFTSECRET|INNERSECRET/);
});

test('an empty open shadow root does not expose unrendered light DOM', () => {
  const dom = page('<main><p>VISIBLEFACT</p><code-example>UNRENDEREDSECRET</code-example></main>');
  dom.window.document.querySelector('code-example').attachShadow({ mode: 'open' });
  assert.doesNotMatch(extractPage(dom.window.document).content, /UNRENDEREDSECRET/);
});

test('visual code lines retain the final line, blank lines and indentation without line numbers', () => {
  const dom = page(`<main><p>${articleProse}</p><pre><code class="language-js">
    <span class="doc-code-line"><span class="doc-line-number">1</span><span class="doc-code-source">import Defuddle from 'defuddle';</span></span>
    <span class="doc-code-line"><span class="doc-line-number">2</span><span class="doc-code-source"></span></span>
    <span class="doc-code-line"><span class="doc-line-number">3</span><span class="doc-code-source">  console.log(result.title); // title</span></span>
    <span class="doc-code-line"><span class="doc-line-number">4</span><span class="doc-code-source">  console.log(result.author);</span></span>
  </code></pre><p>Inline: <code>result.author</code>.</p></main>`);
  const extracted = extractPage(dom.window.document);
  assert.ok(extracted.content.includes("```js\nimport Defuddle from 'defuddle';\n\n  console.log(result.title); // title\n  console.log(result.author);\n```"));
  assert.match(extracted.content, /Inline: `result.author`\./);
  assert.equal((extracted.content.match(/^```/gm) || []).length, 2);
});

test('code line wrappers and BR separators do not double newlines or discard numeric code', () => {
  const dom = page('<main><pre data-language="text"><span class="line">123</span><br><span class="line">  456</span><br><span class="line"></span><br><span class="line">789</span></pre><pre>A<br>B</pre></main>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /```text\n123\n  456\n\n789\n```/);
  assert.match(extracted.content, /```\nA\nB\n```/);
});

test('recommendation prose and nested factual notes survive broad noise names', () => {
  const dom = page(`<main><p>${articleProse}</p><section id="recommendations"><h2>部署建议</h2><p>IMPORTANTLIMIT 迁移前必须备份。</p></section><div class="related"><aside role="note">IMPORTANTNOTE 版本限制。</aside></div><section class="recommended"><a href="/other">RELATEDNOISE 推荐文章</a></section></main>`);
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /IMPORTANTLIMIT/);
  assert.match(extracted.content, /IMPORTANTNOTE/);
  assert.doesNotMatch(extracted.content, /RELATEDNOISE/);
});

test('content recovery remains inside a trusted region on pages without main or article tags', () => {
  const dom = page(`<div class="ascii-doc"><h1>部署指南</h1><p>${articleProse}</p><details><summary>例外</summary><p>IMPORTANTLIMIT</p></details></div><div class="promotion"><p>PROMOTIONNOISE</p></div><div class="sidebar"><p>SIDEBARNOISE</p></div>`);
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /IMPORTANTLIMIT/);
  assert.doesNotMatch(extracted.content, /PROMOTIONNOISE|SIDEBARNOISE/);
});

test('unclassified body nodes are not reinserted after Readability chooses the article', () => {
  const dom = page(`<div><h1>部署指南</h1><p>PRIMARYFACT ${articleProse}</p><p>${articleProse}</p></div><div><h2>站点工具</h2><p>UNRELATEDTOOLS 登录 打印 收藏</p></div>`);
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /PRIMARYFACT/);
  assert.doesNotMatch(extracted.content, /UNRELATEDTOOLS/);
});

test('article interface sections are removed while factual footnotes remain', () => {
  const dom = page(`<main><p>${articleProse}</p><section class="translation-banner"><p>LANGUAGENOISE</p></section><section class="article-footer"><p>EDITNOISE</p></section><p class="edit-link"><a href="/edit">GITHUBNOISE</a></p><footer class="site-footer">LICENSENOISE</footer><footer><p>FACTUALFOOTNOTE</p></footer></main>`);
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /FACTUALFOOTNOTE/);
  assert.doesNotMatch(extracted.content, /LANGUAGENOISE|EDITNOISE|GITHUBNOISE|LICENSENOISE/);
});

test('a named article body within a layout main excludes adjacent promotions without losing its intro', () => {
  const dom = page(`<div role="main"><a href="/guides">GUIDESNOISE</a><div class="ascii-doc"><h1>测试网页</h1><p>INTROFACT ${articleProse}</p><p>TAILFACT</p><pre><code data-lang="json">{"answer":42}</code></pre></div><div><p>PROMOTIONNOISE Try another service.</p></div></div>`);
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /INTROFACT/);
  assert.match(extracted.content, /TAILFACT/);
  assert.match(extracted.content, /```json\n\{"answer":42\}/);
  assert.doesNotMatch(extracted.content, /GUIDESNOISE|PROMOTIONNOISE/);
});

test('a separate introductory header is retained when the named body does not own its title', () => {
  const dom = page(`<main><article><header><h1>测试网页</h1><p>INTROFACT</p></header><div class="markdown-doc"><h2>API</h2><p>${articleProse}</p><p>TAILFACT</p></div></article></main>`);
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /INTROFACT/);
  assert.match(extracted.content, /TAILFACT/);
});

test('MDN brush language and explicit code language attributes survive conversion', () => {
  const dom = page('<main><pre class="brush: js notranslate"><code>const answer = 42;</code></pre><pre><code data-language="python">answer = 42</code></pre><pre data-lang="text injected">plain</pre></main>');
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /```js\nconst answer = 42;/);
  assert.match(extracted.content, /```python\nanswer = 42/);
  assert.match(extracted.content, /```\nplain\n```/);
  assert.doesNotMatch(extracted.content, /```text injected/);
});

test('main-region recovery excludes recommendation and comment containers while keeping factual notes', () => {
  const dom = page(`<main><article><p>${articleProse}</p></article><aside class="related"><h2>猜你喜欢</h2><p>RECOMMENDATIONNOISE</p></aside><section id="comments"><h2>评论</h2><p>COMMENTNOISE</p></section><aside role="note" class="related"><p>IMPORTANTNOTE 配置不能为空。</p></aside><footer>FACTUALFOOTNOTE 仅用于测试环境。</footer></main>`);
  const extracted = extractPage(dom.window.document);
  assert.doesNotMatch(extracted.content, /RECOMMENDATIONNOISE|COMMENTNOISE/);
  assert.match(extracted.content, /IMPORTANTNOTE/);
  assert.match(extracted.content, /FACTUALFOOTNOTE/);
});

test('an explicit main region wins over a longer unrelated article elsewhere on the page', () => {
  const dom = page(`<main><p>${articleProse}</p><p>PRIMARYFACT</p></main><article><p>${'推荐卡片摘要。'.repeat(500)}</p><p>UNRELATEDCARD</p></article>`);
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /PRIMARYFACT/);
  assert.doesNotMatch(extracted.content, /UNRELATEDCARD/);
});

test('article selection considers the page title and link density instead of just text length', () => {
  const dom = page(`<article><h1>测试网页</h1><p>${articleProse}</p><p>PRIMARYFACT</p></article><article><h2>其它文章</h2>${'<p><a href="/other">UNRELATEDCARD 推荐阅读</a></p>'.repeat(200)}</article>`);
  const extracted = extractPage(dom.window.document);
  assert.match(extracted.content, /PRIMARYFACT/);
  assert.doesNotMatch(extracted.content, /UNRELATEDCARD/);
});

test('omitted explanations are supplemented in source order without duplicating retained paragraphs', () => {
  const dom = page(`<main><article><p>FIRSTFACT ${articleProse}</p><details class="comment"><summary>限制说明</summary><p>IMPORTANTLIMIT 必须先下载配置。</p></details><p>LASTFACT ${articleProse}</p></article><div class="share-buttons">SHARENOISE</div></main>`);
  const before = dom.window.document.documentElement.outerHTML;
  const extracted = extractPage(dom.window.document);
  assert.equal(extracted.extraction.method, 'readability-supplemented');
  assert.match(extracted.content, /折叠内容/);
  assert.equal(extracted.content.match(/FIRSTFACT/g)?.length, 1);
  assert.equal(extracted.content.match(/IMPORTANTLIMIT/g)?.length, 1);
  assert.equal(extracted.content.match(/LASTFACT/g)?.length, 1);
  assert.ok(extracted.content.indexOf('FIRSTFACT') < extracted.content.indexOf('IMPORTANTLIMIT'));
  assert.ok(extracted.content.indexOf('IMPORTANTLIMIT') < extracted.content.indexOf('LASTFACT'));
  assert.doesNotMatch(extracted.content, /SHARENOISE/);
  assert.equal(dom.window.document.documentElement.outerHTML, before);
});

test('noise words in code, folded explanations and block quotes do not remove factual content', () => {
  const dom = page(`<main><p>${articleProse}</p><details class="comments"><summary>例外情况</summary><div class="related">FOLDEDFACT</div></details><blockquote><div class="comments">QUOTEDFACT</div></blockquote><pre><code class="language-js">// comments\nconst related = true;</code></pre><p class="commentary">PARAGRAPHFACT</p></main>`);
  const extracted = extractPage(dom.window.document);
  for (const fact of ['FOLDEDFACT', 'QUOTEDFACT', 'const related = true;', 'PARAGRAPHFACT']) assert.ok(extracted.content.includes(fact), fact);
});

test('short genuine body content is still accepted', () => {
  const extracted = extractPage(page('<main><p>公开参数：启用。</p></main>').window.document);
  assert.match(extracted.content, /公开参数：启用/);
});

for (const placeholder of ['正在加载文章，请稍候…', '正在加载…', 'Loading content...', 'Please wait']) {
  test(`loading-only body is rejected: ${placeholder}`, () => {
    const dom = page(`<main><div>${placeholder}</div></main>`);
    assert.throws(() => extractPage(dom.window.document), /正在加载|未就绪/);
  });
}

test('an explicitly busy primary region is rejected until its content is ready', () => {
  const dom = page(`<main aria-busy="true"><p>${articleProse}</p></main>`);
  assert.throws(() => captureReference(dom.window.document, 'page'), /正在加载|未就绪/);
  dom.window.document.querySelector('main').setAttribute('aria-busy', 'false');
  dom.window.document.querySelector('main').insertAdjacentHTML('beforeend', '<p>READYFACT</p>');
  assert.match(captureReference(dom.window.document, 'page').content, /READYFACT/);
});

test('a busy control outside the selected body does not prevent extraction', () => {
  const dom = page(`<main><p>${articleProse}</p><p>READYFACT</p></main><aside aria-busy="true">正在加载推荐</aside>`);
  assert.match(extractPage(dom.window.document).content, /READYFACT/);
});

test('loading phrases within code or a genuine explanation remain readable', () => {
  for (const html of ['<main><pre><code>Loading content...</code></pre></main>', '<main><p>程序显示“正在加载”时，可以等待或重试。</p></main>']) {
    assert.ok(extractPage(page(html).window.document).content);
  }
});

test('an article heading cannot make a loading placeholder look like a ready body', () => {
  assert.throws(() => extractPage(page('<main><h1>测试网页</h1><div>正在加载文章，请稍候…</div></main>').window.document), /正在加载|未就绪/);
});

test('busy article content and an empty busy main cannot be replaced by unrelated content', () => {
  for (const html of [
    `<main><h1>测试网页</h1><article aria-busy="true"><p>${articleProse}</p></article></main>`,
    `<main aria-busy="true"></main><article><p>${articleProse}</p></article>`,
    `<main><p>${articleProse}</p></main>`,
  ]) {
    const dom = page(html);
    if (html.includes('aria-busy')) assert.throws(() => extractPage(dom.window.document), /正在加载|未就绪/);
    else {
      dom.window.document.body.setAttribute('aria-busy', 'true');
      assert.throws(() => extractPage(dom.window.document), /正在加载|未就绪/);
    }
  }
});

test('many omitted callouts fall back to a filtered scope without losing facts or reintroducing noise', () => {
  const callouts = Array.from({ length: 40 }, (_, index) => `<details class="comment"><summary>限制 ${index}</summary><p>FACT${index}END</p></details>`).join('');
  const extracted = extractPage(page(`<main><p>${articleProse}</p>${callouts}<section class="comments">COMMENTNOISE</section></main>`).window.document);
  for (let index = 0; index < 40; index++) assert.equal(extracted.content.split(`FACT${index}END`).length - 1, 1);
  assert.doesNotMatch(extracted.content, /COMMENTNOISE/);
  assert.equal(extracted.extraction.method, 'main-region');
});

test('partially retained quotes, lists and tables recover without duplicating their retained entries', () => {
  for (const structure of [
    '<blockquote><p>STRUCTUREFIRST</p><div class="comment"><p>STRUCTURESECOND</p></div></blockquote>',
    '<ul><li>STRUCTUREFIRST</li><li class="comment">STRUCTURESECOND</li></ul>',
    '<table><tr><th>名称</th></tr><tr><td>STRUCTUREFIRST</td></tr><tr class="comment"><td>STRUCTURESECOND</td></tr></table>',
  ]) {
    const extracted = extractPage(page(`<main><p>${articleProse}</p>${structure}<p>TAILFACT ${articleProse}</p></main>`).window.document);
    for (const marker of ['STRUCTUREFIRST', 'STRUCTURESECOND', 'TAILFACT']) assert.equal(extracted.content.split(marker).length - 1, 1);
    assert.ok(extracted.content.indexOf('STRUCTUREFIRST') < extracted.content.indexOf('STRUCTURESECOND'));
    assert.ok(extracted.content.indexOf('STRUCTURESECOND') < extracted.content.indexOf('TAILFACT'));
  }
});

test('explicit selections can still quote comment containers with their paragraph context', () => {
  const dom = page('<main><p>公开前文</p><section class="comments"><p>用户明确选择的评论文字</p></section></main>');
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.querySelector('main'));
  dom.window.getSelection().addRange(range);
  const reference = captureSelection(dom.window.document);
  assert.match(reference.content, /用户明确选择的评论文字/);
  assert.match(reference.context, /用户明确选择的评论文字/);
});
