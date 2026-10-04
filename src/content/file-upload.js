import { isDisabledControl } from './generic-controls.js';

const CONTROLS = 'button,[role="button"],[role="menuitem"],label[for]';
const OMIT = '[data-sider-enhancement],[data-sider-send-picker],textarea,[contenteditable]';
const FILE_ACTION = /^(?:upload|attach|add|choose|select|browse)(?: local)? files?(?:$|[\s.,:;(])|^(?:上传|添加|附加|选择)(?:本地)?文件(?:$|[\s.。,:：，、（(])|^(?:从电脑上传|从设备上传|upload from computer)(?:$|[\s.。,:：，(])/i;
// Responsive attachment menus often shorten "Upload files" to "Files".
// Bare nouns are only meaningful inside the menu owned by the upload trigger.
const COMPACT_FILE_ACTION = /^(?:(?:local )?files?|(?:本地)?文件)$/i;
const MENU_ACTION = /^(?:uploads? and tools|upload files? and tools|attachments?|add attachments?|上传和工具|附件|添加附件)(?:$|[\s.,:：，(（])/i;
const normalize = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim();

export const acceptsTextFile = input => !isDisabledControl(input) && !input.matches(':disabled')
  && (!input.accept || input.accept.split(',').some(value => /^(?:\.txt|text\/(?:plain|\*)|\*\/\*|application\/octet-stream)$/i.test(value.trim())));

export function activeUploadElement(element) {
  if (!element?.isConnected || !element.getClientRects().length || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  const view = element.ownerDocument.defaultView;
  for (let node = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  const rect = element.getBoundingClientRect();
  return !rect.width || !rect.height || rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight;
}

function labels(control) {
  const labelled = (control.getAttribute('aria-labelledby') || '').split(/\s+/)
    .map(id => control.ownerDocument.getElementById(id)?.textContent || '').join(' ');
  // Decorative icon ligatures (e.g. attach_file) are not the action's label.
  const copy = control.cloneNode(true);
  for (const node of copy.querySelectorAll('svg,[role="img"],[aria-hidden="true"],[hidden],input')) node.remove();
  return [labelled, control.getAttribute('aria-label') || '', control.getAttribute('title') || '', copy.textContent || ''].map(normalize).filter(Boolean);
}

function controls(scope, pattern) {
  return [...scope.querySelectorAll(CONTROLS)].filter(control => !control.closest(OMIT) && activeUploadElement(control)
    && !(control.tagName === 'BUTTON' && control.form && control.type === 'submit')
    && labels(control).some(label => pattern.test(label)));
}

function ambiguous(message) { return Object.assign(new Error(message), { code: 'UPLOAD_ROUTE_AMBIGUOUS' }); }

/** Resolve the input actually invoked by one semantic action, without a picker. */
export function inputFromUploadAction(document, action, boundary, checkCurrent = () => {}) {
  const view = document.defaultView, clicked = new Set();
  let cancelled = true;
  const capture = event => {
    if (!(event.target instanceof view.HTMLInputElement) || event.target.type !== 'file') return;
    event.preventDefault();
    cancelled = cancelled && event.defaultPrevented;
    clicked.add(event.target);
  };
  checkCurrent();
  document.addEventListener('click', capture, true);
  try { action.click(); }
  finally { document.removeEventListener('click', capture, true); }
  checkCurrent();
  if (clicked.size > 1) throw new Error('“上传文件”操作调用了多个文件入口，正文附件准备已停止。');
  const [input] = clicked;
  if (!cancelled || !input?.isConnected || !boundary.contains(input) || !acceptsTextFile(input)) {
    throw new Error('“上传文件”操作没有提供可确认的 TXT 文件入口，问题已保留，请重试。');
  }
  return input;
}

/** Shared by native adapters and custom sites; never guess among hidden inputs. */
export function createFileUploadResolver(document, adapter, { menuSelector = '[role="menu"],[role="dialog"],[popover]', fallbackRoute } = {}) {
  const view = document.defaultView, bindings = new WeakMap();
  const prefix = adapter.site.name;
  const fileActions = (scope, inMenu = false) => [...new Set([
    ...controls(scope, FILE_ACTION), ...(inMenu ? controls(scope, COMPACT_FILE_ACTION) : []),
  ])];
  function triggerFor(scope) {
    const found = [...new Set([...controls(scope, MENU_ACTION), ...fileActions(scope)])];
    if (found.length > 1) throw ambiguous(`${prefix} 上传菜单存在多个匹配，无法安全选择附件入口。`);
    return found[0] || null;
  }
  const outermost = roots => roots.filter(root => !roots.some(other => other !== root && other.contains(root)));
  const menuRoots = () => outermost([...document.querySelectorAll(menuSelector)].filter(activeUploadElement));
  const eligible = root => fileActions(root, true).length || [...root.querySelectorAll('input[type="file"]')].some(acceptsTextFile);
  function currentMenu(trigger, before, opened) {
    const ids = `${trigger.getAttribute('aria-controls') || ''} ${trigger.getAttribute('aria-owns') || ''}`.trim().split(/\s+/).filter(Boolean);
    const roots = ids.length
      ? outermost([...new Set(ids.map(id => document.getElementById(id)).filter(root => root && root !== document.body && root !== document.documentElement && activeUploadElement(root)))])
      : menuRoots().filter(root => (!opened || !before.has(root)) && eligible(root));
    if (roots.length > 1) throw ambiguous(`${prefix} 当前上传菜单存在多个匹配，无法安全选择附件入口。`);
    return roots[0] || null;
  }
  function routeFor(menu) {
    const named = fileActions(menu, true), enabled = named.filter(action => !isDisabledControl(action));
    if (enabled.length > 1) throw ambiguous(`${prefix} 本地文件上传操作存在多个匹配（${enabled.length} 个），无法安全选择。`);
    if (enabled.length === 1) return { action: enabled[0] };
    if (named.length) return null;
    return fallbackRoute?.(menu) || null;
  }
  async function resolve(editor, scope, trigger, { signal, isCurrent = () => true, deadline = Infinity } = {}) {
    if (isDisabledControl(trigger)) throw new Error(`${prefix} 上传菜单暂不可用，请稍后重试。`);
    const session = adapter.sessionKey(), opened = trigger.getAttribute('aria-expanded') !== 'true', before = new Set(menuRoots());
    const checkCurrent = () => {
      if (signal?.aborted || !isCurrent() || editor !== adapter.findComposer() || session !== adapter.sessionKey() || !scope.isConnected || !trigger.isConnected) {
        throw new Error('问题或会话已修改，正文附件准备已取消，请重新发送。');
      }
    };
    const limit = Math.min(deadline, Date.now() + 8000);
    let menu = null;
    try {
      checkCurrent();
      // Direct file actions are supported without opening a portal first.
      if (fileActions(scope).includes(trigger) && !trigger.hasAttribute('aria-expanded') && !trigger.hasAttribute('aria-controls') && trigger.getAttribute('aria-haspopup') !== 'menu') {
        const input = inputFromUploadAction(document, trigger, scope, checkCurrent);
        bindings.set(input, { boundary: scope, trigger });
        return { scope, input };
      }
      if (opened) trigger.click();
      const route = await new Promise((resolveRoute, reject) => {
        let settled = false;
        const finish = (route, error) => {
          if (settled) return; settled = true;
          observer.disconnect(); view.clearInterval(timer); signal?.removeEventListener('abort', tick);
          if (error) reject(error); else resolveRoute(route);
        };
        const tick = () => {
          try {
            checkCurrent();
            if (!menu) menu = currentMenu(trigger, before, opened);
            if (menu && (!menu.isConnected || !activeUploadElement(menu))) throw new Error(`${prefix} 上传菜单已关闭，正文附件准备已取消，请重新发送。`);
            const route = menu && routeFor(menu);
            if (route) finish(route);
            else if (Date.now() >= limit) throw new Error(`${prefix} 上传菜单没有提供可用的 TXT 文件入口，问题已保留，请稍后重试。`);
          } catch (error) {
            // Portals can mount inputs before their visible action. Give that
            // render a chance to finish within the existing upload deadline.
            if (error.code !== 'UPLOAD_ROUTE_AMBIGUOUS' || Date.now() >= limit) finish(null, error);
          }
        };
        const observer = new view.MutationObserver(tick);
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        const timer = view.setInterval(tick, 25); signal?.addEventListener('abort', tick, { once: true }); tick();
      });
      checkCurrent();
      const input = route.action ? inputFromUploadAction(document, route.action, menu, checkCurrent) : route.input;
      bindings.set(input, { boundary: menu, trigger });
      return { scope, input };
    } catch (error) {
      if (opened && trigger.isConnected && trigger.getAttribute('aria-expanded') === 'true') trigger.click();
      throw error;
    }
  }
  function upload({ input, scope, editor, transfer }) {
    const binding = bindings.get(input);
    if (!input?.isConnected || !acceptsTextFile(input) || !scope.contains(editor) || editor !== adapter.findComposer()) throw new Error('附件入口发生变化，请重新发送。');
    if (binding ? !binding.trigger.isConnected || !binding.boundary.contains(input) || !activeUploadElement(binding.boundary) : !scope.contains(input)) {
      throw new Error('上传菜单已关闭，正文附件准备已取消，请重新发送。');
    }
    input.files = transfer.files;
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
  }
  return { triggerFor, resolve, upload };
}
