import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const EXCLUDED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT',
  'IFRAME', 'OBJECT', 'EMBED', 'CANVAS',
]);
const BLOCK_SELECTOR = 'p,li,blockquote,pre,td,th,h1,h2,h3,h4,h5,h6,div,section,article,main';
const MAIN_SELECTOR = 'main,[role="main"],article';
const EVIDENCE_SELECTOR = 'p,li,h2,h3,h4,h5,h6,pre,table,details,aside,footer,blockquote,[role="note"]';
const LOADED_WARNING = '仅包含采集时已加载的网页正文；未加载的内容、其他框架及图片中的文字可能未包含。';

export function isSupportedDocument(document) {
  return /^https?:$/.test(document.location?.protocol || '');
}

function elementFor(node) {
  return node?.nodeType === 1 ? node : node?.parentElement;
}

export function isEditable(node) {
  let element = elementFor(node);
  while (element) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return true;
    const editable = element.getAttribute('contenteditable');
    if (editable !== null) return editable.toLowerCase() !== 'false';
    element = element.parentElement;
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
  return EXCLUDED_TAGS.has(element.tagName) || isEditable(element) || isHidden(element);
}

function isReadableTextNode(node) {
  if (!node.nodeValue?.trim()) return false;
  let ancestor = node.parentElement;
  while (ancestor) {
    if (isExcluded(ancestor)) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

function hasExcludedAncestor(node) {
  let element = elementFor(node);
  while (element) {
    if (isExcluded(element)) return true;
    element = element.parentElement;
  }
  return false;
}

function normaliseInline(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanClone(original, clone) {
  const clean = (source, target) => {
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

function sanitizedDocument(document) {
  const clone = document.cloneNode(true);
  cleanClone(document.documentElement, clone.documentElement);
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
  clone.head?.remove();
  clone.documentElement.prepend(head);
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
      const code = pre.textContent.replace(/\r\n?/g, '\n');
      const element = pre.querySelector('code') || pre;
      const classes = `${element.className} ${pre.className} ${node.className}`;
      const language = (classes.match(/(?:language-|lang-|highlight-(?:text|source)-)([\w+.-]+)/) || [])[1]
        || (pre.getAttribute('data-language') || '').match(/^[\w+.-]+$/)?.[0] || '';
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
  let best = null;
  let length = 0;
  for (const region of document.querySelectorAll(MAIN_SELECTOR)) {
    if (region.parentElement?.closest(MAIN_SELECTOR)) continue;
    const size = region.textContent.trim().length;
    if (size > length) { best = region; length = size; }
  }
  return best;
}

function missesMainContent(article, region) {
  const text = normaliseInline(article.textContent);
  if (text.length < normaliseInline(region.textContent).length * 0.85) return true;
  const retained = new Set([...article.content.querySelectorAll(EVIDENCE_SELECTOR)].map(node => normaliseInline(node.textContent)));
  for (const node of region.querySelectorAll(EVIDENCE_SELECTOR)) {
    const original = normaliseInline(node.textContent);
    if (original && !retained.has(original) && !text.includes(original)) return true;
  }
  return false;
}

export function extractPage(document) {
  const clone = sanitizedDocument(document);
  const main = mainRegion(clone);
  // Readability mutates its input. Preserve just the fallback region, not a
  // second complete document, and pass its DOM output directly to Turndown.
  const fallback = (main || clone.body)?.cloneNode(true);
  if (!fallback) throw new Error('当前页面没有可提取的正文。');
  const warnings = [LOADED_WARNING];
  let article;
  try {
    article = new Readability(clone, { keepClasses: true, serializer: element => element }).parse();
  } catch {
    warnings.push('正文识别失败，已使用主区域或可见文本提取。');
  }
  let region = article?.textContent?.trim() ? article.content : fallback;
  let method = region === fallback ? (main ? 'main-region' : 'visible-text') : 'readability';
  if (main && region !== fallback && missesMainContent(article, fallback)) {
    region = fallback;
    method = 'main-region';
    warnings.push('正文识别结果遗漏了主区域内容，已保留主区域中的段落、代码、表格和说明。');
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
