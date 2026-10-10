export const LAUNCHER_SETTINGS_KEY = 'sider.launcher.v1';
export const LAUNCHER_ORIGINS = ['https://*/*', 'http://*/*'];

// Rules use an exact hostname across protocols and ports; subdomains are separate sites.
export function normalizeLauncherSite(value) {
  if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim())) return '';
  try {
    const url = new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')) return '';
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return ''; }
}

const normalizeSites = values => [...new Set((Array.isArray(values) ? values : []).map(normalizeLauncherSite).filter(Boolean))];

export function normalizeLauncherSettings(value = {}) {
  return {
    floating: value?.floating !== false,
    side: value?.side === 'left' ? 'left' : 'right',
    y: typeof value?.y === 'number' && Number.isFinite(value.y) ? Math.max(0, Math.min(1, value.y)) : 0.65,
    mode: value?.mode === 'whitelist' ? 'whitelist' : 'blacklist',
    blacklist: normalizeSites(value?.blacklist),
    whitelist: normalizeSites(value?.whitelist),
  };
}

export function launcherVisible(value, url) {
  const settings = normalizeLauncherSettings(value);
  let site;
  try { const page = new URL(url); site = /^https?:$/.test(page.protocol) ? normalizeLauncherSite(page.href) : ''; } catch { return false; }
  if (!settings.floating || !site) return false;
  const listed = settings[settings.mode].includes(site);
  return settings.mode === 'whitelist' ? listed : !listed;
}

export function setLauncherSite(value, url, listed = true) {
  const settings = normalizeLauncherSettings(value), site = normalizeLauncherSite(url);
  if (!site) throw new Error('请输入有效的网站域名或 HTTP(S) 地址。');
  settings[settings.mode] = settings[settings.mode].filter(item => item !== site);
  if (listed) settings[settings.mode].push(site);
  return settings;
}

export function validateLauncherSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.floating !== 'boolean'
    || !['left', 'right'].includes(value.side) || typeof value.y !== 'number' || !Number.isFinite(value.y) || value.y < 0 || value.y > 1
    || (value.mode !== undefined && !['blacklist', 'whitelist'].includes(value.mode))
    || ['blacklist', 'whitelist'].some(key => value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(site => !normalizeLauncherSite(site))))) {
    throw new Error('悬浮球设置无效。');
  }
  return normalizeLauncherSettings(value);
}
