import { BUILTIN_AI_SITES } from '../ai-web.js';
import { findComposer as findChatGPTComposer, fillComposer, getComposerText, isUsableComposer } from './composer.js';
import { createAttachmentManager } from './attachments.js';
import { createNativeAttachmentDriver } from './attachment-drivers.js';
import { createGenericAttachmentDriver } from './generic-attachments.js';
import { GENERIC_CONTROLS, genericSendScore, isDisabledControl, genericConnectionIssue } from './generic-controls.js';

const SEND = 'button[data-testid="send-button"],button[aria-label="Send"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="发送提示"],button[aria-label="发送消息"],button[aria-label="发送"]';
const COMPOSERS = {
  gemini: 'rich-textarea [contenteditable="true"][role="textbox"],.ql-editor[contenteditable="true"],textarea',
  claude: '.ProseMirror[contenteditable="true"],[contenteditable="true"][role="textbox"],#static-composer-input,textarea',
  generic: 'textarea,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]',
};
const SENDERS = {
  chatgpt: SEND,
  gemini: `button.send-button,button[aria-label="Send message"],button[aria-label="发送消息"],${SEND}`,
  claude: `button[data-testid="chat-input-send"],button[aria-label="Send Message"],button[aria-label="Send message"],button[data-testid="send-button"],${SEND}`,
  generic: `${SEND},button[type="submit"],[role="button"][aria-label="Send"]`,
};
const IDLE_CONTROLS = {
  chatgpt: 'button[aria-label="Start Voice"],button[aria-label="Dictate"],button[aria-label="开始语音"],button[aria-label="开始语音模式"],button[aria-label="听写"],button[data-testid="voice-mode-button"]',
  gemini: 'button[aria-label^="语音输入"],button[aria-label^="Voice input"],button[aria-label^="Use microphone"],button[aria-label="Microphone"],button.mic-button',
  claude: 'button[aria-label="Dictate"],button[aria-label="Use voice mode"],button[aria-label="Microphone"]',
};
const GENERATION_CONTROLS = 'button[data-testid="stop-button"],button[data-testid="chat-input-stop"],button[data-test-id="stop-button"],button[data-test-id="stop-response-button"],button.stop-button,button.response-stop-button';
const GENERATION_LABEL = /^(?:stop|pause)(?:\s|$)|^cancel (?:response|generation)(?:\s|$)|^(?:停止|暂停|终止)(?:$|生成|回答|回复|响应|输出)/i;

function isGenerationControl(element) {
  return element.matches(GENERATION_CONTROLS)
    || ['aria-label', 'title'].some(attribute => GENERATION_LABEL.test(element.getAttribute(attribute)?.trim() || ''));
}

function visible(element) {
  if (element.closest('[hidden],[inert],[aria-hidden="true"]') || !element.getClientRects().length) return false;
  for (let current = element; current; current = current.parentElement) {
    const style = element.ownerDocument.defaultView.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return !element.closest('[data-sider-enhancement]');
}

/** Site-specific DOM contracts. The enhancement never owns a chat editor. */
export function createWebAdapter(document, site = BUILTIN_AI_SITES[0]) {
  const generic = site.adapter === 'generic';
  const knownComposers = new WeakMap();
  let diagnostic = '';
  let diagnosticReason = '';
  const diagnose = (detail, reason) => { diagnostic = detail; diagnosticReason = reason; };
  const query = (scope, selector, filter) => {
    try { return [...scope.querySelectorAll(selector)].filter(filter); }
    catch { diagnose('CSS 选择器无效，请在 AI 网站设置中检查高级配置。', 'selector-invalid'); return []; }
  };
  const unique = (scope, selector, filter, label, missingReason) => {
    const matches = query(scope, selector, filter);
    if (matches.length > 1) diagnose(`${label}存在多个匹配，请在 AI 网站设置中指定唯一的 CSS 选择器。`, 'ambiguous');
    else if (!matches.length && !diagnostic) diagnose(`没有找到可用的${label}，请确认已登录，或配置对应的 CSS 选择器。`, missingReason);
    return matches.length === 1 ? matches[0] : null;
  };
  function findComposer() {
    diagnostic = '';
    diagnosticReason = '';
    if (site.selectors?.composer) return unique(document, site.selectors.composer, el => visible(el) && isUsableComposer(el), '输入框', 'composer-missing');
    if (site.adapter === 'chatgpt') {
      const element = findChatGPTComposer(document);
      if (!element) diagnose('没有找到可用的 ChatGPT 输入框，请确认已登录且会话已加载。', 'composer-missing');
      return element;
    }
    if (generic) {
      const candidates = query(document, COMPOSERS.generic, el => visible(el) && isUsableComposer(el)
        && !el.parentElement?.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]'));
      const named = candidates.filter(el => el.getAttribute('role') === 'textbox'
        || /message|prompt|question|ask|消息|提问|输入.*问题/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`));
      const choices = named.length ? named : candidates;
      if (choices.length > 1) diagnose('输入框存在多个匹配，请在 AI 网站设置中指定唯一的 CSS 选择器。', 'ambiguous');
      else if (!choices.length) diagnose('没有找到可用的输入框，请确认已登录，或配置对应的 CSS 选择器。', 'composer-missing');
      return choices.length === 1 ? choices[0] : null;
    }
    return unique(document, COMPOSERS[site.adapter] || COMPOSERS.generic, el => visible(el) && isUsableComposer(el), '输入框', 'composer-missing');
  }
  const editorSession = editor => `${document.defaultView.location.href}|${editor.getAttribute('data-conversation-id') || editor.closest('[data-chat-id]')?.getAttribute('data-chat-id') || ''}`;
  function rememberComposer(editor, send) {
    if (!generic) return;
    for (let root = editor.closest('form') || editor.parentElement; root && root !== document.body; root = root.parentElement) {
      if (root.contains(send) || send.form === root) { knownComposers.set(editor, { root, session: editorSession(editor) }); return; }
    }
  }
  function composerRoot(editor) {
    if (site.adapter === 'chatgpt') return editor.closest('form') || editor.closest('[data-composer-body]');
    if (site.adapter === 'gemini') return editor.closest('input-area-v2,input-area') || editor.closest('.input-area') || editor.closest('form');
    if (site.adapter === 'claude') return editor.closest('form') || editor.closest('fieldset') || editor.closest('#static-composer-box');
    if (editor.closest('form')) return editor.closest('form');
    const known = knownComposers.get(editor);
    if (generic && known?.root.isConnected && known.root.contains(editor) && known.session === editorSession(editor)) return known.root;
    return null;
  }
  function findGenerationControl(editor) {
    // Only known composer shells establish a native generation state. A stop
    // control in the transcript or a custom site's broken configuration does not.
    if (generic && !knownComposers.has(editor)) return null;
    const scope = composerRoot(editor);
    return scope && query(scope, 'button,[role="button"]', el => visible(el) && isGenerationControl(el))[0];
  }
  function findSendButton({ includeDisabled = false } = {}) {
    const editor = findComposer();
    if (!editor) return null;
    // Gemini can reuse the send-button class while its action becomes Stop.
    // Explicit selectors must not turn such a control into a send target either.
    const filter = el => visible(el) && !isGenerationControl(el) && (includeDisabled || !isDisabledControl(el));
    if (site.selectors?.send) {
      const send = unique(document, site.selectors.send, filter, '发送控件', 'configured-send-missing');
      if (findGenerationControl(editor)) return null;
      if (send) rememberComposer(editor, send);
      return send;
    }
    if (findGenerationControl(editor)) return null;
    const selector = SENDERS[site.adapter] || SENDERS.generic;
    const form = editor.closest('form');
    const candidatesFor = scope => {
      if (!generic) return query(scope, selector, filter);
      const nodes = new Set(query(scope, GENERIC_CONTROLS, el => filter(el) && el !== editor && !el.contains(editor) && !isUsableComposer(el)));
      if (form && scope === form) for (const node of query(document, '[form]', filter)) if (node.matches(GENERIC_CONTROLS) && node.form === form) nodes.add(node);
      const scored = [...nodes].map(node => ({ node, score: genericSendScore(node, editor) })).filter(item => item.score > 0);
      const best = Math.max(0, ...scored.map(item => item.score));
      return scored.filter(item => item.score === best).map(item => item.node);
    };
    if (form) {
      const matches = candidatesFor(form);
      if (matches.length === 1) { rememberComposer(editor, matches[0]); return matches[0]; }
      diagnose(matches.length ? '发送控件存在多个匹配，请在 AI 网站设置中指定唯一的 CSS 选择器。' : '没有找到可用的发送控件，请确认会话已加载，或配置发送控件。', matches.length ? 'ambiguous' : 'send-missing');
      return null;
    }
    const scope = composerRoot(editor);
    for (let current = editor.parentElement, depth = 0; current && current !== document.body && depth < 16; current = current.parentElement, depth++) {
      const candidates = candidatesFor(current);
      if (candidates.length) {
        if (candidates.length === 1) { rememberComposer(editor, candidates[0]); return candidates[0]; }
        diagnose('发送控件存在多个匹配，请在 AI 网站设置中指定唯一的 CSS 选择器。', 'ambiguous');
        return null;
      }
      if (current === scope) break;
    }
    if (!diagnostic) diagnose('没有找到可用的发送控件，请确认会话已加载，或配置发送控件。', 'send-missing');
    return null;
  }
  function findMountAnchor() {
    const editor = findComposer();
    if (!editor) return null;
    let anchor;
    if (site.selectors?.mount) anchor = unique(document, site.selectors.mount, visible, '引用栏挂载位置', 'mount-missing');
    else {
      anchor = composerRoot(editor);
      if (!anchor) {
        const send = findSendButton({ includeDisabled: true });
        for (let node = editor.parentElement; node && node !== document.body; node = node.parentElement) {
          if (send && node.contains(send)) { anchor = node; break; }
        }
      }
      // Keep the bar out of native editor rows, grids and clipped composer
      // surfaces. Gemini's input-area is a child of a horizontal flex element;
      // Claude's editable row may have a fixed height after hydration.
      for (let depth = 0; anchor?.parentElement && depth < 8; depth++) {
        const parent = anchor.parentElement;
        if (parent === document.body || parent === document.documentElement) break;
        const style = document.defaultView.getComputedStyle(parent);
        const horizontal = /flex/.test(style.display) && !style.flexDirection.startsWith('column');
        const clipped = /^(hidden|clip)$/.test(style.overflowY || style.overflow);
        if (style.display !== 'contents' && !horizontal && !/grid/.test(style.display) && !clipped) break;
        anchor = parent;
      }
    }
    if (anchor?.closest('form')) anchor = anchor.closest('form');
    if (!anchor || anchor === document.body || anchor === document.documentElement) { if (!diagnostic) diagnose('没有找到可靠的引用栏挂载位置，请配置挂载位置。', 'mount-missing'); return null; }
    return anchor;
  }
  function connectionIssue() {
    const message = genericConnectionIssue(document, visible);
    return message ? `${site.name} 实时连接失败，已暂停新的引用发送。可使用右上角原站入口；无法仅凭此提示确定失败原因。\n原站提示：${message}` : '';
  }
  const adapter = {
    site, findComposer, findSendButton, findMountAnchor,
    readDraft: getComposerText,
    writeDraft(text, options = {}) { return fillComposer(document, text, options.mode || 'replace', { ...options, locate: findComposer, siteName: site.name }); },
    sessionKey() { const editor = findComposer(); return `${document.defaultView.location.href}|${editor?.getAttribute('data-conversation-id') || editor?.closest('[data-chat-id]')?.getAttribute('data-chat-id') || ''}`; },
    availability() {
      const composer = findComposer();
      if (!composer) return { ready: false, detail: diagnostic, reason: diagnosticReason };
      const send = findSendButton({ includeDisabled: true });
      const sendDetail = diagnostic;
      const sendReason = diagnosticReason;
      if (!findMountAnchor()) return { ready: false, detail: diagnostic, reason: diagnosticReason };
      const connectionDetail = connectionIssue();
      if (connectionDetail) return { ready: false, detail: connectionDetail, reason: 'site-connection-error' };
      // Native idle and generation controls replace Send without disconnecting
      // the composer. Custom selectors remain strict about missing send targets.
      const scope = composerRoot(composer);
      const idle = !site.selectors?.send && !getComposerText(composer).trim() && IDLE_CONTROLS[site.adapter]
        && scope && query(scope, IDLE_CONTROLS[site.adapter], visible).length > 0;
      const generating = !site.selectors?.send && findGenerationControl(composer);
      if (!send && !idle && !generating) return { ready: false, detail: sendDetail || '没有找到可用的发送控件，请确认会话已加载，或配置发送控件。', reason: sendReason || 'send-missing' };
      return { ready: true, detail: '' };
    },
    isSendIntent(event, editor) {
      if (findGenerationControl(editor)) return false;
      if (event.type === 'keydown') {
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229 || !editor.contains(event.target)) return false;
        const shortcut = site.sendShortcut || 'enter';
        return shortcut === 'enter' ? !event.ctrlKey && !event.metaKey : shortcut === 'ctrl-enter' && Boolean(event.ctrlKey || event.metaKey);
      }
      const send = findSendButton();
      return Boolean(send && (event.target === send || send.contains(event.target)));
    },
    send(button) { button.click(); },
    createAttachmentManager(options = {}) {
      const driver = generic ? createGenericAttachmentDriver(document, adapter) : site.adapter !== 'chatgpt' ? createNativeAttachmentDriver(document, adapter) : null;
      return createAttachmentManager(document, { ...options, ...(driver ? { driver } : {}) });
    },
    supportsAttachments() { return site.adapter === 'chatgpt' || (generic ? createGenericAttachmentDriver(document, adapter) : createNativeAttachmentDriver(document, adapter)).available(); },
  };
  return adapter;
}

export function createUnavailableAttachmentManager() {
  return { async prepare() { throw new Error('此网站尚未支持自动上传正文附件。'); }, async clear() {}, reconcile() {}, isReady() { return false; }, isOwnedRemoveButton() { return false; }, dispose() {} };
}
