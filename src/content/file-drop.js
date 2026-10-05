import { FILE_DROP_MARKER } from './file-drop-compat.js';

/** One drop sequence, centered on the editor and bubbling to the page. */
export function dropFileAtEditor(document, { editor, scope, transfer }) {
  const view = document.defaultView;
  const target = editor?.isConnected && scope.contains(editor) ? editor : scope;
  const rect = target.getBoundingClientRect();
  transfer.effectAllowed = 'copy'; transfer.dropEffect = 'copy';
  const marker = target.getAttribute(FILE_DROP_MARKER);
  target.setAttribute(FILE_DROP_MARKER, transfer.files[0].name);
  try {
    for (const type of ['dragenter', 'dragover', 'drop']) {
      if (!target.isConnected) throw new Error('输入框在准备附件时发生变化，请重新发送。');
      target.dispatchEvent(new view.DragEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, dataTransfer: transfer,
      }));
    }
  } finally {
    if (marker === null) target.removeAttribute(FILE_DROP_MARKER);
    else target.setAttribute(FILE_DROP_MARKER, marker);
  }
}
