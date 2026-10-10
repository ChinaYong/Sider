export const FONT_SETTINGS_KEY = 'sider.font.v1';
export const DEFAULT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
export const FONT_OPTIONS = [
  { value: 'system', label: '系统默认', family: DEFAULT_FONT_FAMILY },
  { value: 'yahei', label: '微软雅黑', family: '"Microsoft YaHei", "Microsoft YaHei UI", sans-serif' },
  { value: 'pingfang', label: '苹方', family: '"PingFang SC", "Microsoft YaHei", sans-serif' },
  { value: 'noto-sans', label: '思源黑体', family: '"Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", sans-serif' },
  { value: 'noto-serif', label: '思源宋体', family: '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", serif' },
  { value: 'mono', label: '等宽字体', family: '"Cascadia Code", Consolas, "SFMono-Regular", "Microsoft YaHei", monospace' },
  { value: 'custom', label: '自定义字体' },
];

const validName = value => typeof value === 'string' && value.trim().length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);

export function normalizeFontSettings(value) {
  const customFont = validName(value?.customFont) ? value.customFont.trim() : '';
  const font = FONT_OPTIONS.some(option => option.value === value?.font) && (value.font !== 'custom' || customFont) ? value.font : 'system';
  return { font, customFont };
}

export function validateFontSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !FONT_OPTIONS.some(option => option.value === value.font)
    || !validName(value.customFont) || value.font === 'custom' && !value.customFont.trim()) {
    throw new Error('字体设置无效，请填写 1–100 字符的本机字体名称。');
  }
  return normalizeFontSettings(value);
}

export function fontFamily(value) {
  const settings = normalizeFontSettings(value);
  // Quote the name as one CSS string; punctuation never becomes CSS syntax.
  return settings.font === 'custom' ? `"${settings.customFont.replace(/[\\"]/g, '\\$&')}", ${DEFAULT_FONT_FAMILY}`
    : FONT_OPTIONS.find(option => option.value === settings.font).family;
}

export function fontLabel(value) {
  const settings = normalizeFontSettings(value);
  return settings.font === 'custom' ? settings.customFont : FONT_OPTIONS.find(option => option.value === settings.font).label;
}

export function applyFontSettings(element, value) {
  element.style.setProperty('--sider-font-family', fontFamily(value));
}

/** Apply only to an extension document or shadow host, never the AI document. */
export function installFontSettings({ element, chrome, onChanged = () => {} }) {
  let revision = 0, disposed = false;
  const apply = value => {
    if (disposed) return;
    const settings = normalizeFontSettings(value);
    applyFontSettings(element, settings); onChanged(settings);
  };
  apply();
  const changed = (changes, area) => {
    if (area !== 'local' || !changes[FONT_SETTINGS_KEY]) return;
    revision++; apply(changes[FONT_SETTINGS_KEY].newValue);
  };
  chrome?.storage?.onChanged?.addListener(changed);
  const ready = (async () => {
    if (!chrome?.storage?.local?.get) return;
    const stored = await chrome.storage.local.get(FONT_SETTINGS_KEY);
    if (revision === 0) apply(stored[FONT_SETTINGS_KEY]);
  })();
  // A missing extension context leaves the default font usable.
  void ready.catch(() => {});
  const view = element.ownerDocument.defaultView;
  function dispose() {
    if (disposed) return;
    disposed = true; chrome?.storage?.onChanged?.removeListener?.(changed);
    view.removeEventListener('pagehide', dispose);
  }
  view.addEventListener('pagehide', dispose, { once: true });
  return { ready, dispose };
}
