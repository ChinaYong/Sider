import { validateConfiguration, configurationSummary } from './configuration.js';
import { downloadText } from './export-file.js';
import { aiSitePattern, selectedAISite } from './ai-web.js';

export function installConfigurationUI({ document, chrome, onImported = () => {} }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#configuration-dialog'); if (!dialog) return;
  let pending = null, busy = false;
  const error = message => { $('#configuration-status').textContent = message; };
  const request = async message => { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || '配置保存失败，已有配置保持原样。'); return result; };
  const controls = active => { busy = active; for (const control of dialog.querySelectorAll('button,input')) control.disabled = active; $('#configuration-apply').disabled = active || !pending; };
  $('#configuration-open').addEventListener('click', () => { pending = null; $('#configuration-preview').textContent = ''; $('#configuration-file').value = ''; error(''); controls(false); dialog.showModal(); });
  $('#configuration-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('#configuration-export').addEventListener('click', async () => {
    controls(true); error('');
    try { const { backup } = await request({ type: 'SIDER_CONFIGURATION_EXPORT' }); downloadText(document, JSON.stringify(backup, null, 2) + '\n', 'Sider-configuration.json', 'application/json;charset=utf-8'); error('配置已导出。'); }
    catch (cause) { error(cause.message); } finally { controls(false); }
  });
  $('#configuration-file').addEventListener('change', async () => {
    pending = null; $('#configuration-preview').textContent = ''; controls(true); error('');
    try {
      const file = $('#configuration-file').files?.[0]; if (!file) return;
      if (file.size > 16 * 1024 * 1024) throw new Error('配置文件超过 16 MB，请检查文件是否正确。');
      const backup = validateConfiguration(JSON.parse(await file.text()), document);
      const { backup: before } = await request({ type: 'SIDER_CONFIGURATION_EXPORT' });
      $('#configuration-preview').textContent = configurationSummary(before, backup); pending = { backup, before };
    } catch (cause) { error(cause instanceof SyntaxError ? 'JSON 文件无法解析，请检查格式。' : cause.message); }
    finally { controls(false); }
  });
  $('#configuration-apply').addEventListener('click', async () => {
    if (!pending || busy) return;
    const saved = pending; controls(true); error('');
    try {
      const site = selectedAISite(saved.backup.configuration.aiWeb);
      // A single request for the selected AI site, directly in this user gesture.
      if (!await chrome.permissions.contains({ origins: [aiSitePattern(site)] }) && !await chrome.permissions.request({ origins: [aiSitePattern(site)] })) throw new Error(`${site.name} 的访问权限未授予，已有配置保持原样。`);
      const result = await request({ type: 'SIDER_CONFIGURATION_IMPORT', backup: saved.backup, expected: saved.before.configuration });
      pending = null; $('#configuration-preview').textContent = ''; error('配置已完整替换。新网站在重新加载侧栏后生效。');
      onImported(result.settings);
    } catch (cause) { error(cause.message); }
    finally { controls(false); }
  });
}
