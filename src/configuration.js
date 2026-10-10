import parse from 'css-tree/selector-parser';
import { CONTEXT_SETTINGS_KEY, DEFAULT_CONTEXT_SETTINGS, normalizeContextSettings, validateContextTemplate } from './context.js';
import { AI_WEB_SETTINGS_KEY, normalizeAIWebSettings, validateAIWebSettings, listAISites } from './ai-web.js';
import { PROMPT_TEMPLATES_KEY, LEGACY_UNIFIED_TEMPLATES_KEY, UNIFIED_TEMPLATES_KEY, validatePromptTemplates, validateTemplates, migrateTemplates, migrateUnifiedTemplates } from './prompt-templates.js';
import { parseAttachmentRegion } from './attachment-region.js';
import { LAUNCHER_SETTINGS_KEY, normalizeLauncherSettings, validateLauncherSettings } from './launcher-settings.js';
import { FONT_SETTINGS_KEY, normalizeFontSettings, validateFontSettings, fontLabel } from './font-settings.js';

export const ENABLED_ORIGINS_KEY = 'siderEnabledOrigins';
export const CONFIGURATION_KEYS = [UNIFIED_TEMPLATES_KEY, LEGACY_UNIFIED_TEMPLATES_KEY, CONTEXT_SETTINGS_KEY, AI_WEB_SETTINGS_KEY, PROMPT_TEMPLATES_KEY, ENABLED_ORIGINS_KEY, LAUNCHER_SETTINGS_KEY, FONT_SETTINGS_KEY];
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function validateOrigins(origins) {
  if (!Array.isArray(origins)) throw new Error('自动划词网站列表必须为数组。');
  const seen = new Set();
  return origins.map(origin => {
    let url; try { url = new URL(origin); } catch { throw new Error('自动划词网站地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password || seen.has(origin)) throw new Error('自动划词网站必须是唯一的 HTTP(S) 来源地址。');
    seen.add(origin); return origin;
  });
}

export function validateConfiguration(raw, document) {
  if (!object(raw) || raw.format !== 'sider-configuration' || ![1, 2, 3].includes(raw.version)) throw new Error('配置文件格式或版本不受支持。需要 Sider 配置版本 1、2 或 3。');
  const config = raw.configuration;
  if (!object(config)) throw new Error('配置文件缺少 configuration。');
  for (const key of [...(raw.version === 1 ? ['references'] : []), 'aiWeb', 'templates', 'enabledOrigins']) if (!Object.hasOwn(config, key)) throw new Error(`配置文件缺少必需字段 ${key}。`);
  let templates;
  if (raw.version === 1) {
    if (!object(config.references)) throw new Error('引用设置格式无效。');
    const references = normalizeContextSettings(config.references);
    for (const key of Object.keys(DEFAULT_CONTEXT_SETTINGS)) {
      if (!Object.hasOwn(config.references, key) || config.references[key] !== references[key]) throw new Error(`引用设置 ${key} 缺失或无效。`);
    }
    for (const kind of ['selection', 'url', 'page', 'pageAttachment']) {
      if (kind === 'pageAttachment' && references.pageMode === 'text') continue;
      const errors = validateContextTemplate(references[`${kind}Template`], { label: kind, attachment: kind === 'pageAttachment' });
      if (errors.length) throw new Error(errors[0]);
    }
    templates = migrateTemplates(references, validatePromptTemplates(config.templates));
  } else templates = raw.version === 2 ? migrateUnifiedTemplates(config.templates) : validateTemplates(config.templates);
  const aiWeb = validateAIWebSettings(config.aiWeb);
  for (const site of listAISites(aiWeb)) for (const selector of Object.values(site.selectors || {})) if (selector) {
    try { parse(selector, { context: 'selectorList' }); document?.querySelector(selector); }
    catch { throw new Error(`${site.name} 的 CSS 选择器无效：${selector}`); }
  }
  return { format: 'sider-configuration', version: 3, configuration: { aiWeb, templates, enabledOrigins: validateOrigins(config.enabledOrigins), launcher: config.launcher === undefined ? normalizeLauncherSettings() : validateLauncherSettings(config.launcher), font: config.font === undefined ? normalizeFontSettings() : validateFontSettings(config.font) } };
}

export function exportConfiguration(stored) {
  return { format: 'sider-configuration', version: 3, exportedAt: new Date().toISOString(), configuration: {
    aiWeb: normalizeAIWebSettings(stored[AI_WEB_SETTINGS_KEY]),
    launcher: normalizeLauncherSettings(stored[LAUNCHER_SETTINGS_KEY]),
    font: normalizeFontSettings(stored[FONT_SETTINGS_KEY]),
    templates: stored[UNIFIED_TEMPLATES_KEY] !== undefined ? validateTemplates(stored[UNIFIED_TEMPLATES_KEY]) : stored[LEGACY_UNIFIED_TEMPLATES_KEY] !== undefined ? migrateUnifiedTemplates(stored[LEGACY_UNIFIED_TEMPLATES_KEY]) : migrateTemplates(stored[CONTEXT_SETTINGS_KEY] === undefined ? undefined : normalizeContextSettings(stored[CONTEXT_SETTINGS_KEY]), stored[PROMPT_TEMPLATES_KEY] || []), enabledOrigins: validateOrigins(stored[ENABLED_ORIGINS_KEY] || []),
  } };
}

export function configurationStorage(config) {
  const value = validateConfiguration(config).configuration;
  return { [UNIFIED_TEMPLATES_KEY]: value.templates, [AI_WEB_SETTINGS_KEY]: value.aiWeb, [ENABLED_ORIGINS_KEY]: value.enabledOrigins, [LAUNCHER_SETTINGS_KEY]: value.launcher, [FONT_SETTINGS_KEY]: value.font };
}

export function configurationSummary(before, after) {
  const old = validateConfiguration(before).configuration, next = validateConfiguration(after).configuration;
  const names = sites => sites.map(site => site.name).join('、') || '无';
  const defaults = items => names(items.filter(item => item.defaultIncluded));
  const font = `扩展字体：${fontLabel(old.font)} → ${fontLabel(next.font)}\n`;
  const details = [`悬浮球：${next.launcher.floating ? '开启' : '关闭'}，${next.launcher.side === 'left' ? '左侧' : '右侧'}，高度 ${Math.round(next.launcher.y * 100)}%，${next.launcher.mode === 'whitelist' ? '白名单模式' : '黑名单模式'}\n悬浮球黑名单：${next.launcher.blacklist.join('、') || '无'}\n悬浮球白名单：${next.launcher.whitelist.join('、') || '无'}`, ...next.templates.map(item => `${item.name}：${item.position === 'prepend' ? '问题前' : '问题后'}，${({ replace: '替换', append: '追加', send: '直接发送' })[item.action]}，${item.delivery === 'text' ? '文本' : item.delivery === 'file' ? '附件' : `超过 ${item.threshold} 字符转附件`}，${parseAttachmentRegion(item.text).marked ? '指定附件区域' : '整条内容'}\n附件说明：${item.attachmentText}`)].join('\n');
  return `将完整替换以下配置：\n自定义网站：${names(old.aiWeb.customSites)} → ${names(next.aiWeb.customSites)}\n选用网站：${listAISites(next.aiWeb).find(site => site.id === next.aiWeb.activeSiteId).name}\n默认勾选：${defaults(old.templates)} → ${defaults(next.templates)}\n预设：${names(old.templates)} → ${names(next.templates)}\n${font}${details}\n自动划词网站：${next.enabledOrigins.join('、') || '无'}\nGemini 界面、模型、思考选项及网站控件配置也按文件替换。\n旧网站和旧预设不会合并。权限须在使用时授权，当前会话和草稿保留。`;
}
