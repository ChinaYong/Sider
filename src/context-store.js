import { TAB_CONTEXT_PREFIX, MAX_CONTEXT_CHARS, DEFAULT_REFERENCE_KEYS, createTabContext, normalizeContext, normalizeContextSettings, validateContextReference } from './context.js';
import { getTemplates, PRESET_IDS, templateSettings, UNIFIED_TEMPLATES_KEY, validateTemplates } from './prompt-templates.js';
import { needsPageVariables, needsTemplateSelection } from './variables.js';

let contextQueue = Promise.resolve();
let settingsQueue = Promise.resolve();

function contextKey(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('没有可用的网页标签页。');
  return `${TAB_CONTEXT_PREFIX}${tabId}`;
}
function sourceIdentity(source = {}) {
  let url;
  try { url = new URL(String(source.url)); } catch { throw new Error('仅支持 HTTP 或 HTTPS 网页。'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('仅支持 HTTP 或 HTTPS 网页。');
  return { url: url.href, title: String(source.title ?? url.hostname) };
}
function enqueueContext(fn) {
  const operation = contextQueue.then(fn);
  contextQueue = operation.catch(() => {});
  return operation;
}
export async function getTabContext(tabId) {
  const key = contextKey(tabId);
  const result = await chrome.storage.session.get(key);
  return normalizeContext(result[key], tabId);
}
function mutateContext(tabId, mutation) {
  const key = contextKey(tabId);
  return enqueueContext(async () => {
    const previous = await getTabContext(tabId);
    const context = structuredClone(previous);
    await mutation(context);
    if (JSON.stringify(context) === JSON.stringify(previous)) return previous;
    context.revision = previous.revision + 1;
    await chrome.storage.session.set({ [key]: context });
    return context;
  });
}
function applySource(context, source) {
  const identity = sourceIdentity(source);
  if (context.url !== identity.url) {
    if (!context.url && context.defaultsInitialized) context.pageError = '';
    else Object.assign(context, createTabContext(context.tabId), { revision: context.revision });
  }
  Object.assign(context, identity);
}

export function updateTabSelection(tabId, source, selection) {
  return mutateContext(tabId, async context => {
    applySource(context, source);
    const next = selection === null || selection === undefined ? null : validateContextReference(selection, 'selection', context);
    const previous = context.selection;
    const sameSelection = next && previous && ['content', 'context', 'url'].every(key => next[key] === previous[key]) && JSON.stringify(next.locator) === JSON.stringify(previous.locator);
    const unchanged = sameSelection && next.title === previous.title;
    context.selection = unchanged ? previous : next;
    if (!sameSelection && (next || previous)) {
      const templates = await getTemplates(); initializeTemplates(context, templates);
      syncTemplateDemand(context, templates);
    }
  });
}
export function setTabAttachment(tabId, kind, referenceOrBoolean) {
  if (!['selection', 'url', 'page'].includes(kind)) return Promise.reject(new Error('不支持的网页引用类型。'));
  return mutateContext(tabId, context => {
    if (kind === 'selection') {
      if (typeof referenceOrBoolean !== 'boolean') throw new Error('划词引用必须为启用或关闭。');
      if (referenceOrBoolean && !context.selection) throw new Error('请先在网页正文中划词。');
      context.selectionIncluded = referenceOrBoolean;
      if (context.templateSelections) context.templateSelections[PRESET_IDS.selection] = referenceOrBoolean;
    } else if (kind === 'url') {
      if (referenceOrBoolean === true) sourceIdentity(context);
      if (typeof referenceOrBoolean !== 'boolean') throw new Error('URL 引用必须为启用或关闭。');
      context.attachments.url = referenceOrBoolean;
      if (context.templateSelections) context.templateSelections[PRESET_IDS.url] = referenceOrBoolean;
    } else {
      const wasRequested = context.pageRequested;
      context.attachments.page = referenceOrBoolean === null || referenceOrBoolean === false ? null : validateContextReference(referenceOrBoolean, 'page', context);
      context.pageRequested = Boolean(context.attachments.page);
      if (context.templateSelections && (!wasRequested || !context.attachments.page)) context.templateSelections[PRESET_IDS.page] = Boolean(context.attachments.page);
      context.pageError = '';
    }
  });
}
export function applyTabDefaults(tabId, rawSettings, kinds) {
  const settings = normalizeContextSettings(rawSettings);
  return mutateContext(tabId, context => {
    if (context.defaultsInitialized && kinds === undefined) return;
    const changed = context.defaultsInitialized ? kinds : Object.keys(DEFAULT_REFERENCE_KEYS);
    context.defaultsInitialized = true;
    for (const kind of changed) {
      const enabled = settings[DEFAULT_REFERENCE_KEYS[kind]];
      if (kind === 'selection') context.selectionIncluded = enabled;
      else if (kind === 'url') context.attachments.url = enabled;
      else if (kind === 'page') {
        context.pageRequested = enabled;
        context.pageError = '';
        if (!enabled) context.attachments.page = null;
      }
    }
  });
}

export function initializeTemplates(context, templates) {
  if (context.templateSelections !== null) return;
  const legacy = context.defaultsInitialized;
  context.templateSelections = Object.fromEntries(templates.map(item => [item.id, legacy && item.preset
    ? item.preset === 'selection' ? context.selectionIncluded : item.preset === 'url' ? context.attachments.url : context.pageRequested
    : item.defaultIncluded]));
  context.defaultsInitialized = true;
}
export function syncTemplateDemand(context, templates) {
  const selected = templates.filter(item => context.templateSelections?.[item.id]
    && (!needsTemplateSelection(item) || context.selection?.content));
  context.selectionIncluded = Boolean(context.templateSelections?.[PRESET_IDS.selection]);
  context.attachments.url = Boolean(context.templateSelections?.[PRESET_IDS.url]);
  const requested = selected.some(item => needsPageVariables(item.text) || item.delivery !== 'text' && needsPageVariables(item.attachmentText));
  if (!requested) { context.attachments.page = null; context.pageError = ''; }
  context.pageRequested = requested;
}
export function applyTemplateDefaults(tabId, templates, changedIds) {
  return mutateContext(tabId, context => {
    initializeTemplates(context, templates);
    for (const id of Object.keys(context.templateSelections)) if (!templates.some(item => item.id === id)) delete context.templateSelections[id];
    for (const item of templates) {
      if (!Object.hasOwn(context.templateSelections, item.id) || changedIds?.includes(item.id)) {
        // A new default belongs to the saving page or a fresh source context.
        // Existing pages have no temporary choice for a newly created ID.
        context.templateSelections[item.id] = changedIds?.includes(item.id) ? item.defaultIncluded : false;
        context.explicitTemplates = context.explicitTemplates.filter(id => id !== item.id);
      }
    }
    syncTemplateDemand(context, templates);
  });
}
export function setTabTemplate(tabId, id, enabled, templates) {
  if (typeof enabled !== 'boolean' || !templates.some(item => item.id === id)) throw new Error('预设已删除或附加选项无效。');
  return mutateContext(tabId, context => {
    initializeTemplates(context, templates);
    context.templateSelections[id] = enabled;
    context.explicitTemplates = context.explicitTemplates.filter(value => value !== id);
    if (enabled) context.explicitTemplates.push(id);
    syncTemplateDemand(context, templates);
  });
}
export function clearTabTemplates(tabId, templates, expectedContext) {
  return mutateContext(tabId, context => {
    // A delayed send completion must not clear choices made for a newer context.
    if (expectedContext?.tabId !== tabId || expectedContext.url !== context.url || expectedContext.revision !== context.revision) return;
    initializeTemplates(context, templates);
    for (const id of Object.keys(context.templateSelections)) context.templateSelections[id] = false;
    context.explicitTemplates = [];
    syncTemplateDemand(context, templates);
  });
}
export function requestTabPage(tabId, error = '') {
  return mutateContext(tabId, context => {
    context.pageRequested = true;
    context.pageError = String(error);
    context.attachments.page = null;
  });
}
export function invalidateTabSource(tabId) {
  return mutateContext(tabId, context => {
    context.url = ''; context.title = ''; context.selection = null; context.attachments.page = null;
  });
}
export function clearTabSelection(tabId) {
  return mutateContext(tabId, context => { context.selection = null; context.selectionIncluded = true; });
}
export function resetTabContext(tabId, source = {}) {
  return mutateContext(tabId, context => {
    const identity = source.url ? sourceIdentity(source) : { url: '', title: '' };
    Object.assign(context, createTabContext(tabId), { revision: context.revision }, identity);
  });
}
export function removeTabContext(tabId) {
  const key = contextKey(tabId);
  return enqueueContext(() => chrome.storage.session.remove(key));
}
export async function getContextSettings() {
  return normalizeContextSettings(templateSettings(await getTemplates()));
}
export function patchContextSettings(patch = {}, { includeChanges = false } = {}) {
  const operation = settingsQueue.then(async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('引用设置格式无效。');
    const settings = await getContextSettings();
    for (const kind of ['selection', 'url', 'page']) {
      const defaultKey = DEFAULT_REFERENCE_KEYS[kind];
      if (Object.hasOwn(patch, defaultKey) && typeof patch[defaultKey] !== 'boolean') throw new Error('默认勾选选项必须为启用或关闭。');
      const templateKey = `${kind}Template`, positionKey = `${kind}Position`;
      if (Object.hasOwn(patch, templateKey) && typeof patch[templateKey] !== 'string') throw new Error('追加格式必须为文本。');
      if (Object.hasOwn(patch, positionKey) && !['prepend', 'append'].includes(patch[positionKey])) throw new Error('追加位置必须为前置或追加。');
    }
    if (Object.hasOwn(patch, 'pageMode') && !['auto', 'text', 'file'].includes(patch.pageMode)) throw new Error('正文发送方式必须为自动、文本或附件。');
    if (Object.hasOwn(patch, 'pageThreshold') && (!Number.isInteger(patch.pageThreshold) || patch.pageThreshold < 1 || patch.pageThreshold > MAX_CONTEXT_CHARS)) throw new Error('正文附件阈值必须为 1 至 1000000 的整数。');
    if (Object.hasOwn(patch, 'pageAttachmentTemplate') && typeof patch.pageAttachmentTemplate !== 'string') throw new Error('正文附件格式必须为文本。');
    const next = normalizeContextSettings({ ...settings, ...patch });
    const templates = await getTemplates();
    const mapped = templates.map(item => {
      if (!item.preset) return item;
      const kind = item.preset;
      return { ...item, text: next[`${kind}Template`], position: next[`${kind}Position`], defaultIncluded: next[DEFAULT_REFERENCE_KEYS[kind]],
        ...(kind === 'page' ? { delivery: next.pageMode, threshold: next.pageThreshold, attachmentText: next.pageAttachmentTemplate } : {}) };
    });
    await chrome.storage.local.set({ [UNIFIED_TEMPLATES_KEY]: validateTemplates(mapped) });
    return includeChanges ? { settings: next, changedDefaults: Object.keys(DEFAULT_REFERENCE_KEYS).filter(kind => next[DEFAULT_REFERENCE_KEYS[kind]] !== settings[DEFAULT_REFERENCE_KEYS[kind]]) } : next;
  });
  settingsQueue = operation.catch(() => {});
  return operation;
}
