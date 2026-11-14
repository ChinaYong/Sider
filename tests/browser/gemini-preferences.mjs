import { createServer as httpsServer } from 'node:https';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from './browser.js';

const ids = { 'flash-lite': '1111111111111111', flash: '2222222222222222', pro: '3333333333333333', argon: '4444444444444444' };
const labels = { 'flash-lite': 'Flash-Lite', flash: 'Flash', pro: 'Pro', argon: 'Argon' };
const levels = { low: 1, medium: 4, high: 2 };
const writes = [];

function frame(rpc, value) {
  const payload = JSON.stringify([['wrb.fr', rpc, JSON.stringify(value), null, null, null, 'generic']]);
  return ")]}'\n\n" + (payload.length + 2) + '\n' + payload + '\n';
}

function catalog(missing, renamed) {
  const data = [];
  data[15] = Object.entries(ids).filter(([name]) => !missing || name !== 'argon').map(([name, id]) => [id, labels[name]]);
  data[24] = [null, Object.values(labels).map(label => [[null, null, null, null, label], [[1, '低'], [4, '中'], [2, '高']], 1])];
  if (renamed) { data[24][1][3][0][5] = '4 Updated Argon'; data[24][1][3][1][2][1] = '更高'; }
  return data;
}

function preferences(shape, sameModel) {
  const prefs = Array(208).fill(null);
  prefs[0] = '保留其他偏好😀';
  prefs[99] = sameModel ? ids.argon : ids.flash;
  if (shape === 'dense') {
    prefs.length = 270;
    prefs[264] = 1;
    prefs[269] = { 280: 42 };
  } else if (shape === 'invalid') prefs[207] = { unexpected: true };
  else if (shape !== 'empty') prefs[207] = { 265: 1, 280: 42 };
  return [prefs];
}

const pageHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Gemini preference fixture</title></head><body>
<textarea id="draft">保留草稿</textarea><button id="picker" data-test-id="bard-mode-menu-button">Model</button><div data-test-id="gem-mode-menu"><button id="manual-choice" role="menuitemradio">Manual model</button></div><div id="result"></div>
<script>
window.fixtureClicks = 0;
document.querySelector('#picker').addEventListener('click', event => {
  window.fixtureClicks++;
  event.currentTarget.setAttribute('aria-expanded', event.currentTarget.getAttribute('aria-expanded') !== 'true' ? 'true' : 'false');
});
const params = new URLSearchParams(location.search);
const ids = ${JSON.stringify(ids)}, labels = ${JSON.stringify(labels)};
const parse = (text, rpc) => {
  for (const line of text.split('\\n')) try {
    const rows = JSON.parse(line), row = Array.isArray(rows) && rows.find(item => item?.[0] === 'wrb.fr' && item?.[1] === rpc);
    if (row) return JSON.parse(row[2]);
  } catch {}
  return null;
};
window.readServerPrefs = async () => parse(await (await fetch('/_/BardChatUi/data/batchexecute?rpcids=ESY5D', { method:'POST' })).text(), 'ESY5D')[0];
const send = (field, value) => {
  const prefs = Array(field).fill(null); prefs[field - 1] = value;
  const body = new URLSearchParams({ 'f.req': JSON.stringify([[['L5adhe', JSON.stringify([prefs, null, [field]]), null, 'generic']]]) });
  return fetch(new Request('/_/BardChatUi/data/batchexecute?rpcids=L5adhe', { method:'POST', body }));
};
window.manualWrite = model => send(100, ids[model] || ids.argon);
window.fixtureDone = (async () => {
  const extra = params.get('delay') ? '&delay=1' : params.get('missing') ? '&missing=1' : '';
  const prefsExtra = (params.get('delayPrefs') ? '&delay=1' : '') + (params.has('shape') ? '&shape=' + params.get('shape') : '') + (params.has('sameModel') ? '&sameModel=1' : '');
  let statusResponse, prefsResponse;
  if (params.has('prefsFirst')) {
    const pendingPrefs = fetch('/_/BardChatUi/data/batchexecute?rpcids=ESY5D' + prefsExtra, { method:'POST' });
    const pendingStatus = fetch('/_/BardChatUi/data/batchexecute?rpcids=otAQ7b&delayLong=1', { method:'POST' });
    [statusResponse, prefsResponse] = await Promise.all([pendingStatus, pendingPrefs]);
  } else {
    statusResponse = await fetch('/_/BardChatUi/data/batchexecute?rpcids=otAQ7b' + extra, { method:'POST' });
    prefsResponse = await fetch('/_/BardChatUi/data/batchexecute?rpcids=ESY5D' + prefsExtra, { method:'POST' });
  }
  const status = parse(await statusResponse.text(), 'otAQ7b');
  const prefs = parse(await prefsResponse.text(), 'ESY5D')[0];
  const model = Object.keys(ids).find(name => ids[name] === prefs[99]) || 'flash';
  const choice = status[24][1].find(item => item[0][4] === labels[model]);
  const tail = prefs[prefs.length - 1];
  const storedLevel = tail && typeof tail === 'object' && !Array.isArray(tail) && prefs.length <= 265 ? tail[265] : prefs[264];
  const level = storedLevel ?? choice[2];
  // The native site can initialize on Flash first, then retain its level when
  // the configured model arrives, even if that model has another default.
  const initialChoice = status[24][1].find(item => item[0][4] === labels.flash);
  window.fixtureInheritedLevel = choice[1].some(item => item[0] === initialChoice[2]) ? initialChoice[2] : choice[2];
  window.fixtureChoiceDefault = choice[2];
  window.fixtureThinking = { storedLevel: storedLevel ?? null, tailIndex: prefs.length - 1 };
  window.fixtureState = { model, level, embedded: prefs[164], other: prefs[0], sparse: tail && typeof tail === 'object' ? tail[280] ?? null : null };
  document.querySelector('#result').textContent = model + '/' + level;
  await send(100, ids[model]);
  await send(265, level);
  await send(5, true);
  return window.fixtureState;
})();
</script></body></html>`;

const tls = httpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, async (req, res) => {
  const url = new URL(req.url, 'https://gemini.google.com');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/_/BardChatUi/data/batchexecute') {
    const rpc = url.searchParams.get('rpcids');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (rpc === 'otAQ7b') {
      if (url.searchParams.has('delay')) await new Promise(resolve => setTimeout(resolve, 1000));
      if (url.searchParams.has('delayLong')) await new Promise(resolve => setTimeout(resolve, 1900));
      res.end(frame(rpc, url.searchParams.has('broken') ? [] : catalog(url.searchParams.has('missing'), url.searchParams.has('renamed'))));
    } else if (rpc === 'ESY5D') {
      if (url.searchParams.has('delay')) await new Promise(resolve => setTimeout(resolve, 1000));
      res.end(frame(rpc, preferences(url.searchParams.get('shape'), url.searchParams.has('sameModel'))));
    }
    else if (rpc === 'L5adhe') {
      let body = '';
      for await (const part of req) body += part;
      const request = JSON.parse(new URLSearchParams(body).get('f.req'));
      const data = JSON.parse(request[0][0][1]);
      writes.push({ field: data[2][0], value: data[0][data[2][0] - 1] });
      res.end(frame(rpc, [1]));
    } else res.end(frame(rpc, []));
    return;
  }
  res.end(pageHTML);
});
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));

const extension = path.resolve('tmp/browser/gemini-preferences-extension');
assert.ok(extension.startsWith(path.resolve('tmp/browser') + path.sep));
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('https://gemini.google.com/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
await writeFile(path.join(extension, 'test-control.html'), '<!doctype html><title>Test control</title>');
const settingsHTML = (await readFile('dist/panel.html', 'utf8')).replace('<script type="module" src="panel.js"></script>', '<script defer src="test-settings.js"></script>');
const settingsBundle = await build({ stdin: { contents: "import { installAIWebSettings } from './src/ai-web-settings.js'; installAIWebSettings({ document, chrome });", resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife' });
await writeFile(path.join(extension, 'test-settings.html'), settingsHTML);
await writeFile(path.join(extension, 'test-settings.js'), settingsBundle.outputFiles[0].text);

let context;
const checks = [];
try {
  context = await chromium.launchPersistentContext(path.resolve('tmp/browser/gemini-preferences-profile-' + Date.now()), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging',
      `--host-resolver-rules=MAP gemini.google.com:443 127.0.0.1:${tls.address().port}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/test-control.html`);
  const save = (model, thinking) => control.evaluate(({ model, thinking }) => chrome.runtime.sendMessage({
    type: 'SIDER_AI_WEB_SETTINGS_SAVE', settings: { activeSiteId: 'gemini', customSites: [], geminiModel: model, geminiThinkingLevel: thinking },
  }), { model, thinking });
  assert.equal((await save('argon', 'high')).ok, true);
  const scripts = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.ok(scripts.some(script => script.world === 'MAIN' && script.runAt === 'document_start' && script.js.includes('gemini-preference-main.js')));
  assert.ok(scripts.some(script => script.world === 'ISOLATED' && script.runAt === 'document_start' && script.js.includes('gemini-preference-bridge.js')));

  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const [model, level] of [['argon', 'high'], ['pro', 'medium'], ['flash-lite', 'low']]) {
    assert.equal((await save(model, level)).ok, true);
    writes.length = 0;
    await page.goto('https://gemini.google.com/app');
    const state = await page.evaluate(() => window.fixtureDone);
    assert.deepEqual(state, { model, level: levels[level], embedded: ids[model], other: '保留其他偏好😀', sparse: 42 });
    assert.equal(await page.evaluate(() => window.fixtureInheritedLevel), levels[level]);
    assert.equal(await page.locator('html').getAttribute('data-sider-gemini-defaults'), 'prepared');
    assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
    assert.deepEqual(writes, [{ field: 5, value: true }]);
    assert.equal(await page.locator('#draft').inputValue(), '保留草稿');
    checks.push(`${model}/${level}: no model clicks, unrelated preferences preserved`);
  }

  const settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${id}/test-settings.html`);
  await settingsPage.locator('#ai-settings-toggle').click();
  await settingsPage.locator('[data-site-id="gemini"] > summary').click();
  await settingsPage.locator('#ai-gemini-model').selectOption(`id:${ids.argon}`);
  await settingsPage.locator('#ai-gemini-thinking').selectOption('level:2');
  await page.evaluate(() => fetch('/_/BardChatUi/data/batchexecute?rpcids=otAQ7b&renamed=1', { method:'POST' }));
  await control.waitForFunction(async () => {
    const result = await chrome.runtime.sendMessage({ type: 'SIDER_GEMINI_CATALOG_GET' });
    return result.catalog?.models.some(model => model.id === '4444444444444444' && model.label.includes('Updated'));
  });
  const published = await control.evaluate(() => chrome.runtime.sendMessage({ type: 'SIDER_GEMINI_CATALOG_GET' }));
  assert.equal(published.catalog.models.find(model => model.id === ids.argon).levels.find(level => level.id === 2).label, '更高');
  await settingsPage.locator('#ai-gemini-model option').filter({ hasText: 'Updated' }).waitFor({ state: 'attached' });
  assert.equal(await settingsPage.locator('#ai-gemini-model').inputValue(), `id:${ids.argon}`);
  assert.equal(await settingsPage.locator('#ai-gemini-thinking').inputValue(), 'level:2');
  assert.equal(await settingsPage.locator('#ai-gemini-thinking option[value="level:2"]').textContent(), '更高');
  await page.evaluate(() => fetch('/_/BardChatUi/data/batchexecute?rpcids=otAQ7b&broken=1', { method:'POST' }));
  await settingsPage.waitForFunction(() => document.querySelector('#ai-gemini-model').disabled);
  await page.evaluate(() => fetch('/_/BardChatUi/data/batchexecute?rpcids=otAQ7b', { method:'POST' }));
  await settingsPage.waitForFunction(() => !document.querySelector('#ai-gemini-model').disabled);
  assert.equal(await settingsPage.locator('#ai-gemini-model').inputValue(), `id:${ids.argon}`);
  assert.equal(await settingsPage.locator('#ai-gemini-thinking').inputValue(), 'level:2');
  await settingsPage.close();
  checks.push('live catalog updates and recovery preserve the open settings draft');

  assert.equal((await save('argon', 'high')).ok, true);
  for (const shape of ['dense', 'empty']) {
    writes.length = 0;
    await page.goto(`https://gemini.google.com/app?shape=${shape}`);
    const state = await page.evaluate(() => window.fixtureDone);
    assert.equal(state.model, 'argon'); assert.equal(state.level, 2);
    assert.equal(state.other, '保留其他偏好😀');
    assert.equal(state.sparse, shape === 'dense' ? 42 : null);
    assert.equal((await page.evaluate(() => window.fixtureThinking)).storedLevel, 2);
    assert.equal(await page.locator('html').getAttribute('data-sider-gemini-defaults'), 'prepared');
    assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
    assert.deepEqual(writes, [{ field: 5, value: true }]);
    checks.push(`${shape}: thinking preference wins over the previous value without clicks`);
  }

  writes.length = 0;
  await page.goto('https://gemini.google.com/app?prefsFirst=1&sameModel=1');
  const prefsFirst = await page.evaluate(() => window.fixtureDone);
  assert.equal(prefsFirst.model, 'argon'); assert.equal(prefsFirst.level, 2);
  assert.equal((await page.evaluate(() => window.fixtureThinking)).storedLevel, 2);
  assert.equal(await page.locator('html').getAttribute('data-sider-gemini-defaults'), 'thinking-prepared');
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  assert.deepEqual(writes, [{ field: 5, value: true }]);
  checks.push('a late catalog does not leave the previous thinking preference active');

  await page.goto('https://gemini.google.com/app?prefsFirst=1&sameModel=1', { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-sider-gemini-defaults="thinking-prepared"]').waitFor();
  await page.locator('#draft').fill('等级就绪后开始输入');
  await page.evaluate(() => window.fixtureDone);
  assert.equal(await page.evaluate(() => window.fixtureChoiceDefault), 1);
  assert.equal(await page.locator('#draft').inputValue(), '等级就绪后开始输入');
  checks.push('input after an early thinking preference cancels the later catalog override');

  writes.length = 0;
  await page.goto('https://gemini.google.com/app?delayPrefs=1', { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-sider-gemini-defaults="catalog-ready"]').waitFor();
  await page.locator('#picker').click();
  const inspected = await page.evaluate(() => window.fixtureDone);
  assert.equal(inspected.model, 'argon'); assert.equal(inspected.level, 2);
  assert.equal(await page.locator('html').getAttribute('data-sider-gemini-defaults'), 'prepared');
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
  assert.deepEqual(writes, [{ field: 5, value: true }]);
  checks.push('opening the model menu while preferences load does not cancel the configured level');

  writes.length = 0;
  await page.goto('https://gemini.google.com/app?delayPrefs=1', { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-sider-gemini-defaults="catalog-ready"]').waitFor();
  await page.locator('#picker').focus();
  await page.keyboard.press('Enter');
  const keyboardOpened = await page.evaluate(() => window.fixtureDone);
  assert.equal(keyboardOpened.model, 'argon'); assert.equal(keyboardOpened.level, 2);
  assert.deepEqual(writes, [{ field: 5, value: true }]);
  checks.push('opening the model menu with the keyboard does not cancel pending defaults');

  await page.goto('https://gemini.google.com/app?shape=invalid');
  const unsupportedPrefs = await page.evaluate(() => window.fixtureDone);
  assert.equal(unsupportedPrefs.model, 'flash'); assert.equal(unsupportedPrefs.level, 2);
  assert.equal((await page.evaluate(() => window.fixtureThinking)).storedLevel, null);
  assert.equal(await page.locator('html').getAttribute('data-sider-gemini-defaults'), 'preferences-unavailable');
  checks.push('an unknown preference response is unchanged and not reported as fully prepared');

  assert.equal((await save('argon', 'medium')).ok, true);
  writes.length = 0;
  await control.evaluate(() => chrome.storage.session.remove('sider.geminiCatalog.v1'));
  await control.evaluate(() => {
    const frame = document.createElement('iframe'); frame.id = 'test-frame'; frame.src = 'https://gemini.google.com/app'; document.body.append(frame);
  });
  const embedded = control.frameLocator('#test-frame');
  const embeddedState = await embedded.locator('body').evaluate(() => window.fixtureDone);
  assert.equal(embeddedState.model, 'argon'); assert.equal(embeddedState.level, 4);
  await control.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'SIDER_GEMINI_CATALOG_GET' })).catalog?.models.length === 4);
  assert.equal(await embedded.locator('body').evaluate(() => window.fixtureClicks), 0);
  assert.deepEqual(writes, [{ field: 5, value: true }]);
  await control.locator('#test-frame').evaluate(frame => frame.remove());
  checks.push('extension iframe publishes its live catalog and receives no-click defaults');

  await page.goto('https://gemini.google.com/app');
  await page.evaluate(() => window.fixtureDone);
  writes.length = 0;
  await page.locator('#picker').click();
  await page.locator('#manual-choice').click();
  const laterPrefs = await page.evaluate(() => window.readServerPrefs());
  assert.equal(laterPrefs[99], ids.flash); assert.equal(laterPrefs[207][265], 1);
  await page.evaluate(() => window.manualWrite('flash-lite'));
  assert.equal(writes.at(-1).field, 100);
  checks.push('manual model interaction stops later overrides and reaches Gemini after automatic startup');

  await page.goto('https://gemini.google.com/app');
  await page.evaluate(() => window.fixtureDone);
  writes.length = 0;
  await page.locator('#picker').click();
  await page.locator('#picker').focus();
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.manualWrite('argon'));
  assert.equal(writes.at(-1).field, 100);
  assert.equal(writes.at(-1).value, ids.argon);
  checks.push('keyboard interaction in an open model menu preserves the manual preference write');

  assert.equal((await save('argon', 'high')).ok, true);
  writes.length = 0;
  await page.goto('https://gemini.google.com/app?delay=1', { waitUntil: 'domcontentloaded' });
  await page.locator('#draft').fill('用户正在输入');
  const interrupted = await page.evaluate(() => window.fixtureDone);
  assert.equal(interrupted.model, 'flash'); assert.equal(interrupted.level, 1);
  assert.equal(await page.locator('#draft').inputValue(), '用户正在输入');
  checks.push('trusted user input cancels a pending automatic change');

  writes.length = 0;
  await page.goto('https://gemini.google.com/app?delayPrefs=1', { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-sider-gemini-defaults="catalog-ready"]').waitFor();
  await page.locator('#draft').fill('模型目录就绪后开始输入');
  const lateInput = await page.evaluate(() => window.fixtureDone);
  assert.equal(lateInput.model, 'flash'); assert.equal(lateInput.level, 1);
  assert.equal(await page.locator('#draft').inputValue(), '模型目录就绪后开始输入');
  checks.push('user input after catalog readiness also cancels the pending preference change');

  await page.goto('https://gemini.google.com/app?missing=1');
  const unavailable = await page.evaluate(() => window.fixtureDone);
  assert.equal(unavailable.model, 'flash');
  assert.equal(await page.locator('html').getAttribute('data-sider-gemini-defaults'), 'catalog-unavailable');
  checks.push('an unavailable model leaves the native response untouched');

  await page.goto('https://gemini.google.com/spark');
  const spark = await page.evaluate(() => window.fixtureDone);
  assert.equal(spark.model, 'flash'); assert.equal(spark.level, 1);
  checks.push('Spark is unaffected');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, errors }));
} finally {
  await context?.close();
  await new Promise(resolve => tls.close(resolve));
}
