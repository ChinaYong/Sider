import { TAB_CONTEXT_PREFIX, CONTEXT_SETTINGS_KEY, MAX_CONTEXT_CHARS, createTabContext, normalizeContext, normalizeContextSettings, validateContextReference } from './context.js';

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
    mutation(context);
    if (JSON.stringify(context) === JSON.stringify(previous)) return previous;
    context.revision = previous.revision + 1;
    await chrome.storage.session.set({ [key]: context });
    return context;
  });
}
function applySource(context, source) {
  const identity = sourceIdentity(source);
  if (context.url !== identity.url) Object.assign(context, createTabContext(context.tabId), { revision: context.revision });
  Object.assign(context, identity);
}

export function updateTabSelection(tabId, source, selection) {
  return mutateContext(tabId, context => {
    applySource(context, source);
    const next = selection === null || selection === undefined ? null : validateContextReference(selection, 'selection', context);
    const previous = context.selection;
    const unchanged = next && previous && ['content', 'context', 'url', 'title'].every(key => next[key] === previous[key]);
    context.selection = unchanged ? previous : next;
    context.selectionIncluded = true;
  });
}
export function setTabAttachment(tabId, kind, referenceOrBoolean) {
  if (!['url', 'page'].includes(kind)) return Promise.reject(new Error('不支持的网页引用类型。'));
  return mutateContext(tabId, context => {
    if (kind === 'url') {
      if (referenceOrBoolean === true) sourceIdentity(context);
      if (typeof referenceOrBoolean !== 'boolean') throw new Error('URL 引用必须为启用或关闭。');
      context.attachments.url = referenceOrBoolean;
    } else context.attachments.page = referenceOrBoolean === null || referenceOrBoolean === false ? null : validateContextReference(referenceOrBoolean, 'page', context);
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
  const result = await chrome.storage.local.get(CONTEXT_SETTINGS_KEY);
  return normalizeContextSettings(result[CONTEXT_SETTINGS_KEY]);
}
export function patchContextSettings(patch = {}) {
  const operation = settingsQueue.then(async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('引用设置格式无效。');
    const settings = await getContextSettings();
    for (const kind of ['selection', 'url', 'page']) {
      const templateKey = `${kind}Template`, positionKey = `${kind}Position`;
      if (Object.hasOwn(patch, templateKey) && typeof patch[templateKey] !== 'string') throw new Error('追加格式必须为文本。');
      if (Object.hasOwn(patch, positionKey) && !['prepend', 'append'].includes(patch[positionKey])) throw new Error('追加位置必须为前置或追加。');
    }
    if (Object.hasOwn(patch, 'pageMode') && !['auto', 'text', 'file'].includes(patch.pageMode)) throw new Error('正文发送方式必须为自动、文本或附件。');
    if (Object.hasOwn(patch, 'pageThreshold') && (!Number.isInteger(patch.pageThreshold) || patch.pageThreshold < 1 || patch.pageThreshold > MAX_CONTEXT_CHARS)) throw new Error('正文附件阈值必须为 1 至 1000000 的整数。');
    if (Object.hasOwn(patch, 'pageAttachmentTemplate') && typeof patch.pageAttachmentTemplate !== 'string') throw new Error('正文附件格式必须为文本。');
    const next = normalizeContextSettings({ ...settings, ...patch });
    await chrome.storage.local.set({ [CONTEXT_SETTINGS_KEY]: next });
    return next;
  });
  settingsQueue = operation.catch(() => {});
  return operation;
}
