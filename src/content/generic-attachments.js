import { attachmentFailureDetail } from './attachments.js';
import { isDisabledControl } from './generic-controls.js';
import { dropFileAtEditor } from './file-drop.js';
import { entryDropAvailable } from './file-drop-compat.js';
import { createFileUploadResolver, acceptsTextFile as acceptsText } from './file-upload.js';

const CONTROLS = 'button,[role="button"],[tabindex="0"]:not(a)';
const OMIT = 'textarea,input,[contenteditable],[data-sider-enhancement],[data-sider-send-picker]';
const FILE_ATTRIBUTES = ['data-file-name', 'data-filename', 'title', 'aria-label'];
const FILE_NAME = /^[^\r\n]{1,300}\.[a-z0-9]{1,12}$/i;
const REMOVE = /^(?:remove(?: (?:file|attachment))?|delete(?: (?:file|attachment))?|close|cancel upload|移除(?:文件|附件)?|删除(?:文件|附件)?|关闭|取消上传)(?:$|[ :：])/i;
const PENDING = '[role="progressbar"],[aria-busy="true"],[data-state="uploading"],[data-state="processing"],[data-status="uploading"],[data-status="processing"],[data-loading="true"],.loading,.spinner';
const FAILURE = '[role="alert"],[data-state="error"],[data-state="failed"],[data-status="error"],[data-status="failed"],[aria-invalid="true"]';
const PENDING_TEXT = /^(?:uploading|processing|preparing|parsing|reading|pending|正在(?:上传|处理|解析|读取)|上传中|处理中|解析中|等待上传)(?:\s|\.|…|$)/i;
const FAILED_TEXT = /^(?:upload(?:ing)?|file|attachment|processing)?\s*(?:failed|error|failure|rejected|not supported)|(?:上传|解析|处理|文件|附件).{0,24}(?:失败|错误|不支持)/i;
const COMPLETE_TEXT = /^(?:uploaded|upload complete|ready|completed|success|已上传|上传完成|解析完成|处理完成)(?:\s|[.!。！]|$)/i;
const SIZE = /^\d+(?:[.,]\d+)?\s*(?:[KMGT]?i?B|bytes?|字节)$/i;
const TYPE = /^(?:TXT|text(?:\/plain)?|plain text|文本)$/i;
const TYPE_SIZE = /^(?:TXT|text(?:\/plain)?|plain text|文本)\s*[·•|—-]?\s*\d+(?:[.,]\d+)?\s*(?:[KMGT]?i?B|bytes?|字节)$/i;
const closeCache = new WeakMap();
const DROP_ZONE = '[data-dropzone],[data-drop-zone],[data-testid*="dropzone"],[ondrop]';

function visible(element) {
  if (!element.getClientRects().length || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  for (let node = element; node; node = node.parentElement) {
    const style = element.ownerDocument.defaultView.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

function fileLabels(element) {
  if (element.closest(OMIT)) return [];
  const values = FILE_ATTRIBUTES.map(key => element.getAttribute(key) || '');
  if (!element.children.length) values.push(element.textContent || '');
  const control = element.matches(CONTROLS);
  return [...new Set(values.map(value => value.trim()).filter(value => FILE_NAME.test(value)
    && !SIZE.test(value) && !TYPE_SIZE.test(value) && (!control || !REMOVE.test(value))))];
}

function labelNodes(scope) {
  return [scope, ...scope.querySelectorAll('[data-file-name],[data-filename],[title],[aria-label],span,div,p,a,button')]
    .filter(node => fileLabels(node).length);
}

// A close glyph is recognized from geometry, not a site's SVG path or classes.
function closeIcon(svg) {
  const shapes = [...svg.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')];
  if (!shapes.length || shapes.length > 4 || shapes.some(shape => ['rect', 'circle', 'ellipse'].includes(shape.localName))) return false;
  const signature = svg.outerHTML;
  const cached = closeCache.get(svg);
  if (cached?.signature === signature) return cached.value;
  let value = false;
  try {
    const points = [];
    for (const shape of shapes) {
      const length = shape.getTotalLength(); const matrix = shape.getCTM?.();
      if (!Number.isFinite(length) || length <= 0) return false;
      for (let step = 0; step <= 64; step++) {
        const p = shape.getPointAtLength(length * step / 64);
        points.push(matrix ? { x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f } : p);
      }
    }
    const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
    const width = Math.max(...points.map(p => p.x)) - left, height = Math.max(...points.map(p => p.y)) - top;
    if (width <= 0 || height <= 0 || width / height < .75 || width / height > 1.35) return false;
    const normalized = points.map(p => ({ x: (p.x - left) / width, y: (p.y - top) / height }));
    value = normalized.every(p => Math.min(Math.abs(p.x - p.y), Math.abs(p.x + p.y - 1)) < .2)
      && [[0, 0], [0, 1], [1, 0], [1, 1]].every(([x, y]) => normalized.some(p => Math.abs(p.x - x) < .23 && Math.abs(p.y - y) < .23));
  } catch { value = false; }
  closeCache.set(svg, { signature, value });
  return value;
}

function isRemove(element) {
  if (element.matches(OMIT) || !visible(element)) return false;
  if (element.tagName === 'BUTTON' && element.form && element.type === 'submit') return false;
  const labels = ['aria-label', 'title', 'data-action'].map(key => element.getAttribute(key) || '');
  const text = element.textContent.trim();
  if ([...labels, text].some(label => REMOVE.test(label.trim())) && ![...labels, text].some(label => /(?:remove|delete|clear) all|全部|所有/i.test(label))) return true;
  if (/^[×✕✖⨉x]$/i.test(text)) return true;
  const icons = [...element.querySelectorAll('svg')];
  return icons.length === 1 && closeIcon(icons[0]);
}

function removeControl(card) {
  const found = [...card.querySelectorAll(CONTROLS)].filter(isRemove);
  return found.length === 1 ? found[0] : null;
}

/** Generic native UI detection; upload and cleanup still use the common manager. */
export function createGenericAttachmentDriver(document, adapter) {
  const resolver = createFileUploadResolver(document, adapter);
  function scopeFor(editor) {
    const anchor = adapter.findMountAnchor();
    let scope = anchor?.contains(editor) ? anchor : editor.closest('form');
    if (anchor?.isConnected && !scope) {
      const send = adapter.findSendButton({ includeDisabled: true });
      // A manual bar mount can sit outside the composer. Resolve the native
      // attachment scope from the actual editor and sender in that case.
      for (let node = editor.parentElement, depth = 0; node && depth < 16; node = node.parentElement, depth++) {
        if (node === document.body || node === document.documentElement || node.matches('main,article,[role="main"]')) break;
        if (send && node.contains(send)) { scope = node; break; }
      }
    }
    if (!anchor?.isConnected || !scope?.contains(editor) || !scope.isConnected) throw new Error('没有找到可靠的原站附件区域。');
    // File cards can be a sibling immediately above the editor/send shell.
    // Keep the search in that neighborhood, outside transcript containers.
    for (let depth = 0; depth < 2; depth++) {
      const parent = scope.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement || parent.matches('main,article,[role="main"]')
        || parent.querySelector('[role="log"],[data-message-id],[data-testid="conversation-turn"]')) break;
      scope = parent;
    }
    return scope;
  }
  function hasAttachmentUI(scope) {
    return scope.matches(DROP_ZONE) || Boolean(scope.querySelector(DROP_ZONE))
      || [...scope.querySelectorAll('input[type="file"]')].some(acceptsText)
      || Boolean(resolver.triggerFor(scope));
  }
  const preferDrop = (scope, editor) => Boolean((scope.matches(DROP_ZONE) || scope.querySelector(DROP_ZONE)) && entryDropAvailable(document, editor));
  function cards(scope) {
    const found = new Set();
    const editor = adapter.findComposer();
    for (const label of labelNodes(scope)) {
      for (let node = label.parentElement, depth = 0; node && node !== scope && depth < 7; node = node.parentElement, depth++) {
        if (node.contains(editor) || node.closest(OMIT)) break;
        const filenames = new Set(labelNodes(node).flatMap(fileLabels));
        if (filenames.size !== 1) break;
        if (removeControl(node)) { found.add(node); break; }
      }
    }
    return [...found].filter(card => ![...found].some(other => other !== card && card.contains(other)));
  }
  const namesCard = (card, name) => labelNodes(card).some(node => fileLabels(node).includes(name));
  function statusNodes(card) {
    const remove = removeControl(card);
    // A native file preview (or an ancestor around it) can itself be clickable.
    // Its metadata still describes the file; exclude only the remove action.
    return [...card.querySelectorAll('*')].filter(node => visible(node) && !node.children.length && !node.closest(OMIT)
      && !fileLabels(node).length && !remove?.contains(node));
  }
  function errorNode(card) {
    return [card, ...card.querySelectorAll(FAILURE)].find(node => visible(node) && node.matches(FAILURE))
      || statusNodes(card).find(node => FAILED_TEXT.test(node.textContent.trim()));
  }
  function pending(card) {
    if ([card, ...card.querySelectorAll(PENDING)].some(node => visible(node) && node.matches(PENDING))) return true;
    return statusNodes(card).some(node => PENDING_TEXT.test(node.textContent.trim()));
  }
  return {
    siteName: adapter.site.name, findComposer: () => adapter.findComposer(), sessionKey: () => adapter.sessionKey(), cards, namesCard,
    removeButton: card => removeControl(card),
    composerScope(_document, editor, options) {
      const scope = scopeFor(editor);
      if (preferDrop(scope, editor)) return { scope, input: null };
      const trigger = resolver.triggerFor(scope);
      if (trigger) return resolver.resolve(editor, scope, trigger, options);
      if (!hasAttachmentUI(scope)) throw new Error('未检测到原站的文本附件入口，请改用正文文本或检查附件区域。');
      return { scope, input: null };
    },
    available() {
      try {
        const view = document.defaultView, editor = adapter.findComposer(), scope = editor && scopeFor(editor);
        return Boolean(editor && ['File', 'DataTransfer'].every(key => typeof view[key] === 'function')
          && (preferDrop(scope, editor) || resolver.triggerFor(scope) || typeof view.DragEvent === 'function' && hasAttachmentUI(scope)));
      } catch { return false; }
    },
    failed: card => Boolean(errorNode(card)),
    failureDetail(card) {
      const detail = attachmentFailureDetail(card, FAILURE);
      // The whole card can carry data-state="failed" while its actual reason
      // appears in a child. Do not substitute the filename or whole card text.
      const reason = statusNodes(card).find(node => FAILED_TEXT.test(node.textContent.trim()));
      return (detail || reason?.textContent.trim() || '').slice(0, 1000);
    },
    ready(card, name) {
      if (!namesCard(card, name) || pending(card) || errorNode(card)) return false;
      const remove = removeControl(card);
      if (!remove || isDisabledControl(remove) || !adapter.findSendButton()) return false;
      const state = `${card.getAttribute('data-state') || ''} ${card.getAttribute('data-status') || ''}`;
      if (/\b(?:ready|complete|completed|success|done)\b/i.test(state)) return true;
      const statuses = statusNodes(card).map(node => node.textContent.trim());
      return statuses.some(value => COMPLETE_TEXT.test(value) || TYPE_SIZE.test(value))
        || statuses.some(value => TYPE.test(value)) && statuses.some(value => SIZE.test(value));
    },
    upload({ editor, scope, transfer, input }) {
      if (editor !== adapter.findComposer() || !scope.contains(editor)) throw new Error('输入框在准备附件时发生变化，请重新发送。');
      if (input) return resolver.upload({ editor, scope, transfer, input });
      // File inputs only establish capability. Drop once at the editor; do not
      // dispatch change or retry a second upload route after attempting it.
      dropFileAtEditor(document, { editor, scope, transfer });
    },
  };
}
