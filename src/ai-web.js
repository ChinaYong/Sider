export const AI_WEB_SETTINGS_KEY = 'sider.aiWebSettings.v1';
export const GEMINI_NORMAL_URL = 'https://gemini.google.com/app';
export const GEMINI_SPARK_URL = 'https://gemini.google.com/spark';
export const GEMINI_MODE_NORMAL = 'normal';
export const GEMINI_MODE_SPARK = 'spark';
export const GEMINI_MODEL_FLASH_LITE = 'flash-lite';
export const GEMINI_MODEL_FLASH = 'flash';
export const GEMINI_MODEL_PRO = 'pro';
export const GEMINI_MODEL_OPTIONS = Object.freeze([
  Object.freeze({ value: GEMINI_MODEL_FLASH_LITE, label: 'Flash-Lite（快速）' }),
  Object.freeze({ value: GEMINI_MODEL_FLASH, label: 'Flash（均衡）' }),
  Object.freeze({ value: GEMINI_MODEL_PRO, label: 'Pro（高级推理）' }),
]);
export const BUILTIN_AI_SITES = Object.freeze([
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', adapter: 'chatgpt' },
  { id: 'gemini', name: 'Gemini', url: GEMINI_NORMAL_URL, adapter: 'gemini' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', adapter: 'claude' },
].map(site => Object.freeze({ ...site, origin: new URL(site.url).origin, selectors: Object.freeze({ composer: '', send: '', mount: '' }), sendShortcut: 'enter', builtin: true })));

function normalizeGeminiMode(value, strict = false) {
  if (value == null || value === GEMINI_MODE_NORMAL) return GEMINI_MODE_NORMAL;
  if (value === GEMINI_MODE_SPARK) return GEMINI_MODE_SPARK;
  if (strict) throw new Error('Gemini 界面设置无效。');
  return GEMINI_MODE_NORMAL;
}

function normalizeGeminiModel(value, strict = false) {
  if (value == null || value === GEMINI_MODEL_FLASH_LITE || value === GEMINI_MODEL_FLASH || value === GEMINI_MODEL_PRO) return value || GEMINI_MODEL_FLASH_LITE;
  if (strict) throw new Error('Gemini 默认模型设置无效。');
  return GEMINI_MODEL_FLASH_LITE;
}

function normalizeGeminiExtendedThinking(value, strict = false) {
  if (value == null || typeof value === 'boolean') return value === true;
  if (strict) throw new Error('Gemini 扩展思考设置无效。');
  return false;
}

export function normalizeGeminiDefaults(raw, strict = false) {
  return {
    model: normalizeGeminiModel(raw?.model ?? raw?.geminiModel, strict),
    extendedThinking: normalizeGeminiExtendedThinking(raw?.extendedThinking ?? raw?.geminiExtendedThinking, strict),
  };
}

export function aiSiteURL(site, settings) {
  if (site?.id === 'gemini' && normalizeGeminiMode(settings?.geminiMode) === GEMINI_MODE_SPARK) return GEMINI_SPARK_URL;
  return site?.url || '';
}

function normalizeControls(raw) {
  const selectors = {};
  for (const key of ['composer', 'send', 'mount']) {
    selectors[key] = String(raw?.selectors?.[key] || '').trim();
    if (selectors[key].length > 1000) throw new Error('CSS 选择器过长，请精简配置。');
  }
  const sendShortcut = raw?.sendShortcut || 'enter';
  if (!['enter', 'ctrl-enter', 'button'].includes(sendShortcut)) throw new Error('发送快捷键无效。');
  return { selectors, sendShortcut };
}

function builtinOverrides(raw, strict = false) {
  const overrides = {};
  if (raw == null) return overrides;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw new Error('内置网站配置无效。');
    return overrides;
  }
  for (const [id, value] of Object.entries(raw)) {
    try {
      if (!BUILTIN_AI_SITES.some(site => site.id === id) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内置网站配置无效。');
      const controls = normalizeControls(value);
      if (Object.values(controls.selectors).some(Boolean) || controls.sendShortcut !== 'enter') overrides[id] = controls;
    } catch (error) { if (strict) throw error; }
  }
  return overrides;
}

function withOverrides(settings, overrides) {
  return Object.keys(overrides).length ? { ...settings, builtinOverrides: overrides } : settings;
}

export function normalizeCustomAISite(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('AI 网站配置无效。');
  const name = String(raw.name || '').trim();
  if (!name || name.length > 80) throw new Error('请填写 1–80 个字符的网站名称。');
  let url;
  try { url = new URL(String(raw.url || '').trim()); } catch { throw new Error('请填写完整的 HTTP 或 HTTPS 网站地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网站地址必须使用 HTTP 或 HTTPS，且不能包含登录凭据。');
  if (BUILTIN_AI_SITES.some(site => site.origin === url.origin)) throw new Error('此地址已有内置适配，请选择对应的内置网站。');
  if (typeof raw.id !== 'string' || !/^custom-[a-zA-Z0-9-]{8,100}$/.test(raw.id)) throw new Error('自定义网站标识无效。');
  return { id: raw.id, name, url: url.href, origin: url.origin, adapter: 'generic', ...normalizeControls(raw), builtin: false };
}

export function validateAIWebSettings(raw) {
  if (!raw || !Array.isArray(raw.customSites)) throw new Error('AI 网站设置格式无效。');
  const geminiDefaults = normalizeGeminiDefaults(raw, true);
  const customSites = raw.customSites.map(normalizeCustomAISite);
  const ids = new Set(); const origins = new Set();
  for (const site of customSites) {
    if (ids.has(site.id) || origins.has(site.origin)) throw new Error('每个自定义网站的地址与标识必须唯一。');
    ids.add(site.id); origins.add(site.origin);
  }
  if (![...BUILTIN_AI_SITES, ...customSites].some(site => site.id === raw.activeSiteId)) throw new Error('请选择一个有效的 AI 网站。');
  return withOverrides({ activeSiteId: raw.activeSiteId, customSites, geminiMode: normalizeGeminiMode(raw.geminiMode, true), geminiModel: geminiDefaults.model, geminiExtendedThinking: geminiDefaults.extendedThinking }, builtinOverrides(raw.builtinOverrides, true));
}

export function normalizeAIWebSettings(raw) {
  const geminiDefaults = normalizeGeminiDefaults(raw);
  const customSites = []; const origins = new Set(); const ids = new Set();
  for (const candidate of Array.isArray(raw?.customSites) ? raw.customSites : []) {
    try {
      const site = normalizeCustomAISite(candidate);
      if (!origins.has(site.origin) && !ids.has(site.id)) { customSites.push(site); origins.add(site.origin); ids.add(site.id); }
    } catch { /* Invalid persisted entries cannot expand extension privileges. */ }
  }
  const activeSiteId = [...BUILTIN_AI_SITES, ...customSites].some(site => site.id === raw?.activeSiteId) ? raw.activeSiteId : 'chatgpt';
  return withOverrides({ activeSiteId, customSites, geminiMode: normalizeGeminiMode(raw?.geminiMode), geminiModel: geminiDefaults.model, geminiExtendedThinking: geminiDefaults.extendedThinking }, builtinOverrides(raw?.builtinOverrides));
}

export function listAISites(settings) {
  const normalized = normalizeAIWebSettings(settings);
  return [...BUILTIN_AI_SITES.map(site => normalized.builtinOverrides?.[site.id] ? { ...site, ...normalized.builtinOverrides[site.id] } : site), ...normalized.customSites];
}
export function selectedAISite(settings) { const normalized = normalizeAIWebSettings(settings); return listAISites(normalized).find(site => site.id === normalized.activeSiteId); }
export function siteForURL(value, settings) {
  try { const origin = new URL(value).origin; return listAISites(settings).find(site => site.origin === origin) || null; } catch { return null; }
}
export function aiSitePattern(site) { return `${site.origin}/*`; }
