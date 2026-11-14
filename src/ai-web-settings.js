import { GEMINI_MODE_NORMAL, GEMINI_MODE_SPARK, normalizeAIWebSettings, listAISites, selectedAISite, normalizeCustomAISite, validateAIWebSettings, aiSitePattern } from './ai-web.js';
import { GEMINI_CATALOG_KEY, geminiLevelNumber, geminiModelValue, resolveGeminiModel, validateGeminiCatalog } from './gemini-catalog.js';
import { CHATGPT_CATALOG_KEY, chatgptModelId, chatgptModelValue, chatgptPresetValue, validateChatGPTCatalog } from './chatgpt-catalog.js';
import { installSettingsNavigation } from './settings-navigation.js';

export function installAIWebSettings({ document, chrome, onSaved, pickSendButton }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#ai-settings-dialog');
  const siteMenu = $('#ai-site-settings');
  const siteGroups = $('#ai-site-groups');
  const geminiOptions = $('#ai-gemini-options');
  const chatgptOptions = $('#ai-chatgpt-options');
  const siteEditor = $('#ai-custom-fields');
  const editorHome = $('#ai-editor-home');
  const navigation = installSettingsNavigation(document);
  let draft = normalizeAIWebSettings();
  let savedDraft = JSON.stringify(draft);
  let saving = false;
  let editingId = null;
  let editingBuiltin = false;
  let picking = false;
  let disposed = false;
  let editOpener = null;
  let geminiCatalog = null, catalogRevision = 0, geminiEdited = false;
  let chatgptCatalog = null, chatgptCatalogRevision = 0, chatgptEdited = false;
  document.defaultView.addEventListener('pagehide', () => { disposed = true; });
  const error = message => { $('#ai-settings-error').textContent = message; $('#ai-settings-error').hidden = !message; };
  const status = message => { $('#ai-settings-status').textContent = message; $('#ai-settings-status').hidden = !message; };
  const dirty = () => !siteEditor.hidden || JSON.stringify(draft) !== savedDraft;
  function updateSaveHint() {
    const pending = dirty();
    dialog.toggleAttribute('data-unsaved', pending);
    const immediate = ['appearance', 'launcher'].includes(dialog.dataset.settingsSection);
    $('#ai-save-settings').hidden = immediate && !pending;
    $('#settings-done').hidden = !immediate || pending;
    $('#settings-save-hint').textContent = pending ? 'AI 网站或引用有未保存的更改' : immediate ? '本页设置立即保存，无需再次保存' : 'AI 网站与引用设置保存后生效';
  }
  function requestClose() {
    if (saving || picking) return;
    if (!dirty()) { dialog.close(); return; }
    $('#settings-discard').hidden = false;
    $('#settings-keep-editing').focus();
  }
  dialog.addEventListener('sider-settings-section', updateSaveHint);
  dialog.addEventListener('input', updateSaveHint);
  dialog.addEventListener('change', updateSaveHint);
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  $('#settings-keep-editing').addEventListener('click', () => { $('#settings-discard').hidden = true; $('#ai-close-settings').focus(); });
  $('#settings-discard-close').addEventListener('click', () => { $('#settings-discard').hidden = true; dialog.close(); });
  function revealEditor() {
    navigation.activate('ai');
    for (let parent = siteEditor.parentElement; parent && parent !== dialog; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    error('请先完成或取消当前网站编辑。'); $('#ai-apply-site').focus();
  }
  function finishEdit() {
    siteEditor.hidden = true; editingId = null; error('');
    const opener = editOpener?.isConnected ? editOpener : $('#ai-edit-site');
    opener.focus();
    updateSaveHint();
  }
  function renderSiteGroups() {
    const expanded = new Set([...siteGroups.children].filter(group => group.open).map(group => group.dataset.siteId));
    // Keep the shared editor and website controls (and their listeners) when rebuilding the list.
    editorHome.append(siteEditor);
    geminiOptions.remove(); chatgptOptions.remove();
    siteGroups.replaceChildren();
    for (const site of listAISites(draft)) {
      const group = document.createElement('details');
      group.className = 'site-settings-group'; group.dataset.siteId = site.id; group.open = expanded.has(site.id);
      const summary = document.createElement('summary');
      const name = document.createElement('span'); name.className = 'site-name'; name.textContent = site.name;
      const badge = document.createElement('span'); badge.className = 'site-badge';
      const selected = site.id === draft.activeSiteId;
      group.toggleAttribute('data-selected', selected);
      badge.textContent = selected ? '已选择' : site.builtin ? '内置' : '自定义';
      summary.append(name, badge);
      const content = document.createElement('div'); content.className = 'site-settings-content';
      if (site.id === 'gemini') content.append(geminiOptions);
      if (site.id === 'chatgpt') content.append(chatgptOptions);
      const controls = document.createElement('section'); controls.className = 'setting-block';
      const title = document.createElement('h3'); title.textContent = '网站控件';
      const description = document.createElement('p'); description.className = 'setting-help';
      description.textContent = '输入框或发送按钮识别异常时，在这里调整。';
      const actions = document.createElement('div'); actions.className = 'settings-actions';
      const configure = document.createElement('button'); configure.type = 'button';
      configure.textContent = site.builtin ? '配置网站控件' : '编辑网站与控件';
      configure.addEventListener('click', () => { error(''); edit(site); });
      actions.append(configure); controls.append(title, description, actions); content.append(controls); group.append(summary, content); siteGroups.append(group);
    }
  }
  function renderGeminiOptions() {
    const model = $('#ai-gemini-model'), thinking = $('#ai-gemini-thinking');
    model.replaceChildren(); thinking.replaceChildren();
    const add = (select, value, label, disabled = false) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; option.disabled = disabled; select.append(option);
    };
    if (!geminiCatalog) {
      add(model, '', '请先打开或刷新 Gemini 页面', true);
      add(thinking, '', '等待网页提供可用等级', true);
      model.disabled = thinking.disabled = true;
      $('#ai-gemini-catalog-status').textContent = '打开或刷新 Gemini 后，模型和思考等级会自动读取。';
      return;
    }
    model.disabled = false;
    const selected = resolveGeminiModel(geminiCatalog.models, draft.geminiModel);
    if (!selected) add(model, '__missing__', '已保存的模型在当前页面不可用', true);
    for (const entry of geminiCatalog.models) add(model, geminiModelValue(entry.id), entry.available ? entry.label : `${entry.label}（需升级或不可用）`, !entry.available);
    model.value = selected ? geminiModelValue(selected.id) : '__missing__';
    $('#ai-gemini-catalog-status').textContent = selected?.available === false
      ? '已保存的模型在当前账号不可用，请选择其他模型。' : '已从最近加载的 Gemini 页面读取；重新加载网页时自动更新。';
    if (!selected?.available || !selected.levels.length) {
      add(thinking, 'site-default', selected?.available ? '网页未提供思考等级' : '当前模型没有可用等级', true);
      thinking.value = 'site-default'; thinking.disabled = true; return;
    }
    thinking.disabled = false;
    add(thinking, 'site-default', '跟随网页默认');
    const level = geminiLevelNumber(draft.geminiThinkingLevel);
    const matched = level !== null && selected.levels.some(item => item.id === level);
    if (draft.geminiThinkingLevel !== 'site-default' && !matched) add(thinking, '__missing__', '已保存的等级不适用于此模型', true);
    for (const item of selected.levels) add(thinking, `level:${item.id}`, item.label);
    thinking.value = draft.geminiThinkingLevel === 'site-default' ? 'site-default' : matched ? `level:${level}` : '__missing__';
  }
  function receiveGeminiCatalog(raw) {
    catalogRevision++;
    geminiCatalog = validateGeminiCatalog(raw);
    if (dialog.open && !saving) renderGeminiOptions();
  }
  function renderChatGPTOptions() {
    const model = $('#ai-chatgpt-model'), preset = $('#ai-chatgpt-preset');
    model.replaceChildren(); preset.replaceChildren();
    const add = (select, value, text, disabled = false) => {
      const option = document.createElement('option'); option.value = value; option.textContent = text; option.disabled = disabled; select.append(option);
    };
    add(model, 'site-default', '跟随网页默认');
    const selected = chatgptCatalog?.versions.find(item => item.id === chatgptModelId(draft.chatgptModel));
    if (draft.chatgptModel !== 'site-default' && !selected) add(model, '__missing__', '已保存的模型在当前页面不可用', true);
    for (const version of chatgptCatalog?.versions || []) add(model, chatgptModelValue(version.id), version.available ? version.label : `${version.label}（不可用）`, !version.available);
    model.value = draft.chatgptModel === 'site-default' ? 'site-default' : selected ? chatgptModelValue(selected.id) : '__missing__';
    model.disabled = false;
    const message = !chatgptCatalog ? '打开或刷新 ChatGPT 后，模型和推理档位会自动读取。'
      : selected?.available === false ? '已保存的模型在当前账号不可用，请重新选择。'
        : '已从最近加载的 ChatGPT 页面读取；重新加载网页时自动更新。';
    $('#ai-chatgpt-catalog-status').textContent = message;
    if (draft.chatgptModel === 'site-default') {
      add(preset, 'site-default', '跟随网页默认'); preset.value = 'site-default'; preset.disabled = true; return;
    }
    if (!selected?.available) {
      add(preset, '', '当前模型没有可用档位', true); preset.value = ''; preset.disabled = true; return;
    }
    add(preset, 'site-default', '请选择推理档位', true);
    const match = selected.presets.find(item => chatgptPresetValue(item) === draft.chatgptPreset);
    if (draft.chatgptPreset !== 'site-default' && !match) add(preset, '__missing__', '已保存的档位不适用于此模型', true);
    for (const item of selected.presets) add(preset, chatgptPresetValue(item), item.available ? item.label : `${item.label}（不可用）`, !item.available);
    preset.value = draft.chatgptPreset === 'site-default' ? 'site-default' : match ? chatgptPresetValue(match) : '__missing__';
    preset.disabled = false;
  }
  function receiveChatGPTCatalog(raw) {
    chatgptCatalogRevision++;
    chatgptCatalog = validateChatGPTCatalog(raw);
    if (dialog.open && !saving) renderChatGPTOptions();
  }
  chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'session' && changes[GEMINI_CATALOG_KEY]) receiveGeminiCatalog(changes[GEMINI_CATALOG_KEY].newValue);
    if (area === 'session' && changes[CHATGPT_CATALOG_KEY]) receiveChatGPTCatalog(changes[CHATGPT_CATALOG_KEY].newValue);
  });
  function render() {
    const select = $('#ai-active-site'); select.replaceChildren();
    for (const site of listAISites(draft)) { const option = document.createElement('option'); option.value = site.id; option.textContent = site.name; select.append(option); }
    select.value = draft.activeSiteId;
    $('#ai-gemini-spark').checked = draft.geminiMode === GEMINI_MODE_SPARK;
    renderGeminiOptions();
    renderChatGPTOptions();
    $('#reference-hide-unavailable-tabs').checked = draft.hideUnavailableTabs;
    const custom = !selectedAISite(draft).builtin;
    $('#ai-edit-site').hidden = false; $('#ai-edit-site').textContent = custom ? '编辑网站' : '配置网站'; $('#ai-remove-site').hidden = !custom;
    renderSiteGroups();
    updateSaveHint();
  }
  function edit(site) {
    if (!siteEditor.hidden) { revealEditor(); return; }
    editOpener = document.activeElement;
    status('完成编辑后，点击「保存更改」应用。');
    if (site) {
      const group = [...siteGroups.children].find(candidate => candidate.dataset.siteId === site.id);
      siteMenu.open = true; group.open = true;
      group.querySelector('.site-settings-content').append(siteEditor);
    } else editorHome.append(siteEditor);
    $('#ai-editor-title').textContent = site ? `编辑 ${site.name}` : '添加 AI 网站';
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
    updateSaveHint();
    $('#ai-site-name').focus();
  }
  async function open() {
    if (picking || dialog.open) return;
    error(''); status(''); $('#ai-custom-fields').hidden = true; editingId = null; geminiEdited = false; chatgptEdited = false;
    $('#settings-discard').hidden = true;
    navigation.activate('ai', { reset: true });
    siteMenu.open = true;
    for (const group of siteGroups.children) group.open = false;
    dialog.showModal();
    $('#ai-save-settings').disabled = true;
    try {
      const revision = catalogRevision;
      void chrome.runtime.sendMessage({ type: 'SIDER_GEMINI_CATALOG_GET' }).then(result => {
        if (!disposed && catalogRevision === revision) receiveGeminiCatalog(result?.catalog);
      }).catch(() => {});
      const chatgptRevision = chatgptCatalogRevision;
      void chrome.runtime.sendMessage({ type: 'SIDER_CHATGPT_CATALOG_GET' }).then(result => {
        if (!disposed && chatgptCatalogRevision === chatgptRevision) receiveChatGPTCatalog(result?.catalog);
      }).catch(() => {});
      const response = await chrome.runtime.sendMessage({ type: 'SIDER_AI_WEB_SETTINGS_GET' });
      if (!response?.ok) throw new Error(response?.error || '无法读取 AI 网站设置。');
      draft = normalizeAIWebSettings(response.settings); savedDraft = JSON.stringify(draft); render();
      $('#ai-save-settings').disabled = false;
    } catch (cause) { error(cause.message); }
  }
  $('#ai-settings-toggle').addEventListener('click', () => {
    if (!chrome?.runtime?.id) { error('请安装扩展后配置 AI 网站。'); dialog.showModal(); return; }
    void open();
  });
  $('#ai-close-settings').addEventListener('click', requestClose);
  $('#settings-done').addEventListener('click', requestClose);
  $('#ai-active-site').addEventListener('change', () => {
    if (!siteEditor.hidden) { $('#ai-active-site').value = draft.activeSiteId; revealEditor(); return; }
    draft.activeSiteId = $('#ai-active-site').value; error(''); status('网站已选择，保存后生效。'); render();
  });
  $('#ai-gemini-spark').addEventListener('change', () => { draft.geminiMode = $('#ai-gemini-spark').checked ? GEMINI_MODE_SPARK : GEMINI_MODE_NORMAL; error(''); });
  $('#ai-gemini-model').addEventListener('change', () => {
    draft.geminiModel = $('#ai-gemini-model').value; geminiEdited = true;
    const selected = resolveGeminiModel(geminiCatalog?.models || [], draft.geminiModel);
    if (selected && !selected.levels.length) draft.geminiThinkingLevel = 'site-default';
    error(''); renderGeminiOptions();
  });
  $('#ai-gemini-thinking').addEventListener('change', () => { draft.geminiThinkingLevel = $('#ai-gemini-thinking').value; geminiEdited = true; error(''); });
  $('#ai-chatgpt-model').addEventListener('change', () => {
    draft.chatgptModel = $('#ai-chatgpt-model').value; draft.chatgptPreset = 'site-default'; chatgptEdited = true;
    error(''); renderChatGPTOptions();
  });
  $('#ai-chatgpt-preset').addEventListener('change', () => { draft.chatgptPreset = $('#ai-chatgpt-preset').value; chatgptEdited = true; error(''); });
  $('#reference-hide-unavailable-tabs').addEventListener('change', () => { draft.hideUnavailableTabs = $('#reference-hide-unavailable-tabs').checked; error(''); });
  $('#ai-add-site').addEventListener('click', () => { error(''); edit(); });
  $('#ai-edit-site').addEventListener('click', () => { error(''); edit(selectedAISite(draft)); });
  $('#ai-cancel-edit').addEventListener('click', () => { finishEdit(); status('已取消本次网站编辑。'); });
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
      draft = settings; finishEdit(); render(); $('#ai-edit-site').focus(); status('网站编辑已完成，保存更改后生效。');
    } catch (cause) { error(cause.name === 'SyntaxError' ? 'CSS 选择器无效，请检查高级配置。' : cause.message); }
  });
  $('#ai-remove-site').addEventListener('click', () => {
    if (!siteEditor.hidden) { revealEditor(); return; }
    draft.customSites = draft.customSites.filter(site => site.id !== draft.activeSiteId); draft.activeSiteId = 'chatgpt';
    $('#ai-custom-fields').hidden = true; editingId = null; error(''); render();
  });
  $('#ai-save-settings').addEventListener('click', async () => {
    if (!$('#ai-custom-fields').hidden) {
      revealEditor(); return;
    }
    if (saving) return;
    saving = true;
    const button = $('#ai-save-settings'); button.disabled = true; button.textContent = '正在保存…'; button.setAttribute('aria-busy', 'true'); error('');
    const controls = [...dialog.querySelectorAll('input,select,button')].filter(control => control.id !== 'ai-close-settings' && control !== button);
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    try {
      const settings = validateAIWebSettings(draft);
      if (geminiEdited) {
        const model = resolveGeminiModel(geminiCatalog?.models || [], settings.geminiModel);
        const level = geminiLevelNumber(settings.geminiThinkingLevel);
        if (!model?.available) throw new Error('所选 Gemini 模型当前不可用，请重新选择。');
        if (settings.geminiThinkingLevel !== 'site-default' && !model.levels.some(item => item.id === level)) throw new Error('请选择此模型支持的思考等级。');
      }
      if (chatgptEdited && settings.chatgptModel !== 'site-default') {
        const version = chatgptCatalog?.versions.find(item => item.id === chatgptModelId(settings.chatgptModel));
        const preset = version?.presets.find(item => item.available && chatgptPresetValue(item) === settings.chatgptPreset);
        if (!version?.available || !preset) throw new Error('请选择当前 ChatGPT 模型支持的推理档位。');
      }
      const site = selectedAISite(settings);
      // Keep the permission request directly in the Save click's user gesture.
      const granted = await chrome.permissions.request({ origins: [aiSitePattern(site)] });
      if (!granted) throw new Error(`${site.name} 的访问权限未授予，设置尚未保存。`);
      const result = await chrome.runtime.sendMessage({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings });
      if (!result?.ok) throw new Error(result?.error || '设置保存失败，请重试。');
      savedDraft = JSON.stringify(draft); updateSaveHint(); dialog.close(); onSaved?.(normalizeAIWebSettings(result.settings));
    } catch (cause) { error(cause.message); }
    finally { saving = false; button.disabled = false; button.textContent = '保存更改'; button.removeAttribute('aria-busy'); controls.forEach((control, index) => { control.disabled = disabled[index]; }); if (dialog.open) { renderGeminiOptions(); renderChatGPTOptions(); } }
  });
  render();
}
