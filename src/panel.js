import { AI_WEB_SETTINGS_KEY, BUILTIN_AI_SITES, aiSiteURL, normalizeAIWebSettings, selectedAISite } from './ai-web.js';
import { installAIWebSettings } from './ai-web-settings.js';
import { installConfigurationUI } from './configuration-ui.js';
import { createMotion, installDialogMotion } from './motion.js';

const $ = selector => document.querySelector(selector);
const motion = createMotion(window);
const isExtension = Boolean(globalThis.chrome?.runtime?.id);
const bridgeId = crypto.randomUUID();
const sourceParameter = new URL(window.location.href).searchParams.get('sourceTab');
const sourceTabId = sourceParameter && /^\d+$/.test(sourceParameter) ? Number(sourceParameter) : null;
let windowId;
let generation = 0;
let timer;
let heartbeat;
let lifecycle;
let disposed = false;
let toastTimer;
let siteSource;
let sitePurpose;
let hasConnected = false;
let activeSite = BUILTIN_AI_SITES[0];
let activeAISettings = normalizeAIWebSettings();
let loadedSite = null;
let loadedAISettings = null;
let pendingSendPicker;
const diagnostics = { version: globalThis.chrome?.runtime?.getManifest?.().version || '0.4.0', sourceTabId, browser: navigator.userAgent, stage: '启动', rule: false, connected: false, enhancementReady: false };

function showToast(text) {
  clearTimeout(toastTimer);
  const toast = $('#toast'), changed = toast.textContent !== text, visible = !toast.hidden;
  if (changed) toast.textContent = text;
  motion.setVisible(toast, true, { fadeOnly: true });
  if (changed && visible) motion.enter(toast, { fadeOnly: true, duration: 120 });
  toastTimer = setTimeout(() => motion.setVisible(toast, false, { fadeOnly: true }), 6000);
}

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有响应。请在扩展管理页重新加载 Sider。');
  return result;
}

function pickNativeSendButton(site) {
  if (!isExtension || !loadedSite || site.id !== loadedSite.id || site.origin !== loadedSite.origin || !hasConnected) {
    return Promise.resolve({ ok: false, error: '请先保存并加载此网站，确认已登录，再点选发送按钮。' });
  }
  pendingSendPicker?.cancel();
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let timer;
    const pending = {
      cancel() {
        try { channel.port1.postMessage({ type: 'SIDER_AI_SEND_PICK_CANCEL' }); } catch {}
        finish({ ok: false, cancelled: true });
      },
    };
    pendingSendPicker = pending;
    function finish(result) {
      if (pendingSendPicker !== pending) return;
      clearTimeout(timer);
      pendingSendPicker = null;
      channel.port1.close();
      resolve(result);
    }
    channel.port1.onmessage = event => {
      const result = event.data;
      if (result?.ok === true && typeof result.selector === 'string' && result.selector.length > 0 && result.selector.length <= 1000) finish({ ok: true, selector: result.selector });
      else finish({ ok: false, cancelled: Boolean(result?.cancelled), error: typeof result?.error === 'string' ? result.error.slice(0, 1000) : '未能点选发送按钮，请重试。' });
    };
    channel.port1.onmessageerror = () => pending.cancel();
    timer = setTimeout(() => { pending.cancel(); }, 65000);
    try {
      $('#chatgpt-frame').contentWindow.postMessage({ type: 'SIDER_AI_SEND_PICK_REQUEST', bridgeId, siteId: loadedSite.id }, loadedSite.origin, [channel.port2]);
    } catch { channel.port2.close(); finish({ ok: false, error: 'AI 网站尚未完成加载，请重新连接后重试。' }); }
  });
}

function status(text, kind = '', detail = text) {
  const label = $('#connection-status > span'), indicator = $('#connection-status');
  if (label.textContent !== text) label.textContent = text;
  if (indicator.className !== kind) indicator.className = kind;
  if (indicator.title !== detail) indicator.title = detail;
}

function renderDiagnostics() {
  $('#diagnostics-text').textContent = Object.entries(diagnostics).map(([key, value]) => `${key}: ${value}`).join('\n');
}

function failed(error) {
  clearTimeout(timer);
  if (hasConnected) {
    enhancementUnavailable(`网页引用连接暂时中断：${error}`);
    return;
  }
  diagnostics.stage = '连接失败'; diagnostics.error = error;
  const navigationStarted = $('#chatgpt-frame').hasAttribute('src');
  status(navigationStarted ? `${activeSite.name} 连接尚未确认` : `${activeSite.name} 连接失败`, 'failed');
  $('#loading-screen').toggleAttribute('data-inline', navigationStarted);
  $('#loading-title').textContent = navigationStarted ? `尚未确认 ${activeSite.name} 连接` : `${activeSite.name} 没有完成加载`;
  $('#loading-detail').textContent = error;
  $('#loading-symbol').hidden = true;
  $('#recovery-actions').hidden = false;
  $('#loading-screen').hidden = false;
  renderDiagnostics();
}

function enhancementUnavailable(detail) {
  diagnostics.stage = `${activeSite.name} 已连接，网页引用尚未就绪`;
  diagnostics.enhancementReady = false;
  diagnostics.warning = `${detail} 可点击右上角 ↻ 重新连接或使用原站入口。`;
  status(`${activeSite.name} · 网页引用未就绪`, 'warning', diagnostics.warning);
  renderDiagnostics();
}

function connectLifecycle() {
  if (lifecycle) return;
  clearInterval(heartbeat);
  try {
    const port = chrome.runtime.connect({ name: 'sider-panel-lifecycle' });
    lifecycle = port;
    port.postMessage({ type: 'SIDER_PANEL_ATTACH', bridgeId });
    port.onMessage.addListener(message => {
      if (lifecycle !== port || disposed || message?.type !== 'SIDER_ENHANCEMENT_READY' || message.bridgeId !== bridgeId) return;
      // Read the bound registration again rather than rendering a possibly
      // outdated frame report. A later state change supersedes a pending poll.
      clearTimeout(timer);
      void poll(++generation, Date.now());
    });
    heartbeat = setInterval(() => {
      try { port.postMessage({ type: 'SIDER_PANEL_PING', bridgeId }); } catch {}
    }, 25000);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (lifecycle !== port || disposed) return;
      lifecycle = null;
      clearInterval(heartbeat);
      timer = setTimeout(async () => {
        try {
          await request({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId, tabId: sourceTabId, siteId: activeSite.id, reuseSite: true });
          connectLifecycle();
        } catch (error) { failed(error.message); }
      }, 500);
    });
  } catch (error) { failed(`无法维持侧栏连接：${error.message}`); }
}

async function poll(run, startedAt) {
  if (disposed || run !== generation) return;
  try {
    const result = await request({ type: 'SIDER_EMBED_STATUS_GET', bridgeId });
    if (run !== generation) return;
    diagnostics.rule = Boolean(result.compatibility);
    diagnostics.connected = Boolean(result.connected);
    diagnostics.enhancementReady = Boolean(result.enhancementReady);
    if (result.connected) {
      hasConnected = true;
      delete diagnostics.warning;
      delete diagnostics.error;
      $('#loading-screen').hidden = true;
      $('#loading-screen').removeAttribute('data-inline');
      diagnostics.stage = result.enhancementReady ? `${activeSite.name} 与增强层就绪` : `${activeSite.name} 已连接`;
      status(result.enhancementReady ? `${activeSite.name} · 网页引用已就绪` : `${activeSite.name} · 正在准备网页引用`, 'connected');
      if (!result.enhancementReady && result.enhancementDetail) enhancementUnavailable(result.enhancementDetail);
    }
    if (result.enhancementReady) {
      delete diagnostics.warning;
      renderDiagnostics();
      return;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > 35000) {
      if (!hasConnected) {
        failed(`35 秒内没有收到 ${activeSite.name} 网页的连接回执。请检查网络、登录状态及扩展的 ${new URL(activeSite.origin).host} 访问权限。可在右上角“⋯”复制连接信息。`);
        return;
      }
      enhancementUnavailable('网页引用没有完成加载。');
    } else renderDiagnostics();
    // Give a late enhancement layer time to recover, with fewer background checks.
    if (elapsed < 120000) timer = setTimeout(() => poll(run, startedAt), elapsed > 35000 ? 5000 : 700);
  } catch (error) {
    if (run !== generation) return;
    if (!hasConnected) { failed(error.message); return; }
    enhancementUnavailable(`网页引用连接暂时中断：${error.message}`);
    if (Date.now() - startedAt < 120000) timer = setTimeout(() => poll(run, startedAt), 5000);
  }
}

async function start() {
  pendingSendPicker?.cancel();
  if (!isExtension) {
    status('需要安装浏览器扩展');
    $('#loading-screen').hidden = false;
    $('#loading-symbol').hidden = true;
    $('#loading-title').textContent = '请在浏览器侧栏打开 Sider';
    $('#loading-detail').textContent = '在浏览器的扩展管理页加载构建生成的 dist 文件夹，再点击扩展图标。原版 AI 网站在已安装的扩展侧栏中加载。';
    return;
  }
  const run = ++generation;
  clearTimeout(timer);
  delete diagnostics.error;
  delete diagnostics.warning;
  hasConnected = false;
  diagnostics.connected = false; diagnostics.enhancementReady = false;
  diagnostics.stage = '安装内嵌兼容规则';
  status(`正在打开 ${activeSite.name}`);
  $('#loading-screen').hidden = true;
  $('#loading-screen').removeAttribute('data-inline');
  $('#loading-symbol').hidden = false;
  $('#recovery-actions').hidden = true;
  $('#loading-title').textContent = `正在打开 ${activeSite.name}`;
  $('#loading-detail').textContent = '正在准备侧栏连接…';
  try {
    const stored = await chrome.storage?.local?.get(AI_WEB_SETTINGS_KEY);
    if (run !== generation) return;
    activeAISettings = normalizeAIWebSettings(stored?.[AI_WEB_SETTINGS_KEY]);
    activeSite = selectedAISite(activeAISettings);
    diagnostics.site = activeSite.name; diagnostics.url = aiSiteURL(activeSite, activeAISettings);
    status(`正在打开 ${activeSite.name}`);
    $('#loading-title').textContent = `正在打开 ${activeSite.name}`;
    $('#reload-chatgpt').title = `重新加载 ${activeSite.name}`;
    $('#open-chatgpt').title = `在标签页登录或打开 ${activeSite.name}`;
    $('#chatgpt-frame').title = `原版 ${activeSite.name}`;
    if (!Number.isSafeInteger(sourceTabId) || sourceTabId < 0) throw new Error('此侧栏没有绑定来源标签页。请关闭它，再在要提问的网页上点击 Sider 图标。');
    windowId = (await chrome.tabs.get(sourceTabId)).windowId;
    const registered = await request({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId, tabId: sourceTabId, siteId: activeSite.id });
    if (run !== generation) return;
    diagnostics.rule = registered.compatibility;
    if (registered.site) activeSite = registered.site;
    activeSite = { ...activeSite, url: aiSiteURL(activeSite, activeAISettings) };
    const frame = $('#chatgpt-frame');
    frame.hidden = false;
    // Show the site's first paint without waiting for load or the document-idle bridge.
    const url = new URL(activeSite.url); url.searchParams.set('sider_bridge', bridgeId);
    frame.src = url.href;
    loadedSite = structuredClone(activeSite);
    loadedAISettings = structuredClone(activeAISettings);
    $('#ai-settings-updated').hidden = true;
    diagnostics.stage = `等待 ${activeSite.name} 网页回执`;
    $('#loading-detail').textContent = `正在加载 ${new URL(activeSite.origin).host}…`;
    $('#ai-diagnostics-description').textContent = `网页主体由 ${new URL(activeSite.origin).host} 提供。当前标签页的划词和引用会显示在原版输入框旁，发送时按设置中的格式加入问题。`;
    connectLifecycle();
    void poll(run, Date.now());
  } catch (error) { if (run === generation) failed(error.message); }
}

$('#chatgpt-frame').addEventListener('load', () => {
  pendingSendPicker?.cancel();
  const frame = $('#chatgpt-frame');
  if (!frame.hasAttribute('src') || frame.contentDocument?.URL === 'about:blank') return;
  clearTimeout(timer);
  void poll(++generation, Date.now());
});
$('#retry-embed').addEventListener('click', start);
$('#reload-chatgpt').addEventListener('click', start);
$('#ai-settings-updated').addEventListener('click', start);
for (const id of ['open-chatgpt', 'login-chatgpt']) $("#" + id).addEventListener('click', async () => {
  try {
    if (isExtension) await request({ type: 'SIDER_CHAT_OPEN', siteId: activeSite.id });
    else window.open(activeSite.url, '_blank', 'noopener');
  } catch (error) { showToast(error.message); }
});
$('#diagnostics-toggle').addEventListener('click', () => { renderDiagnostics(); $('#diagnostics-dialog').showModal(); });
$('#close-diagnostics').addEventListener('click', () => $('#diagnostics-dialog').close());
$('#copy-diagnostics').addEventListener('click', async () => {
  try { renderDiagnostics(); await navigator.clipboard.writeText($('#diagnostics-text').textContent); showToast('连接信息已复制。'); }
  catch { showToast('复制失败，请直接选中连接信息复制。'); }
});
window.addEventListener('message', async event => {
  if (!isExtension || disposed || event.origin !== (loadedSite || activeSite).origin || event.source !== $('#chatgpt-frame').contentWindow) return;
  if (event.data?.type === 'SIDER_EMBED_HELLO_REQUEST') {
    // The child starts this exchange only after a ChatGPT document exists.
    // Reply through its port: a WindowProxy can change origin during navigation.
    if (event.ports.length !== 1) return;
    const port = event.ports[0];
    try { port.postMessage({ type: 'SIDER_EMBED_HELLO', bridgeId, site: loadedSite || activeSite }); }
    catch { /* A navigating child can close its own response port. */ }
    finally { port.close(); }
    return;
  }
  if (event.data?.bridgeId !== bridgeId || !['SIDER_ENABLE_SITE_REQUEST', 'SIDER_SOURCE_ACCESS_REQUEST'].includes(event.data.type)) return;
  try {
    sitePurpose = event.data.type === 'SIDER_ENABLE_SITE_REQUEST' ? 'selection' : 'capture';
    siteSource = (await request({ type: 'SIDER_SOURCE_INFO', tabId: sourceTabId })).source;
    $('#site-description').textContent = siteSource.url
      ? sitePurpose === 'selection'
        ? `在 ${new URL(siteSource.url).hostname} 显示划词引用按钮，之后选中文字即可加入引用。浏览器会请求此网站的访问权限。`
        : `允许 Sider 读取 ${new URL(siteSource.url).hostname} 的划词和正文。授权后可在此网站直接引用，无需每次点击扩展图标。`
      : '浏览器尚未允许读取当前网站。点击下方按钮后，请在浏览器的扩展权限提示中允许访问。也可以点击浏览器工具栏的 Sider 图标，仅授权当前标签页。';
    $('#site-dialog-title').textContent = sitePurpose === 'selection' ? '网页划词引用' : '允许引用当前网站';
    $('#grant-site').textContent = siteSource.url ? (sitePurpose === 'selection' ? '启用此网站' : '允许此网站') : '请求网站访问';
    $('#site-status').hidden = true;
    $('#site-status').textContent = '';
    $('#site-dialog').showModal();
  } catch (error) { showToast(error.message); }
});
$('#close-site').addEventListener('click', () => $('#site-dialog').close());
$('#grant-site').addEventListener('click', async () => {
  const source = siteSource;
  if (!source) return;
  const purpose = sitePurpose;
  const button = $('#grant-site'); button.disabled = true;
  $('#site-status').hidden = true;
  $('#site-status').textContent = '';
  try {
    if (!source.url) {
      const result = await request({ type: 'SIDER_SOURCE_ACCESS_REQUEST', tabId: sourceTabId });
      $('#site-dialog').close();
      showToast(result.granted ? '当前网站已授权，划词会自动显示。' : '请在浏览器的扩展权限提示中允许当前网站，划词随后会自动显示。');
      return;
    }
    const origin = new URL(source.url).origin;
    // Must run directly inside the user's click, with the original source snapshot.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error('此网站的访问权限未授予。');
    if (purpose === 'selection') await request({ type: 'SIDER_ENABLE_SITE', tabId: source.tabId });
    $('#site-dialog').close();
    showToast(purpose === 'selection' ? `已在 ${new URL(source.url).hostname} 启用划词引用。` : '已允许引用此网站，划词会自动显示。');
  } catch (error) {
    if ($('#site-dialog').open) {
      $('#site-status').textContent = error.message;
      $('#site-status').hidden = false;
    } else showToast(error.message);
  }
  finally { button.disabled = false; }
});
window.addEventListener('pagehide', () => {
  disposed = true; generation++;
  pendingSendPicker?.cancel();
  clearTimeout(timer); clearInterval(heartbeat);
  try { lifecycle?.disconnect(); } catch {}
});
function settingsUpdated(settings) {
  const normalized = normalizeAIWebSettings(settings);
  const next = selectedAISite(normalized);
  const nextWithURL = { ...next, url: aiSiteURL(next, normalized) };
  const geminiDefaultsChanged = next.id === 'gemini' && loadedSite?.id === 'gemini' &&
    (normalized.geminiModel !== loadedAISettings?.geminiModel || normalized.geminiExtendedThinking !== loadedAISettings?.geminiExtendedThinking);
  $('#ai-settings-updated').hidden = !loadedSite || (!geminiDefaultsChanged && JSON.stringify(nextWithURL) === JSON.stringify(loadedSite));
  if (!$('#ai-settings-updated').hidden) $('#ai-settings-updated').textContent = `AI 网站设置已更新，点击加载 ${next.name}`;
}
installAIWebSettings({ document, chrome: globalThis.chrome, pickSendButton: pickNativeSendButton, onSaved(settings) { settingsUpdated(settings); showToast('AI 网站设置已保存，重新加载侧栏后生效。'); } });
installConfigurationUI({ document, chrome: globalThis.chrome, onImported(settings) { $('#ai-settings-dialog').close(); settingsUpdated(settings); } });
const disposeDialogs = installDialogMotion(document, motion);
window.addEventListener('pagehide', () => { clearTimeout(toastTimer); motion.dispose(); disposeDialogs(); });
const settingsChanged = (changes, area) => { if (area === 'local' && changes[AI_WEB_SETTINGS_KEY]) settingsUpdated(normalizeAIWebSettings(changes[AI_WEB_SETTINGS_KEY].newValue)); };
globalThis.chrome?.storage?.onChanged?.addListener(settingsChanged);
window.addEventListener('pagehide', () => globalThis.chrome?.storage?.onChanged?.removeListener(settingsChanged));
void start();
