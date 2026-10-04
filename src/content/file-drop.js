/** One native drop sequence, centered on the editor and bubbling to the page. */
export function dropFileAtEditor(document, { editor, scope, transfer }) {
  const view = document.defaultView;
  const target = editor?.isConnected && scope.contains(editor) ? editor : scope;
  const rect = target.getBoundingClientRect();
  transfer.effectAllowed = 'copy'; transfer.dropEffect = 'copy';
  for (const type of ['dragenter', 'dragover', 'drop']) {
    if (!target.isConnected) throw new Error('输入框在准备附件时发生变化，请重新发送。');
    target.dispatchEvent(new view.DragEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, dataTransfer: transfer,
    }));
  }
}
