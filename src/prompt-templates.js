import { MAX_CONTEXT_CHARS, normalizeContextSettings } from './context.js';
import { validateVariables } from './variables.js';
import { parseAttachmentRegion, escapeLegacyAttachmentMarkers } from './attachment-region.js';
export const PROMPT_TEMPLATES_KEY = 'sider.promptTemplates.v1';
export const LEGACY_UNIFIED_TEMPLATES_KEY = 'sider.templates.v2';
export const UNIFIED_TEMPLATES_KEY = 'sider.templates.v3';
export const PRESET_IDS = Object.freeze({ selection: 'preset-selection', url: 'preset-url', page: 'preset-page' });
export const DEFAULT_ATTACHMENT_TEXT = '预设“{{template.name}}”的内容见附件《{{filename}}》。';

export function newTemplate(overrides = {}) {
  return { id: '', preset: null, name: '', text: '', position: 'append', defaultIncluded: false, action: 'append',
    delivery: 'text', threshold: 10000, attachmentText: DEFAULT_ATTACHMENT_TEXT, ...overrides };
}

export function presetTemplates(settings = {}) {
  return [
    newTemplate({ id: PRESET_IDS.selection, preset: 'selection', name: '划词', text: settings.selectionTemplate ?? '网页划词：\n{{selection}}', position: settings.selectionPosition ?? 'prepend', defaultIncluded: settings.defaultSelection ?? true }),
    newTemplate({ id: PRESET_IDS.url, preset: 'url', name: '网页链接', text: settings.urlTemplate ?? '网页 URL：{{url}}', position: settings.urlPosition ?? 'append', defaultIncluded: settings.defaultUrl ?? false }),
    newTemplate({ id: PRESET_IDS.page, preset: 'page', name: '网页正文', text: settings.pageTemplate ?? '网页正文：\n<attachment>{{content}}</attachment>', position: settings.pagePosition ?? 'append', defaultIncluded: settings.defaultPage ?? false, delivery: settings.pageMode ?? 'auto', threshold: settings.pageThreshold ?? 10000, attachmentText: settings.pageAttachmentTemplate ?? DEFAULT_ATTACHMENT_TEXT }),
  ];
}

export function validateTemplates(raw, { legacy = false } = {}) {
  if (!Array.isArray(raw) || raw.length > 103) throw new Error('预设须为数组，最多 100 条自建预设。');
  const ids = new Set();
  const presets = new Set();
  const result = raw.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(item.id) || ids.has(item.id)) throw new Error('预设 ID 无效或重复。');
    ids.add(item.id);
    if (item.preset !== null && (!Object.hasOwn(PRESET_IDS, item.preset) || PRESET_IDS[item.preset] !== item.id || presets.has(item.preset))) throw new Error('预置预设身份无效。');
    if (Object.values(PRESET_IDS).includes(item.id) && item.preset === null) throw new Error('预置预设身份无效。');
    if (item.preset) presets.add(item.preset);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80) throw new Error('预设名称须为 1–80 个字符。');
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_CONTEXT_CHARS) throw new Error('预设内容不能为空，最多 100 万字符。');
    if (!['prepend', 'append'].includes(item.position) || !(legacy ? ['attach', 'fill', 'send'] : ['replace', 'append', 'send']).includes(item.action) || typeof item.defaultIncluded !== 'boolean') throw new Error('预设位置、点击行为或默认勾选无效。');
    if (!legacy) try { parseAttachmentRegion(item.text); } catch (cause) { throw new Error(`预设“${item.name}”：${cause.message}`); }
    if (!['text', 'auto', 'file'].includes(item.delivery) || !Number.isInteger(item.threshold) || item.threshold < 1 || item.threshold > MAX_CONTEXT_CHARS) throw new Error('附件方式或阈值无效，阈值须为 1 至 1000000 的整数。');
    const unknown = validateVariables(item.text);
    if (unknown.length) throw new Error(`预设“${item.name}”含未知变量：${unknown.map(name => `{{${name}}}`).join('、')}。`);
    if (typeof item.attachmentText !== 'string') throw new Error('附件说明须为文本。');
    if (item.delivery !== 'text') {
      if (!item.attachmentText.trim() || item.attachmentText.length > MAX_CONTEXT_CHARS) throw new Error('附件说明不能为空，最多 100 万字符。');
      const invalid = validateVariables(item.attachmentText, 'attachment');
      if (invalid.length) throw new Error(`预设“${item.name}”附件说明含不支持的变量：${invalid.map(name => `{{${name}}}`).join('、')}。`);
    }
    return newTemplate({ id: item.id, preset: item.preset, name: item.name.trim(), text: item.text, position: item.position, defaultIncluded: item.defaultIncluded, action: item.action, delivery: item.delivery, threshold: item.threshold, attachmentText: item.attachmentText });
  });
  if (presets.size !== 3) throw new Error('必须保留划词、网页链接、网页正文三条预置预设。');
  return result;
}

export function migrateTemplates(settings, legacy = []) {
  const presets = presetTemplates(settings && Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, key.endsWith('Template') && key !== 'pageAttachmentTemplate' ? escapeLegacyAttachmentMarkers(value) : value])));
  return validateTemplates([...presets, ...validatePromptTemplates(legacy).map(item => newTemplate({ id: item.id, name: item.name, text: escapeLegacyAttachmentMarkers(item.text), action: item.directSend ? 'send' : 'append' }))]);
}

export function migrateUnifiedTemplates(raw) {
  return validateTemplates(validateTemplates(raw, { legacy: true }).map(item => ({ ...item, text: escapeLegacyAttachmentMarkers(item.text), action: item.action === 'send' ? 'send' : 'append' })));
}

// Serialize the first migration so concurrent sidebars never overwrite a save.
let migration = null;
export async function getTemplates() {
  if (migration) return structuredClone(await migration);
  migration = (async () => {
    const stored = await chrome.storage.local.get([UNIFIED_TEMPLATES_KEY, LEGACY_UNIFIED_TEMPLATES_KEY, 'sider.contextSettings.v1', PROMPT_TEMPLATES_KEY]);
    if (stored[UNIFIED_TEMPLATES_KEY] !== undefined) return validateTemplates(stored[UNIFIED_TEMPLATES_KEY]);
    const oldSettings = stored['sider.contextSettings.v1'];
    const templates = stored[LEGACY_UNIFIED_TEMPLATES_KEY] !== undefined ? migrateUnifiedTemplates(stored[LEGACY_UNIFIED_TEMPLATES_KEY]) : migrateTemplates(oldSettings === undefined ? undefined : normalizeContextSettings(oldSettings), stored[PROMPT_TEMPLATES_KEY] || []);
    await chrome.storage.local.set({ [UNIFIED_TEMPLATES_KEY]: templates });
    return templates;
  })();
  try { return structuredClone(await migration); } finally { migration = null; }
}

// Compatibility view for source capture and older callers, never a second store.
export function templateSettings(templates) {
  const settings = {};
  for (const item of templates.filter(item => item.preset)) {
    const kind = item.preset;
    settings[`default${kind === 'selection' ? 'Selection' : kind === 'url' ? 'Url' : 'Page'}`] = item.defaultIncluded;
    settings[`${kind}Template`] = item.text; settings[`${kind}Position`] = item.position;
    if (kind === 'page') Object.assign(settings, { pageMode: item.delivery, pageThreshold: item.threshold, pageAttachmentTemplate: item.attachmentText });
  }
  return settings;
}

export function validatePromptTemplates(raw) {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error('快捷预设须为数组，最多 100 个。');
  const ids = new Set();
  return raw.map(template => {
    if (!template || typeof template.id !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(template.id) || ids.has(template.id)) throw new Error('快捷预设 ID 无效或重复。');
    ids.add(template.id);
    if (typeof template.name !== 'string' || !template.name.trim() || template.name.length > 80) throw new Error('预设名称须为 1–80 个字符。');
    if (typeof template.text !== 'string' || !template.text.trim() || template.text.length > MAX_CONTEXT_CHARS) throw new Error('预设内容不能为空，最多 100 万字符。');
    if (typeof template.directSend !== 'boolean') throw new Error('每个预设必须指定直接发送开关。');
    const unknown = validateVariables(template.text); if (unknown.length) throw new Error(`预设含无效变量：${unknown.map(name => `{{${name}}}`).join('、')}。`);
    return { id: template.id, name: template.name.trim(), text: template.text, directSend: template.directSend };
  });
}

export async function getPromptTemplates() {
  const result = await chrome.storage.local.get(PROMPT_TEMPLATES_KEY);
  return validatePromptTemplates(result[PROMPT_TEMPLATES_KEY] || []);
}

export function pageAlreadyInline(proof, question, context, editor, session) {
  const page = context?.attachments?.page;
  return Boolean(proof && page && proof.editor === editor && proof.session === session && proof.tabId === context.tabId && proof.url === context.url
    && page.url === context.url && proof.content === page.content && proof.content.trim() && question.includes(proof.content));
}
