import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const EXCLUDED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON',
  'IFRAME', 'OBJECT', 'EMBED', 'CANVAS',
]);
const BLOCK_SELECTOR = 'p,li,blockquote,pre,td,th,h1,h2,h3,h4,h5,h6,div,section,article,main';
const MAIN_SELECTOR = 'main,[role="main"],article';
const CONTENT_SELECTOR = '#content,#main-content,.entry-content,.post-content,.article-content,.article-body,.markdown-body,.markdown-doc,.ascii-doc,.vt-doc,.body';
const EVIDENCE_SELECTOR = 'p,li,ul,ol,h1,h2,h3,h4,h5,h6,pre,table,details,aside,footer,blockquote,figure,[role="note"]';
const SOURCE_ATTRIBUTE = 'data-sider-source-block';
const FACTUAL_SELECTOR = 'details,pre,table,blockquote,[role="note"]';
const NOISE_CONTAINERS = new Set(['DIV', 'SECTION', 'ASIDE', 'FOOTER', 'UL', 'OL', 'ARTICLE']);
const NOISE_NAME = /(?:^|[\s_-])(?:comments?|share|sharing|social|advertisement|advertising|ads?|cookie-banner|cookie-consent|breadcrumbs?|pagination|sidebar)(?:$|[\s_-])/i;
const AMBIGUOUS_NOISE_NAME = /(?:^|[\s_-])(?:related|recommendations?|recommended)(?:$|[\s_-])/i;
const UI_SELECTOR = '[role="navigation"],[role="banner"],[role="contentinfo"],.translation-banner,.article-footer,.site-footer,.edit-link';
const CODE_LINE_SELECTOR = '.line,.code-line,.doc-code-line,.ec-line,[data-line],[data-line-number]';
const CODE_GUTTER_SELECTOR = '.line-number,.line-numbers,.doc-line-number,.lineno,.lnt,.rouge-gutter,.react-syntax-highlighter-line-number';
const LOADING_TEXT = /^(?:正在加载(?:文章|正文|内容|页面|数据)?(?:中)?|加载中|请稍候|请稍等|loading(?:\s+(?:article|content|page|data))?|please\s+wait)(?:[，,\s]*(?:请稍候|请稍等|please\s+wait))?[\s.。…!！]*$/i;
const LOADED_WARNING = '仅包含采集时已加载的网页正文；未加载的内容、其他框架及图片中的文字可能未包含。';

export function isSupportedDocument(document) {
  return /^https?:$/.test(document.location?.protocol || '');
}

function elementFor(node) {
  return node?.nodeType === 1 ? node : node?.parentElement || node?.getRootNode?.().host;
}

function composedParent(element) {
  return element.parentElement || element.getRootNode?.().host || null;
}

function composedClosest(element, selector) {
  while (element) {
    const match = element.closest(selector);
    if (match) return match;
    element = element.getRootNode?.().host;
  }
  return null;
}

export function isEditable(node) {
  let element = elementFor(node);
  while (element) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return true;
    const editable = element.getAttribute('contenteditable');
    if (editable !== null) return editable.toLowerCase() !== 'false';
    element = composedParent(element);
  }
  return false;
}

function isHidden(element) {
  if (!element) return false;
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return true;
  const window = element.ownerDocument.defaultView;
  if (!window) return false;
  const style = window.getComputedStyle(element);
  return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
}

function isExcluded(element) {
  return EXCLUDED_TAGS.has(element.tagName) || element.hasAttribute('data-sider-ui') || isEditable(element) || isHidden(element);
}

function isReadableTextNode(node) {
  if (!node.nodeValue?.trim()) return false;
  let ancestor = node.parentElement;
  while (ancestor) {
    if (isExcluded(ancestor)) return false;
    ancestor = composedParent(ancestor);
  }
  return true;
}

function hasExcludedAncestor(node) {
  let element = elementFor(node);
  while (element) {
    if (isExcluded(element)) return true;
    element = composedParent(element);
  }
  return false;
}

function normaliseInline(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanAttributes(source, target) {
  for (const attribute of [...target.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on') || name === 'srcdoc') target.removeAttribute(attribute.name);
    if (['href', 'src', 'action', 'formaction'].includes(name)) {
      try {
        const url = new URL(attribute.value.trim(), source.ownerDocument.baseURI);
        if (/^(?:javascript|vbscript|data):$/i.test(url.protocol)) target.removeAttribute(attribute.name);
        else target.setAttribute(attribute.name, url.href);
      } catch { target.removeAttribute(attribute.name); }
    }
  }
}

function isPeripheral(element) {
  if (element.tagName === 'NAV' || element.matches(UI_SELECTOR)) return true;
  if (!NOISE_CONTAINERS.has(element.tagName)) return false;
  const peripheral = element.tagName === 'ASIDE' || element.tagName === 'FOOTER';
  const name = `${element.id} ${element.className}`;
  const namedNoise = NOISE_NAME.test(name);
  const ambiguousNoise = AMBIGUOUS_NOISE_NAME.test(name);
  if (!peripheral && !namedNoise && !ambiguousNoise) return false;
  // Factual callouts and examples can legitimately use words such as "related"
  // or "comments". Do not classify them by a class-name substring alone.
  if (composedClosest(element, FACTUAL_SELECTOR) || element.querySelector(FACTUAL_SELECTOR)) return false;
  if (peripheral && !composedClosest(element, MAIN_SELECTOR)) return true;
  if (!namedNoise) {
    if (!ambiguousNoise) return false;
    // "Recommendations" may be a real prose chapter. Only treat these broad
    // names as noise when they identify an aside or a list dominated by links.
    const length = normaliseInline(element.textContent).length;
    const links = [...element.querySelectorAll('a')].reduce((sum, link) => sum + normaliseInline(link.textContent).length, 0);
    if (!peripheral && links <= length * 0.5) return false;
  }
  // A standalone article may itself be about comments or sharing. Only prune
  // article containers when they are auxiliary sections within a main scope.
  return element.tagName !== 'ARTICLE' || Boolean(composedClosest(composedParent(element), MAIN_SELECTOR));
}

function cleanClone(original, clone) {
  const clean = (source, target) => {
    cleanAttributes(source, target);
    let sourceChild = source.firstElementChild;
    let targetChild = target.firstElementChild;
    while (sourceChild && targetChild) {
      const nextSource = sourceChild.nextElementSibling;
      const nextTarget = targetChild.nextElementSibling;
      const navigation = sourceChild.matches('nav,[role="navigation"]');
      const peripheral = sourceChild.matches('aside,footer') && !sourceChild.closest(MAIN_SELECTOR) && sourceChild.getAttribute('role') !== 'note';
      if (navigation || peripheral || isExcluded(sourceChild)) targetChild.remove();
      else clean(sourceChild, targetChild);
      sourceChild = nextSource;
      targetChild = nextTarget;
    }
  };
  clean(original, clone);
  return clone;
}

function filteredBody(source, document) {
  if (!source || isExcluded(source)) return null;
  const root = document.importNode(source, false);
  cleanAttributes(source, root);
  const pending = [[source, root]];
  while (pending.length) {
    const [original, clone] = pending.pop();
    // Compose open shadow roots in the detached copy. Neutral elements cannot
    // attach their own shadow roots; slot assignments are copied exactly once.
    const assigned = original.tagName === 'SLOT' ? original.assignedNodes?.({ flatten: true }) : null;
    const children = assigned?.length ? assigned : (original.shadowRoot || original).childNodes;
    for (const child of children) {
      if (child.nodeType === 3) {
        clone.append(document.createTextNode(child.nodeValue));
      } else if (child.nodeType === 1) {
        // Excluded ancestors are never traversed, so editable state only needs
        // checking on this element rather than walking its ancestors again.
        const editable = child.getAttribute('contenteditable');
        if (EXCLUDED_TAGS.has(child.tagName) || (editable !== null && editable.toLowerCase() !== 'false') || isPeripheral(child) || isHidden(child)) continue;
        const target = child.shadowRoot || child.tagName === 'SLOT'
          ? document.createElement(child.tagName === 'SLOT' ? 'span' : 'div')
          : document.importNode(child, false);
        if (child.shadowRoot || child.tagName === 'SLOT') {
          for (const attribute of child.attributes) target.setAttribute(attribute.name, attribute.value);
        }
        cleanAttributes(child, target);
        clone.append(target);
        pending.push([child, target]);
      }
    }
  }
  return root;
}

function sanitizedDocument(document) {
  // Copy only accepted body nodes. Hidden/editor/script subtrees are not first
  // allocated in a full-document clone just to be discarded afterwards.
  const clone = document.cloneNode(false);
  const html = clone.importNode(document.documentElement, false);
  cleanAttributes(document.documentElement, html);
  clone.append(html);
  // Head elements are visually hidden, but their metadata describes the source.
  const head = clone.createElement('head');
  const title = clone.createElement('title');
  title.textContent = document.title;
  head.append(title);
  for (const source of document.querySelectorAll('meta[name],meta[property]')) {
    const meta = clone.createElement('meta');
    for (const attribute of ['name', 'property', 'content']) {
      if (source.hasAttribute(attribute)) meta.setAttribute(attribute, source.getAttribute(attribute));
    }
    head.append(meta);
  }
  html.append(head);
  const body = filteredBody(document.body, clone);
  if (body) html.append(body);
  // Keep inert metadata in the detached head for Readability's JSON-LD parser.
  // It is never included in the fallback body or executed in the live document.
  for (const source of document.querySelectorAll('script[type="application/ld+json"]')) {
    const data = clone.createElement('script');
    data.type = 'application/ld+json';
    data.textContent = source.textContent;
    head.append(data);
  }
  return clone;
}

function tableNeedsTextFallback(table) {
  return Boolean(table.querySelector('[rowspan]:not([rowspan="1"]),[colspan]:not([colspan="1"])'))
    || !table.rows[0]?.cells.length || ![...table.rows[0].cells].every(cell => cell.tagName === 'TH')
    || Boolean(table.querySelector('pre,table,br,ul,ol,blockquote,td p+p,th p+p'));
}

function tableMarkdown(table, converter) {
  const rows = [...table.rows].filter(row => row.closest('table') === table);
  const caption = [...table.children].find(node => node.tagName === 'CAPTION');
  const title = caption ? converter.turndown(caption).trim() : '';
  const converted = new Map();
  const cellText = cell => {
    if (!converted.has(cell)) converted.set(cell, converter.turndown(cell).trim());
    return converted.get(cell);
  };
  if (!tableNeedsTextFallback(table) && rows.every(row => [...row.cells].every(cell => !cellText(cell).includes('\n')))) {
    const lines = rows.map(row => `| ${[...row.cells].map(cell => cellText(cell).replace(/\\?\|/g, '\\|')).join(' | ')} |`);
    lines.splice(1, 0, `| ${[...rows[0].cells].map(() => '---').join(' | ')} |`);
    return `\n\n${title ? `${title}\n\n` : ''}${lines.join('\n')}\n\n`;
  }
  const spans = new Map();
  const content = rows.map((row, index) => {
    const inherited = new Map(spans);
    for (const [column, span] of spans) {
      if (--span.remaining === 0) spans.delete(column);
    }
    const cells = [];
    let column = 1;
    for (const cell of row.cells) {
      while (inherited.has(column)) column += 1;
      const width = cell.colSpan || 1;
      const remaining = row.parentElement.rows.length - row.sectionRowIndex;
      const height = cell.rowSpan === 0 ? remaining : Math.min(cell.rowSpan || 1, remaining);
      const label = `第 ${index + 1} 行第 ${column} 列`;
      const merged = [height > 1 && `跨 ${height} 行`, width > 1 && `跨 ${width} 列`].filter(Boolean);
      cells.push({ column, merged, content: cellText(cell) });
      if (height > 1) for (let offset = 0; offset < width; offset += 1) spans.set(column + offset, { label, remaining: height - 1 });
      column += width;
    }
    if (!inherited.size && cells.every(cell => !cell.merged.length && !/[\n|]/.test(cell.content))) {
      return `第 ${index + 1} 行：${cells.map(cell => cell.content).join(' | ')}`;
    }
    const entries = [
      ...[...inherited].map(([column, span]) => ({ column, text: `第 ${column} 列：沿用${span.label}` })),
      ...cells.map(cell => ({ column: cell.column, text: `第 ${cell.column} 列${cell.merged.length ? `（${cell.merged.join('，')}）` : ''}：${cell.content.includes('\n') ? '\n\n' : ''}${cell.content}` })),
    ].sort((left, right) => left.column - right.column);
    return `第 ${index + 1} 行：\n${entries.map(entry => entry.text).join('\n\n')}`;
  });
  return `\n\n[表格，按行保留]\n${title ? `${title}\n\n` : ''}${content.join('\n\n')}\n\n`;
}

function createMarkdownConverter() {
  const converter = new TurndownService({
    headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true,
  });
  converter.use(gfm);
  converter.addRule('loaded-details', {
    filter: 'details',
    replacement: (content, node) => `\n\n${node.hasAttribute('open') ? '' : '[折叠内容，已加载]\n\n'}${content.trim()}\n\n`,
  });
  converter.addRule('details-summary', {
    filter: 'summary', replacement: content => `\n\n${content.trim()}\n\n`,
  });
  converter.addRule('preformatted-block', {
    filter: node => node.nodeName === 'PRE' || (node.nodeName === 'DIV' && /highlight-(?:text|source)-[\w+.-]+/.test(node.className) && node.firstElementChild?.nodeName === 'PRE'),
    replacement: (_content, node) => {
      const pre = node.nodeName === 'PRE' ? node : node.firstElementChild;
      const code = codeText(pre).replace(/\r\n?/g, '\n');
      const element = pre.querySelector('code') || pre;
      const classes = `${element.className} ${pre.className} ${node.className}`;
      const language = (classes.match(/(?:language-|lang-|highlight-(?:text|source)-|brush:\s*)([\w+.-]+)/) || [])[1]
        || [element.getAttribute('data-language'), element.getAttribute('data-lang'), pre.getAttribute('data-language'), pre.getAttribute('data-lang')]
          .find(value => /^[\w+.-]+$/.test(value || '')) || '';
      let longest = 0;
      for (const [run] of code.matchAll(/`+/g)) longest = Math.max(longest, run.length);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `\n\n${fence}${language}\n${code}${code.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    },
  });
  converter.addRule('structured-table', {
    filter: 'table',
    replacement: (_content, node) => tableMarkdown(node, converter),
  });
  return converter;
}

function codeText(root) {
  // Syntax highlighters often express visual lines as spans with no text-node
  // newline. Preserve their last line, blank lines and indentation as well.
  const visit = node => {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 || node.matches(CODE_GUTTER_SELECTOR)) return '';
    if (node.tagName === 'BR') return '\n';
    const children = [...node.childNodes];
    const hasLines = children.some(child => child.nodeType === 1 && child.matches(CODE_LINE_SELECTOR));
    let text = '';
    let previousLine = false;
    for (const child of children) {
      if (hasLines && child.nodeType === 3 && !child.nodeValue.trim()) continue;
      if (previousLine && child.nodeName === 'BR') { previousLine = false; continue; }
      text += visit(child);
      previousLine = child.nodeType === 1 && child.matches(CODE_LINE_SELECTOR);
    }
    return node.matches(CODE_LINE_SELECTOR) && !text.endsWith('\n') ? `${text}\n` : text;
  };
  return visit(root);
}

function readableText(root) {
  const blockTags = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'LI', 'PRE', 'BLOCKQUOTE', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const visit = node => {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    if (node.tagName === 'BR') return '\n';
    const text = [...node.childNodes].map(visit).join('');
    return blockTags.has(node.tagName) ? `\n${text}\n` : text;
  };
  return visit(root).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function mainRegion(document) {
  let candidates = [...document.querySelectorAll(MAIN_SELECTOR)].filter(region => !region.parentElement?.closest(MAIN_SELECTOR));
  if (!candidates.length) {
    candidates = [...document.querySelectorAll(CONTENT_SELECTOR)].filter(region =>
      region.querySelectorAll('p,pre,table,details,dl').length >= 2);
  }
  if (candidates.length === 1) {
    const region = candidates[0];
    return region.textContent.trim() || region.matches('[aria-busy="true"]') ? contentRegion(region) : null;
  }
  let best = null;
  let bestScore = -Infinity;
  const title = normaliseInline(document.title).toLowerCase();
  for (const region of candidates) {
    const text = region.textContent.trim();
    if (!text && !region.matches('[aria-busy="true"]')) continue;
    const heading = normaliseInline(region.querySelector('h1')?.textContent).toLowerCase();
    const titleMatch = heading.length >= 4 && title.length >= 4 && (title.includes(heading) || heading.includes(title));
    const linkLength = [...region.querySelectorAll('a')].reduce((sum, link) => sum + normaliseInline(link.textContent).length, 0);
    const linkDensity = Math.min(1, linkLength / Math.max(1, text.length));
    const structured = Math.min(20, region.querySelectorAll('p,pre,table,details').length);
    const score = (region.matches('main,[role="main"]') ? 100 : 0) + (heading ? 20 : 0)
      + (titleMatch ? 80 : 0) + Math.min(60, Math.log2(text.length + 1) * 4)
      + structured * 2 - linkDensity * 100;
    if (score > bestScore) { best = region; bestScore = score; }
  }
  return best ? contentRegion(best) : null;
}

function contentRegion(region) {
  // A layout's main can also contain promotions and tool panels. A named inner
  // article body is a stronger recovery boundary when it owns the same title
  // and most of the content. Requiring that title preserves separate intros.
  const heading = region.querySelector('h1');
  if (!heading) return region;
  const length = normaliseInline(region.textContent).length;
  const bodies = [...region.querySelectorAll(CONTENT_SELECTOR)].filter(body =>
    body.contains(heading) && body.querySelectorAll('p,pre,table,details,dl').length >= 2
    && normaliseInline(body.textContent).length >= length * 0.65);
  return bodies.sort((left, right) => left.textContent.length - right.textContent.length)[0] || region;
}

function assertContentReady(region) {
  const busy = region.closest('[aria-busy="true"]') || region.querySelector('main[aria-busy="true"],[role="main"][aria-busy="true"],article[aria-busy="true"]');
  if (busy) throw new Error('来源网页正文正在加载，尚未就绪，请等待完成后重试正文。');
  const rawText = region.textContent;
  if (rawText.length > 200 || region.querySelector('pre,table,blockquote,details')) return;
  const text = normaliseInline(rawText);
  const blocks = recoveryBlocks(region).filter(node => node.tagName !== 'H1');
  if (LOADING_TEXT.test(text) || (blocks.length && blocks.every(node => LOADING_TEXT.test(normaliseInline(node.textContent))))) {
    throw new Error('来源网页正文正在加载，尚未就绪，请等待完成后重试正文。');
  }
}

function recoveryBlocks(root) {
  const blocks = [];
  const visit = node => {
    if (node.matches(EVIDENCE_SELECTOR) || !node.querySelector(EVIDENCE_SELECTOR)) {
      if (node.textContent.trim()) blocks.push(node);
    } else {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return blocks;
}

function supplementArticle(article, fallback) {
  const text = normaliseInline(article.textContent);
  const retained = new Set([...article.content.querySelectorAll(EVIDENCE_SELECTOR)].map(node => normaliseInline(node.textContent)));
  const missing = recoveryBlocks(fallback).filter(node => {
    // Readability normally removes the article's first H1; the title is already
    // retained separately in the reference, so it does not need duplicating.
    if (node.tagName === 'H1') return false;
    const original = normaliseInline(node.textContent);
    return !retained.has(original) && !text.includes(original);
  });
  if (!missing.length) return { region: article.content, supplemented: false };
  // Bound merge work when recognition lost most of the selected region. This
  // fallback has already excluded other regions and known peripheral sections.
  if (missing.length > 32 || text.length < normaliseInline(fallback.textContent).length * 0.5) {
    return { region: fallback, supplemented: false };
  }
  const outerBlock = node => {
    let parent = node.parentElement;
    while (parent && parent !== article.content) {
      if (parent.matches(EVIDENCE_SELECTOR)) node = parent;
      parent = parent.parentElement;
    }
    return node;
  };
  for (const block of missing) {
    const id = Number(block.getAttribute(SOURCE_ATTRIBUTE));
    const ids = new Set([block, ...block.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)].map(node => node.getAttribute(SOURCE_ATTRIBUTE)));
    const nodes = [...article.content.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)];
    const matches = new Set(nodes.filter(node => ids.has(node.getAttribute(SOURCE_ATTRIBUTE))));
    const topMatches = [...matches].filter(node => {
      let parent = node.parentElement;
      while (parent && parent !== article.content) {
        if (matches.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
    const restored = block.cloneNode(true);
    if (topMatches.length) {
      // Replace a partially retained table/details/list as one unit. Appending
      // its missing text would duplicate retained cells, summaries or items.
      topMatches[0].replaceWith(restored);
      for (const node of topMatches.slice(1)) node.remove();
    } else {
      const anchors = nodes.filter(node => node.matches(EVIDENCE_SELECTOR));
      const next = anchors.find(node => Number(node.getAttribute(SOURCE_ATTRIBUTE)) > id);
      const previous = anchors.findLast(node => Number(node.getAttribute(SOURCE_ATTRIBUTE)) < id);
      if (next) outerBlock(next).before(restored);
      else if (previous) outerBlock(previous).after(restored);
      else article.content.append(restored);
    }
  }
  return { region: article.content, supplemented: true };
}

export function extractPage(document) {
  const clone = sanitizedDocument(document);
  const main = mainRegion(clone);
  const source = main || clone.body;
  if (!source) throw new Error('当前页面没有可提取的正文。');
  assertContentReady(source);
  // Recognition and recovery operate on the same selected scope, so a larger
  // article/card elsewhere cannot displace it during Readability's own scoring.
  if (main) clone.body.replaceChildren(main);
  let sourceId = 0;
  for (const node of [source, ...source.querySelectorAll('*')]) node.setAttribute(SOURCE_ATTRIBUTE, String(++sourceId));
  // Readability mutates its input. Preserve just the fallback region, not a
  // second complete document, and pass its DOM output directly to Turndown.
  const fallback = source.cloneNode(true);
  const warnings = [LOADED_WARNING];
  let article;
  try {
    article = new Readability(clone, { keepClasses: true, serializer: element => element }).parse();
  } catch {
    warnings.push('正文识别失败，已使用主区域或可见文本提取。');
  }
  let region = article?.textContent?.trim() ? article.content : fallback;
  let method = region === fallback ? (main ? 'main-region' : 'visible-text') : 'readability';
  // Without a trusted content region, Readability's selected body is the only
  // evidence of relevance. Re-merging the entire body would restore sidebars.
  if (region !== fallback && main) {
    const recovered = supplementArticle(article, fallback);
    region = recovered.region;
    if (region === fallback) {
      method = main ? 'main-region' : 'visible-text';
      warnings.push('正文识别结果遗漏了大部分内容，已使用过滤后的主区域或可见文本。');
    } else if (recovered.supplemented) {
      method = 'readability-supplemented';
      warnings.push('正文识别遗漏了部分正文，已按原文顺序补回段落、代码、表格或说明。');
    }
  } else if (region === fallback) {
    warnings.push('已使用主区域或可见文本作为降级结果，请检查引用预览。');
  }
  if ([...region.querySelectorAll('table')].some(tableNeedsTextFallback)) {
    warnings.push('无表头或复杂表格按行保留，合并单元格关系已标注。');
  }
  if (region.querySelector('details:not([open])')) warnings.push('包含页面中已加载的折叠正文，采集时未自动展开页面。');
  const content = createMarkdownConverter().turndown(region).trim() || readableText(region);
  if (!content) throw new Error('没有找到可读取的网页正文，请尝试划词或截取需要的区域。');
  return {
    title: article?.title || document.title || '未命名网页', content,
    metadata: { author: article?.byline || '', publishedAt: article?.publishedTime || '' },
    extraction: { method, scope: 'currently-loaded', warnings },
  };
}

// Keep a mapping to original text nodes so a quote can be restored without HTML insertion.
function buildTextIndex(document) {
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, 5);
  const positions = [];
  let text = '';
  let previousBlock = null;
  let node;
  const append = (character, position) => {
    if (/\s/.test(character)) {
      if (!text || text.endsWith(' ')) return;
      text += ' ';
      positions.push(position);
    } else {
      text += character;
      positions.push(position);
    }
  };
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1) {
      if (node.tagName === 'BR' && !hasExcludedAncestor(node) && positions.length) {
        const previous = positions[positions.length - 1];
        append(' ', { node: previous.node, start: previous.end, end: previous.end });
      }
      continue;
    }
    if (!isReadableTextNode(node)) continue;
    const block = node.parentElement.closest(BLOCK_SELECTOR);
    if (text && previousBlock !== block) append(' ', { node, start: 0, end: 0 });
    const value = node.nodeValue || '';
    for (let offset = 0; offset < value.length; offset += 1) {
      append(value[offset], { node, start: offset, end: offset + 1 });
    }
    previousBlock = block;
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    positions.pop();
  }
  return { text, positions };
}

function quoteOffsets(index, exact) {
  const offsets = [];
  let offset = index.text.indexOf(exact);
  while (offset >= 0) {
    offsets.push(offset);
    offset = index.text.indexOf(exact, offset + Math.max(exact.length, 1));
  }
  return offsets;
}

function isSelectionExcluded(selection) {
  for (const boundary of [selection.anchorNode, selection.focusNode]) {
    if (hasExcludedAncestor(boundary)) return true;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const ancestor = elementFor(range.commonAncestorContainer);
    if (!ancestor) continue;
    for (const element of ancestor.querySelectorAll('*')) {
      if (range.intersectsNode(element) && isExcluded(element)) return true;
    }
  }
  return false;
}

export function captureSelection(document) {
  const selection = document.defaultView?.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed || isSelectionExcluded(selection)) return null;
  const content = selection.toString().trim();
  if (!content) return null;
  const index = buildTextIndex(document);
  const exact = normaliseInline(content);
  const range = selection.getRangeAt(0);
  const offsets = quoteOffsets(index, exact);
  const offset = offsets.find(candidate => {
    const position = index.positions[candidate];
    try { return range.comparePoint(position.node, position.start) === 0; } catch { return false; }
  }) ?? offsets[0];
  const block = elementFor(range.commonAncestorContainer)?.closest(BLOCK_SELECTOR);
  const context = block ? normaliseInline(cleanClone(block, block.cloneNode(true)).textContent) : exact;
  return {
    kind: 'selection', title: document.title || '未命名网页', url: document.location.href,
    content, context,
    locator: {
      exact: content,
      prefix: offset === undefined ? '' : index.text.slice(Math.max(0, offset - 80), offset),
      suffix: offset === undefined ? '' : index.text.slice(offset + exact.length, offset + exact.length + 80),
    },
    capturedAt: new Date().toISOString(),
  };
}

export function captureReference(document, kind, cachedSelection = null) {
  if (!isSupportedDocument(document)) throw new Error('仅支持 HTTP 或 HTTPS 网页，浏览器内部页面无法读取。');
  if (kind === 'selection') {
    const selection = document.defaultView?.getSelection();
    if (isEditable(document.activeElement) || (selection && isSelectionExcluded(selection))) {
      throw new Error('输入框、可编辑区域和隐藏内容不会被引用。');
    }
    const reference = captureSelection(document) || cachedSelection;
    if (!reference || reference.url !== document.location.href) throw new Error('请先在网页正文中选择需要引用的文字。');
    return reference;
  }
  if (!['url', 'page'].includes(kind)) throw new Error('不支持的引用类型。');
  const base = {
    kind, title: document.title || '未命名网页', url: document.location.href,
    capturedAt: new Date().toISOString(),
  };
  return kind === 'url' ? { ...base, content: base.url } : { ...base, ...extractPage(document) };
}

export function highlightReference(document, locator) {
  if (!locator || typeof locator.exact !== 'string' || !locator.exact.trim()) return false;
  const index = buildTextIndex(document);
  const exact = normaliseInline(locator.exact);
  const offsets = quoteOffsets(index, exact);
  if (!offsets.length) return false;
  const prefix = normaliseInline(locator.prefix);
  const suffix = normaliseInline(locator.suffix);
  const score = offset => {
    let result = 0;
    if (prefix && normaliseInline(index.text.slice(Math.max(0, offset - prefix.length - 2), offset)).endsWith(prefix)) result += 1;
    if (suffix && normaliseInline(index.text.slice(offset + exact.length, offset + exact.length + suffix.length + 2)).startsWith(suffix)) result += 1;
    return result;
  };
  const offset = offsets.sort((left, right) => score(right) - score(left))[0];
  const start = index.positions[offset];
  const end = index.positions[offset + exact.length - 1];
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.node, start.start);
  range.setEnd(end.node, end.end);
  const selection = document.defaultView?.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  elementFor(start.node)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  return true;
}
