const $ = selector => document.querySelector(selector);
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
const diagnostics = { version: globalThis.chrome?.runtime?.getManifest?.().version || '0.4.0', sourceTabId, browser: navigator.userAgent, stage: '启动', rule: false, connected: false, enhancementReady: false };

function showToast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000);
}

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有响应。请在扩展管理页重新加载 Sider。');
  return result;
}

function status(text, kind = '') {
  $('#connection-status > span').textContent = text;
  $('#connection-status').className = kind;
}

function renderDiagnostics() {
  $('#diagnostics-text').textContent = Object.entries(diagnostics).map(([key, value]) => `${key}: ${value}`).join('\n');
}

function failed(error) {
  clearTimeout(timer);
  diagnostics.stage = '连接失败'; diagnostics.error = error;
  status('ChatGPT 连接失败', 'failed');
  $('#loading-title').textContent = 'ChatGPT 没有完成加载';
  $('#loading-detail').textContent = error;
  $('#loading-symbol').hidden = true;
  $('#recovery-actions').hidden = false;
  $('#loading-screen').hidden = false;
  renderDiagnostics();
}

function connectLifecycle() {
  if (lifecycle) return;
  clearInterval(heartbeat);
  try {
    const port = chrome.runtime.connect({ name: 'sider-panel-lifecycle' });
    lifecycle = port;
    port.postMessage({ type: 'SIDER_PANEL_ATTACH', bridgeId });
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
          await request({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId, tabId: sourceTabId });
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
      $('#loading-screen').hidden = true;
      diagnostics.stage = result.enhancementReady ? 'ChatGPT 与增强层就绪' : 'ChatGPT 已连接';
      status(result.enhancementReady ? 'ChatGPT · 网页引用已就绪' : 'ChatGPT', 'connected');
    }
    renderDiagnostics();
    if (result.enhancementReady) return;
    if (Date.now() - startedAt > 35000) {
      if (!result.connected) failed('35 秒内没有收到 ChatGPT 网页的连接回执。请检查网络、ChatGPT 登录状态及扩展的 chatgpt.com 访问权限。可在右上角“⋯”复制连接信息。');
      return;
    }
    timer = setTimeout(() => poll(run, startedAt), 700);
  } catch (error) { if (run === generation) failed(error.message); }
}

async function start() {
  if (!isExtension) {
    status('需要安装浏览器扩展');
    $('#loading-symbol').hidden = true;
    $('#loading-title').textContent = '请在浏览器侧栏打开 Sider';
    $('#loading-detail').textContent = '在 Tabbit 的扩展管理页加载 Q:\\1Coding\\Sider\\dist，再点击扩展图标。此页面只提供安装提示；原版 ChatGPT 在已安装的扩展侧栏中加载。';
    return;
  }
  const run = ++generation;
  clearTimeout(timer);
  delete diagnostics.error;
  diagnostics.connected = false; diagnostics.enhancementReady = false;
  diagnostics.stage = '安装内嵌兼容规则';
  status('正在打开 ChatGPT');
  $('#loading-screen').hidden = false;
  $('#loading-symbol').hidden = false;
  $('#recovery-actions').hidden = true;
  $('#loading-title').textContent = '正在打开 ChatGPT';
  $('#loading-detail').textContent = '正在准备侧栏连接…';
  try {
    if (!Number.isSafeInteger(sourceTabId) || sourceTabId < 0) throw new Error('此侧栏没有绑定来源标签页。请关闭它，再在要提问的网页上点击 Sider 图标。');
    windowId = (await chrome.tabs.get(sourceTabId)).windowId;
    const registered = await request({ type: 'SIDER_EMBED_REGISTER', bridgeId, windowId, tabId: sourceTabId });
    if (run !== generation) return;
    diagnostics.rule = registered.compatibility;
    connectLifecycle();
    const frame = $('#chatgpt-frame');
    frame.hidden = false;
    frame.src = `https://chatgpt.com/?sider_bridge=${encodeURIComponent(bridgeId)}`;
    diagnostics.stage = '等待 ChatGPT 网页回执';
    $('#loading-detail').textContent = '正在加载 chatgpt.com…';
    void poll(run, Date.now());
  } catch (error) { if (run === generation) failed(error.message); }
}

$('#chatgpt-frame').addEventListener('load', () => {
  const frame = $('#chatgpt-frame');
  if (!frame.hasAttribute('src') || frame.contentDocument?.URL === 'about:blank') return;
  clearTimeout(timer);
  void poll(++generation, Date.now());
});
$('#retry-embed').addEventListener('click', start);
$('#reload-chatgpt').addEventListener('click', start);
for (const id of ['open-chatgpt', 'login-chatgpt']) $("#" + id).addEventListener('click', async () => {
  try {
    if (isExtension) await request({ type: 'SIDER_CHAT_OPEN' });
    else window.open('https://chatgpt.com/', '_blank', 'noopener');
  } catch (error) { showToast(error.message); }
});
$('#diagnostics-toggle').addEventListener('click', () => { renderDiagnostics(); $('#diagnostics-dialog').showModal(); });
$('#close-diagnostics').addEventListener('click', () => $('#diagnostics-dialog').close());
$('#copy-diagnostics').addEventListener('click', async () => {
  try { renderDiagnostics(); await navigator.clipboard.writeText($('#diagnostics-text').textContent); showToast('连接信息已复制。'); }
  catch { showToast('复制失败，请直接选中连接信息复制。'); }
});
window.addEventListener('message', async event => {
  if (!isExtension || disposed || event.origin !== 'https://chatgpt.com' || event.source !== $('#chatgpt-frame').contentWindow) return;
  if (event.data?.type === 'SIDER_EMBED_HELLO_REQUEST') {
    // The child starts this exchange only after a ChatGPT document exists.
    // Reply through its port: a WindowProxy can change origin during navigation.
    if (event.ports.length !== 1) return;
    const port = event.ports[0];
    try { port.postMessage({ type: 'SIDER_EMBED_HELLO', bridgeId }); }
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
    $('#site-dialog').showModal();
  } catch (error) { showToast(error.message); }
});
$('#close-site').addEventListener('click', () => $('#site-dialog').close());
$('#grant-site').addEventListener('click', async () => {
  const source = siteSource;
  if (!source) return;
  const purpose = sitePurpose;
  const button = $('#grant-site'); button.disabled = true;
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
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
window.addEventListener('pagehide', () => {
  disposed = true; generation++;
  clearTimeout(timer); clearInterval(heartbeat);
  try { lifecycle?.disconnect(); } catch {}
});
void start();
