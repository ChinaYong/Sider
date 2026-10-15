import { GEMINI_MODEL_FLASH, GEMINI_MODEL_FLASH_LITE, GEMINI_MODEL_PRO, GEMINI_MODEL_ARGON, normalizeGeminiDefaults } from '../ai-web.js';

const PICKER_LABEL = /(?:mode|model)\s*picker|(?:打开|开启).*(?:模型|模式)|(?:模型|模式).*(?:选择|切换)/i;
const EXTENDED = /extended|扩展|延伸/i;
const STANDARD = /standard|标准|標準/i;
const LEVEL = /thinking\s*level|思考\s*(?:级别|等級|等级)|推理\s*(?:级别|强度)/i;
const MENU = '[role="menu"],[role="listbox"]';
const ITEM = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],button,[role="button"],[role="switch"],input[type="checkbox"],input[type="radio"]';
const OWN_MENU = 'data-sider-gemini-auto-menu';

function textOf(node) {
  const ids = (node?.getAttribute?.('aria-labelledby') || '').split(/\s+/);
  return [node?.getAttribute?.('aria-label'), node?.getAttribute?.('title'), node?.textContent,
    ...ids.map(id => node?.ownerDocument.getElementById(id)?.textContent)]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function visible(document, node) {
  if (!node?.isConnected) return false;
  for (let current = node; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert') || current.getAttribute('data-visible') === 'false') return false;
    const style = document.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}

function enabled(node) {
  return !node.disabled && !node.closest('[aria-disabled="true"],[disabled]');
}

function modelOf(text) {
  text = String(text).replace(/Gemini(?=Flash|Pro|Argon)/gi, 'Gemini ');
  if (/flash\s*[- ]?\s*lite/i.test(text)) return GEMINI_MODEL_FLASH_LITE;
  if (/\bflash\b/i.test(text)) return GEMINI_MODEL_FLASH;
  if (/\bpro\b/i.test(text)) return GEMINI_MODEL_PRO;
  if (/\bargon\b/i.test(text)) return GEMINI_MODEL_ARGON;
  return null;
}

function levelOf(text) {
  if (/\blow\b|低点|低點|^(?:低|低等)(?:\s|$)/i.test(text)) return 'low';
  if (/\bmedium\b|中等/i.test(text)) return 'medium';
  if (/\bhigh\b|高点|高點|^(?:高|高等)(?:\s|$)/i.test(text)) return 'high';
  return null;
}

// A compact accordion can contain its submenu inside the parent item. Its
// descendants must not become the parent's label or selection evidence.
function itemText(node) {
  const label = [...node.querySelectorAll('.label')].find(part => part.closest(ITEM) === node);
  if (label) return textOf(label);
  const copy = node.cloneNode(true);
  for (const menu of copy.querySelectorAll(MENU)) menu.remove();
  return textOf(copy);
}

function findPicker(document) {
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(node => visible(document, node) && enabled(node));
  const native = buttons.filter(node => {
    const named = PICKER_LABEL.test(textOf(node));
    const known = node.closest('[data-test-id="bard-mode-menu-button"]') || node.matches('button.input-area-switch');
    // Gemini first paints an input-area-switch placeholder without a label or
    // menu binding. It is replaced by a gem-button in the compact layout.
    return named || known && (node.hasAttribute('aria-controls') || node.hasAttribute('aria-haspopup'));
  });
  return native.length === 1 ? native[0] : null;
}

function items(document, menu) {
  return [...menu.querySelectorAll(ITEM)].filter(node => {
    const parent = node.parentElement?.closest(ITEM);
    // Compact Gemini renders the three native choices inside an expandable
    // menuitem, with no nested role=menu. Keep those choices while excluding
    // implementation buttons inside an ordinary menuitem.
    const inlineChoice = parent?.matches('gem-menu-item[value="thinking_level"][aria-expanded="true"]')
      && node.matches('gem-menu-item[role="menuitem"]');
    return node.closest(MENU) === menu && visible(document, node) && (!parent || !menu.contains(parent) || inlineChoice);
  });
}

function menus(document) {
  return [...document.querySelectorAll(MENU)].filter(node => visible(document, node));
}

// data-active is keyboard focus, not selection. The current native menu exposes
// its selection through a check icon and gem-menu-item-content.selected.
function selected(node) {
  if (node.matches('input[type="checkbox"],input[type="radio"]')) return node.checked;
  for (const name of ['aria-checked', 'aria-pressed', 'aria-selected', 'data-state']) {
    const value = node.getAttribute(name);
    if (['true', 'checked', 'on', 'selected'].includes(value)) return true;
    if (['false', 'unchecked', 'off', 'unselected'].includes(value)) return false;
  }
  if (node.matches('.selected') || [...node.querySelectorAll('gem-menu-item-content.selected,[aria-label="Selected"],[aria-label="已选中"],[fonticon="check"],[data-mat-icon-name="check"]')].some(part => part.closest(ITEM) === node)) return true;
  if (node.matches('gem-menu-item') && node.querySelector('gem-menu-item-content.checkmark-only')) return false;
  return null;
}

function pickerModel(picker, document) {
  // The accessible label names the model; the Gemini Pro logo can instead name
  // the subscription, so consult the selected menu item before the logo text.
  const explicit = modelOf(picker.getAttribute('aria-label') || '');
  if (explicit) return explicit;
  const menu = boundMenu(document, picker);
  const checked = menu && items(document, menu).filter(node => modelOf(itemText(node)) && selected(node) === true);
  if (checked?.length === 1) return modelOf(itemText(checked[0]));
  return modelOf(textOf(picker));
}

function pickerThinking(picker) {
  const text = textOf(picker);
  if (EXTENDED.test(text)) return 'high';
  if (STANDARD.test(text)) return 'low';
  // Absence of an Extended badge no longer implies Low. New pickers display
  // only the model, so consult the actual thinking menu in that case.
  return levelOf(picker.querySelector('.picker-secondary-text')?.textContent || '');
}

function boundMenu(document, trigger) {
  const ids = ((trigger.getAttribute('aria-controls') || '') + ' ' + (trigger.getAttribute('aria-owns') || '')).trim().split(/\s+/).filter(Boolean);
  if (ids.length) {
    const found = ids.map(id => document.getElementById(id)).filter(node => node && visible(document, node));
    return found.length === 1 ? found[0] : null;
  }
  const candidates = menus(document).filter(menu => menu.matches('[data-test-id="gem-mode-menu"]') || items(document, menu).some(node => modelOf(itemText(node))));
  return candidates.length === 1 ? candidates[0] : null;
}

async function activatePicker(picker, signal) {
  // Give the compact inner button's focus handlers a turn before activation.
  // Restore the previous editor focus after closing the owned popover.
  if (picker.closest('gem-button[data-test-id="bard-mode-menu-button"]')) {
    picker.focus({ preventScroll: true });
    await delay(picker.ownerDocument.defaultView, 40, signal);
    if (signal?.aborted || !picker.isConnected) return;
  }
  picker.click();
}

function captureFocus(document) {
  const active = document.activeElement;
  const selection = document.getSelection();
  const range = selection?.rangeCount && active?.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
  const inputRange = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  return () => {
    if (!active?.isConnected || active === document.body) return;
    active.focus({ preventScroll: true });
    if (inputRange) active.setSelectionRange(...inputRange);
    if (range && range.startContainer.isConnected && range.endContainer.isConnected) {
      selection.removeAllRanges(); selection.addRange(range);
    }
  };
}

function quietMenus(document) {
  const root = document.documentElement;
  const marked = new Set();
  const existingMenus = new Set(menus(document));
  const existingBackdrops = new Set(document.querySelectorAll('.cdk-overlay-backdrop'));
  const style = document.createElement('style');
  // Opacity preserves native layout, focus and handlers. Install before opening;
  // mark newly created portals in a MutationObserver microtask, before painting.
  style.textContent = 'html[data-sider-gemini-auto] [data-test-id="gem-mode-menu"],html[data-sider-gemini-auto] [' + OWN_MENU + '] { opacity:0!important; pointer-events:none!important; transition:none!important; animation:none!important; }';
  root.setAttribute('data-sider-gemini-auto', ''); root.append(style);
  const mark = () => {
    for (const menu of menus(document)) if (!existingMenus.has(menu)) { menu.setAttribute(OWN_MENU, ''); marked.add(menu); }
    for (const backdrop of document.querySelectorAll('.cdk-overlay-backdrop')) if (!existingBackdrops.has(backdrop)) { backdrop.setAttribute(OWN_MENU, ''); marked.add(backdrop); }
  };
  const observer = new document.defaultView.MutationObserver(mark);
  observer.observe(root, { childList: true, subtree: true });
  return {
    mark,
    closed: () => ![...marked].some(node => node.matches(MENU) && visible(document, node)),
    close(picker) {
      mark();
      const open = [...marked].find(node => node.matches(MENU) && visible(document, node));
      if (open && picker?.isConnected && picker.closest('gem-button[data-test-id="bard-mode-menu-button"]')) {
        // Closing only the inner gem-menu with Escape can leave its enclosing
        // gem-popover logically open. Toggle the owning compact trigger instead.
        picker.click();
        return;
      }
      if (open) {
        open.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        if (visible(document, open)) [...marked].find(node => node.matches('.cdk-overlay-backdrop') && visible(document, node))?.click();
      }
      // Legacy triggers expose aria-expanded and can fall back to click.
      if ([...marked].some(node => node.matches(MENU) && visible(document, node)) && picker?.getAttribute('aria-expanded') === 'true') picker.click();
    },
    dispose() { observer.disconnect(); style.remove(); root.removeAttribute('data-sider-gemini-auto'); for (const node of marked) node.removeAttribute(OWN_MENU); },
  };
}

function delay(window, milliseconds, signal) {
  return new Promise(resolve => {
    const done = () => { window.clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = window.setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

export async function applyGeminiDefaults(document, rawSettings, { signal, timeoutMs = 4000, stableMs = 150 } = {}) {
  const settings = normalizeGeminiDefaults(rawSettings);
  const window = document.defaultView;
  const deadline = Date.now() + timeoutMs;
  const picker = findPicker(document);
  if (!picker) return { complete: false, reason: 'model-picker-missing' };
  if (picker.getAttribute('aria-expanded') === 'true' || menus(document).length) return { complete: false, reason: 'user-menu-open' };
  const controller = new window.AbortController();
  const cancel = () => controller.abort(signal?.reason || 'cancelled');
  const interrupt = event => { if (event.isTrusted) controller.abort('user-interaction'); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  for (const type of ['pointerdown', 'keydown', 'input']) document.addEventListener(type, interrupt, true);
  const restoreFocus = captureFocus(document);
  let quiet;
  let currentPicker = picker;
  const check = () => {
    if (controller.signal.aborted) throw new Error(String(controller.signal.reason || 'cancelled'));
    if (!appRoute(window)) throw new Error('navigation');
    currentPicker = findPicker(document);
    if (!currentPicker) throw new Error('model-picker-replaced');
  };
  const wait = async (read, reason, stable = 0) => {
    let since;
    while (Date.now() < deadline) {
      check(); quiet?.mark();
      const result = await read();
      if (result) { since ??= Date.now(); if (Date.now() - since >= stable) return result; }
      else since = undefined;
      await delay(window, 40, controller.signal);
    }
    throw new Error(reason);
  };
  const open = async () => {
    check();
    if (!boundMenu(document, currentPicker)) {
      quiet ??= quietMenus(document);
      await activatePicker(currentPicker, controller.signal); quiet.mark();
    }
    return wait(() => {
      const menu = boundMenu(document, currentPicker);
      return menu && items(document, menu).length ? menu : null;
    }, 'model-menu-missing');
  };
  const thinkingItems = menu => items(document, menu).filter(node => {
    const text = itemText(node);
    return !modelOf(text) && !LEVEL.test(text) && (levelOf(text) || EXTENDED.test(text) || STANDARD.test(text));
  });
  const thinkingChoice = async () => {
    let menu = await open();
    let candidates = thinkingItems(menu);
    if (!candidates.length) {
      const triggers = items(document, menu).filter(node => LEVEL.test(itemText(node)));
      if (triggers.length !== 1 || !enabled(triggers[0])) throw new Error('thinking-unavailable');
      const trigger = triggers[0];
      const ids = ((trigger.getAttribute('aria-controls') || '') + ' ' + (trigger.getAttribute('aria-owns') || '')).trim().split(/\s+/).filter(Boolean);
      const previous = new Set(menus(document));
      const readSubmenu = () => {
        const main = boundMenu(document, currentPicker);
        const controlled = ids.map(id => document.getElementById(id)).filter(node => node && visible(document, node) && thinkingItems(node).length);
        if (controlled.length > 1) throw new Error('thinking-unavailable');
        if (controlled.length === 1) return controlled[0];
        if (main && thinkingItems(main).length) return main;
        const found = menus(document).filter(node => !previous.has(node) && thinkingItems(node).length);
        if (found.length > 1) throw new Error('thinking-unavailable');
        return found[0];
      };
      menu = readSubmenu();
      if (!menu) {
        check(); trigger.click();
        menu = await wait(readSubmenu, 'thinking-menu-missing');
      }
      candidates = thinkingItems(menu);
    }
    const radio = candidates.some(node => levelOf(itemText(node)) || STANDARD.test(itemText(node)));
    if (!radio && settings.thinkingLevel === 'medium') throw new Error('thinking-unavailable');
    const targets = candidates.filter(node => {
      const text = itemText(node);
      if (!radio) return EXTENDED.test(text);
      return (levelOf(text) || (STANDARD.test(text) ? 'low' : EXTENDED.test(text) ? 'high' : null)) === settings.thinkingLevel;
    });
    if (targets.length !== 1 || !enabled(targets[0])) throw new Error('thinking-unavailable');
    return { node: targets[0], radio, expected: radio || settings.thinkingLevel === 'high' };
  };
  try {
    check();
    if (pickerModel(currentPicker, document) !== settings.model) {
      await open();
      const options = await wait(() => {
        const menu = boundMenu(document, currentPicker);
        const found = menu ? items(document, menu).filter(node => modelOf(itemText(node)) === settings.model) : [];
        return found.length ? found : null;
      }, 'model-unavailable');
      if (options.length !== 1 || !enabled(options[0])) throw new Error('model-unavailable');
      options[0].click();
      await wait(() => pickerModel(currentPicker, document) === settings.model, 'model-unconfirmed', stableMs);
    }
    if (pickerThinking(currentPicker) !== settings.thinkingLevel) {
      let choice = await thinkingChoice();
      const state = selected(choice.node);
      if (!choice.radio && state === null) throw new Error('thinking-state-unknown');
      if (state !== choice.expected) { check(); choice.node.click(); }
      await wait(async () => {
        // Native choices can dismiss and destroy both menus. Reacquire the
        // model menu and its thinking submenu; never repeat the choice click.
        if (!choice.node.isConnected || !visible(document, choice.node)) choice = await thinkingChoice();
        return selected(choice.node) === choice.expected;
      }, 'thinking-unconfirmed', stableMs);
    }
    await wait(() => pickerModel(currentPicker, document) === settings.model, 'model-unconfirmed', stableMs);
    return { complete: true, model: true, thinking: true };
  } catch (error) {
    return { complete: false, reason: error.message };
  } finally {
    try {
      quiet?.close(currentPicker);
      // Keep the pre-paint rule through native closing animations as well.
      const closingDeadline = Date.now() + 500;
      while (quiet && !quiet.closed() && Date.now() < closingDeadline) await delay(window, 20);
    } finally {
      quiet?.dispose();
      if (quiet && !controller.signal.aborted) restoreFocus();
      signal?.removeEventListener('abort', cancel);
      for (const type of ['pointerdown', 'keydown', 'input']) document.removeEventListener(type, interrupt, true);
    }
  }
}

function appRoute(window) {
  const path = window.location.pathname;
  return !/(?:^|\/)spark(?:\/|$)/.test(path) && /^(?:\/u\/\d+)?\/app(?:\/|$)/.test(path) && !/\/app\/download/.test(path);
}

export function installGeminiDefaults({ document, settings, getSettings, timeoutMs = 30000, routeIntervalMs = 500, applyTimeoutMs = 4000, retryDelayMs = 500, onResult } = {}) {
  const window = document.defaultView;
  let started = false;
  let disposed = false;
  let wasApp = false;
  let observer;
  let timeout;
  let routeTimer;
  let active;
  let operation = Promise.resolve();
  function stopWaiting() { observer?.disconnect(); observer = null; window.clearTimeout(timeout); }
  function enter() {
    stopWaiting();
    const controller = new window.AbortController();
    active = controller;
    let claimed = false;
    const ready = () => {
      if (claimed || !findPicker(document) || controller.signal.aborted) return;
      claimed = true;
      stopWaiting();
      const previous = operation;
      operation = (async () => {
        await previous;
        if (disposed || controller.signal.aborted) return;
        const interrupt = event => { if (event.isTrusted) controller.abort('user-interaction'); };
        for (const type of ['pointerdown', 'keydown', 'input']) document.addEventListener(type, interrupt, true);
        try {
          const defaults = getSettings ? await getSettings() : settings;
          const retryable = new Set(['model-picker-missing', 'model-picker-replaced', 'model-menu-missing', 'model-unconfirmed', 'thinking-menu-missing']);
          let result;
          // A rendered trigger can precede its native popover's hydration. Retry
          // only transient failures, always re-reading selection before clicking.
          for (let attempt = 0; attempt < 3; attempt++) {
            if (disposed || controller.signal.aborted || !appRoute(window)) return;
            result = await applyGeminiDefaults(document, defaults, { signal: controller.signal, timeoutMs: applyTimeoutMs });
            if (result.complete || !retryable.has(result.reason)) break;
            if (attempt < 2) await delay(window, retryDelayMs, controller.signal);
          }
          if (!controller.signal.aborted) onResult?.(result);
        } finally {
          for (const type of ['pointerdown', 'keydown', 'input']) document.removeEventListener(type, interrupt, true);
        }
      })().catch(error => { if (!controller.signal.aborted) onResult?.({ complete: false, reason: error.message }); });
    };
    observer = new window.MutationObserver(ready);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'aria-disabled', 'hidden'] });
    timeout = window.setTimeout(() => { stopWaiting(); controller.abort('model-picker-timeout'); }, timeoutMs);
    ready();
  }
  function checkRoute() {
    if (disposed) return;
    const isApp = appRoute(window);
    if (isApp !== wasApp) {
      wasApp = isApp;
      active?.abort('navigation'); stopWaiting();
      if (isApp) enter();
    }
  }
  function start() {
    if (started || disposed) return;
    started = true;
    checkRoute();
    window.addEventListener('popstate', checkRoute);
    window.navigation?.addEventListener('currententrychange', checkRoute);
    // Only compare the route string. No perpetual DOM scan or model override.
    routeTimer = window.setInterval(checkRoute, routeIntervalMs);
  }
  function dispose() {
    disposed = true; active?.abort('disposed'); stopWaiting(); window.clearInterval(routeTimer);
    window.removeEventListener('popstate', checkRoute);
    window.navigation?.removeEventListener('currententrychange', checkRoute);
  }
  return { start, dispose };
}
