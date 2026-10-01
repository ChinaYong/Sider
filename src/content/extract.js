import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const EXCLUDED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT',
  'IFRAME', 'OBJECT', 'EMBED', 'CANVAS',
]);
const BLOCK_SELECTOR = 'p,li,blockquote,pre,td,th,h1,h2,h3,h4,h5,h6,div,section,article,main';
const LOADED_WARNING = '仅包含采集时已加载的网页内容；未加载、未展开或其他框架中的内容可能未包含。';

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
  const originals = [original, ...original.querySelectorAll('*')];
  const clones = [clone, ...clone.querySelectorAll('*')];
  for (let index = 0; index < originals.length; index += 1) {
    const source = originals[index];
    const target = clones[index];
    if (source.nodeType !== 1 || !target) continue;
    if (source !== original && isExcluded(source)) {
      target.remove();
      continue;
    }
    for (const attribute of [...target.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') target.removeAttribute(attribute.name);
      if (['href', 'src', 'action', 'formaction'].includes(name)) {
        const value = attribute.value.trim();
        if (/^(?:javascript|vbscript|data):/i.test(value)) target.removeAttribute(attribute.name);
      }
    }
  }
  clone.querySelectorAll('nav,aside,footer,[role="navigation"]').forEach(element => element.remove());
  return clone;
}

function sanitizedDocument(document) {
  const clone = document.cloneNode(true);
  cleanClone(document.documentElement, clone.documentElement);
  return clone;
}

function tableNeedsTextFallback(table) {
  return Boolean(table.querySelector('[rowspan]:not([rowspan="1"]),[colspan]:not([colspan="1"])'))
    || !table.querySelector('tr')?.querySelector('th');
}

function createMarkdownConverter() {
  const converter = new TurndownService({
    headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true,
  });
  converter.use(gfm);
  converter.addRule('unstructured-table', {
    filter: node => node.nodeName === 'TABLE' && tableNeedsTextFallback(node),
    replacement: (_content, node) => {
      const rows = Array.from(node.querySelectorAll('tr')).map((row, index) => {
        const cells = Array.from(row.children).filter(cell => ['TH', 'TD'].includes(cell.nodeName))
          .map(cell => normaliseInline(cell.textContent));
        return `第 ${index + 1} 行：${cells.join(' | ')}`;
      });
      return `\n\n[表格，按行保留]\n${rows.join('\n')}\n\n`;
    },
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

export function extractPage(document) {
  const clone = sanitizedDocument(document);
  const warnings = [LOADED_WARNING];
  if ([...clone.querySelectorAll('table')].some(tableNeedsTextFallback)) {
    warnings.push('无表头或含合并单元格的表格按行保留，原布局可能发生变化。');
  }
  let article;
  try {
    article = new Readability(clone.cloneNode(true), { keepClasses: true }).parse();
  } catch {
    warnings.push('正文识别失败，已使用主区域或可见文本提取。');
  }
  const converter = createMarkdownConverter();
  if (article?.textContent?.trim()) {
    const content = converter.turndown(article.content).trim();
    if (content) {
      return {
        title: article.title || document.title || '未命名网页', content,
        extraction: { method: 'readability', scope: 'currently-loaded', warnings },
      };
    }
  }
  const regions = [...clone.querySelectorAll('main,[role="main"],article')]
    .sort((left, right) => readableText(right).length - readableText(left).length);
  const region = regions[0] || clone.body;
  if (!region) throw new Error('当前页面没有可提取的正文。');
  const content = converter.turndown(region).trim() || readableText(region);
  if (!content) throw new Error('没有找到可读取的网页正文，请尝试划词或截取需要的区域。');
  warnings.push('已使用主区域或可见文本作为降级结果，请检查引用预览。');
  return {
    title: document.title || '未命名网页', content,
    extraction: { method: regions.length ? 'main-region' : 'visible-text', scope: 'currently-loaded', warnings },
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
