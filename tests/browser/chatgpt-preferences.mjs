import { createServer as httpsServer } from 'node:https';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from './browser.js';

function catalog(revision = '') {
  return { models: [{ slug: 'new-instant' },
    { slug: 'new-thinking', configurable_thinking_effort: true, default_thinking_effort: 'extended', thinking_efforts: [{ thinking_effort: 'standard' }, { thinking_effort: 'extended' }] },
    { slug: 'old-thinking', configurable_thinking_effort: true, default_thinking_effort: 'standard', thinking_efforts: [{ thinking_effort: 'standard' }, { thinking_effort: 'extended' }] },
    { slug: 'internal', tags: ['hidden'] }], versions: [
    { id: 'latest', display_text_for_intelligence: revision ? 'GPT Renamed' : 'GPT New', enabled: true,
      slugs: ['new-instant', 'new-thinking'], intelligence_presets: [
        { model_slug: 'new-instant', title: 'Instant', preset_type: 'available' },
        { model_slug: 'new-thinking', thinking_effort: 'standard', title: revision ? 'Balanced' : 'Medium', preset_type: 'available' },
        { model_slug: 'new-thinking', thinking_effort: 'extended', title: 'High', preset_type: 'available' },
      ] },
    { id: 'old', display_text_for_intelligence: 'GPT Old', enabled: true, slugs: ['old-thinking'], intelligence_presets: [
      { model_slug: 'old-thinking', thinking_effort: 'standard', title: 'Standard', preset_type: 'available' },
      { model_slug: 'old-thinking', thinking_effort: 'extended', title: 'High', preset_type: 'available' },
      { model_slug: 'old-thinking', thinking_effort: 'ultra', title: 'Locked', preset_type: 'locked' },
    ] },
  ] };
}

function preferences() {
  return { settings: { last_used_model_config: { slugs: { default: 'new-thinking', web: 'new-thinking', ios_app: 'ios-model' },
    juices: { default: { 'new-thinking': 'extended' }, web: { 'new-thinking': 'extended' }, ios_app: { 'new-thinking': 'extended' } } }, unrelated: 'keep' }, privateValue: 'not-a-real-secret' };
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT fixture</title></head><body>
<textarea id="draft" data-testid="prompt-textarea">保留草稿</textarea><button id="send" data-testid="send-button">Send</button><button id="picker" aria-label="Select ChatGPT model" aria-expanded="false">Model</button>
<button id="new-chat" aria-label="New chat">New chat</button>
<div role="menu"><button id="manual" role="menuitemradio">Manual choice</button></div><div id="result"></div>
<script>
const params = new URLSearchParams(location.search);
window.fixtureClicks = 0; window.fixtureModelsLoaded = false; window.fixtureSettingsLoaded = false;
window.fixtureHostState = { 'chatgpt-last-selected-model-v1': { slug: 'new-thinking', thinkingEffort: 'extended', versionId: 'latest' } };
window.fixtureHomeModel = { slug: 'new-thinking', thinkingEffort: 'standard', versionId: 'latest' };
window.renderSPASelection = () => {
  if (!window.fixtureSPAActive) return;
  const model = window.fixtureHomeModel;
  document.querySelector('#result').textContent = model.slug + '/' + model.thinkingEffort;
};
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.type === 'persisted-atom-sync') window.fixturePersistedModel = event.data.state['chatgpt-last-selected-model-v1'];
  if (event.data?.type === 'persisted-atom-updated' && event.data.key === 'chatgpt-last-selected-model-v1') window.fixturePersistedModel = event.data.value;
  if (event.data?.type === 'persisted-atom-updated' && event.data.key === 'chatgpt-last-selected-home-model-v1') { window.fixtureHomeModel = event.data.value; window.renderSPASelection(); }
});
window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin,
  data: { type: 'persisted-atom-sync', state: window.fixtureHostState } }));
document.querySelector('#picker').addEventListener('click', event => { window.fixtureClicks++; event.currentTarget.setAttribute('aria-expanded', 'true'); });
document.querySelector('#manual').addEventListener('click', () => { window.fixtureManualOverride = { slug: 'new-thinking', effort: 'extended' }; });
document.querySelector('#new-chat').addEventListener('click', () => {
  window.fixtureManualOverride = null; window.fixtureSent = null; window.fixtureSPAActive = true;
  history.pushState({ entry: Math.random() }, '', '/');
  window.renderSPASelection();
});
window.refreshCatalog = revision => fetch('/backend-api/models' + (revision ? '?revision=' + revision : '')).then(response => response.json());
window.readQuota = () => fetch('/backend-api/conversation/init', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ conversation_id: null, system_hints: null, timezone: 'Asia/Shanghai', timezone_offset_min: -480 }) }).then(response => response.json());
window.initWithRequest = () => fetch(new Request('/backend-api/conversation/init', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture': 'preserved' },
  body: JSON.stringify({ conversation_id: null, conversation_origin: null, gizmo_id: null, requested_default_model: null,
    system_hints: null, timezone: 'Asia/Shanghai', timezone_offset_min: -480 }) })).then(response => response.json());
// Like the site, refresh initialization when admitting the first turn, then
// use its intended model unless the user has explicitly chosen another one.
document.querySelector('#send').addEventListener('click', async () => {
  history.replaceState(null, '', '/c/local-chatgpt%3A00000000-0000-4000-8000-000000000001');
  const initialized = await window.initWithRequest();
  const slug = window.fixtureManualOverride?.slug || initialized.intended_default_model_slug || window.fixturePersistedModel?.slug;
  const effort = window.fixtureManualOverride?.effort || (window.fixturePersistedModel?.slug === slug ? window.fixturePersistedModel.thinkingEffort : 'standard');
  await fetch('/backend-api/conversation', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'next', model: slug, messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [document.querySelector('#draft').value] }, metadata: { thinking_effort: effort } }] }) });
  window.fixtureSent = { slug, effort };
  document.querySelector('#result').textContent = slug + '/' + effort;
});
document.querySelector('#draft').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.querySelector('#send').click(); }
});
window.fixtureDone = (async () => {
  const pendingModels = fetch('/backend-api/models' + (params.has('delayModels') ? '?delay=1' : ''))
    .then(response => response.json()).then(value => { window.fixtureModelsLoaded = true; return value; });
  const pendingSettings = fetch('/backend-api/settings/user' + (params.has('delaySettings') ? '?delay=1' : '')).then(response => response.json()).then(value => { window.fixtureSettingsLoaded = true; return value; });
  const pendingInit = fetch('/backend-api/conversation/init' + (params.has('limitModel') ? '?limited=1' : ''), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: null, conversation_origin: null, gizmo_id: null, requested_default_model: null, system_hints: null,
      timezone: 'Asia/Shanghai', timezone_offset_min: -480 }),
  }).then(response => response.json());
  const [models, settings, initialized] = await Promise.all([pendingModels, pendingSettings, pendingInit]);
  const state = settings.settings.last_used_model_config;
  const slug = window.fixtureManualOverride?.slug || initialized.intended_default_model_slug || state.slugs.web;
  const model = models.models.find(item => item.slug === slug);
  const storedEffort = window.fixturePersistedModel?.slug === slug ? window.fixturePersistedModel.thinkingEffort : null;
  const result = { slug, effort: window.fixtureManualOverride?.effort || storedEffort || model?.default_thinking_effort || null, ios: state.slugs.ios_app, other: settings.settings.unrelated };
  document.querySelector('#result').textContent = result.slug + '/' + result.effort;
  return result;
})();
</script></body></html>`;

const requests = [], settingsGates = [], gateWaiters = [];
const waitForSettingsGate = () => settingsGates.length ? Promise.resolve() : new Promise(resolve => gateWaiters.push(resolve));
const releaseSettings = async () => { await waitForSettingsGate(); settingsGates.shift()(); };
const tls = httpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, async (req, res) => {
  const url = new URL(req.url, 'https://chatgpt.com');
  const request = { method: req.method, path: url.pathname, fixtureHeader: req.headers['x-fixture'] || null }; requests.push(request);
  if (url.searchParams.has('delay') && url.pathname.includes('/settings/')) await new Promise(resolve => { settingsGates.push(resolve); gateWaiters.splice(0).forEach(waiter => waiter()); });
  else if (url.searchParams.has('delay')) await new Promise(resolve => setTimeout(resolve, 1000));
  if (url.pathname === '/backend-api/models') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(url.searchParams.has('broken') ? {} : catalog(url.searchParams.get('revision')))); return;
  }
  if (url.pathname === '/backend-api/settings/user') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(preferences())); return;
  }
  if (url.pathname === '/backend-api/conversation/init') {
    let text = ''; for await (const part of req) text += part;
    try { request.body = JSON.parse(text); } catch { request.body = null; }
    const limited = url.searchParams.has('limited'), selected = request.body?.requested_default_model;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ default_model_slug: 'new-thinking',
      intended_default_model_slug: limited ? 'new-thinking' : selected || 'new-thinking',
      model_limits: limited ? [{ model_slug: 'old-thinking', using_default_model_slug: 'new-thinking' }] : [] })); return;
  }
  if (url.pathname === '/backend-api/conversation') {
    let text = ''; for await (const part of req) text += part;
    request.body = JSON.parse(text);
    res.setHeader('content-type', 'application/json'); res.end('{}'); return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html);
});
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));

const extension = path.resolve('tmp/browser/chatgpt-preferences-extension');
assert.ok(extension.startsWith(path.resolve('tmp/browser') + path.sep));
await cp('dist', extension, { recursive: true });
await writeFile(path.join(extension, 'test-control.html'), '<!doctype html><title>Test control</title>');
const settingsHTML = (await readFile('dist/panel.html', 'utf8')).replace('<script type="module" src="panel.js"></script>', '<script defer src="test-settings.js"></script>');
const settingsBundle = await build({ stdin: { contents: "import { installAIWebSettings } from './src/ai-web-settings.js'; installAIWebSettings({ document, chrome });", resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife' });
await writeFile(path.join(extension, 'test-settings.html'), settingsHTML);
await writeFile(path.join(extension, 'test-settings.js'), settingsBundle.outputFiles[0].text);

let context;
const checks = [], errors = [];
try {
  context = await chromium.launchPersistentContext(path.resolve('tmp/browser/chatgpt-preferences-profile-' + Date.now()), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging',
      `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${tls.address().port}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/test-control.html`);
  const saved = await control.evaluate(() => chrome.runtime.sendMessage({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: { activeSiteId: 'chatgpt', customSites: [] } }));
  assert.equal(saved.ok, true);
  const scripts = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.ok(scripts.some(script => script.js.includes('chatgpt-preference-main.js') && script.world === 'MAIN' && script.runAt === 'document_start'));
  assert.ok(scripts.some(script => script.js.includes('chatgpt-preference-bridge.js') && script.runAt === 'document_start'));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://chatgpt.com/');
  assert.deepEqual(await page.evaluate(() => window.fixtureDone), { slug: 'new-thinking', effort: 'extended', ios: 'ios-model', other: 'keep' });
  await control.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'SIDER_CHATGPT_CATALOG_GET' })).catalog?.versions.length === 2);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  checks.push('website default and catalog publication without automatic clicks');

  const settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${id}/test-settings.html`);
  await settingsPage.locator('#ai-settings-toggle').click();
  await settingsPage.locator('[data-site-id="chatgpt"] > summary').click();
  await settingsPage.locator('#ai-chatgpt-model').selectOption('version:latest');
  await settingsPage.locator('#ai-chatgpt-preset').selectOption('preset:new-thinking:standard');
  await page.evaluate(() => window.refreshCatalog('renamed'));
  await settingsPage.locator('#ai-chatgpt-model option').filter({ hasText: 'GPT Renamed' }).waitFor({ state: 'attached' });
  assert.equal(await settingsPage.locator('#ai-chatgpt-model').inputValue(), 'version:latest');
  assert.equal(await settingsPage.locator('#ai-chatgpt-preset').inputValue(), 'preset:new-thinking:standard');
  assert.equal(await settingsPage.locator('#ai-chatgpt-preset option[value="preset:new-thinking:standard"]').textContent(), 'Balanced');
  await page.evaluate(() => fetch('/backend-api/models?broken=1'));
  await settingsPage.waitForFunction(() => document.querySelector('#ai-chatgpt-model').value === '__missing__');
  await page.evaluate(() => window.refreshCatalog('renamed'));
  await settingsPage.waitForFunction(() => document.querySelector('#ai-chatgpt-model').value === 'version:latest');
  assert.equal(await settingsPage.locator('#ai-chatgpt-preset').inputValue(), 'preset:new-thinking:standard');
  await settingsPage.locator('#ai-save-settings').click();
  await settingsPage.waitForFunction(() => !document.querySelector('#ai-settings-dialog').open);
  checks.push('live model and effort updates and recovery preserve the unsaved selection');

  requests.length = 0;
  await page.reload();
  assert.deepEqual(await page.evaluate(() => window.fixtureDone), { slug: 'new-thinking', effort: 'standard', ios: 'ios-model', other: 'keep' });
  assert.equal(await page.locator('html').getAttribute('data-sider-chatgpt-defaults'), 'prepared');
  assert.equal(await page.locator('html').getAttribute('data-sider-chatgpt-selection'), 'prepared');
  assert.equal(await page.evaluate(() => window.fixtureHostState['chatgpt-last-selected-model-v1'].thinkingEffort), 'extended');
  assert.equal(await page.locator('#draft').inputValue(), '保留草稿');
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  assert.deepEqual(requests.filter(request => request.method !== 'GET').map(request => request.path), ['/backend-api/conversation/init']);
  checks.push('new chat applies the selected model and effort without clicks or preference writes');

  await control.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'chatgpt-fixture'; frame.src = 'https://chatgpt.com/'; document.body.append(frame); });
  const embedded = await (await control.locator('#chatgpt-fixture').elementHandle()).contentFrame();
  await embedded.waitForFunction(() => window.fixtureDone);
  assert.deepEqual(await embedded.evaluate(() => window.fixtureDone), { slug: 'new-thinking', effort: 'standard', ios: 'ios-model', other: 'keep' });
  assert.equal(await embedded.evaluate(() => window.fixtureClicks), 0);
  assert.equal(await embedded.locator('html').getAttribute('data-sider-chatgpt-defaults'), 'prepared');
  await control.locator('#chatgpt-fixture').evaluate(node => node.remove());
  checks.push('extension iframe receives the same no-click new-chat preference');

  await page.goto('https://chatgpt.com/c/existing');
  assert.deepEqual(await page.evaluate(() => window.fixtureDone), { slug: 'new-thinking', effort: 'extended', ios: 'ios-model', other: 'keep' });
  assert.equal(await page.locator('html').getAttribute('data-sider-chatgpt-defaults'), null);
  await page.goto('https://chatgpt.com/?model=explicit');
  assert.equal((await page.evaluate(() => window.fixtureDone)).effort, 'extended');
  checks.push('existing conversations and explicit model URLs keep their native preference');

  await page.goto('https://chatgpt.com/?delayModels=1', { waitUntil: 'domcontentloaded' });
  await page.locator('#draft').fill('用户正在编辑');
  assert.equal((await page.evaluate(() => window.fixtureDone)).effort, 'extended');
  assert.equal(await page.locator('#draft').inputValue(), '用户正在编辑');
  checks.push('user input cancels a pending startup preference and preserves the draft');

  await page.goto('https://chatgpt.com/?delaySettings=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.fixtureModelsLoaded);
  await page.locator('#picker').click();
  await releaseSettings();
  assert.equal((await page.evaluate(() => window.fixtureDone)).effort, 'standard');
  checks.push('opening the picker while settings load does not cancel the configured preference');

  await page.goto('https://chatgpt.com/?delaySettings=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.fixtureModelsLoaded);
  assert.equal(await page.evaluate(() => window.fixtureSettingsLoaded), false);
  await page.locator('#picker').click(); await page.locator('#manual').click();
  assert.equal(await page.evaluate(() => window.fixtureSettingsLoaded), false);
  await releaseSettings();
  assert.equal((await page.evaluate(() => window.fixtureDone)).effort, 'extended');
  checks.push('manual menu interaction cancels a pending automatic preference');

  assert.equal((await control.evaluate(() => chrome.runtime.sendMessage({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: {
    activeSiteId: 'chatgpt', customSites: [], chatgptModel: 'version:old', chatgptPreset: 'preset:old-thinking:extended',
  } }))).ok, true);
  requests.length = 0;
  await page.goto('https://chatgpt.com/');
  assert.deepEqual(await page.evaluate(() => window.fixtureDone), { slug: 'old-thinking', effort: 'extended', ios: 'ios-model', other: 'keep' });
  assert.equal(requests.find(request => request.path === '/backend-api/conversation/init').body.requested_default_model, 'old-thinking');
  assert.equal(await page.locator('html').getAttribute('data-sider-chatgpt-init'), 'requested');
  assert.equal(await page.locator('html').getAttribute('data-sider-chatgpt-thinking'), 'prepared');
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  assert.equal(await page.locator('#draft').inputValue(), '保留草稿');
  checks.push('new-chat initialization keeps a different model and High after the server response');

  requests.length = 0;
  assert.equal((await page.evaluate(() => window.initWithRequest())).intended_default_model_slug, 'old-thinking');
  const nativeRequest = requests.find(request => request.path === '/backend-api/conversation/init');
  assert.equal(nativeRequest.body.requested_default_model, 'old-thinking'); assert.equal(nativeRequest.fixtureHeader, 'preserved');
  checks.push('native Request objects keep their headers and use the selected model');

  // Typing and clicking Send happen after startup, often well past 60 seconds.
  await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 61000; });
  await page.locator('#draft').fill('First message after editing');
  requests.length = 0;
  await page.locator('#send').click();
  await page.waitForFunction(() => window.fixtureSent);
  assert.deepEqual(await page.evaluate(() => window.fixtureSent), { slug: 'old-thinking', effort: 'extended' });
  assert.equal(requests.find(request => request.path === '/backend-api/conversation/init').body.requested_default_model, 'old-thinking');
  const generated = requests.find(request => request.path === '/backend-api/conversation').body;
  assert.equal(generated.model, 'old-thinking');
  assert.equal(generated.messages[0].metadata.thinking_effort, 'extended');
  assert.equal(generated.messages[0].content.parts[0], 'First message after editing');
  assert.equal(await page.locator('#draft').inputValue(), 'First message after editing');
  checks.push('typing and first send retain the prepared model and effort beyond the startup window');

  await page.goto('https://chatgpt.com/');
  await page.evaluate(() => window.fixtureDone);
  await page.locator('#picker').click(); await page.locator('#manual').click();
  await page.locator('#draft').fill('Manual model');
  requests.length = 0;
  await page.locator('#send').click();
  await page.waitForFunction(() => window.fixtureSent);
  assert.equal(requests.find(request => request.path === '/backend-api/conversation/init').body.requested_default_model, null);
  assert.equal(requests.find(request => request.path === '/backend-api/conversation').body.model, 'new-thinking');
  checks.push('manual selection after preparation wins during first-send initialization');

  assert.equal((await control.evaluate(() => chrome.runtime.sendMessage({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: {
    activeSiteId: 'chatgpt', customSites: [], chatgptModel: 'version:old', chatgptPreset: 'preset:old-thinking:standard',
  } }))).ok, true);
  await page.goto('https://chatgpt.com/');
  assert.equal((await page.evaluate(() => window.fixtureDone)).slug, 'old-thinking');
  await page.locator('#draft').fill('Medium sent with Enter');
  requests.length = 0;
  await page.locator('#draft').press('Enter');
  await page.waitForFunction(() => window.fixtureSent);
  const medium = requests.find(request => request.path === '/backend-api/conversation').body;
  assert.equal(medium.model, 'old-thinking');
  assert.equal(medium.messages[0].metadata.thinking_effort, 'standard');
  checks.push('Medium with real keyboard input and Enter sends the configured older model');

  assert.equal((await control.evaluate(() => chrome.runtime.sendMessage({ type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: {
    activeSiteId: 'chatgpt', customSites: [], chatgptModel: 'version:old', chatgptPreset: 'preset:old-thinking:extended',
  } }))).ok, true);
  await page.goto('https://chatgpt.com/c/existing');
  await page.evaluate(() => window.fixtureDone);
  await page.evaluate(() => { window.fixtureDocument = 'retained'; const now = Date.now; Date.now = () => now() + 120000; });
  requests.length = 0;
  await page.locator('#new-chat').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent === 'old-thinking/extended');
  assert.equal(await page.evaluate(() => window.fixtureDocument), 'retained');
  assert.equal(requests.length, 0, 'New chat uses the already loaded catalog and does not write account preferences');
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  await page.locator('#draft').fill('First message in the next chat');
  await page.locator('#send').click();
  await page.waitForFunction(() => window.fixtureSent);
  assert.deepEqual(await page.evaluate(() => window.fixtureSent), { slug: 'old-thinking', effort: 'extended' });
  checks.push('New chat from an existing conversation reapplies model and High with a cached catalog after two minutes');

  await page.locator('#new-chat').click();
  await page.locator('#picker').click(); await page.locator('#manual').click();
  await page.locator('#draft').fill('Manual choice in this new chat');
  requests.length = 0;
  await page.locator('#send').click();
  await page.waitForFunction(() => window.fixtureSent);
  assert.equal(requests.find(request => request.path === '/backend-api/conversation').body.model, 'new-thinking');
  await page.locator('#new-chat').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent === 'old-thinking/extended');
  // A second New chat while already at / must also start a fresh preference attempt.
  await page.locator('#picker').click(); await page.locator('#manual').click();
  await page.locator('#new-chat').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent === 'old-thinking/extended');
  requests.length = 0;
  await page.locator('#draft').fill('Default restored on another new chat');
  await page.locator('#draft').press('Enter');
  await page.waitForFunction(() => window.fixtureSent);
  assert.equal(requests.find(request => request.path === '/backend-api/conversation').body.model, 'old-thinking');
  checks.push('manual model choice wins within a chat and repeated New chat at the same URL restores configured defaults');

  requests.length = 0;
  await page.goto('https://chatgpt.com/?limitModel=1');
  const limited = await page.evaluate(() => window.fixtureDone);
  assert.equal(requests.find(request => request.path === '/backend-api/conversation/init').body.requested_default_model, 'old-thinking');
  assert.equal(limited.slug, 'new-thinking');
  checks.push('server model limits retain the native fallback');

  requests.length = 0;
  await page.evaluate(() => window.readQuota());
  const quota = requests.find(request => request.path === '/backend-api/conversation/init');
  assert.equal(Object.hasOwn(quota.body, 'requested_default_model'), false);
  checks.push('quota-only requests are not changed');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, errors }));
} finally {
  settingsGates.splice(0).forEach(resolve => resolve());
  if (context) await context.close();
  await new Promise(resolve => tls.close(resolve));
}
