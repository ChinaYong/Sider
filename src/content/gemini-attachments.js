import { attachmentFailureDetail } from './attachments.js';
import { isDisabledControl } from './generic-controls.js';
import { dropFileAtEditor } from './file-drop.js';
import { entryDropAvailable } from './file-drop-compat.js';
import { createFileUploadResolver, activeUploadElement as active, acceptsTextFile as acceptsText } from './file-upload.js';

const CARD = 'gem-attachment,file-preview,.file-preview,.file-preview-container,.file-preview-chip,[data-testid="file-attachment"]';
const REMOVE = /^(?:remove(?: (?:file|attachment))?|delete(?: (?:file|attachment))?|close|移除(?:文件|附件)?|删除(?:文件|附件)?|关闭)(?:\s|$)/i;
const PENDING = '[role="progressbar"],[aria-busy="true"],[data-state="uploading"],[data-status="uploading"],[data-loading="true"],.loading,.spinner,mat-progress-spinner,mat-spinner';
const FAILURE = '[role="alert"],[data-state="error"],[data-state="failed"],[data-status="error"],[data-status="failed"],[aria-invalid="true"],.gem-attachment-error-content,[data-mat-icon-name="error"],[fonticon="error"],[data-mat-icon-name="error_outline"],[fonticon="error_outline"]';

function visible(element) {
  if (!element.getClientRects().length || element.closest('[hidden],[inert]')) return false;
  for (let node = element; node; node = node.parentElement) {
    const style = element.ownerDocument.defaultView.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

/** Native preview rules; delivery uses the shared drop or file-action route. */
export function createGeminiAttachmentDriver(document, adapter) {
  const resolver = createFileUploadResolver(document, adapter, {
    menuSelector: '[role="menu"],[role="dialog"],[popover],.cdk-overlay-pane',
    fallbackRoute(menu) {
      const uploaders = [...menu.querySelectorAll('images-files-uploader')];
      const local = uploaders.length
        ? uploaders.filter(active).flatMap(uploader => [...uploader.querySelectorAll('input[type="file"]')].filter(input => input.closest('images-files-uploader') === uploader))
        : [...menu.querySelectorAll('input[type="file"]')].filter(input => active(input.parentElement));
      const inputs = local.filter(acceptsText);
      if (inputs.length > 1) throw Object.assign(new Error('Gemini 本地文件上传入口存在多个匹配（' + inputs.length + ' 个），且未找到唯一的“上传文件”操作。'), { code: 'UPLOAD_ROUTE_AMBIGUOUS' });
      return inputs[0] ? { input: inputs[0] } : null;
    },
  });
  function scopeFor(editor) {
    const scope = editor.closest('input-area-v2,input-area') || editor.closest('form') || editor.closest('.input-area-container,.input-area');
    if (!scope) throw new Error('没有找到可靠的 Gemini 附件区域。');
    return scope;
  }
  function oneInput(scope) {
    const inputs = [...scope.querySelectorAll('input[type="file"]')].filter(acceptsText);
    if (inputs.length > 1) throw new Error('Gemini 正文附件上传入口存在多个匹配，请检查原站附件控件。');
    return inputs[0] || null;
  }
  function removeButton(card) {
    const controls = [...card.querySelectorAll('button,[role="button"]')].filter(element => REMOVE.test(element.getAttribute('aria-label') || element.getAttribute('title') || '')
      && !/(?:remove|delete|close) all|全部|所有/i.test(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`));
    return controls.length === 1 ? controls[0] : null;
  }
  function descriptions(card) {
    return [...new Set([card, card.closest('.file-preview-container')].filter(Boolean))].flatMap(node => (node.getAttribute('aria-describedby') || '').split(/\s+/)
      .map(id => document.getElementById(id)?.textContent.trim()).filter(Boolean));
  }
  function tileNames(card, name) {
    if (!name.toLowerCase().endsWith('.txt')) return false;
    const labels = [...card.querySelectorAll('.gem-attachment-text')].map(node => node.textContent.trim());
    const types = [...card.querySelectorAll('.gem-attachment-extension-label')].map(node => node.textContent.trim());
    // Long names are shortened in both the visible label and the close label.
    // The native tooltip retains the full name, including our ownership nonce.
    return labels.length === 1 && (labels[0] === name.slice(0, -4) || descriptions(card).includes(name)) && types.length === 1 && types[0].toUpperCase() === 'TXT';
  }
  function namesCard(card, name) {
    return tileNames(card, name) || descriptions(card).includes(name) || [card, ...card.querySelectorAll('[aria-label],[title],[data-file-name],span,div,button')]
      .some(element => ['aria-label', 'title', 'data-file-name'].some(key => element.getAttribute(key) === name)
        || !element.children.length && element.textContent.trim() === name
        || /^(?:remove|delete|close|移除|删除|关闭) /i.test(element.getAttribute('aria-label') || '') && (element.getAttribute('aria-label') || '').endsWith(` ${name}`));
  }
  function cards(scope) {
    const found = new Set([...scope.querySelectorAll(CARD)].filter(visible));
    for (const button of scope.querySelectorAll('button,[role="button"]')) {
      if (!REMOVE.test(button.getAttribute('aria-label') || button.getAttribute('title') || '') || button.closest(CARD)) continue;
      for (let node = button.parentElement, depth = 0; node && node !== scope && depth < 5; node = node.parentElement, depth++) {
        if (node.contains(adapter.findComposer())) break;
        if (/\.txt(?:\s|$)/i.test(node.textContent) || node.querySelector('[data-file-name]')) { found.add(node); break; }
      }
    }
    return [...found].filter(card => ![...found].some(other => other !== card && card.contains(other)));
  }
  function statusScope(card) {
    const wrapper = card.closest('.file-preview-container');
    // Status can be a sibling of the tile. Only use a wrapper belonging to
    // this one tile; another file's progress/error must not affect it.
    return wrapper && wrapper.querySelectorAll('gem-attachment').length === 1 && wrapper.querySelector('gem-attachment') === card ? wrapper : card;
  }
  const hasVisible = (card, selector) => { const scope = statusScope(card); return [scope, ...scope.querySelectorAll(selector)].some(node => node.matches(selector) && visible(node)); };
  return {
    siteName: adapter.site.name, findComposer: () => adapter.findComposer(), sessionKey: () => adapter.sessionKey(), cards, namesCard, removeButton,
    composerScope(_document, editor, options) {
      const scope = scopeFor(editor);
      if (entryDropAvailable(document, editor)) return { scope, input: null };
      const trigger = resolver.triggerFor(scope);
      return trigger ? resolver.resolve(editor, scope, trigger, options) : { scope, input: oneInput(scope) };
    },
    available() { try { const editor = adapter.findComposer(), scope = editor && scopeFor(editor); return Boolean(scope && (entryDropAvailable(document, editor) || resolver.triggerFor(scope) || oneInput(scope) || scope.matches('.input-area,.input-area-container,form,input-area-v2,input-area'))); } catch { return false; } },
    failed: card => hasVisible(card, FAILURE),
    failureDetail(card) {
      const detail = attachmentFailureDetail(statusScope(card), FAILURE);
      if (detail && detail.toLowerCase() !== 'error') return detail;
      return (descriptions(card).find(text => !text.toLowerCase().endsWith('.txt') && /error|fail|不支持|失败|无法|出错/i.test(text)) || detail).slice(0, 1000);
    },
    ready(card, name, { requireSendReady = true } = {}) {
      const remove = removeButton(card);
      // Native tile close buttons use visibility:hidden until hover. The tile
      // itself must be visible, but that presentation rule is not upload state.
      if (!namesCard(card, name) || hasVisible(card, PENDING) || hasVisible(card, FAILURE) || !remove || remove.closest('[hidden],[inert]') || isDisabledControl(remove)) return false;
      // A fill or empty-draft direct template uploads before its description
      // exists. The native sender can stay disabled until that text is written.
      if (tileNames(card, name)) return !requireSendReady || Boolean(adapter.findSendButton());
      return card.getAttribute('data-state') === 'ready' || card.getAttribute('data-status') === 'complete'
        || [...card.querySelectorAll('button,a,[role="button"],.file-name,[data-testid="file-name"]')].some(element => element !== remove && !isDisabledControl(element)
          && [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent.trim()].includes(name));
    },
    upload({ input, scope, transfer, editor }) {
      if (input) resolver.upload({ input, scope, transfer, editor });
      else dropFileAtEditor(document, { editor, scope, transfer });
    },
  };
}
