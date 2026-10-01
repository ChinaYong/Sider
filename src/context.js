export const TAB_CONTEXT_PREFIX = 'sider.tabContext.';
export const CONTEXT_SETTINGS_KEY = 'sider.contextSettings.v1';
export const MAX_CONTEXT_CHARS = 1000000;
export const CONTEXT_VARIABLES = Object.freeze(['selection', 'selection.context', 'context', 'url', 'title', 'content', 'page.content']);
export const PAGE_ATTACHMENT_VARIABLES = Object.freeze([...CONTEXT_VARIABLES.filter(variable => !['content', 'page.content'].includes(variable)), 'filename']);
export const DEFAULT_CONTEXT_SETTINGS = Object.freeze({
  selectionTemplate: '网页划词：\n{{selection}}', selectionPosition: 'prepend',
  urlTemplate: '网页 URL：{{url}}', urlPosition: 'append',
  pageTemplate: '网页正文：\n{{content}}', pagePosition: 'append',
  pageMode: 'auto', pageThreshold: 10000,
  pageAttachmentTemplate: '网页正文见附件《{{filename}}》。请结合附件内容回答。',
});

function webURL(value) {
  try { const url = new URL(String(value)); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; }
}

export function createTabContext(tabId) {
  return { tabId: Number.isInteger(tabId) ? tabId : null, revision: 0, url: '', title: '', selection: null, selectionIncluded: true, attachments: { url: false, page: null } };
}

// Keep source text intact. The store rejects invalid captures; composition also
// checks restored data before allowing a send, without silently truncating it.
export function normalizeContextReference(raw, kind, source = {}) {
  if (raw === null || raw === undefined || raw === false) return null;
  const reference = typeof raw === 'string' && kind === 'selection' ? { content: raw } : raw;
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return { kind, url: '', title: '', content: '', context: '' };
  return {
    kind, url: webURL(reference.url ?? source.url), title: String(reference.title ?? source.title ?? ''),
    content: String(reference.content ?? ''), context: String(reference.context ?? ''),
    capturedAt: typeof reference.capturedAt === 'string' ? reference.capturedAt : '',
    locator: reference.locator && typeof reference.locator === 'object' ? {
      exact: String(reference.locator.exact ?? ''), prefix: String(reference.locator.prefix ?? ''), suffix: String(reference.locator.suffix ?? ''),
    } : null,
    extraction: reference.extraction && typeof reference.extraction === 'object' ? structuredClone(reference.extraction) : null,
  };
}

export function normalizeContext(raw, tabId = raw?.tabId) {
  const initial = createTabContext(tabId);
  if (!raw || typeof raw !== 'object') return initial;
  const source = { url: webURL(raw.url), title: String(raw.title ?? '') };
  return {
    ...initial, revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0, ...source,
    selection: normalizeContextReference(raw.selection, 'selection', source), selectionIncluded: raw.selectionIncluded !== false,
    attachments: { url: raw.attachments?.url === true, page: normalizeContextReference(raw.attachments?.page, 'page', source) },
  };
}

export function normalizeContextSettings(raw) {
  const settings = { ...DEFAULT_CONTEXT_SETTINGS };
  if (!raw || typeof raw !== 'object') return settings;
  // The former send budget is not an attachment threshold. Ignore maxChars
  // during migration rather than changing when an existing user gets a file.
  if (['auto', 'text', 'file'].includes(raw.pageMode)) settings.pageMode = raw.pageMode;
  if (Number.isFinite(Number(raw.pageThreshold)) && Number(raw.pageThreshold) >= 1) settings.pageThreshold = Math.min(MAX_CONTEXT_CHARS, Math.floor(Number(raw.pageThreshold)));
  if (typeof raw.pageAttachmentTemplate === 'string') settings.pageAttachmentTemplate = raw.pageAttachmentTemplate;
  for (const kind of ['selection', 'url', 'page']) {
    const templateKey = `${kind}Template`, positionKey = `${kind}Position`;
    if (typeof raw[templateKey] === 'string') settings[templateKey] = raw[templateKey];
    if (['prepend', 'append'].includes(raw[positionKey])) settings[positionKey] = raw[positionKey];
  }
  return settings;
}

export function validateContextReference(raw, kind, source) {
  const reference = normalizeContextReference(raw, kind, source);
  if (!reference || !reference.content.trim()) throw new Error(kind === 'selection' ? '没有取得划词内容，请先在网页正文中划词。' : '没有取得网页正文。');
  if (!reference.url || reference.url !== webURL(source.url)) throw new Error('引用来源与当前网页不一致，请重新引用。');
  if (reference.content.length > MAX_CONTEXT_CHARS || reference.context.length > MAX_CONTEXT_CHARS) throw new Error('引用超过 100 万字符，请选择较小的内容范围。内容没有被截断。');
  return reference;
}

export function composeContextPrompt(question, rawContext, rawSettings = {}, { attachmentName } = {}) {
  const draft = String(question ?? '');
  const context = normalizeContext(rawContext);
  const settings = normalizeContextSettings(rawSettings);
  const errors = [];
  const before = [], after = [];
  const included = [];
  let attachment = null, pageDelivery = null;
  if (!draft.trim()) errors.push('请先输入问题。');
  if (context.selection && context.selectionIncluded) included.push('selection');
  if (context.attachments.url) included.push('url');
  if (context.attachments.page) included.push('page');
  if (included.length && !context.url) errors.push('当前网页地址无效，请重新引用。');

  const checkReference = kind => {
    const reference = kind === 'selection' ? context.selection : context.attachments.page;
    if (!reference?.content.trim()) errors.push(kind === 'selection' ? '当前划词内容为空，请重新划词。' : '网页正文为空，请重新引用。');
    if (reference && reference.url !== context.url) errors.push('引用来源与当前网页不一致，请重新引用。');
    if (reference && (reference.content.length > MAX_CONTEXT_CHARS || reference.context.length > MAX_CONTEXT_CHARS)) errors.push('引用超过 100 万字符，请缩小内容范围。内容没有被截断。');
  };
  if (included.includes('selection')) checkReference('selection');
  if (included.includes('page')) checkReference('page');

  // Only settings templates are expanded. A user's question and every value
  // inserted into a template remain plain text, even when containing {{...}}.
  const value = variable => {
    if (variable === 'url') return context.url;
    if (variable === 'title') return context.title;
    if (variable === 'selection') return context.selection?.content;
    if (variable === 'selection.context' || variable === 'context') return context.selection?.context;
    if (variable === 'content' || variable === 'page.content') return context.attachments.page?.content;
    return undefined;
  };
  const expandTemplate = (template, label, filename) => {
    if (!template.trim()) errors.push(`${label}的追加格式不能为空，请在设置中修改。`);
    return template.replace(/\{\{([^{}]*)\}\}/g, (token, expression) => {
      const variable = expression.trim();
      if (filename !== undefined && ['content', 'page.content'].includes(variable)) { errors.push(`附件说明不能使用 {{${variable}}}，请使用 {{filename}} 引用正文附件。`); return token; }
      const allowed = filename === undefined ? CONTEXT_VARIABLES : PAGE_ATTACHMENT_VARIABLES;
      if (!allowed.includes(variable)) { errors.push(`未知变量 {{${variable}}}，请在设置中修改。`); return token; }
      const replacement = variable === 'filename' ? filename : value(variable);
      if (replacement === undefined || !String(replacement).trim()) { errors.push(`变量 {{${variable}}} 缺少内容，请检查当前网页引用。`); return token; }
      return replacement;
    });
  };
  for (const kind of included) {
    const label = kind === 'selection' ? '划词' : kind === 'url' ? 'URL' : '正文';
    let block = expandTemplate(settings[`${kind}Template`], label);
    if (kind === 'page') {
      pageDelivery = settings.pageMode === 'file' || (settings.pageMode === 'auto' && block.length > settings.pageThreshold) ? 'file' : 'text';
      if (pageDelivery === 'file') {
        const title = context.title || context.attachments.page.title || '未命名网页';
        const name = typeof attachmentName === 'string' && attachmentName.trim() ? attachmentName : pageFilename(title);
        attachment = {
          name, mimeType: 'text/plain',
          content: `标题：${title}\n来源 URL：${context.url}\n采集时间：${context.attachments.page.capturedAt || '未记录'}\n\n${block}`,
        };
        block = expandTemplate(settings.pageAttachmentTemplate, '正文附件说明', name);
      }
    }
    (settings[`${kind}Position`] === 'prepend' ? before : after).push(block);
  }
  const prefix = before.length ? `${before.join('\n\n')}\n\n` : '';
  const suffix = after.length ? `\n\n${after.join('\n\n')}` : '';
  const text = `${prefix}${draft}${suffix}`;
  return { text, prefix, suffix, errors: [...new Set(errors)], characterCount: text.length, attachment: errors.length ? null : attachment, pageDelivery };
}

function pageFilename(title) {
  const cleaned = String(title).replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '') || '未命名网页';
  let stem = '';
  for (const character of cleaned) { if (stem.length + character.length > 96) break; stem += character; }
  return `${stem.trim().replace(/[. ]+$/g, '') || '未命名网页'}-网页正文.txt`;
}
