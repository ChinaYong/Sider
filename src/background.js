import { getState, patchState, addReference, removeReference, updateReference, setReferenceSelected } from './store.js';
import { TAB_CONTEXT_PREFIX, expandTemplateItem } from './context.js';
import { getTabContext, updateTabSelection, setTabAttachment, applyTemplateDefaults, setTabTemplate, clearTabTemplates, requestTabPage, invalidateTabSource, clearTabSelection, resetTabContext, removeTabContext, getContextSettings, patchContextSettings, syncTemplateDemand } from './context-store.js';
import { createReferenceSessions, referenceSource, REFERENCE_SESSIONS_KEY } from './reference-sessions.js';
import { AI_WEB_SETTINGS_KEY, BUILTIN_AI_SITES, aiSiteURL, normalizeAIWebSettings, validateAIWebSettings, normalizeCustomAISite, listAISites, selectedAISite, siteForURL, aiSitePattern } from './ai-web.js';
import { UNIFIED_TEMPLATES_KEY, PRESET_IDS, getTemplates, validateTemplates } from './prompt-templates.js';
import { needsPageVariables, needsTemplateSelection } from './variables.js';
import { CONFIGURATION_KEYS, ENABLED_ORIGINS_KEY, exportConfiguration, validateConfiguration, configurationStorage } from './configuration.js';
import { installLauncherBackground } from './launcher-background.js';
import { installSidePanelState } from './side-panel-state.js';

const launchers = installLauncherBackground(chrome);
const panelState = installSidePanelState(chrome);
const referenceSessions = createReferenceSessions(chrome);

const extensionRoot = chrome.runtime.getURL('/');
const recentSources = new Map();
const chatFrames = new Map();
const chatPorts = new Set();
const embedRegistrations = new Map();
const panelPorts = new Map();
const EMBED_STORAGE_KEY = 'siderEmbedRegistrations';
const ENHANCEMENT_MESSAGES = new Set(['SIDER_TAB_CONTEXT_GET', 'SIDER_TAB_ATTACHMENT_SET', 'SIDER_TAB_TEMPLATE_SET', 'SIDER_TAB_TEMPLATES_CLEAR', 'SIDER_TAB_SELECTION_CLEAR', 'SIDER_CONTEXT_SETTINGS_PATCH', 'SIDER_SOURCE_INFO', 'SIDER_SOURCE_TABS_LIST', 'SIDER_REFERENCE_SOURCE_SET', 'SIDER_TEMPLATE_CONTEXT_GET', 'SIDER_PROMPT_TEMPLATES_GET', 'SIDER_PROMPT_TEMPLATES_SAVE']);
const CONTENT_MESSAGES = new Set(['SIDER_SELECTION_CHANGED', 'SIDER_OPEN_SOURCE_PANEL']);
const tabOperations = new Map();
const liveSources = new Map();
const sourceVersions = new Map();
const SITE_KEY = 'siderEnabledOrigins';
const EMBED_RULE_ID = 731001;
const EMBED_PERMISSION = 'declarativeNetRequestWithHostAccess';
let siteQueue = Promise.resolve();
let embedQueue = Promise.resolve();
let embedInitialization = Promise.resolve();
let embedRuleInstalled = false;
let requestSequence = 0;
let aiWebSettings = normalizeAIWebSettings();
let aiSettingsLoaded = false;
const aiSettingsInitialization = chrome.storage.local.get(AI_WEB_SETTINGS_KEY).then(data => { aiWebSettings = normalizeAIWebSettings(data[AI_WEB_SETTINGS_KEY]); aiSettingsLoaded = true; });
let aiSettingsQueue = Promise.resolve();
let installedEmbedSignature = '';
let installedEmbedRuleIds = [EMBED_RULE_ID];
let aiScriptsQueue = Promise.resolve();
let configurationQueue = Promise.resolve();
function configurationOperation(operation) {
  const pending = configurationQueue.then(operation);
  configurationQueue = pending.catch(() => {}); return pending;
}

function syncAIScripts(settings = aiWebSettings) {
  const operation = aiScriptsQueue.then(() => performAIScriptSync(settings));
  aiScriptsQueue = operation.catch(() => {});
  return operation;
}

async function performAIScriptSync(settings) {
  if (!chrome.scripting.getRegisteredContentScripts) return;
  const sites = new Map(listAISites(settings).map(site => [site.origin, site]));
  for (const registration of embedRegistrations.values()) if (registration.site) sites.set(registration.site.origin, registration.site);
  const desired = [];
  for (const site of sites.values()) {
    if (site.id === 'chatgpt' || !await chrome.permissions.contains({ origins: [aiSitePattern(site)] })) continue;
    desired.push({ id: `sider-ai-drop-${encodeURIComponent(site.origin)}`, matches: [aiSitePattern(site)], js: ['file-drop-main.js'], world: 'MAIN', runAt: 'document_start', allFrames: true, persistAcrossSessions: true });
    desired.push({ id: `sider-ai-${encodeURIComponent(site.origin)}`, matches: [aiSitePattern(site)], js: ['ai-content.js'], runAt: 'document_idle', allFrames: true, persistAcrossSessions: true });
  }
  const current = (await chrome.scripting.getRegisteredContentScripts()).filter(script => script.id.startsWith('sider-ai-'));
  const removed = current.filter(script => !desired.some(next => next.id === script.id && JSON.stringify(next.matches) === JSON.stringify(script.matches) && JSON.stringify(next.js) === JSON.stringify(script.js)
    && (next.world || 'ISOLATED') === (script.world || 'ISOLATED') && next.runAt === script.runAt));
  if (removed.length) await chrome.scripting.unregisterContentScripts({ ids: removed.map(script => script.id) });
  const added = desired.filter(script => !current.some(old => old.id === script.id && !removed.includes(old)));
  if (added.length) await chrome.scripting.registerContentScripts(added);
}

async function saveAISettings(raw) {
  const operation = configurationOperation(async () => {
    await aiSettingsInitialization;
    const settings = validateAIWebSettings(raw);
    const selected = selectedAISite(settings);
    if (!await chrome.permissions.contains({ origins: [aiSitePattern(selected)] })) throw new Error(`尚未获得 ${selected.name} 的网站访问权限，请在 AI 网站设置中授权后保存。`);
    // Register before committing so script-install failures remain reviewable in settings.
    const previous = aiWebSettings;
    try { await syncAIScripts(settings); await chrome.storage.local.set({ [AI_WEB_SETTINGS_KEY]: settings }); aiWebSettings = settings; }
    catch (error) { aiWebSettings = previous; await syncAIScripts().catch(() => {}); throw error; }
    return { ok: true, settings, sites: listAISites(settings) };
  });
  aiSettingsQueue = operation.catch(() => {});
  return operation;
}

function parseURL(value) {
  try { return new URL(value); } catch { return null; }
}

function isWebURL(value) {
  return ['https:', 'http:'].includes(parseURL(value)?.protocol);
}

function isChatURL(value) {
  const url = parseURL(value);
  return Boolean(url && (siteForURL(value, aiWebSettings) || [...embedRegistrations.values()].some(registration => registration.site?.origin === url.origin)));
}

function isExtensionSender(sender) {
  return sender?.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(extensionRoot);
}

function isPageSender(sender) {
  return sender?.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) && isWebURL(sender.url);
}

function isChatSender(sender) {
  return sender?.id === chrome.runtime.id && isChatURL(sender.url);
}

function authorize(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('请求格式错误。');
  if (isExtensionSender(sender)) return;
  if (message.type === 'SIDER_CHAT_READY' && isChatSender(sender)) return;
  if (message.type === 'SIDER_GEMINI_DEFAULTS_GET' && isChatSender(sender)) return;
  if (message.type === 'SIDER_ENHANCEMENT_REQUEST' && isChatSender(sender) && message.embedded && embedRegistration(sender, message.bridgeId)) return;
  if (isPageSender(sender) && !isChatURL(sender.url) && CONTENT_MESSAGES.has(message.type)) {
    if (message.type === 'SIDER_CAPTURE' && message.tabId != null && message.tabId !== sender.tab.id) {
      throw new Error('网页不能读取其他标签页。');
    }
    if (message.type === 'SIDER_CAPTURE' && message.frameId != null && message.frameId !== sender.frameId) {
      throw new Error('网页不能读取其他框架。');
    }
    return;
  }
  throw new Error('拒绝来自非扩展页面的请求。');
}

function rememberSource(tab) {
  if (Number.isInteger(tab?.id) && Number.isInteger(tab.windowId) && isWebURL(tab.url) && !isChatURL(tab.url)) {
    recentSources.set(tab.windowId, tab.id);
  }
}

function openPanelNow(tab) {
  // Keep this call synchronous with the action/context-menu/command/message gesture.
  if (!chrome.sidePanel?.open || !Number.isInteger(tab?.id)) return Promise.resolve({ ok: false, error: '当前标签页无法打开侧栏。' });
  // IPC calls preserve their order; configure before opening, without awaiting
  // unrelated tab/storage work that would consume the click's user gesture.
  void configureTabPanel(tab).catch(() => {});
  const revision = panelState.revision(tab.id);
  return chrome.sidePanel.open({ tabId: tab.id }).then(() => ({ ok: true, opened: panelState.commit(tab.id, revision, true) })).catch(error => {
    chrome.storage.local.set({ siderLastEvent: { ok: false, error: error.message, at: Date.now() } }).catch(() => {});
    return { ok: false, error: error.message || '打开侧栏失败，请重试。' };
  });
}

function closePanelNow(tab) {
  if (!chrome.sidePanel?.close || !Number.isInteger(tab?.id)) return Promise.resolve({ ok: false, error: '当前浏览器无法关闭侧栏。' });
  const revision = panelState.revision(tab.id);
  return chrome.sidePanel.close({ tabId: tab.id }).then(() => ({ ok: true, opened: panelState.commit(tab.id, revision, false) })).catch(error => {
    return { ok: false, error: error.message || '关闭侧栏失败，请重试。' };
  });
}

function configureTabPanel(tab) {
  if (!Number.isInteger(tab?.id)) return Promise.resolve();
  return chrome.sidePanel.setOptions({ tabId: tab.id, path: `panel.html?sourceTab=${tab.id}`, enabled: true });
}

function prepareSource(tab) {
  rememberSource(tab);
  void launchers.inject(tab).catch(() => {});
  if (Number.isInteger(tab?.id) && isWebURL(tab.url) && !isChatURL(tab.url)) {
    // Install while the source page still has its selection, before sidebar focus.
    void withTab(tab.id, () => syncSourceContext(tab.id)).catch(() => {});
  }
}

function sourceAccessError() {
  return Object.assign(new Error('当前网页还没有访问权限。请点击浏览器工具栏的 Sider 图标授权当前标签页，或允许访问此网站。'), { code: 'SOURCE_ACCESS_REQUIRED' });
}

async function sourceTab(message = {}, sender = {}, { allowUnexposedURL = false } = {}) {
  let tab;
  if (Number.isInteger(message.tabId)) tab = await chrome.tabs.get(message.tabId);
  else if (isPageSender(sender)) tab = await chrome.tabs.get(sender.tab.id);
  else {
    const active = await chrome.tabs.query({ active: true, ...(Number.isInteger(message.windowId) ? { windowId: message.windowId } : { lastFocusedWindow: true }) });
    tab = active[0];
    if (tab && typeof tab.url !== 'string') {
      // Never substitute a previously read tab for an ungranted active tab.
      if (allowUnexposedURL) return tab;
      throw sourceAccessError();
    }
    if (isChatURL(tab?.url)) throw new Error(`当前标签页是 ${siteForURL(tab.url, aiWebSettings)?.name || 'AI 网站'}，请先切回要引用的网页。`);
    if (!isWebURL(tab?.url)) {
      const sourceWindowId = Number.isInteger(message.windowId) ? message.windowId : (await chrome.windows.getLastFocused()).id;
      const lastId = recentSources.get(sourceWindowId);
      if (Number.isInteger(lastId)) {
        try { tab = await chrome.tabs.get(lastId); } catch { tab = null; }
      }
    }
  }
  if (tab && typeof tab.url !== 'string') {
    if (allowUnexposedURL) return tab;
    throw sourceAccessError();
  }
  if (!tab || !isWebURL(tab.url) || isChatURL(tab.url)) {
    throw new Error('请先打开一个普通网页再引用；浏览器内部页面与 AI 网站页面不支持采集。');
  }
  rememberSource(tab);
  return tab;
}

async function injectPage(tabId, frameId = 0) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['page-content.js'] });
  } catch (error) {
    if (/cannot access|missing host permission|must request permission|not allowed|权限/i.test(error?.message || '')) throw sourceAccessError();
    throw new Error(`网页采集脚本加载失败：${error?.message || '网页没有响应'}。请刷新来源网页后重试。`);
  }
}

function withTab(tabId, operation) {
  if (!Number.isInteger(tabId) || tabId < 0) return Promise.reject(new Error('来源标签页标识无效。请从网页点击扩展图标打开侧栏。'));
  const pending = (tabOperations.get(tabId) || Promise.resolve()).then(operation);
  tabOperations.set(tabId, pending.catch(() => {}));
  return pending;
}

async function sourceById(tabId, allowUnexposedURL = false) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { throw Object.assign(new Error('来源标签页已关闭，请重新选择引用来源或切回当前页。'), { code: 'SOURCE_CLOSED' }); }
  if (typeof tab.url !== 'string') {
    if (allowUnexposedURL) return tab;
    throw sourceAccessError();
  }
  if (!isWebURL(tab.url) || isChatURL(tab.url)) throw Object.assign(new Error('浏览器内部页面与 AI 网站页面不支持网页引用。'), { code: 'SOURCE_UNSUPPORTED' });
  return tab;
}

async function readSourceSnapshot(tabId) {
  const version = sourceVersions.get(tabId) || 0;
  const tab = await sourceById(tabId, true);
  if (tab.status === 'loading') throw Object.assign(new Error('来源网页正在加载，请等待完成后重新发送。'), { code: 'SOURCE_LOADING' });
  if (!tab.url) {
    liveSources.delete(tabId);
    return { source: tab, selection: null, needsAccess: true };
  }
  if (liveSources.get(tabId) !== tab.url || !await chrome.permissions.contains({ origins: [`${new URL(tab.url).origin}/*`] })) {
    await injectPage(tabId);
    liveSources.set(tabId, tab.url);
  }
  let result;
  try { result = await chrome.tabs.sendMessage(tabId, { type: 'SIDER_PAGE_SELECTION_GET' }, { frameId: 0 }); }
  catch {
    liveSources.delete(tabId);
    await injectPage(tabId);
    liveSources.set(tabId, tab.url);
    result = await chrome.tabs.sendMessage(tabId, { type: 'SIDER_PAGE_SELECTION_GET' }, { frameId: 0 });
  }
  if (!result?.ok || !result.source) throw new Error(result?.error || '网页没有响应，请刷新来源网页后重试。');
  const current = await sourceById(tabId);
  if (result.source.url !== current.url || current.url !== tab.url || current.status === 'loading' || version !== (sourceVersions.get(tabId) || 0)) throw new Error('来源网页正在跳转，请稍后重新发送。');
  if (result.reference) {
    validateReference(result.reference, {});
    if (result.reference.kind !== 'selection' || result.reference.url !== current.url) throw new Error('划词来源与当前网页不符。');
  }
  return { source: { ...current, title: current.title || result.source.title }, selection: result.reference || null, needsAccess: false };
}

async function syncSourceContext(tabId) {
  const result = await readSourceSnapshot(tabId);
  return { context: result.needsAccess ? await invalidateTabSource(tabId)
    : await updateTabSelection(tabId, result.source, result.selection), needsAccess: result.needsAccess };
}

async function contextResponse(tabId, sync = true, { defaultKinds, settings: savedSettings, refreshPage = false, knownContext } = {}) {
  const templates = await getTemplates();
  let snapshot;
  if (sync) {
    const settings = savedSettings || await getContextSettings();
    try {
      snapshot = await syncSourceContext(tabId);
      snapshot.context = await applyTemplateDefaults(tabId, templates, defaultKinds?.map(kind => PRESET_IDS[kind]));
      if (snapshot.needsAccess) {
        if (snapshot.context.pageRequested) snapshot.context = await requestTabPage(tabId, sourceAccessError().message);
      } else if (snapshot.context.pageRequested && (refreshPage || (!snapshot.context.attachments.page && !snapshot.context.pageError))) {
        // Refresh once at send preparation. Polls and later send checks reuse
        // this snapshot so an in-flight attachment cannot change underneath it.
        snapshot.context = await captureRequestedPage(tabId);
      }
    }
    catch (error) {
      if (!['SOURCE_ACCESS_REQUIRED', 'SOURCE_UNSUPPORTED'].includes(error.code)) throw error;
      if (error.code === 'SOURCE_UNSUPPORTED') {
        const wasCapturingPage = refreshPage && snapshot?.context.pageRequested;
        snapshot = { context: await resetTabContext(tabId), needsAccess: false };
        if (wasCapturingPage) throw error;
      }
      else {
        await invalidateTabSource(tabId);
        const context = await applyTemplateDefaults(tabId, templates, defaultKinds?.map(kind => PRESET_IDS[kind]));
        snapshot = { context: context.pageRequested ? await requestTabPage(tabId, error.message) : context, needsAccess: true };
      }
    }
  } else snapshot = { context: await getTabContext(tabId), needsAccess: false };
  if (!refreshPage && knownContext?.tabId === tabId && knownContext.revision === snapshot.context.revision) {
    return { ok: true, contextUnchanged: true, needsAccess: snapshot.needsAccess, settings: await getContextSettings() };
  }
  return { ok: true, ...snapshot, settings: await getContextSettings(), templates };
}

async function captureRequestedPage(tabId) {
  const version = sourceVersions.get(tabId) || 0;
  try {
    return await setTabAttachment(tabId, 'page', await capturePageSnapshot(tabId));
  } catch (error) {
    if (version !== (sourceVersions.get(tabId) || 0) || error.code === 'SOURCE_UNSUPPORTED') throw error;
    const context = await requestTabPage(tabId, error?.message || '没有取得网页正文，请重试或取消正文引用。');
    if (error.code === 'SOURCE_ACCESS_REQUIRED') throw error;
    return context;
  }
}

async function capturePageSnapshot(tabId) {
  const version = sourceVersions.get(tabId) || 0;
  const tab = await sourceById(tabId);
  if (tab.status === 'loading') throw new Error('来源网页正在加载，请等待完成后重试正文。');
  const result = await chrome.tabs.sendMessage(tabId, { type: 'SIDER_PAGE_CAPTURE', kind: 'page' }, { frameId: 0 });
  if (!result?.ok || !result.reference) throw new Error(result?.error || '没有取得网页正文。');
  validateReference(result.reference, {});
  const current = await sourceById(tabId);
  if (result.reference.url !== current.url || current.url !== tab.url || current.status === 'loading' || version !== (sourceVersions.get(tabId) || 0)) throw new Error('页面已经跳转，请重新引用正文。');
  return result.reference;
}

async function sourceTabsList(ownerTabId) {
  const owner = await chrome.tabs.get(ownerTabId);
  const session = await referenceSessions.get(ownerTabId);
  const tabs = (await chrome.tabs.query({})).filter(tab => Number.isSafeInteger(tab.id));
  tabs.sort((a, b) => Number(b.windowId === owner.windowId) - Number(a.windowId === owner.windowId)
    || a.windowId - b.windowId || (a.index || 0) - (b.index || 0));
  return { ok: true, ownerTabId, ownerWindowId: owner.windowId, sourceTabId: session?.sourceTabId ?? ownerTabId, tabs: tabs.map(tab => ({
    tabId: tab.id, windowId: tab.windowId, title: tab.title || tab.url || '未命名标签页', url: tab.url || '',
    disabledReason: !isWebURL(tab.url) ? '浏览器内部页面不支持引用' : isChatURL(tab.url) ? 'AI 网站页面不支持引用' : '',
  })) };
}

async function ownedContextResponse(tabId, options) {
  const result = await contextResponse(tabId, true, options);
  const tab = await chrome.tabs.get(tabId);
  return { ...result, referenceSource: { ownerTabId: tabId, tabId, epoch: 0, title: tab.title || result.context?.title || '当前网页',
    status: result.needsAccess ? 'needs-access' : isWebURL(tab.url) && !isChatURL(tab.url) ? 'ready' : 'unsupported',
    error: result.needsAccess ? sourceAccessError().message : '' } };
}

function referenceChanged() {
  return Object.assign(new Error('引用来源已变化，请重新操作。'), { code: 'REFERENCE_CHANGED' });
}

async function referenceResponse(ownerTabId, { sync = true, refreshPage = false, knownContext, needPage = false } = {}) {
  const templates = await getTemplates();
  let state = await referenceSessions.defaults(ownerTabId, templates);
  if (!state) throw referenceChanged();
  const epoch = state.epoch;
  let variablePage;
  if (sync && state.status !== 'closed') {
    try {
      const snapshot = await readSourceSnapshot(state.sourceTabId);
      if (snapshot.needsAccess) throw sourceAccessError();
      state = await referenceSessions.update(ownerTabId, epoch, next => {
        const context = next.context;
        if (context.url !== snapshot.source.url) { context.selection = null; context.attachments.page = null; context.pageError = ''; }
        context.url = snapshot.source.url; context.title = snapshot.source.title || '';
        const old = context.selection, selection = snapshot.selection;
        const same = old && selection && ['url', 'title', 'content', 'context'].every(key => old[key] === selection[key])
          && JSON.stringify(old.locator) === JSON.stringify(selection.locator);
        context.selection = same ? old : selection;
        next.title = context.title || context.url; next.status = 'ready'; next.error = '';
        syncTemplateDemand(context, templates);
      });
      if (state.context.pageRequested || needPage) {
        const shouldCapture = refreshPage || !state.context.attachments.page && (needPage || !state.context.pageError);
        if (shouldCapture) {
          try {
            variablePage = await capturePageSnapshot(state.sourceTabId);
            state = await referenceSessions.update(ownerTabId, epoch, next => {
              if (next.context.url !== variablePage.url) throw referenceChanged();
              if (next.context.pageRequested) next.context.attachments.page = variablePage;
              next.context.pageError = '';
            });
          } catch (error) {
            if (error.code === 'REFERENCE_CHANGED') throw error;
            if (['SOURCE_ACCESS_REQUIRED', 'SOURCE_UNSUPPORTED', 'SOURCE_CLOSED'].includes(error.code)) throw error;
            state = await referenceSessions.update(ownerTabId, epoch, next => {
              next.context.attachments.page = null;
              next.context.pageError = error.message || '没有取得网页正文。';
            });
          }
        } else variablePage = state.context.attachments.page;
      }
    } catch (error) {
      if (error.code === 'REFERENCE_CHANGED') throw error;
      state = await referenceSessions.update(ownerTabId, epoch, next => {
        next.status = ({ SOURCE_ACCESS_REQUIRED: 'needs-access', SOURCE_UNSUPPORTED: 'unsupported', SOURCE_CLOSED: 'closed', SOURCE_LOADING: 'loading' })[error.code] || 'error';
        next.error = error.message;
        Object.assign(next.context, { url: '', title: '', selection: null,
          attachments: { url: next.context.attachments.url, page: null }, pageError: next.context.pageRequested ? error.message : '' });
      });
    }
  }
  // A switch or navigation may have occurred while the source was being read.
  const current = await referenceSessions.get(ownerTabId);
  if (!current || current.epoch !== epoch) throw referenceChanged();
  state = current;
  if (needPage && (!variablePage || state.context.pageError || state.status !== 'ready')) {
    throw Object.assign(new Error(state.context.pageError || state.error || '没有取得网页正文，请重新选择来源或重试。'),
      { code: state.status === 'needs-access' ? 'SOURCE_ACCESS_REQUIRED' : 'SOURCE_UNAVAILABLE' });
  }
  const common = { ok: true, referenceSource: referenceSource(state), needsAccess: state.status === 'needs-access', settings: await getContextSettings() };
  if (!refreshPage && !needPage && knownContext?.tabId === state.sourceTabId && knownContext.revision === state.context.revision && knownContext.referenceEpoch === state.epoch) {
    return { ...common, contextUnchanged: true };
  }
  return { ...common, context: state.context, templates, ...(variablePage ? { variablePage } : {}) };
}

async function setReferenceSource(ownerTabId, targetTabId) {
  if (!Number.isSafeInteger(targetTabId) || targetTabId < 0) throw new Error('引用来源标签页无效。');
  const owner = await chrome.tabs.get(ownerTabId);
  let target;
  try { target = await chrome.tabs.get(targetTabId); } catch { throw new Error('所选标签页已关闭，请刷新列表后重试。'); }
  if (target.id !== owner.id && (!isWebURL(target.url) || isChatURL(target.url))) throw new Error('此标签页不支持网页引用。');
  // query() is scoped to the profile and permitted incognito surfaces.
  if (!(await chrome.tabs.query({})).some(tab => tab.id === target.id)) throw new Error('所选标签页不可访问。');
  const templates = await getTemplates();
  const previous = await referenceSessions.get(ownerTabId);
  const initial = previous?.context || (await contextResponse(ownerTabId)).context;
  await referenceSessions.switch(ownerTabId, target, initial, templates);
  try { return await referenceResponse(ownerTabId); }
  catch (error) {
    if (error.code !== 'REFERENCE_CHANGED') throw error;
    return referenceResponse(ownerTabId, { sync: false });
  }
}

async function referenceRequest(ownerTabId, inner) {
  const state = await referenceSessions.get(ownerTabId);
  if (!state) throw referenceChanged();
  const epoch = state.epoch;
  if (inner.referenceEpoch !== undefined && inner.referenceEpoch !== epoch && !['SIDER_TAB_CONTEXT_GET', 'SIDER_TAB_TEMPLATES_CLEAR'].includes(inner.type)) throw referenceChanged();
  if (inner.type === 'SIDER_TAB_CONTEXT_GET') return referenceResponse(ownerTabId, { refreshPage: inner.refreshPage === true, knownContext: inner.knownContext });
  if (inner.type === 'SIDER_TEMPLATE_CONTEXT_GET') {
    const items = (await getTemplates()).filter(item => inner.ids?.includes(item.id));
    const needPage = inner.needPage || items.some(item => needsPageVariables(item.text) || item.delivery !== 'text' && needsPageVariables(item.attachmentText));
    return referenceResponse(ownerTabId, { needPage: Boolean(needPage), refreshPage: inner.refreshPage === true && needPage });
  }
  if (inner.type === 'SIDER_CONTEXT_SETTINGS_PATCH') {
    const { changedDefaults } = await configurationOperation(() => patchContextSettings(inner.patch, { includeChanges: true }));
    await referenceSessions.update(ownerTabId, epoch, () => {});
    await referenceSessions.defaults(ownerTabId, await getTemplates(), changedDefaults.map(kind => PRESET_IDS[kind]));
    return referenceResponse(ownerTabId);
  }
  const templates = await getTemplates();
  if (inner.type === 'SIDER_TAB_TEMPLATES_CLEAR') {
    const expected = inner.expectedContext;
    await referenceSessions.update(ownerTabId, undefined, next => {
      if (expected?.referenceEpoch !== next.epoch || expected.tabId !== next.sourceTabId || expected.url !== next.context.url || expected.revision !== next.context.revision) return;
      for (const id of Object.keys(next.context.templateSelections)) next.context.templateSelections[id] = false;
      next.context.explicitTemplates = []; syncTemplateDemand(next.context, templates);
    });
    return referenceResponse(ownerTabId, { sync: false });
  }
  if (inner.type === 'SIDER_TAB_SELECTION_CLEAR') {
    try { await chrome.tabs.sendMessage(state.sourceTabId, { type: 'SIDER_PAGE_CLEAR_SELECTION' }, { frameId: 0 }); } catch {}
    await referenceSessions.update(ownerTabId, epoch, next => {
      next.context.selection = null; next.context.templateSelections[PRESET_IDS.selection] = false;
      next.context.explicitTemplates = next.context.explicitTemplates.filter(id => id !== PRESET_IDS.selection);
      syncTemplateDemand(next.context, templates);
    });
    return referenceResponse(ownerTabId, { sync: false });
  }
  const id = inner.type === 'SIDER_TAB_ATTACHMENT_SET' ? PRESET_IDS[inner.kind] : inner.id;
  if (typeof inner.enabled !== 'boolean' || !templates.some(item => item.id === id)) throw new Error('预设已删除或附加选项无效。');
  await referenceSessions.update(ownerTabId, epoch, next => {
    next.context.templateSelections[id] = inner.enabled;
    next.context.explicitTemplates = next.context.explicitTemplates.filter(value => value !== id);
    if (inner.enabled) next.context.explicitTemplates.push(id);
    syncTemplateDemand(next.context, templates);
  });
  return referenceResponse(ownerTabId, { sync: inner.enabled });
}

function templateContext(tabId, inner) {
  return withTab(tabId, async () => {
    const ids = Array.isArray(inner.ids) ? inner.ids : [];
    const templates = (await getTemplates()).filter(item => ids.includes(item.id));
    const needsPage = inner.needPage || templates.some(item => needsPageVariables(item.text) || item.delivery !== 'text' && needsPageVariables(item.attachmentText));
    const result = await contextResponse(tabId, true, { refreshPage: inner.refreshPage === true && needsPage });
    if (needsPage) {
      if (result.needsAccess) throw sourceAccessError();
      if (result.context.pageError) throw new Error(result.context.pageError);
      result.variablePage = result.context.attachments.page || await capturePageSnapshot(tabId);
    }
    return result;
  });
}

function changeTabAttachment(tabId, kind, enabled) {
  if (!Object.hasOwn(PRESET_IDS, kind)) throw new Error('网页引用选项无效。');
  return changeTabTemplate(tabId, PRESET_IDS[kind], enabled);
}

function changeTabTemplate(tabId, id, enabled) {
  return withTab(tabId, async () => {
    const templates = await getTemplates();
    if (!enabled) {
      await setTabTemplate(tabId, id, false, templates);
      return contextResponse(tabId, false);
    }
    await syncSourceContext(tabId);
    const template = templates.find(item => item.id === id);
    const wasSelected = Boolean((await getTabContext(tabId)).templateSelections?.[id]);
    const next = await setTabTemplate(tabId, id, true, templates);
    if (template && needsTemplateSelection(template) && !next.selection?.content) return contextResponse(tabId, false);
    if (next.pageRequested) {
      await requestTabPage(tabId);
      await captureRequestedPage(tabId);
    }
    if (template) {
      const errors = expandTemplateItem(template, await getTabContext(tabId)).errors;
      if (errors.length) {
        if (!wasSelected) await setTabTemplate(tabId, id, false, templates);
        throw new Error(errors[0]);
      }
    }
    return contextResponse(tabId, false);
  });
}

function changeContextSettings(tabId, patch) {
  return withTab(tabId, async () => {
    const { settings, changedDefaults } = await configurationOperation(() => patchContextSettings(patch, { includeChanges: true }));
    return contextResponse(tabId, changedDefaults.length > 0, { defaultKinds: changedDefaults, settings });
  });
}

function clearCurrentSelection(tabId) {
  return withTab(tabId, async () => {
    try { await chrome.tabs.sendMessage(tabId, { type: 'SIDER_PAGE_CLEAR_SELECTION' }, { frameId: 0 }); }
    catch { /* Storage cancellation still works if the source is unavailable. */ }
    await clearTabSelection(tabId);
    await setTabTemplate(tabId, PRESET_IDS.selection, false, await getTemplates());
    return contextResponse(tabId, false);
  });
}

function receiveSelection(message, sender) {
  if ((sender.frameId || 0) !== 0) throw new Error('仅支持来源网页的主框架划词。');
  return withTab(sender.tab.id, async () => {
    const tab = await sourceById(sender.tab.id);
    if (message.source?.url !== tab.url || sender.url !== tab.url) throw new Error('网页已跳转，旧页面划词已忽略。');
    if (message.reference) {
      validateReference(message.reference, sender);
      if (message.reference.kind !== 'selection' || message.reference.url !== tab.url) throw new Error('划词来源与当前网页不符。');
    }
    const context = await updateTabSelection(tab.id, { url: tab.url, title: tab.title || message.source.title }, message.reference || null);
    return { ok: true, context };
  });
}

function validateReference(reference, sender) {
  if (!reference || !['selection', 'url', 'page'].includes(reference.kind)) throw new Error('引用类型错误。');
  if (!isWebURL(reference.url)) throw new Error('引用来源需要是有效的网页链接。');
  if (typeof reference.content !== 'string') throw new Error('引用正文格式错误。');
  if (reference.content.length > 1_000_000) throw new Error('引用内容过长，请缩小范围后重试。');
  if (isPageSender(sender) && parseURL(reference.url)?.origin !== parseURL(sender.url)?.origin) {
    throw new Error('网页不能伪造其他站点的引用。');
  }
}

async function capture(message, sender = {}) {
  if (!['selection', 'url', 'page'].includes(message.kind)) throw new Error('不支持的引用类型。');
  const tab = await sourceTab(message, sender);
  const frameId = Number.isInteger(message.frameId) ? message.frameId : (isPageSender(sender) ? sender.frameId || 0 : 0);
  await injectPage(tab.id, frameId);
  let result;
  try {
    result = await chrome.tabs.sendMessage(tab.id, { type: 'SIDER_PAGE_CAPTURE', kind: message.kind }, { frameId });
  } catch {
    throw new Error('网页没有响应，可能已经跳转。请回到来源网页后重试。');
  }
  if (!result?.ok || !result.reference) throw new Error(result?.error || '没有取得可引用的网页内容。');
  validateReference(result.reference, {});
  if (parseURL(result.reference.url)?.origin !== parseURL(tab.url)?.origin) {
    throw new Error('页面已跳转到其他站点，请重新引用。');
  }
  return { ok: true, ...await addReference(result.reference) };
}

function frameKey(sender) {
  return sender.documentId || `${sender.tab?.id ?? 'sidebar'}:${sender.frameId ?? 0}`;
}

function embedRegistration(sender, bridgeId) {
  if (!isChatSender(sender) || typeof bridgeId !== 'string') return null;
  const queryId = parseURL(sender.url)?.searchParams.get('sider_bridge');
  if (queryId && queryId !== bridgeId) return null;
  const registration = embedRegistrations.get(bridgeId);
  if (!registration) return null;
  if (parseURL(sender.url)?.origin !== (registration.site || BUILTIN_AI_SITES[0]).origin) return null;
  if (sender.tab && sender.tab.windowId !== registration.windowId) return null;
  return registration;
}

function embedCompatibilityRule(site = BUILTIN_AI_SITES[0], id = EMBED_RULE_ID) {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'content-security-policy', operation: 'remove' },
        { header: 'x-frame-options', operation: 'remove' },
      ],
    },
    condition: {
      // Domains include subdomains, so also anchor the exact HTTPS hostname.
      urlFilter: `|${site.origin}/`,
      requestDomains: [new URL(site.origin).hostname],
      // Keep matching after a navigation initiated by ChatGPT inside the frame.
      // Chrome 145+ matches the actual top frame, including extension panels.
      topDomains: [chrome.runtime.id],
      resourceTypes: ['sub_frame'],
    },
  };
}

function embedSites() {
  return [...new Map([...embedRegistrations.values()].map(registration => {
    const site = registration.site || BUILTIN_AI_SITES[0]; return [site.origin, site];
  })).values()].sort((a, b) => a.origin.localeCompare(b.origin));
}

function compatibilityRules(sites) {
  let customId = EMBED_RULE_ID + 10;
  return sites.map(site => {
    const builtinIndex = BUILTIN_AI_SITES.findIndex(builtin => builtin.origin === site.origin);
    return embedCompatibilityRule(site, builtinIndex >= 0 ? EMBED_RULE_ID + builtinIndex : customId++);
  });
}

function canonicalRule(value) {
  if (Array.isArray(value)) return value.map(canonicalRule);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalRule(value[key])]));
  return value;
}

async function updateEmbedRule(enabled, sites = embedSites()) {
  const permitted = await chrome.permissions.contains({ permissions: [EMBED_PERMISSION] });
  if (!permitted) {
    embedRuleInstalled = false;
    installedEmbedSignature = '';
    if (enabled) throw new Error('内嵌权限尚未授权。请在扩展管理页启用新版 Sider，并允许新增的内嵌权限。');
    return;
  }
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    throw new Error('当前浏览器不支持范围受限的兼容嵌入，请使用原站标签页。');
  }
  for (const site of enabled ? sites : []) {
    if (!await chrome.permissions.contains({ origins: [aiSitePattern(site)] })) throw new Error(`请允许扩展访问 ${new URL(site.origin).host} 后再启用兼容嵌入。`);
  }
  const rules = enabled ? compatibilityRules(sites) : [];
  const signature = JSON.stringify(rules);
  if (enabled && embedRuleInstalled && signature === installedEmbedSignature) return;
  try {
    // The update is atomic. Never retry using less restrictive matching conditions.
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [...new Set([...installedEmbedRuleIds, ...rules.map(rule => rule.id)])],
      addRules: rules,
    });
  } catch (error) {
    throw new Error(`${enabled ? '兼容嵌入规则安装失败' : '兼容嵌入规则移除失败'}：${error?.message || '浏览器拒绝了规则更新'}。请使用原站标签页。`);
  }
  embedRuleInstalled = enabled && rules.length > 0;
  installedEmbedSignature = signature;
  installedEmbedRuleIds = rules.length ? rules.map(rule => rule.id) : [EMBED_RULE_ID];
}

function changeEmbed(operation) {
  const pending = embedQueue.then(async () => {
    await embedInitialization;
    return operation();
  });
  embedQueue = pending.catch(() => {});
  return pending;
}

async function persistEmbeds() {
  if (chrome.storage.session) await chrome.storage.session.set({ [EMBED_STORAGE_KEY]: Object.fromEntries(embedRegistrations) });
}

async function restoreEmbeds() {
  await aiSettingsInitialization;
  if (chrome.storage.session) {
    const stored = (await chrome.storage.session.get(EMBED_STORAGE_KEY))[EMBED_STORAGE_KEY];
    for (const [id, value] of Object.entries(stored || {})) {
      if (!/^[a-zA-Z0-9-]{16,100}$/.test(id) || !Number.isInteger(value?.windowId)) continue;
      let site = BUILTIN_AI_SITES[0];
      if (value.site) {
        site = BUILTIN_AI_SITES.find(builtin => builtin.id === value.site.id && builtin.origin === value.site.origin);
        if (site) site = listAISites({ builtinOverrides: { [site.id]: value.site } }).find(candidate => candidate.id === site.id);
        if (!site) { try { site = normalizeCustomAISite(value.site); } catch { continue; } }
      }
      embedRegistrations.set(id, { windowId: value.windowId, site, ...(Number.isInteger(value.tabId) ? { tabId: value.tabId } : {}) });
    }
  }
  // Worker suspension does not mean that the sidebar has closed.
  // Keep session rules and registrations together across worker restarts.
  const permitted = await chrome.permissions.contains({ permissions: [EMBED_PERMISSION] });
  const rules = permitted ? await chrome.declarativeNetRequest?.getSessionRules?.() : [];
  const expected = compatibilityRules(embedSites());
  installedEmbedRuleIds = rules?.filter(rule => rule.id >= EMBED_RULE_ID && rule.id < EMBED_RULE_ID + 10000).map(rule => rule.id) || [];
  if (!installedEmbedRuleIds.length) installedEmbedRuleIds = [EMBED_RULE_ID];
  embedRuleInstalled = Boolean(expected.length && expected.every(next => rules?.some(rule => JSON.stringify(canonicalRule(rule)) === JSON.stringify(canonicalRule(next)))));
  installedEmbedSignature = embedRuleInstalled ? JSON.stringify(expected) : '';
  await syncAIScripts().catch(error => chrome.storage.local.set({ siderLastEvent: { ok: false, error: `AI 网站脚本注册失败：${error.message}`, at: Date.now() } }));
}

function embedStatus(bridgeId) {
  const ports = [...chatPorts].filter(entry => entry.bridgeId === bridgeId && entry.reportedEmbedded && embedRegistration(entry.port.sender, bridgeId));
  return { ok: true, registered: embedRegistrations.has(bridgeId), compatibility: embedRuleInstalled, connected: ports.length > 0, enhancementReady: ports.some(entry => entry.enhancementReady), enhancementDetail: ports.find(entry => entry.enhancementDetail)?.enhancementDetail || '' };
}

function notifyEmbedStatus(bridgeId) {
  const status = embedStatus(bridgeId);
  try { panelPorts.get(bridgeId)?.postMessage({ type: 'SIDER_ENHANCEMENT_READY', bridgeId, ready: status.enhancementReady, detail: status.enhancementDetail }); } catch {}
}

function registerEmbed(message) {
  return changeEmbed(async () => {
    if (typeof message.bridgeId !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(message.bridgeId)) {
      throw new Error('侧栏连接标识无效。');
    }
    if (!Number.isInteger(message.windowId) || message.windowId < 0) throw new Error('侧栏窗口标识无效。');
    if (message.tabId != null) {
      if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error('侧栏来源标签页标识无效。');
      const source = await chrome.tabs.get(message.tabId);
      if (source.windowId !== message.windowId) throw new Error('来源标签页与侧栏窗口不符。');
    }
    const previous = embedRegistrations.get(message.bridgeId);
    if (previous && (previous.windowId !== message.windowId || previous.tabId !== message.tabId)) throw new Error('侧栏连接已经属于另一个标签页。');
    await aiSettingsInitialization;
    const site = message.reuseSite && message.siteId && previous?.site?.id === message.siteId ? previous.site : listAISites(aiWebSettings).find(candidate => candidate.id === (message.siteId || aiWebSettings.activeSiteId));
    if (!site) throw new Error('所选 AI 网站已移除，请重新打开侧栏。');
    const desired = new Map(embedSites().map(candidate => [candidate.origin, candidate]));
    if (previous?.site && ![...embedRegistrations].some(([id, registration]) => id !== message.bridgeId && registration.site?.origin === previous.site.origin)) desired.delete(previous.site.origin);
    desired.set(site.origin, site);
    await syncAIScripts();
    await updateEmbedRule(true, [...desired.values()].sort((a, b) => a.origin.localeCompare(b.origin)));
    // A successful response means the browser has accepted the narrow session rule.
    embedRegistrations.set(message.bridgeId, { windowId: message.windowId, site, ...(Number.isInteger(message.tabId) ? { tabId: message.tabId } : {}) });
    if (!message.reuseSite) for (const entry of chatPorts) if (entry.bridgeId === message.bridgeId) { entry.reportedEmbedded = false; entry.enhancementReady = false; }
    await persistEmbeds();
    return { ok: true, compatibility: true, site };
  });
}

function unregisterEmbed(message) {
  return changeEmbed(async () => {
    const registered = embedRegistrations.has(message.bridgeId);
    if (registered) {
      const remaining = new Map([...embedRegistrations].filter(([id]) => id !== message.bridgeId).map(([, registration]) => [(registration.site || BUILTIN_AI_SITES[0]).origin, registration.site || BUILTIN_AI_SITES[0]]));
      await updateEmbedRule(remaining.size > 0, [...remaining.values()].sort((a, b) => a.origin.localeCompare(b.origin)));
    }
    embedRegistrations.delete(message.bridgeId);
    await persistEmbeds();
    await syncAIScripts();
    for (const [key, frame] of chatFrames) if (frame.bridgeId === message.bridgeId) chatFrames.delete(key);
    return { ok: true };
  });
}

function registerChatFrame(message, sender) {
  const registration = embedRegistration(sender, message.bridgeId);
  if (Number.isInteger(sender.tab?.id)) {
    chatFrames.set(frameKey(sender), {
      tabId: sender.tab.id,
      windowId: sender.tab.windowId,
      frameId: sender.frameId || 0,
      documentId: sender.documentId,
      embedded: Boolean(message.embedded && registration),
      bridgeId: registration ? message.bridgeId : null,
      at: Date.now(),
    });
  }
  return { ok: true };
}

function callChatPort(entry, message) {
  return new Promise((resolve, reject) => {
    const requestId = `sider-${Date.now()}-${++requestSequence}`;
    const timer = setTimeout(() => {
      entry.pending.delete(requestId);
      reject(new Error('侧栏中的 AI 网站没有响应。'));
    }, 12000);
    entry.pending.set(requestId, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try {
      entry.port.postMessage({ ...message, requestId });
    } catch (error) {
      clearTimeout(timer);
      entry.pending.delete(requestId);
      reject(error);
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sider-panel-lifecycle' && isExtensionSender(port.sender)) {
    let attached;
    port.onMessage.addListener(async message => {
      await embedInitialization;
      if (message?.type !== 'SIDER_PANEL_ATTACH' || !embedRegistrations.has(message.bridgeId)) return;
      attached = message.bridgeId;
      panelPorts.set(attached, port);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!attached || panelPorts.get(attached) !== port) return;
      panelPorts.delete(attached);
      unregisterEmbed({ bridgeId: attached }).catch(() => {});
    });
    return;
  }
  const pendingSettingsSender = !aiSettingsLoaded && port.sender?.id === chrome.runtime.id && isWebURL(port.sender.url);
  if (port.name !== 'sider-chat-bridge' || !isChatSender(port.sender) && !pendingSettingsSender) {
    port.disconnect();
    return;
  }
  const entry = {
    port,
    bridgeId: parseURL(port.sender.url)?.searchParams.get('sider_bridge') || null,
    reportedEmbedded: false,
    enhancementReady: false,
    at: Date.now(),
    pending: new Map(),
  };
  chatPorts.add(entry);
  port.onMessage.addListener(async (message) => {
    await embedInitialization;
    if (!isChatSender(port.sender)) { port.disconnect(); return; }
    if (message?.type === 'SIDER_CHAT_READY') {
      entry.bridgeId = message.bridgeId;
      entry.reportedEmbedded = Boolean(message.embedded && embedRegistration(port.sender, message.bridgeId));
      entry.at = Date.now();
      registerChatFrame(message, port.sender);
    } else if (message?.type === 'SIDER_ENHANCEMENT_READY' && message.bridgeId === entry.bridgeId && entry.reportedEmbedded && embedRegistration(port.sender, entry.bridgeId)) {
      entry.enhancementReady = Boolean(message.ready);
      entry.enhancementDetail = typeof message.detail === 'string' ? message.detail.slice(0, 1000) : '';
      notifyEmbedStatus(entry.bridgeId);
    } else if (message?.type === 'SIDER_CHAT_RESULT' && typeof message.requestId === 'string') {
      const pending = entry.pending.get(message.requestId);
      if (!pending) return;
      entry.pending.delete(message.requestId);
      pending.resolve(message);
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    chatPorts.delete(entry);
    if (entry.reportedEmbedded && embedRegistration(port.sender, entry.bridgeId)) notifyEmbedStatus(entry.bridgeId);
    // A document navigation closes this port. Only the owning panel closes
    // its registration and compatibility rule.
    for (const pending of entry.pending.values()) pending.reject(new Error('AI 网站页面或侧栏已关闭。'));
    entry.pending.clear();
  });
});

async function enhancementRequest(message, sender) {
  await embedInitialization;
  const registration = embedRegistration(sender, message.bridgeId);
  const inner = message.request;
  if (!registration || !message.embedded || !ENHANCEMENT_MESSAGES.has(inner?.type)) throw new Error('未登记的内嵌增强请求。');
  const tabId = registration.tabId;
  if (!Number.isInteger(tabId)) throw new Error('侧栏尚未绑定来源标签页，请关闭旧侧栏并在来源网页上重新打开。');
  if (inner.type === 'SIDER_SOURCE_TABS_LIST') return sourceTabsList(tabId);
  if (inner.type === 'SIDER_REFERENCE_SOURCE_SET') return setReferenceSource(tabId, inner.tabId);
  if (inner.type === 'SIDER_SOURCE_INFO') return sourceInfo({ tabId, bridgeId: message.bridgeId });
  if (!['SIDER_PROMPT_TEMPLATES_GET', 'SIDER_PROMPT_TEMPLATES_SAVE'].includes(inner.type) && await referenceSessions.get(tabId)) return referenceRequest(tabId, inner);
  if (inner.type === 'SIDER_TAB_CONTEXT_GET') return withTab(tabId, () => ownedContextResponse(tabId, { refreshPage: inner.refreshPage === true, knownContext: inner.knownContext }));
  if (inner.type === 'SIDER_TAB_ATTACHMENT_SET') return changeTabAttachment(tabId, inner.kind, inner.enabled);
  if (inner.type === 'SIDER_TAB_TEMPLATE_SET') return changeTabTemplate(tabId, inner.id, inner.enabled);
  if (inner.type === 'SIDER_TAB_TEMPLATES_CLEAR') return withTab(tabId, async () => {
    await clearTabTemplates(tabId, await getTemplates(), inner.expectedContext);
    return contextResponse(tabId, false);
  });
  if (inner.type === 'SIDER_TAB_SELECTION_CLEAR') return clearCurrentSelection(tabId);
  if (inner.type === 'SIDER_CONTEXT_SETTINGS_PATCH') return changeContextSettings(tabId, inner.patch);
  if (inner.type === 'SIDER_TEMPLATE_CONTEXT_GET') return templateContext(tabId, inner);
  if (inner.type === 'SIDER_PROMPT_TEMPLATES_GET') return { ok: true, templates: await getTemplates() };
  if (inner.type === 'SIDER_PROMPT_TEMPLATES_SAVE') {
    return configurationOperation(async () => {
      const templates = validateTemplates(inner.templates);
      const previous = await getTemplates();
      if (inner.expected && JSON.stringify(inner.expected) !== JSON.stringify(previous)) throw new Error('预设已在另一侧栏修改，请重新打开预设菜单后保存。');
      await chrome.storage.local.set({ [UNIFIED_TEMPLATES_KEY]: templates });
      const changed = templates.filter(item => previous.find(old => old.id === item.id)?.defaultIncluded !== item.defaultIncluded).map(item => item.id);
      if (await referenceSessions.get(tabId)) {
        await referenceSessions.defaults(tabId, templates, changed);
        return referenceResponse(tabId, { sync: false });
      }
      await applyTemplateDefaults(tabId, templates, changed);
      return contextResponse(tabId, false);
    });
  }
}

async function referenceTarget(message) {
  if (!message.bridgeId) return message;
  const registration = embedRegistrations.get(message.bridgeId);
  if (!registration || registration.tabId !== message.tabId) throw new Error('侧栏连接或所属标签页已变化。');
  const state = await referenceSessions.get(registration.tabId);
  const tabId = state?.sourceTabId ?? registration.tabId;
  const epoch = state?.epoch ?? 0;
  if (message.expectedSource && (message.expectedSource.tabId !== tabId || message.expectedSource.referenceEpoch !== epoch)) throw referenceChanged();
  return { ...message, tabId, referenceEpoch: epoch, ownerTabId: registration.tabId };
}

async function sourceInfo(target) {
  const message = typeof target === 'number' ? { windowId: target } : target || {};
  const resolved = await referenceTarget(message);
  const tab = Number.isInteger(resolved.tabId) ? await sourceById(resolved.tabId, true) : await sourceTab(resolved, {}, { allowUnexposedURL: true });
  const origins = (await chrome.storage.local.get(SITE_KEY))[SITE_KEY] || [];
  const url = parseURL(tab.url);
  return { ok: true, source: { title: tab.title || url?.hostname || '当前网页', url: url?.href || null, tabId: tab.id,
    ...(message.bridgeId ? { referenceEpoch: resolved.referenceEpoch, ownerTabId: resolved.ownerTabId } : {}), needsAccess: !url, enabled: Boolean(url && origins.includes(url.origin)) } };
}

async function requestSourceAccess(target) {
  const message = typeof target === 'number' ? { windowId: target } : target || {};
  const resolved = await referenceTarget(message);
  const tab = Number.isInteger(resolved.tabId) ? await sourceById(resolved.tabId, true) : await sourceTab(resolved, {}, { allowUnexposedURL: true });
  const url = parseURL(tab.url);
  if (url && await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) return { ok: true, granted: true };
  if (!chrome.permissions.addHostAccessRequest) throw new Error('浏览器未提供网站授权入口。请在来源网页上点击浏览器工具栏的 Sider 图标。');
  // The browser can identify the origin even when tabs.Tab.url is withheld.
  // This only displays a request; the browser still requires the user's approval.
  await chrome.permissions.addHostAccessRequest({ tabId: tab.id });
  return { ok: true, requested: true };
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  const settingsChanged = area === 'local' && changes[UNIFIED_TEMPLATES_KEY]?.oldValue !== undefined;
  const tabIds = area === 'session' ? new Set(Object.keys(changes).filter(key => key.startsWith(TAB_CONTEXT_PREFIX)).map(key => Number(key.slice(TAB_CONTEXT_PREFIX.length)))) : new Set();
  const referenceChange = area === 'session' && changes[REFERENCE_SESSIONS_KEY];
  const references = referenceChange?.newValue || await referenceSessions.all();
  for (const entry of chatPorts) {
    const owner = embedRegistrations.get(entry.bridgeId);
    const ref = references[owner?.tabId];
    const referenceUpdated = referenceChange && JSON.stringify(referenceChange.oldValue?.[owner?.tabId]) !== JSON.stringify(ref);
    if (!entry.reportedEmbedded || !owner || (!settingsChanged && !referenceUpdated && !tabIds.has(ref?.sourceTabId ?? owner.tabId))) continue;
    try { entry.port.postMessage({ type: 'SIDER_TAB_CONTEXT_CHANGED' }); } catch {}
  }
  if (referenceChange) for (const [bridgeId, owner] of embedRegistrations) {
    const ref = references[owner.tabId];
    if (ref && ref.epoch !== referenceChange.oldValue?.[owner.tabId]?.epoch) {
      try { panelPorts.get(bridgeId)?.postMessage({ type: 'SIDER_REFERENCE_SOURCE_CHANGED', bridgeId, referenceSource: referenceSource(ref) }); } catch {}
    }
  }
});

async function openChat(siteId) {
  await aiSettingsInitialization;
  const site = listAISites(aiWebSettings).find(candidate => candidate.id === (siteId || aiWebSettings.activeSiteId)) || [...embedRegistrations.values()].find(registration => registration.site?.id === siteId)?.site;
  if (!site) throw new Error('此 AI 网站已移除，请更新 AI 网站设置。');
  const desiredURL = aiSiteURL(site, aiWebSettings);
  const tabs = (await chrome.tabs.query({ url: aiSitePattern(site) })).filter(tab => parseURL(tab.url)?.origin === site.origin);
  const preferredTabs = site.id !== 'gemini' ? tabs : tabs.filter(tab => {
    const pathname = parseURL(tab.url)?.pathname || '';
    const isSpark = pathname === '/spark' || pathname.startsWith('/spark/');
    const desiredPath = new URL(desiredURL).pathname;
    return isSpark === (desiredPath === '/spark' || desiredPath.startsWith('/spark/'));
  });
  const currentWindow = await chrome.windows.getLastFocused();
  const ranked = [...preferredTabs].sort((a, b) =>
    Number(b.windowId === currentWindow.id) - Number(a.windowId === currentWindow.id) ||
    Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const tab = ranked[0]
    ? await chrome.tabs.update(ranked[0].id, { active: true })
    : await chrome.tabs.create({ url: desiredURL, active: true, windowId: currentWindow.id });
  if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

async function waitForTab(tabId, timeoutMs = 20000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return;
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      error ? reject(error) : resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const onRemoved = (id) => { if (id === tabId) finish(new Error('标签页已关闭。')); };
    const timer = setTimeout(() => finish(new Error('网页加载超时，请稍后重试或复制提示词。')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // The navigation may have finished between the first read and listener registration.
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') finish(); }, () => finish(new Error('标签页已关闭。')));
  });
}

async function fillChat(message) {
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 1_000_000) {
    throw new Error('提示词为空或过长，请检查预览。');
  }
  const mode = message.mode || 'append';
  if (!['append', 'replace'].includes(mode)) throw new Error('不支持的填入方式。');
  const payload = { type: 'SIDER_CHAT_FILL', text: message.text, mode };
  if (message.preferEmbedded !== false && typeof message.bridgeId === 'string') {
    const currentWindow = await chrome.windows.getLastFocused();
    const ports = [...chatPorts].filter((entry) =>
      entry.reportedEmbedded && entry.bridgeId === message.bridgeId &&
      embedRegistration(entry.port.sender, entry.bridgeId)?.windowId === currentWindow.id).sort((a, b) => b.at - a.at);
    for (const entry of ports) {
      try {
        const result = await callChatPort(entry, payload);
        if (result?.ok && result.filled) return { ok: true, embedded: true, filled: true };
      } catch { /* A closed or blocked embed falls back to a normal ChatGPT tab. */ }
    }
    const frames = [...chatFrames.entries()].filter(([, frame]) =>
      frame.embedded && frame.bridgeId === message.bridgeId && frame.windowId === currentWindow.id &&
      embedRegistrations.get(frame.bridgeId)?.windowId === currentWindow.id).sort((a, b) => b[1].at - a[1].at);
    for (const [key, frame] of frames) {
      try {
        const tab = await chrome.tabs.get(frame.tabId);
        if (isChatURL(tab.url) && frame.frameId === 0) continue;
        const options = frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId };
        const result = await chrome.tabs.sendMessage(frame.tabId, payload, options);
        if (result?.ok && result.filled) return { ok: true, embedded: true, filled: true };
      } catch { chatFrames.delete(key); }
    }
  }

  const site = selectedAISite(aiWebSettings);
  const tab = await openChat(site.id);
  await waitForTab(tab.id);
  const loaded = await chrome.tabs.get(tab.id);
  if (parseURL(loaded.url)?.origin !== site.origin) throw new Error(`请在 ${site.name} 标签页完成登录后再填入。`);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['file-drop-main.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['ai-content.js'] });
    const result = await chrome.tabs.sendMessage(tab.id, { ...payload, site }, { frameId: 0 });
    if (!result?.ok || !result.filled) throw new Error(result?.error || `没有确认提示词已填入，请检查 ${site.name} 草稿。`);
    return { ok: true, tabId: tab.id, embedded: false, filled: true };
  } catch (error) {
    throw new Error(error?.message || `无法填入 ${site.name}，请复制提示词。`);
  }
}

async function openSource(message) {
  const reference = message.reference;
  if (!reference || !isWebURL(reference.url)) throw new Error('来源链接无效。');
  const tab = await chrome.tabs.create({ url: reference.url, active: true });
  if (!reference.locator) return { ok: true, tabId: tab.id, highlighted: false };
  try {
    await waitForTab(tab.id);
    await injectPage(tab.id);
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'SIDER_HIGHLIGHT', locator: reference.locator }, { frameId: 0 });
    const highlighted = Boolean(result?.ok && result.found);
    return { ok: true, tabId: tab.id, highlighted, ...(!highlighted ? { warning: '来源已打开，但没有定位到原文；页面内容可能已经变化。' } : {}) };
  } catch {
    return { ok: true, tabId: tab.id, highlighted: false, warning: '来源已打开；页面可能发生变化，或尚未授权定位原文。' };
  }
}

function siteScriptId(origin) {
  return `sider-selection-${encodeURIComponent(origin)}`;
}

function changeSite(message, sender, enabled) {
  const operation = siteQueue.then(() => configurationOperation(async () => {
    const tab = await sourceTab(message, sender);
    const origin = parseURL(tab.url).origin;
    const pattern = `${origin}/*`;
    const id = siteScriptId(origin);
    if (enabled && !await chrome.permissions.contains({ origins: [pattern] })) {
      throw new Error('请先允许此站点的访问权限，再启用自动划词。');
    }
    const stored = await chrome.storage.local.get(SITE_KEY);
    const origins = new Set(Array.isArray(stored[SITE_KEY]) ? stored[SITE_KEY] : []);
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (enabled) {
      if (!registered.length) {
        await chrome.scripting.registerContentScripts([{ id, matches: [pattern], js: ['page-content.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
      }
      origins.add(origin);
    } else {
      if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
      origins.delete(origin);
    }
    await chrome.storage.local.set({ [SITE_KEY]: [...origins] });
    // Apply the choice to tabs already open on this origin, without waiting for navigation.
    const matching = await chrome.tabs.query({ url: pattern });
    await Promise.allSettled(matching.map(async (candidate) => {
      if (enabled) await injectPage(candidate.id);
      await chrome.tabs.sendMessage(candidate.id, { type: 'SIDER_ENABLE_SELECTION', enabled }, { frameId: 0 });
    }));
    return { ok: true, enabled, origin };
  }));
  siteQueue = operation.catch(() => {});
  return operation;
}

async function syncSourceScripts(origins) {
  if (!chrome.scripting.getRegisteredContentScripts) return;
  const desired = [];
  for (const origin of origins) if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) desired.push({ id: siteScriptId(origin), matches: [`${origin}/*`], js: ['page-content.js'], runAt: 'document_idle', persistAcrossSessions: true });
  const old = (await chrome.scripting.getRegisteredContentScripts()).filter(script => script.id.startsWith('sider-selection-'));
  const removed = old.filter(script => !desired.some(next => next.id === script.id));
  if (removed.length) await chrome.scripting.unregisterContentScripts({ ids: removed.map(script => script.id) });
  const added = desired.filter(script => !old.some(previous => previous.id === script.id));
  if (added.length) await chrome.scripting.registerContentScripts(added);
}

function importConfiguration(message) {
  return configurationOperation(async () => {
    await getTemplates();
    const backup = validateConfiguration(message.backup);
    const previous = exportConfiguration(await chrome.storage.local.get(CONFIGURATION_KEYS));
    if (!message.expected || JSON.stringify(message.expected) !== JSON.stringify(previous.configuration)) throw new Error('预览后配置已变化，请重新选择文件并核对变更。已有配置保持原样。');
    const settings = backup.configuration.aiWeb;
    const site = selectedAISite(settings);
    if (!await chrome.permissions.contains({ origins: [aiSitePattern(site)] })) throw new Error(`尚未获得 ${site.name} 的网站权限，已有配置保持原样。`);
    try {
      await syncAIScripts(settings); await syncSourceScripts(backup.configuration.enabledOrigins);
      // One storage commit replaces every supported setting together.
      await chrome.storage.local.set(configurationStorage(backup)); aiWebSettings = settings;
    } catch (error) {
      const restored = await Promise.allSettled([syncAIScripts(previous.configuration.aiWeb), syncSourceScripts(previous.configuration.enabledOrigins)]);
      if (restored.some(result => result.status === 'rejected')) throw new Error(`${error.message}\n已有配置未改动，但网站脚本恢复失败，请在扩展管理页面重新加载 Sider 后重试。`);
      throw error;
    }
    for (const origin of new Set([...previous.configuration.enabledOrigins, ...backup.configuration.enabledOrigins])) {
      const enabled = backup.configuration.enabledOrigins.includes(origin);
      const tabs = await chrome.tabs.query({ url: `${origin}/*` }).catch(() => []);
      await Promise.allSettled(tabs.map(async tab => { if (enabled) await injectPage(tab.id); await chrome.tabs.sendMessage(tab.id, { type: 'SIDER_ENABLE_SELECTION', enabled }, { frameId: 0 }); }));
    }
    return { ok: true, settings };
  });
}

async function handleMessage(message, sender) {
  await aiSettingsInitialization;
  await embedInitialization;
  authorize(message, sender);
  switch (message.type) {
    case 'SIDER_AI_WEB_SETTINGS_GET':
      await aiSettingsInitialization;
      return { ok: true, settings: aiWebSettings, sites: listAISites(aiWebSettings) };
    case 'SIDER_AI_WEB_SETTINGS_SAVE': return saveAISettings(message.settings);
    case 'SIDER_CONFIGURATION_EXPORT': await getTemplates(); return { ok: true, backup: exportConfiguration(await chrome.storage.local.get(CONFIGURATION_KEYS)) };
    case 'SIDER_CONFIGURATION_IMPORT': return importConfiguration(message);
    case 'SIDER_GEMINI_DEFAULTS_GET': return { ok: true, settings: { geminiModel: aiWebSettings.geminiModel, geminiExtendedThinking: aiWebSettings.geminiExtendedThinking } };
    case 'SIDER_ENHANCEMENT_REQUEST': return enhancementRequest(message, sender);
    case 'SIDER_SELECTION_CHANGED': return receiveSelection(message, sender);
    case 'SIDER_OPEN_SOURCE_PANEL': return changeTabAttachment(sender.tab.id, 'selection', true);
    case 'SIDER_TAB_CONTEXT_GET': return withTab(message.tabId, () => contextResponse(message.tabId, true, { refreshPage: message.refreshPage === true, knownContext: message.knownContext }));
    case 'SIDER_TAB_ATTACHMENT_SET': return changeTabAttachment(message.tabId, message.kind, message.enabled);
    case 'SIDER_TAB_SELECTION_CLEAR': return clearCurrentSelection(message.tabId);
    case 'SIDER_CONTEXT_SETTINGS_PATCH': return changeContextSettings(message.tabId, message.patch);
    case 'SIDER_STATE_GET': return { ok: true, state: await getState() };
    case 'SIDER_STATE_PATCH': return { ok: true, state: await patchState(message.patch) };
    case 'SIDER_ADD_REFERENCE':
      validateReference(message.reference, sender);
      return { ok: true, ...await addReference(message.reference) };
    case 'SIDER_REMOVE_REFERENCE': return { ok: true, state: await removeReference(message.id) };
    case 'SIDER_REFERENCE_SELECTION': return { ok: true, state: await setReferenceSelected(message.id, message.selected) };
    case 'SIDER_UPDATE_REFERENCE': return { ok: true, ...await updateReference(message.id, message.changes) };
    case 'SIDER_CAPTURE': return capture(message, sender);
    case 'SIDER_CHAT_READY': return registerChatFrame(message, sender);
    case 'SIDER_CHAT_FILL': return fillChat(message);
    case 'SIDER_CHAT_OPEN': return { ok: true, tabId: (await openChat(message.siteId)).id };
    case 'SIDER_EMBED_REGISTER': return registerEmbed(message);
    case 'SIDER_EMBED_STATUS_GET': return embedStatus(message.bridgeId);
    case 'SIDER_EMBED_UNREGISTER': return unregisterEmbed(message);
    case 'SIDER_SOURCE_OPEN': return openSource(message);
    case 'SIDER_SOURCE_INFO': return sourceInfo(message);
    case 'SIDER_SOURCE_ACCESS_REQUEST': return requestSourceAccess(message);
    case 'SIDER_ENABLE_SITE': return changeSite(message, sender, true);
    case 'SIDER_DISABLE_SITE': return changeSite(message, sender, false);
    default: throw new Error('未知的扩展操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (['SIDER_OPEN_PANEL', 'SIDER_TOGGLE_PANEL', 'SIDER_PANEL_STATE_GET'].includes(message?.type)) {
    if (!isPageSender(sender) || (sender.frameId || 0) !== 0) {
      sendResponse({ ok: false, error: '拒绝来自非网页主框架的打开请求。' });
      return false;
    }
    if (message.type === 'SIDER_PANEL_STATE_GET') {
      panelState.ready.then(() => sendResponse({ ok: true, opened: panelState.isOpen(sender.tab.id) }));
    } else if (message.type === 'SIDER_TOGGLE_PANEL' && panelState.isOpen(sender.tab.id, message.opened)) {
      closePanelNow(sender.tab).then(sendResponse);
    } else {
      // Keep opening within the message gesture, even on a cold worker start.
      prepareSource(sender.tab);
      openPanelNow(sender.tab).then(sendResponse);
    }
    return true;
  }
  // Opening the panel must precede async storage or tab lookups to retain the gesture.
  if (isPageSender(sender) && !isChatURL(sender.url) && message?.type === 'SIDER_OPEN_SOURCE_PANEL') {
    prepareSource(sender.tab);
    openPanelNow(sender.tab);
  }
  handleMessage(message, sender).then(sendResponse, (error) => sendResponse({ ok: false, error: error?.message || '操作失败，请重试。',
    ...(['SOURCE_ACCESS_REQUIRED', 'REFERENCE_CHANGED', 'SOURCE_UNAVAILABLE', 'SOURCE_CLOSED'].includes(error?.code) ? { code: error.code } : {}) }));
  return true;
});

async function recordEvent(operation) {
  try {
    const result = await operation;
    await chrome.storage.local.set({ siderLastEvent: { ok: true, message: '当前网页引用已更新。', at: Date.now() } });
    return result;
  } catch (error) {
    await chrome.storage.local.set({ siderLastEvent: { ok: false, error: error?.message || '引用失败。', at: Date.now() } });
    return null;
  }
}

async function contextCapture(info, tab, kind) {
  if (kind === 'selection' && info.editable) throw new Error('输入框与编辑器中的文字不会作为网页划词引用。');
  if ((info.frameId || 0) !== 0) throw new Error('请在网页主框架中划词。');
  if (kind !== 'selection') return changeTabAttachment(tab.id, kind, true);
  return withTab(tab.id, async () => {
    const result = await contextResponse(tab.id);
    if (!result.context.selection && info.editable === false && info.selectionText) {
      const source = await sourceById(tab.id);
      const reference = { kind, title: source.title, url: source.url, content: info.selectionText };
      validateReference(reference, {});
      result.context = await updateTabSelection(tab.id, source, reference);
    }
    if (!result.context.selection) throw new Error('请先在网页正文中划词。');
    result.context = await setTabTemplate(tab.id, PRESET_IDS.selection, true, await getTemplates());
    return result;
  });
}

async function configureMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'sider-open-panel', title: '打开 Sider 侧栏', contexts: ['all'], documentUrlPatterns: ['https://*/*', 'http://*/*'] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'sider-open-panel' || !Number.isInteger(tab?.id)) return;
  prepareSource(tab);
  openPanelNow(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (['open-side-panel', 'open-panel'].includes(command)) {
    prepareSource(tab);
    openPanelNow(tab);
  }
  else if (['capture-selection', 'quote-selection'].includes(command)) {
    openPanelNow(tab);
    void recordEvent((async () => {
      const source = await sourceTab(Number.isInteger(tab?.id) ? { tabId: tab.id } : {});
      return contextCapture({ editable: false }, source, 'selection');
    })());
  }
});

chrome.action.onClicked.addListener((tab) => {
  // Native action execution grants activeTab; automatic sidebar toggling doesn't.
  prepareSource(tab);
  openPanelNow(tab);
});

chrome.tabs.onCreated.addListener(tab => { void configureTabPanel(tab).catch(() => {}); });
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(tab => { rememberSource(tab); void configureTabPanel(tab).catch(() => {}); }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tab.active && (change.url || change.status === 'complete')) rememberSource(tab);
  if (change.status === 'loading' || change.url) {
    sourceVersions.set(tabId, (sourceVersions.get(tabId) || 0) + 1);
    liveSources.delete(tabId);
    void referenceSessions.invalidate(tabId, 'loading', '来源网页正在加载，请等待完成。').catch(() => {});
    void withTab(tabId, () => resetTabContext(tabId, { url: isWebURL(tab.url) && !isChatURL(tab.url) ? tab.url : '', title: tab.title || '' })).catch(() => {});
    for (const [key, frame] of chatFrames) if (frame.tabId === tabId) chatFrames.delete(key);
  }
  if (change.status === 'complete' && isWebURL(tab.url) && !isChatURL(tab.url)) prepareSource(tab);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  liveSources.delete(tabId);
  sourceVersions.delete(tabId);
  void referenceSessions.invalidate(tabId, 'closed', '来源标签页已关闭，请重新选择引用来源或切回当前页。').catch(() => {});
  void referenceSessions.remove(tabId).catch(() => {});
  void withTab(tabId, () => removeTabContext(tabId)).finally(() => tabOperations.delete(tabId)).catch(() => {});
  for (const [bridgeId, registration] of embedRegistrations) if (registration.tabId === tabId) void unregisterEmbed({ bridgeId }).catch(() => {});
  for (const [windowId, id] of recentSources) if (id === tabId) recentSources.delete(windowId);
  for (const [key, frame] of chatFrames) if (frame.tabId === tabId) chatFrames.delete(key);
});
chrome.windows.onRemoved.addListener((windowId) => {
  recentSources.delete(windowId);
  for (const [bridgeId, registration] of embedRegistrations) {
    if (registration.windowId === windowId) {
      unregisterEmbed({ bridgeId }).catch((error) => {
        chrome.storage.local.set({ siderLastEvent: { ok: false, error: error.message, at: Date.now() } }).catch(() => {});
      });
    }
  }
});

chrome.permissions.onRemoved?.addListener((removed) => {
  if (removed.origins?.length) {
    liveSources.clear();
    void referenceSessions.all().then(async states => {
      const ids = new Set(Object.values(states).filter(state => removed.origins.some(pattern => pattern === '<all_urls>'
        || pattern === 'https://*/*' && state.context.url.startsWith('https:') || pattern === 'http://*/*' && state.context.url.startsWith('http:')
        || parseURL(pattern)?.origin === parseURL(state.context.url)?.origin)).map(state => state.sourceTabId));
      await Promise.all([...ids].map(id => referenceSessions.invalidate(id, 'needs-access', sourceAccessError().message)));
    }).catch(() => {});
  }
  changeEmbed(async () => {
    const all = removed.permissions?.includes(EMBED_PERMISSION);
    for (const [id, registration] of embedRegistrations) {
      if (all || !await chrome.permissions.contains({ origins: [aiSitePattern(registration.site || BUILTIN_AI_SITES[0])] })) {
        embedRegistrations.delete(id);
        for (const entry of chatPorts) if (entry.bridgeId === id) { entry.reportedEmbedded = false; entry.enhancementReady = false; }
        for (const [key, frame] of chatFrames) if (frame.bridgeId === id) chatFrames.delete(key);
      }
    }
    await updateEmbedRule(embedRegistrations.size > 0);
    await persistEmbeds();
    await syncAIScripts();
  }).catch((error) => {
    chrome.storage.local.set({ siderLastEvent: { ok: false, error: error.message, at: Date.now() } }).catch(() => {});
  });
});

chrome.permissions.onAdded?.addListener(() => {
  void aiSettingsInitialization.then(syncAIScripts).catch(() => {});
  void chrome.storage.local.get(ENABLED_ORIGINS_KEY).then(stored => syncSourceScripts(stored[ENABLED_ORIGINS_KEY] || [])).catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[AI_WEB_SETTINGS_KEY]) return;
  aiWebSettings = normalizeAIWebSettings(changes[AI_WEB_SETTINGS_KEY].newValue);
});

embedInitialization = restoreEmbeds();
embedQueue = embedInitialization.catch(() => {});

chrome.runtime.onInstalled.addListener(() => { void configureMenus().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void configureExistingPanels(); });
// Let the native action event run so clicking the icon also grants page access.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
async function configureExistingPanels() {
  await chrome.sidePanel.setOptions({ path: 'panel.html', enabled: false });
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(tab => { rememberSource(tab); return configureTabPanel(tab); }));
}
void configureExistingPanels().catch(() => {});
