import { attachmentFailureDetail } from './attachments.js';
import { dropFileAtEditor } from './file-drop.js';
import { createGeminiAttachmentDriver } from './gemini-attachments.js';

const REMOVE = /^(remove( (file|attachment))?|delete( (file|attachment))?|移除(文件|附件)?|删除(文件|附件)?)(\s|$)/i;
const CARDS = {
  claude: '[data-testid="file-thumbnail"],[data-testid="file-attachment"],[data-testid="attachment"],[class~="group/file"],[class~="group/file-card"],[class~="group/file-thumbnail"]',
  gemini: 'file-preview,.file-preview,.file-preview-container,.file-preview-chip,[data-testid="file-attachment"]',
};
const PENDING = '[role="progressbar"],[aria-busy="true"],[data-state="uploading"],[data-status="uploading"],[data-loading="true"],.loading,.spinner,mat-progress-spinner,mat-spinner';
const FAILURE = '[role="alert"],[data-state="error"],[data-status="error"],[aria-invalid="true"]';

/** Native attachment UI only; a positive preview is required before delivery. */
export function createNativeAttachmentDriver(document, adapter) {
  const kind = adapter.site.adapter;
  if (kind === 'gemini') return createGeminiAttachmentDriver(document, adapter);
  const removeButton = card => [...card.querySelectorAll('button,[role="button"]')].find(button => REMOVE.test(button.getAttribute('aria-label') || button.getAttribute('title') || '')) || null;
  function namesCard(card, name) {
    return [...card.querySelectorAll('[aria-label],[title],[data-file-name]'), card].some(el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-file-name'), el.textContent?.trim()].includes(name))
      || [...card.querySelectorAll('button')].some(button => (button.getAttribute('aria-label') || '').endsWith(` ${name}`));
  }
  function cards(scope) {
    const found = new Set(scope.querySelectorAll(CARDS[kind]));
    // Some versions have no stable card class. Restrict discovery to a native
    // remove control's nearest filename-bearing container in this composer.
    for (const button of scope.querySelectorAll('button,[role="button"]')) {
      if (!REMOVE.test(button.getAttribute('aria-label') || button.getAttribute('title') || '')) continue;
      for (let node = button.parentElement, depth = 0; node && node !== scope && depth < 5; node = node.parentElement, depth++) {
        if (/\.txt(?:\s|$)/i.test(node.textContent) || node.querySelector('[data-file-name]')) { found.add(node); break; }
      }
    }
    return [...found].filter(card => ![...found].some(other => other !== card && card.contains(other)));
  }
  function findScope(editor) {
    for (let node = editor.closest('form') || editor.parentElement, depth = 0; node && node !== document.body && depth < 9; node = node.parentElement, depth++) {
      const inputs = [...node.querySelectorAll('input[type="file"]')].filter(input => !input.disabled && (!input.accept || /text|\.txt|\*\//i.test(input.accept)));
      if (inputs.length > 1) throw new Error('正文附件上传入口存在多个匹配，请检查原站附件控件。');
      if (inputs.length === 1) return { scope: node, input: inputs[0] };
      if (kind === 'gemini' && node.matches('.input-area,.input-area-container')) return { scope: node, input: null };
    }
    throw new Error('没有找到可用的原站正文附件上传入口。');
  }
  return {
    siteName: adapter.site.name, findComposer: () => adapter.findComposer(), sessionKey: () => adapter.sessionKey(), composerScope: (_document, editor) => findScope(editor), cards, namesCard, removeButton,
    available() { try { const editor = adapter.findComposer(); return Boolean(editor && findScope(editor)); } catch { return false; } },
    failed(card) { return Boolean(card.matches(FAILURE) || card.querySelector(FAILURE) || [...card.querySelectorAll('button')].some(button => /^(retry upload|retry attachment|重试上传|重试附件)$/i.test(button.getAttribute('aria-label') || ''))); },
    failureDetail(card) { return attachmentFailureDetail(card, FAILURE); },
    ready(card, name) {
      if (card.matches(PENDING) || card.querySelector(PENDING) || !namesCard(card, name)) return false;
      const remove = removeButton(card);
      if (!remove || remove.disabled) return false;
      // Do not equate the disappearance of an upload spinner with success.
      return card.getAttribute('data-state') === 'ready' || card.getAttribute('data-status') === 'complete'
        || [...card.querySelectorAll('button:not([disabled]),a,[role="button"],.file-name,[data-testid="file-name"]')].some(el => el !== remove && [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent?.trim()].includes(name));
    },
    upload({ input, scope, transfer, editor }) {
      if (input) { input.files = transfer.files; input.dispatchEvent(new document.defaultView.Event('change', { bubbles: true })); }
      else dropFileAtEditor(document, { editor, scope, transfer });
    },
  };
}
