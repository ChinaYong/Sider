import { GENERIC_CONTROLS } from './generic-controls.js';

const BUTTONS = GENERIC_CONTROLS;
const ATTRIBUTE_KEYS = ['data-testid', 'data-test-id', 'data-test', 'id', 'name', 'aria-label', 'title'];

const pickable = element => element?.matches(BUTTONS) && !element.matches('textarea,input:not([type="submit"]):not([type="image"]),[contenteditable],[role="textbox"]');

function cssString(value) {
  return `"${value.replace(/[\\"\n\r\f\0]/g, character => character === '\0' ? '\ufffd' : `\\${character.codePointAt(0).toString(16)} `)}"`;
}

function selectorsFor(element) {
  const tag = element.localName;
  return ATTRIBUTE_KEYS.flatMap(key => {
    const value = element.getAttribute(key);
    // React's transient IDs cannot identify a replacement after hydration.
    return value && value.length <= 300 && !(key === 'id' && /^:.*:$/.test(value)) ? [`${tag}[${key}=${cssString(value)}]`] : [];
  });
}

/** Store a selector, not a DOM node: native controls are routinely replaced. */
export function sendButtonSelector(document, button) {
  if (!pickable(button) || !button.isConnected || button.getRootNode() !== document) throw new Error('请选择原站的发送按钮。');
  const unique = selector => {
    if (selector.length > 1000) return false;
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === button;
  };
  for (const selector of selectorsFor(button)) if (unique(selector)) return selector;
  let path = '';
  for (let node = button; node && node !== document.documentElement; node = node.parentElement) {
    for (const prefix of selectorsFor(node)) {
      const selector = path ? `${prefix} > ${path}` : prefix;
      if (unique(selector)) return selector;
    }
    const siblings = [...node.parentElement.children].filter(sibling => sibling.localName === node.localName);
    const step = siblings.length > 1 ? `${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})` : node.localName;
    path = path ? `${step} > ${path}` : step;
    if (unique(path)) return path;
  }
  throw new Error('无法生成唯一的发送按钮选择器，请在高级配置中手动填写。');
}

/** The selection surface intercepts pointer events, including disabled buttons. */
export function pickSendButton(document, { signal, timeoutMs = 60000 } = {}) {
  if (signal?.aborted) return Promise.resolve({ ok: false, cancelled: true });
  const view = document.defaultView;
  const previousFocus = document.activeElement;
  const host = document.createElement('div');
  host.setAttribute('data-sider-send-picker', '');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{font:13px system-ui,"Microsoft YaHei",sans-serif;color:#fff}
    .surface{position:fixed;inset:0;cursor:crosshair;outline:none}
    .hint{position:fixed;top:8px;left:8px;right:8px;padding:10px 12px;color:#fff;font:13px system-ui,"Microsoft YaHei",sans-serif;background:#202525;border-radius:9px;box-shadow:0 3px 12px #0004;display:flex;align-items:center;gap:8px;line-height:1.6;pointer-events:auto}
    .hint span{flex:1}.hint button{color:#fff;background:#ffffff18;border:1px solid #ffffff40;border-radius:6px;padding:5px 9px;font:inherit;cursor:pointer}
    .outline{position:fixed;border:2px solid #10a37f;border-radius:5px;background:#10a37f20;pointer-events:none;box-sizing:border-box}
    [hidden]{display:none!important}
  `;
  const surface = document.createElement('div'); surface.className = 'surface'; surface.tabIndex = 0; surface.setAttribute('aria-label', '点选发送按钮');
  const outline = document.createElement('div'); outline.className = 'outline'; outline.hidden = true;
  const toolbar = document.createElement('div'); toolbar.className = 'hint'; toolbar.setAttribute('role', 'status');
  const hint = document.createElement('span'); hint.textContent = '点击原站发送按钮完成选择。此次点击只用于配置；按 Esc 或点击取消退出。';
  const cancelButton = document.createElement('button'); cancelButton.type = 'button'; cancelButton.textContent = '取消';
  toolbar.append(hint, cancelButton); root.append(style, surface, outline, toolbar);
  document.documentElement.append(host);
  surface.focus({ preventScroll: true });
  return new Promise(resolve => {
    let completed = false;
    let timer;
    const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const finish = result => {
      if (completed) return;
      completed = true;
      view.clearTimeout(timer);
      document.removeEventListener('keydown', keyboard, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('pointerdown', stop, true);
      signal?.removeEventListener('abort', cancel);
      view.removeEventListener('pagehide', cancel);
      host.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(result);
    };
    const cancel = () => finish({ ok: false, cancelled: true });
    function candidate(event) {
      const target = document.elementsFromPoint(event.clientX, event.clientY).find(element => element !== host && !host.contains(element));
      const button = target?.closest(BUTTONS);
      if (!pickable(button) || button.closest('[data-sider-enhancement],[data-sider-send-picker],[hidden],[inert],[aria-hidden="true"]') || !button.getClientRects().length) return null;
      return button;
    }
    function click(event) {
      if (event.composedPath().includes(toolbar)) return;
      stop(event);
      const button = candidate(event);
      if (!button) { hint.textContent = '这里没有可选择的按钮。请点击发送按钮，或按 Esc 退出后先输入问题，使发送按钮出现。'; return; }
      try { finish({ ok: true, selector: sendButtonSelector(document, button) }); }
      catch (error) { hint.textContent = error.message; }
    }
    function keyboard(event) {
      if (event.key === 'Escape') { stop(event); cancel(); }
      else if (!event.composedPath().includes(toolbar)) stop(event);
    }
    surface.addEventListener('pointermove', event => {
      const button = candidate(event);
      outline.hidden = !button;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      Object.assign(outline.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    });
    cancelButton.addEventListener('click', event => { stop(event); cancel(); });
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('click', click, true);
    document.addEventListener('pointerdown', stop, true);
    signal?.addEventListener('abort', cancel, { once: true });
    view.addEventListener('pagehide', cancel, { once: true });
    timer = view.setTimeout(() => finish({ ok: false, error: '点选发送按钮超时，配置未更改，请重试。' }), timeoutMs);
  });
}
