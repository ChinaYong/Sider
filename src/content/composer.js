const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '#pending-home-input',
  '[data-testid="prompt-textarea"]',
  '[data-composer-body] [contenteditable="true"][role="textbox"]',
  '[data-composer-body] textarea',
  'form .ProseMirror[contenteditable="true"]',
  'main .ProseMirror[contenteditable="true"]',
  'form [contenteditable="true"][role="textbox"]',
  'main [contenteditable="true"][role="textbox"]',
  'form textarea',
  'main textarea',
];

const filling = new WeakSet();

function isUsable(element) {
  if (element.disabled || element.readOnly || element.getAttribute('aria-disabled') === 'true') return false;
  if (element.tagName !== 'TEXTAREA' && element.getAttribute('contenteditable') !== 'true') return false;
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const view = element.ownerDocument.defaultView;
  for (let parent = element; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return element.getClientRects().length > 0;
}

export function findComposer(document) {
  for (const selector of COMPOSER_SELECTORS) {
    const candidate = [...document.querySelectorAll(selector)].find(isUsable);
    if (candidate) return candidate;
  }
  const editors = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(isUsable);
  if (editors.length === 1) return editors[0];
  return null;
}

function editableText(element) {
  // Read the editing document rather than textContent, which joins adjacent paragraphs.
  const lines = [];
  let current = '';
  const blockTags = new Set(['P', 'DIV', 'LI', 'PRE']);
  for (const child of element.childNodes) {
    if (child.nodeType === 3) {
      current += child.nodeValue;
    } else if (child.nodeType === 1 && child.tagName === 'BR') {
      lines.push(current);
      current = '';
    } else if (child.nodeType === 1 && blockTags.has(child.tagName)) {
      if (current) {
        lines.push(current);
        current = '';
      }
      const value = editableText(child);
      lines.push(value);
    } else if (child.nodeType === 1) {
      current += editableText(child);
    }
  }
  if (current || !lines.length) lines.push(current);
  return lines.join('\n');
}

export function getComposerText(element) {
  const value = element.tagName === 'TEXTAREA' ? element.value : editableText(element);
  return value.replace(/\r\n?/g, '\n');
}

function waitForComposer(document, timeoutMs) {
  const immediate = findComposer(document);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    const view = document.defaultView;
    let finished = false;
    const finish = (element) => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      view.clearTimeout(timer);
      view.clearInterval(interval);
      resolve(element);
    };
    const check = () => {
      const element = findComposer(document);
      if (element) finish(element);
    };
    const observer = new view.MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const timer = view.setTimeout(() => finish(null), timeoutMs);
    const interval = view.setInterval(check, 200);
    check();
  });
}

function inputEvent(element, name, text, cancelable = false) {
  const view = element.ownerDocument.defaultView;
  return new view.InputEvent(name, {
    bubbles: true,
    cancelable,
    inputType: 'insertText',
    data: text,
  });
}

function writeComposer(element, text) {
  const document = element.ownerDocument;
  const view = document.defaultView;
  element.focus({ preventScroll: true });
  if (element.tagName === 'TEXTAREA') {
    if (!element.dispatchEvent(inputEvent(element, 'beforeinput', text, true))) return false;
    // Use the native setter so frameworks observe an actual value transition.
    const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(element, text);
    element.setSelectionRange(text.length, text.length);
    element.dispatchEvent(inputEvent(element, 'input', text));
    return true;
  }

  const selection = view.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);

  // Native editing allows ProseMirror to update its own editing state and undo history.
  // Avoid rewriting a rich editor's DOM, which may only change its visual appearance.
  if (typeof document.execCommand !== 'function') return false;
  let edited = false;
  try {
    edited = document.execCommand('insertText', false, text);
  } catch {
    return false;
  }
  if (!edited) return false;
  element.dispatchEvent(inputEvent(element, 'input', text));
  selection.collapse(element, element.childNodes.length);
  return true;
}

/** Fill a draft only. This module never presses Enter, clicks Send, or submits a form. */
export async function fillComposer(document, text, mode = 'append', { timeoutMs = 8000, expectedPrevious } = {}) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '请先输入问题。' };
  if (!['append', 'replace'].includes(mode)) return { ok: false, error: '不支持的填入方式。' };
  const element = await waitForComposer(document, timeoutMs);
  if (!element) return { ok: false, error: '没有找到可用的 ChatGPT 输入框，请确认已登录且会话已加载。' };
  if (filling.has(element)) return { ok: false, error: '正在准备发送内容，请稍后再试。' };

  filling.add(element);
  try {
    const previous = getComposerText(element);
    if (expectedPrevious !== undefined && previous !== expectedPrevious) return { ok: false, error: '草稿在准备过程中发生了变化，请检查后重新发送。' };
    const incoming = text.replace(/\r\n?/g, '\n');
    const expected = mode === 'replace' || !previous ? incoming : `${previous}\n\n${incoming}`;
    if (!writeComposer(element, expected)) {
      return { ok: false, error: '输入框不接受自动编辑，原草稿已保留。请刷新 ChatGPT 后重试。' };
    }
    // Allow the page's editor to reconcile before reporting success.
    await new Promise((resolve) => document.defaultView.setTimeout(resolve, 50));
    const current = findComposer(document);
    if (!current || getComposerText(current) !== expected) {
      return { ok: false, error: 'ChatGPT 输入框未完整保留发送内容，请检查草稿后重试。' };
    }
    return { ok: true, filled: true, mode, characters: expected.length };
  } catch {
    return { ok: false, error: '准备发送内容时发生错误，请检查原版输入框后重试。' };
  } finally {
    filling.delete(element);
  }
}
