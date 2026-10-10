// Keep search and focus independent of context polling and preset list updates.
export function createSourcePicker({ document, getSource, isBusy, listTabs, selectTab, onError, onSelected, requestAccess }) {
  const view = document.defaultView;
  const node = (tag, attributes = {}, text = '') => {
    const result = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, value);
    result.textContent = text; return result;
  };
  const container = node('div', { class: 'source-picker' });
  const line = node('div', { class: 'source-line' });
  const trigger = node('button', { type: 'button', class: 'source source-trigger', 'aria-label': '切换引用来源标签页', 'aria-expanded': 'false', 'aria-controls': 'source-tab-menu' });
  const title = node('span', { class: 'source-title' });
  trigger.append(title, node('span', { 'aria-hidden': 'true' }, '▾'));
  const back = node('button', { type: 'button', class: 'source-back', 'aria-label': '切回当前标签页', title: '切回当前标签页', hidden: '' }, '↩ 当前页');
  line.append(trigger, back);
  const stateNote = node('p', { class: 'note source-state-note', hidden: '' });
  const grant = node('button', { type: 'button', class: 'source-grant', hidden: '' }, '允许来源网站');
  const menu = node('div', { id: 'source-tab-menu', class: 'source-menu', hidden: '' });
  const search = node('input', { type: 'search', class: 'source-search', placeholder: '搜索标签页标题或网址', 'aria-label': '搜索标签页', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'source-tab-options', autocomplete: 'off' });
  const note = node('p', { class: 'note source-menu-status', role: 'status' });
  const list = node('div', { id: 'source-tab-options', class: 'source-options', role: 'listbox', 'aria-label': '打开的标签页' });
  menu.append(search, note, list); container.append(line, stateNote, grant, menu);
  let open = false, disposed = false, switching = false, fetching = false;
  let tabs = [], ownerWindowId, active = -1, timer, identity = '', query = '', generation = 0;
  const busy = () => switching || isBusy();
  const filtered = () => tabs.filter(tab => !query || `${tab.title}\n${tab.url}`.toLocaleLowerCase().includes(query));
  function highlight(index, scroll = false) {
    const choices = filtered();
    active = index;
    for (const row of list.querySelectorAll('[role="option"]')) row.classList.toggle('active', Number(row.dataset.index) === active);
    const selected = choices[active];
    if (selected && !selected.disabledReason) {
      search.setAttribute('aria-activedescendant', `source-tab-${selected.tabId}`);
      if (scroll) list.querySelector(`#source-tab-${selected.tabId}`)?.scrollIntoView?.({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');
  }
  function renderList() {
    const choices = filtered(), source = getSource();
    const previousTabId = list.querySelector('.active')?.dataset.tabId;
    list.replaceChildren();
    const windows = [...new Set(tabs.map(tab => tab.windowId))];
    const groups = new Map();
    choices.forEach((tab, index) => {
      let group = groups.get(tab.windowId);
      if (!group) {
        const label = tab.windowId === ownerWindowId ? '当前窗口' : `窗口 ${windows.indexOf(tab.windowId) + 1}`;
        group = node('div', { role: 'group', 'aria-label': label }); groups.set(tab.windowId, group);
        if (windows.length > 1) group.append(node('div', { class: 'source-window', 'aria-hidden': 'true' }, label));
        list.append(group);
      }
      const row = node('button', { type: 'button', role: 'option', id: `source-tab-${tab.tabId}`, tabindex: '-1',
        'data-index': String(index), 'data-tab-id': String(tab.tabId), 'aria-selected': String(tab.tabId === source.tabId), class: 'source-option' });
      row.disabled = Boolean(tab.disabledReason) || busy();
      row.title = tab.disabledReason || tab.url || tab.title;
      const label = tab.title + (tab.tabId === source.tabId ? ' · 正在引用' : tab.tabId === source.ownerTabId ? ' · 当前页' : '');
      row.append(node('span', { class: 'source-option-title' }, label), node('span', { class: 'source-option-url' }, tab.disabledReason || tab.url));
      row.addEventListener('click', () => void choose(tab.tabId));
      row.addEventListener('pointermove', () => { if (!row.disabled) highlight(index); });
      group.append(row);
    });
    note.textContent = fetching && !tabs.length ? '正在读取标签页…' : !choices.length ? query ? '没有匹配的标签页。' : '没有可显示的标签页。' : '';
    note.hidden = !note.textContent;
    let next = choices.findIndex(tab => String(tab.tabId) === previousTabId && !tab.disabledReason);
    if (next < 0) next = choices.findIndex(tab => tab.tabId === source.tabId && !tab.disabledReason);
    if (next < 0) next = choices.findIndex(tab => !tab.disabledReason);
    highlight(next);
  }
  function sync() {
    if (disposed) return;
    const source = getSource();
    const unavailable = ['closed', 'unsupported', 'error'].includes(source.status);
    const text = (source.title || '当前网页') + (source.status === 'closed' ? ' · 已关闭' : unavailable ? ' · 无法引用' : '');
    if (title.textContent !== text) title.textContent = text;
    trigger.title = source.error || source.title || '切换引用来源标签页';
    trigger.disabled = busy(); back.disabled = busy(); search.disabled = busy();
    stateNote.textContent = source.error || ''; stateNote.hidden = !source.error;
    grant.hidden = source.status !== 'needs-access' || !requestAccess; grant.disabled = busy();
    back.hidden = source.tabId === source.ownerTabId;
    for (const row of list.querySelectorAll('[role="option"]')) {
      const tab = tabs.find(tab => tab.tabId === Number(row.dataset.tabId));
      row.disabled = Boolean(tab?.disabledReason) || busy();
    }
    const nextIdentity = JSON.stringify([tabs, query, source.tabId]);
    if (open && nextIdentity !== identity) { identity = nextIdentity; renderList(); }
  }
  function close({ restoreFocus = true } = {}) {
    if (!open) return;
    open = false; generation++; menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-expanded', 'false');
    view.clearInterval(timer); timer = null;
    if (restoreFocus && !disposed) trigger.focus({ preventScroll: true });
  }
  async function refresh() {
    if (!open || disposed || fetching) return;
    fetching = true; const expected = generation;
    if (!tabs.length) renderList();
    try {
      const result = await listTabs();
      if (!open || disposed || expected !== generation) return;
      tabs = result.tabs; ownerWindowId = result.ownerWindowId;
      fetching = false; sync();
    } catch (error) {
      if (!open || disposed || expected !== generation) return;
      note.textContent = error.message || '标签页读取失败，请重新打开后重试。'; note.hidden = false;
    } finally { fetching = false; }
  }
  async function choose(tabId) {
    if (busy() || disposed) return;
    switching = true; sync();
    try {
      await selectTab(tabId);
      if (disposed) return;
      close({ restoreFocus: false });
      onSelected?.();
    } catch (error) { if (!disposed) { onError(error); note.textContent = error.message; note.hidden = false; } }
    finally { switching = false; sync(); if (!disposed && !open) trigger.focus({ preventScroll: true }); }
  }
  trigger.addEventListener('click', () => {
    if (busy()) return;
    if (open) { close(); return; }
    open = true; generation++; menu.hidden = false; query = ''; search.value = ''; identity = '';
    trigger.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-expanded', 'true');
    sync(); search.focus({ preventScroll: true });
    void refresh(); timer = view.setInterval(() => void refresh(), 1500);
  });
  back.addEventListener('click', () => void choose(getSource().ownerTabId));
  grant.addEventListener('click', () => {
    if (busy()) return;
    try { requestAccess?.(); } catch (error) { onError(error); }
  });
  search.addEventListener('input', () => { query = search.value.trim().toLocaleLowerCase(); identity = ''; sync(); });
  search.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    const choices = filtered();
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      let index = active;
      for (let count = 0; count < choices.length; count++) {
        index = (index + step + choices.length) % choices.length;
        if (!choices[index].disabledReason) { highlight(index, true); break; }
      }
    } else if (event.key === 'Enter') {
      event.preventDefault(); if (choices[active] && !choices[active].disabledReason) void choose(choices[active].tabId);
    }
  });
  const outside = event => { if (open && !event.composedPath().includes(container)) close({ restoreFocus: false }); };
  document.addEventListener('pointerdown', outside, true);
  sync();
  return { element: container, sync, refresh, close, isOpen: () => open, dispose() { disposed = true; close({ restoreFocus: false }); document.removeEventListener('pointerdown', outside, true); } };
}
