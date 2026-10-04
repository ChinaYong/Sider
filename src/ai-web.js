export const AI_WEB_SETTINGS_KEY = 'sider.aiWebSettings.v1';
export const BUILTIN_AI_SITES = Object.freeze([
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', adapter: 'chatgpt' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', adapter: 'gemini' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', adapter: 'claude' },
].map(site => Object.freeze({ ...site, origin: new URL(site.url).origin, selectors: Object.freeze({ composer: '', send: '', mount: '' }), sendShortcut: 'enter', builtin: true })));

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
  const customSites = raw.customSites.map(normalizeCustomAISite);
  const ids = new Set(); const origins = new Set();
  for (const site of customSites) {
    if (ids.has(site.id) || origins.has(site.origin)) throw new Error('每个自定义网站的地址与标识必须唯一。');
    ids.add(site.id); origins.add(site.origin);
  }
  if (![...BUILTIN_AI_SITES, ...customSites].some(site => site.id === raw.activeSiteId)) throw new Error('请选择一个有效的 AI 网站。');
  return withOverrides({ activeSiteId: raw.activeSiteId, customSites }, builtinOverrides(raw.builtinOverrides, true));
}

export function normalizeAIWebSettings(raw) {
  const customSites = []; const origins = new Set(); const ids = new Set();
  for (const candidate of Array.isArray(raw?.customSites) ? raw.customSites : []) {
    try {
      const site = normalizeCustomAISite(candidate);
      if (!origins.has(site.origin) && !ids.has(site.id)) { customSites.push(site); origins.add(site.origin); ids.add(site.id); }
    } catch { /* Invalid persisted entries cannot expand extension privileges. */ }
  }
  const activeSiteId = [...BUILTIN_AI_SITES, ...customSites].some(site => site.id === raw?.activeSiteId) ? raw.activeSiteId : 'chatgpt';
  return withOverrides({ activeSiteId, customSites }, builtinOverrides(raw?.builtinOverrides));
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
