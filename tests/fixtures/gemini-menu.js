// Native-style Gemini controls for unit and isolated browser regression.
// Options use labels and checkmarks; opaque mode IDs intentionally vary.
export function mountGeminiMenu(document, {
  model = 'flash-lite', thinkingLevel = 'low', compact = false, inline = false,
  rebuild = true, changeDelay = 0, submenuDelay = 0, ignoreThinking = false, english = false,
} = {}) {
  const window = document.defaultView;
  const labels = { 'flash-lite': '3.5 Flash-Lite', flash: '3.8 Flash', pro: '3.1 Pro', argon: '4 Argon' };
  const levels = english ? { low: 'Low', medium: 'Medium', high: 'High' } : { low: '低点', medium: '中等', high: '高点' };
  const state = { model, thinkingLevel };
  const counts = { opened: 0, models: 0, thinking: 0 };
  const root = document.createElement('div'); root.id = 'native-controls';
  const picker = document.createElement('button'); picker.id = 'native-picker';
  picker.setAttribute('aria-haspopup', 'menu');
  if (compact) {
    const host = document.createElement('gem-button'); host.setAttribute('data-test-id', 'bard-mode-menu-button');
    host.append(picker); root.append(host);
  } else {
    picker.setAttribute('data-test-id', 'bard-mode-menu-button');
    picker.setAttribute('aria-controls', 'native-model-menu'); picker.setAttribute('aria-expanded', 'false');
    root.append(picker);
  }
  document.body.append(root);
  let menu;
  let submenu;
  let serial = 0;
  function renderPicker() {
    picker.setAttribute('aria-label', 'Open model picker, currently Gemini ' + labels[state.model]);
    picker.textContent = compact ? 'Gemini' + labels[state.model] : labels[state.model];
  }
  function close() {
    if (!menu) return;
    menu.hidden = true; menu.setAttribute('data-visible', 'false');
    if (!compact) picker.setAttribute('aria-expanded', 'false');
    if (rebuild) { menu.remove(); menu = null; submenu = null; }
  }
  function option(label, selected, attributes, action) {
    const node = document.createElement('gem-menu-item'); node.setAttribute('role', 'menuitem');
    node.setAttribute('aria-disabled', 'false'); node.tabIndex = -1;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    const content = document.createElement('gem-menu-item-content'); content.className = 'checkmark-only';
    const text = document.createElement('span'); text.className = 'label'; text.textContent = label;
    content.append(text); node.append(content);
    mark(node, selected);
    node.addEventListener('click', event => { event.stopPropagation(); action(); });
    return node;
  }
  function mark(node, checked) {
    node.classList.toggle('selected', checked);
    const content = node.querySelector('gem-menu-item-content'); content.classList.toggle('selected', checked);
    content.querySelector('[fonticon="check"]')?.remove();
    if (checked) { const icon = document.createElement('mat-icon'); icon.setAttribute('fonticon', 'check'); content.prepend(icon); }
  }
  function later(action, delay) { if (delay) window.setTimeout(action, delay); else action(); }
  function renderMenu() {
    serial++;
    menu = document.createElement('gem-menu'); menu.id = 'native-model-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('data-test-id', 'gem-mode-menu');
    menu.setAttribute('data-visible', 'true'); menu.tabIndex = -1;
    for (const [value, label] of Object.entries(labels)) {
      const node = option(label, value === state.model, { 'data-model': value, 'data-mode-id': serial + '-' + value }, () => {
        counts.models++;
        later(() => {
          state.model = value; renderPicker();
          for (const item of menu.querySelectorAll('[data-model]')) mark(item, item.getAttribute('data-model') === value);
          close();
        }, changeDelay);
      });
      node.setAttribute('data-active', String(value === 'flash-lite'));
      menu.append(node);
    }
    const trigger = option(english ? 'Thinking level' : '思考等级', false, { value: 'thinking_level', 'aria-haspopup': inline ? 'false' : 'true', 'aria-expanded': 'false' }, () => {
      const surface = submenu;
      later(() => {
        if (!surface.isConnected) return;
        surface.hidden = false; surface.setAttribute('data-visible', 'true');
        trigger.setAttribute('aria-expanded', 'true');
      }, submenuDelay);
    });
    submenu = document.createElement(inline ? 'div' : 'gem-menu'); submenu.id = 'native-thinking-menu';
    submenu.hidden = true; submenu.setAttribute('data-visible', 'false');
    if (!inline) { submenu.setAttribute('role', 'menu'); trigger.setAttribute('aria-controls', submenu.id); }
    for (const [value, label] of Object.entries(levels)) {
      submenu.append(option(label, value === state.thinkingLevel, { 'data-level': value }, () => {
        counts.thinking++;
        if (ignoreThinking) return;
        later(() => {
          state.thinkingLevel = value;
          if (rebuild) close();
          else for (const node of submenu.querySelectorAll('[data-level]')) mark(node, node.getAttribute('data-level') === value);
        }, changeDelay);
      }));
    }
    // Real compact Gemini nests .expand-content inside its parent menuitem,
    // without an extra role=menu boundary. It is not a sibling submenu.
    if (inline) { submenu.className = 'expand-content'; trigger.append(submenu); }
    menu.append(trigger);
    if (!inline) menu.append(submenu);
    root.append(menu);
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  }
  picker.addEventListener('click', () => {
    if (compact && (!menu || menu.hidden) && document.activeElement !== picker) return;
    if (menu && !menu.hidden) { close(); return; }
    counts.opened++;
    if (!menu) renderMenu();
    else { menu.hidden = false; menu.setAttribute('data-visible', 'true'); }
    if (!compact) picker.setAttribute('aria-expanded', 'true');
    menu.focus();
  });
  renderPicker();
  return { root, picker, state, counts, close, get menu() { return menu; }, get submenu() { return submenu; } };
}
