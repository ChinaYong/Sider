import { FONT_SETTINGS_KEY, FONT_OPTIONS, normalizeFontSettings, validateFontSettings, fontFamily, applyFontSettings, installFontSettings } from './font-settings.js';

export function installFontSettingsUI({ document, chrome }) {
  const $ = selector => document.querySelector(selector);
  const select = $('#extension-font');
  if (!select) return;
  const custom = $('#extension-font-name'), fields = $('#extension-font-custom');
  const preview = $('#extension-font-preview'), status = $('#extension-font-status');
  const apply = $('#extension-font-apply'), reset = $('#extension-font-reset');
  let settings = normalizeFontSettings(), busy = false, loading = true;
  for (const item of FONT_OPTIONS) {
    const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; select.append(option);
  }
  function previewDraft() {
    fields.hidden = select.value !== 'custom';
    preview.style.fontFamily = fontFamily({ font: select.value, customFont: custom.value });
  }
  function render() {
    select.value = settings.font; custom.value = settings.customFont;
    previewDraft();
  }
  const watcher = installFontSettings({ element: document.documentElement, chrome, onChanged(value) { settings = value; render(); } });
  const available = Boolean(chrome?.storage?.local?.set);
  function controls() {
    for (const node of [select, custom, apply, reset]) node.disabled = busy || loading || !available;
    apply.setAttribute('aria-busy', String(busy));
  }
  async function save(value) {
    if (busy || loading || !available) return;
    let next;
    try { next = validateFontSettings(value); }
    catch (error) { status.textContent = error.message; custom.focus(); return; }
    busy = true; controls(); status.textContent = '正在保存字体…';
    try {
      await chrome.storage.local.set({ [FONT_SETTINGS_KEY]: next });
      settings = next; applyFontSettings(document.documentElement, settings); render();
      status.textContent = '字体已保存，立即生效。';
    } catch (error) {
      if (next.font !== 'custom') render();
      status.textContent = error.message || '字体保存失败，请重试。';
    } finally { busy = false; controls(); }
  }
  select.addEventListener('change', () => {
    status.textContent = ''; previewDraft();
    if (select.value === 'custom') custom.focus();
    else void save({ ...settings, font: select.value });
  });
  custom.addEventListener('input', previewDraft);
  const saveCustom = () => { void save({ font: 'custom', customFont: custom.value }); };
  apply.addEventListener('click', saveCustom);
  custom.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); saveCustom(); } });
  reset.addEventListener('click', () => { void save(normalizeFontSettings()); });
  controls();
  void watcher.ready.catch(() => { status.textContent = '字体设置读取失败，请重新打开侧栏。'; }).finally(() => { loading = false; controls(); });
  return watcher;
}
