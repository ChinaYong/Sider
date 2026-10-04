const MAX_DRAFT_LENGTH = 1_000_000;

function textTransfer(transfer, { read = false } = {}) {
  if (!transfer) return null;
  const types = Array.from(transfer.types || [], type => type.toLowerCase());
  // Leave images, links, and files with the site's native drop handlers. An
  // image dragged from a web page may have URI/HTML types without File items.
  if (types.includes('files') || types.includes('text/uri-list') || transfer.files?.length
    || Array.from(transfer.items || []).some(item => item.kind === 'file') || !types.includes('text/plain')) return null;
  if (!read) return '';
  try {
    const html = transfer.getData('text/html');
    if (/<(?:img|video|audio|svg|iframe|object|embed)\b/i.test(html)) return null;
    const text = transfer.getData('text/plain').replace(/\r\n?/g, '\n');
    return text.trim() ? text : null;
  } catch { return null; }
}

/** Text-only fallback for custom sites whose attachment drop handler eats text. */
export function installTextDrop({ document, adapter, beforeWrite = () => {}, afterWrite = () => {}, onError = () => {}, isBusy = () => false }) {
  let disposed = false;
  let pending = false;
  let internalDrag = false;
  const editorFor = event => {
    const editor = adapter.findComposer();
    return editor && (event.target === editor || editor.contains(event.target)) ? editor : null;
  };
  const start = event => { internalDrag = Boolean(editorFor(event)); };
  const end = () => { internalDrag = false; };
  const over = event => {
    if (!event.isTrusted || internalDrag || !editorFor(event) || textTransfer(event.dataTransfer) === null) return;
    event.preventDefault(); event.stopImmediatePropagation();
    event.dataTransfer.dropEffect = 'copy';
  };
  const drop = event => {
    if (!event.isTrusted || internalDrag) return;
    const editor = editorFor(event);
    if (!editor) return;
    // DataTransfer is readable only while the trusted drop event is dispatching.
    const incoming = textTransfer(event.dataTransfer, { read: true });
    if (incoming === null) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (pending || isBusy()) { onError('正在写入输入框，请稍后重新拖入文字。'); return; }
    const previous = adapter.readDraft(editor);
    const session = adapter.sessionKey();
    const selected = editor.tagName === 'TEXTAREA' && document.activeElement === editor;
    const from = selected ? editor.selectionStart : previous.length;
    const to = selected ? editor.selectionEnd : previous.length;
    const expected = previous.slice(0, from) + incoming + previous.slice(to);
    if (expected.length > MAX_DRAFT_LENGTH) { onError('拖入后文字过长，原草稿已保留；请减少文字后重试。'); return; }
    pending = true;
    void (async () => {
      let started = false;
      try {
        if (disposed || adapter.findComposer() !== editor || adapter.sessionKey() !== session) return;
        beforeWrite(); started = true;
        const result = await adapter.writeDraft(expected, { mode: 'replace', expectedPrevious: previous, expectedEditor: editor, timeoutMs: 0,
          isCurrent: () => !disposed && adapter.findComposer() === editor && adapter.sessionKey() === session,
        });
        if (disposed) return;
        if (!result.ok) { onError(result.error); return; }
        if (adapter.findComposer() !== editor || adapter.sessionKey() !== session || adapter.readDraft(editor) !== expected) {
          onError('输入框或会话已变化，请检查草稿后重新拖入文字。'); return;
        }
        if (editor.tagName === 'TEXTAREA') editor.setSelectionRange(from + incoming.length, from + incoming.length);
      } catch { if (!disposed) onError('文字未能完整填入，请检查原草稿后重试。'); }
      finally { pending = false; if (started) afterWrite(); }
    })();
  };
  document.addEventListener('dragstart', start, true);
  document.addEventListener('dragend', end, true);
  document.addEventListener('dragover', over, true);
  document.addEventListener('drop', drop, true);
  return () => {
    disposed = true;
    document.removeEventListener('dragstart', start, true);
    document.removeEventListener('dragend', end, true);
    document.removeEventListener('dragover', over, true);
    document.removeEventListener('drop', drop, true);
  };
}
