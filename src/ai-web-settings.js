import { GEMINI_MODE_NORMAL, GEMINI_MODE_SPARK, GEMINI_MODEL_OPTIONS, normalizeAIWebSettings, listAISites, selectedAISite, normalizeCustomAISite, validateAIWebSettings, aiSitePattern } from './ai-web.js';

export function installAIWebSettings({ document, chrome, onSaved, pickSendButton }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#ai-settings-dialog');
  const siteMenu = $('#ai-site-settings');
  const siteGroups = $('#ai-site-groups');
  const geminiOptions = $('#ai-gemini-options');
  const siteEditor = $('#ai-custom-fields');
  let draft = normalizeAIWebSettings();
  let editingId = null;
  let editingBuiltin = false;
  let picking = false;
  let disposed = false;
  document.defaultView.addEventListener('pagehide', () => { disposed = true; });
  const error = message => { $('#ai-settings-error').textContent = message; $('#ai-settings-error').hidden = !message; };
  function renderSiteGroups() {
    const expanded = new Set([...siteGroups.children].filter(group => group.open).map(group => group.dataset.siteId));
    // Keep the shared editor and Gemini controls (and their listeners) when rebuilding the list.
    dialog.insertBefore(siteEditor, $('#ai-settings-error'));
    geminiOptions.remove();
    siteGroups.replaceChildren();
    for (const site of listAISites(draft)) {
      const group = document.createElement('details');
      group.className = 'site-settings-group'; group.dataset.siteId = site.id; group.open = expanded.has(site.id);
      const summary = document.createElement('summary'); summary.textContent = site.name;
      const content = document.createElement('div'); content.className = 'site-settings-content';
      if (site.id === 'gemini') content.append(geminiOptions);
      const actions = document.createElement('div'); actions.className = 'settings-actions';
      const configure = document.createElement('button'); configure.type = 'button';
      configure.textContent = site.builtin ? '配置网站控件' : '编辑网站与控件';
      configure.addEventListener('click', () => { error(''); edit(site); });
      actions.append(configure); content.append(actions); group.append(summary, content); siteGroups.append(group);
    }
  }
  function render() {
    const select = $('#ai-active-site'); select.replaceChildren();
    for (const site of listAISites(draft)) { const option = document.createElement('option'); option.value = site.id; option.textContent = site.name; select.append(option); }
    select.value = draft.activeSiteId;
    $('#ai-gemini-spark').checked = draft.geminiMode === GEMINI_MODE_SPARK;
    const model = $('#ai-gemini-model'); model.replaceChildren();
    for (const optionData of GEMINI_MODEL_OPTIONS) { const option = document.createElement('option'); option.value = optionData.value; option.textContent = optionData.label; model.append(option); }
    model.value = draft.geminiModel;
    $('#ai-gemini-thinking').checked = draft.geminiExtendedThinking;
    const custom = !selectedAISite(draft).builtin;
    $('#ai-edit-site').hidden = false; $('#ai-edit-site').textContent = custom ? '编辑网站' : '配置网站'; $('#ai-remove-site').hidden = !custom;
    renderSiteGroups();
  }
  function edit(site) {
    if (!siteEditor.hidden) { error('请先保存或取消当前网站编辑。'); return; }
    if (site) {
      const group = [...siteGroups.children].find(candidate => candidate.dataset.siteId === site.id);
      siteMenu.open = true; group.open = true;
      group.querySelector('.site-settings-content').append(siteEditor);
    } else dialog.insertBefore(siteEditor, $('#ai-settings-error'));
    editingId = site?.id || `custom-${crypto.randomUUID()}`;
    editingBuiltin = Boolean(site?.builtin);
    $('#ai-site-name').value = site?.name || '';
    $('#ai-site-url').value = site?.url || '';
    $('#ai-site-name').readOnly = editingBuiltin; $('#ai-site-url').readOnly = editingBuiltin;
    $('#ai-site-help').textContent = editingBuiltin ? '保留内置适配。识别失败时可点选发送按钮，或在高级配置中指定控件。' : '默认自动识别输入框和发送控件。自定义网站支持文本引用；能否在侧栏加载取决于原站。';
    $('#ai-pick-status').hidden = true;
    for (const key of ['composer', 'send', 'mount']) $(`#ai-selector-${key}`).value = site?.selectors[key] || '';
    $('#ai-send-shortcut').value = site?.sendShortcut || 'enter';
    $('#ai-custom-fields').hidden = false;
    $('#ai-site-name').focus();
  }
  async function open() {
    if (picking) return;
    error(''); $('#ai-custom-fields').hidden = true; editingId = null;
    siteMenu.open = false;
    for (const group of siteGroups.children) group.open = false;
    dialog.showModal();
    $('#ai-save-settings').disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SIDER_AI_WEB_SETTINGS_GET' });
      if (!response?.ok) throw new Error(response?.error || '无法读取 AI 网站设置。');
      draft = normalizeAIWebSettings(response.settings); render();
      $('#ai-save-settings').disabled = false;
    } catch (cause) { error(cause.message); }
  }
  $('#ai-settings-toggle').addEventListener('click', () => {
    if (!chrome?.runtime?.id) { error('请安装扩展后配置 AI 网站。'); dialog.showModal(); return; }
    void open();
  });
  $('#ai-close-settings').addEventListener('click', () => dialog.close());
  $('#ai-active-site').addEventListener('change', () => { draft.activeSiteId = $('#ai-active-site').value; $('#ai-custom-fields').hidden = true; editingId = null; error(''); render(); });
  $('#ai-gemini-spark').addEventListener('change', () => { draft.geminiMode = $('#ai-gemini-spark').checked ? GEMINI_MODE_SPARK : GEMINI_MODE_NORMAL; error(''); });
  $('#ai-gemini-model').addEventListener('change', () => { draft.geminiModel = $('#ai-gemini-model').value; error(''); });
  $('#ai-gemini-thinking').addEventListener('change', () => { draft.geminiExtendedThinking = $('#ai-gemini-thinking').checked; error(''); });
  $('#ai-add-site').addEventListener('click', () => { error(''); edit(); });
  $('#ai-edit-site').addEventListener('click', () => { error(''); edit(selectedAISite(draft)); });
  $('#ai-cancel-edit').addEventListener('click', () => { $('#ai-custom-fields').hidden = true; editingId = null; error(''); });
  $('#ai-reset-send').addEventListener('click', () => { $('#ai-selector-send').value = ''; $('#ai-pick-status').hidden = true; });
  $('#ai-pick-send').addEventListener('click', async () => {
    error('');
    if (!pickSendButton) { error('请先加载此网站，再点选发送按钮。'); return; }
    let site;
    try {
      site = editingBuiltin ? listAISites(draft).find(candidate => candidate.id === editingId) : normalizeCustomAISite({ id: editingId, name: $('#ai-site-name').value, url: $('#ai-site-url').value });
    } catch (cause) { error(cause.message); return; }
    picking = true;
    if (dialog.closeImmediately) dialog.closeImmediately(); else dialog.close();
    try {
      const result = await pickSendButton(site);
      if (disposed) return;
      if (result?.ok && typeof result.selector === 'string') {
        document.querySelector(result.selector);
        $('#ai-selector-send').value = result.selector;
        $('#ai-pick-status').textContent = '已选中发送按钮。保存网站和全局设置后，重新加载侧栏生效。';
        $('#ai-pick-status').hidden = false;
      } else if (result?.cancelled) {
        $('#ai-pick-status').textContent = '已取消点选，配置未更改。'; $('#ai-pick-status').hidden = false;
      } else error(result?.error || '未能点选发送按钮，请重试。');
    } catch (cause) { if (!disposed) error(cause.message); }
    finally { picking = false; if (!disposed) { dialog.showModal(); $('#ai-apply-site').focus(); } }
  });
  $('#ai-apply-site').addEventListener('click', () => {
    try {
      const selectors = Object.fromEntries(['composer', 'send', 'mount'].map(key => [key, $(`#ai-selector-${key}`).value.trim()]));
      for (const selector of Object.values(selectors)) if (selector) document.querySelector(selector);
      const controls = { selectors, sendShortcut: $('#ai-send-shortcut').value };
      const settings = editingBuiltin
        ? validateAIWebSettings({ ...draft, builtinOverrides: { ...draft.builtinOverrides, [editingId]: controls } })
        : (() => {
          const site = normalizeCustomAISite({ id: editingId, name: $('#ai-site-name').value, url: $('#ai-site-url').value, ...controls });
          const existing = draft.customSites.some(candidate => candidate.id === site.id);
          return validateAIWebSettings({ ...draft, activeSiteId: existing ? draft.activeSiteId : site.id, customSites: [...draft.customSites.filter(candidate => candidate.id !== site.id), site] });
        })();
      draft = settings; $('#ai-custom-fields').hidden = true; editingId = null; error(''); render();
    } catch (cause) { error(cause.name === 'SyntaxError' ? 'CSS 选择器无效，请检查高级配置。' : cause.message); }
  });
  $('#ai-remove-site').addEventListener('click', () => {
    draft.customSites = draft.customSites.filter(site => site.id !== draft.activeSiteId); draft.activeSiteId = 'chatgpt';
    $('#ai-custom-fields').hidden = true; editingId = null; error(''); render();
  });
  $('#ai-save-settings').addEventListener('click', async () => {
    if (!$('#ai-custom-fields').hidden) {
      for (let parent = siteEditor.parentElement; parent && parent !== dialog; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      error('请先保存或取消当前网站编辑。'); $('#ai-apply-site').focus(); return;
    }
    const button = $('#ai-save-settings'); button.disabled = true; error('');
    const controls = [...dialog.querySelectorAll('input,select,button')].filter(control => control.id !== 'ai-close-settings' && control !== button);
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    try {
      const settings = validateAIWebSettings(draft);
      const site = selectedAISite(settings);
      // Keep the permission request directly in the Save click's user gesture.
      const granted = await chrome.permissions.request({ origins: [aiSitePattern(site)] });
      if (!granted) throw new Error(`${site.name} 的访问权限未授予，设置尚未保存。`);
      const result = await chrome.runtime.sendMessage({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings });
      if (!result?.ok) throw new Error(result?.error || '设置保存失败，请重试。');
      dialog.close(); onSaved?.(normalizeAIWebSettings(result.settings));
    } catch (cause) { error(cause.message); }
    finally { button.disabled = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
  });
  render();
}
