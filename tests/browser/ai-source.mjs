import { createServer } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from './browser.js';
import { TAB_CONTEXT_PREFIX } from '../../src/context.js';

const html = `<!doctype html><meta charset="utf-8"><title>ChatGPT AI source fixture</title>
<main><article><h1>当前 AI 会话</h1><p id="quote">ChatGPT 回答中的第一段划词。</p><p id="replacement">ChatGPT 回答中的第二段划词。</p></article>
<form><div data-composer-body><textarea id="prompt-textarea" aria-label="Ask ChatGPT"></textarea></div>
<input type="file" aria-label="User file"><button type="submit" data-testid="send-button">Send</button></form></main>
<script>window.sent=[];window.identity=crypto.randomUUID();document.querySelector('form').onsubmit=event=>{event.preventDefault();sent.push(document.querySelector('textarea').value)};</script>`;
const server = createServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const checks = [], errors = [];
const checked = message => { checks.push(message); console.log(`PASS ${message}`); };
let context;
try {
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext(path.resolve(`tmp/browser/ai-source-profile-${Date.now()}`), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}),
    headless: true, ignoreHTTPSErrors: true, viewport: { width: 420, height: 840 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging',
      `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${server.address().port}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  await worker.evaluate(() => chrome.storage.local.set({
    siderEnabledOrigins: [],
    'sider.aiWebSettings.v1': { activeSiteId: 'chatgpt', hideUnavailableTabs: true },
    'sider.launcher.v1': { floating: true, mode: 'blacklist', blacklist: ['chatgpt.com'] },
  }));
  const source = await context.newPage(); source.on('pageerror', error => errors.push(error.message));
  await source.goto('https://chatgpt.com/c/ai-source'); await source.bringToFront();
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), source.url());
  const installed = () => worker.evaluate(async tabId => (await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, func: () => Boolean(globalThis.__siderPageCaptureInstalled),
  }))[0].result, tab.id);
  assert.equal(await installed(), false);
  assert.equal(await source.locator('#sider-floating-launcher').count(), 0);
  checked('AI navigation keeps automatic capture and the blacklisted launcher disabled');

  const draft = source.locator('textarea'); await draft.fill('来源 AI 会话里尚未发送的草稿');
  await source.getByLabel('User file').setInputFiles({ name: '保留.txt', mimeType: 'text/plain', buffer: Buffer.from('用户已有附件') });
  const identity = await source.evaluate(() => window.identity);
  const select = async selector => {
    await source.bringToFront();
    await source.locator(selector).click();
    await source.locator(selector).selectText();
  };
  await select('#quote');
  const cdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfos.find(target => target.url === source.url()).targetId });
  await eventually(async () => assert.equal(await installed(), true));
  // Use a visible test panel bound to the same owner; the native action above
  // exercises the production gesture and pre-focus selection installation.
  const panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/panel.html?sourceTab=${tab.id}`);
  const chat = panel.frameLocator('iframe');
  await chat.locator('#sider-enhancement').waitFor();
  const snapshot = () => panel.evaluate(tabId => chrome.runtime.sendMessage({ type: 'SIDER_TAB_CONTEXT_GET', tabId }), tab.id);
  await eventually(async () => {
    const current = await snapshot(); assert.equal(current.ok, true, current.error);
    assert.equal(current.needsAccess, false); assert.equal(current.context.url, source.url());
    assert.equal(current.context.selection?.content, 'ChatGPT 回答中的第一段划词。');
  });
  await chat.locator('.selection-chip').filter({ hasText: 'ChatGPT 回答中的第一段划词。' }).waitFor();
  checked('a native toolbar open captures the pre-existing ChatGPT selection and displays it in the sidebar');

  await select('#replacement');
  // Wait for the unsolicited notification in session storage, without a GET
  // that could mask a broken content-message authorization path.
  await eventually(async () => {
    const current = await worker.evaluate(key => chrome.storage.session.get(key), TAB_CONTEXT_PREFIX + tab.id);
    assert.equal(Object.values(current)[0]?.selection?.content, 'ChatGPT 回答中的第二段划词。');
  });
  await panel.bringToFront();
  await chat.locator('.selection-chip').filter({ hasText: 'ChatGPT 回答中的第二段划词。' }).waitFor();
  checked('later selections on the AI main page update the open sidebar through content notifications');

  await chat.getByRole('button', { name: '预设', exact: true }).click();
  await chat.getByRole('button', { name: '切换引用来源标签页', exact: true }).click();
  await chat.getByRole('option').filter({ hasText: 'ChatGPT AI source fixture' }).waitFor();
  assert.equal(await chat.getByRole('option').filter({ hasText: 'ChatGPT AI source fixture' }).isEnabled(), true);
  checked('hiding unavailable tabs keeps the manually opened AI source selectable');

  assert.equal(await draft.inputValue(), '来源 AI 会话里尚未发送的草稿');
  assert.deepEqual(await source.getByLabel('User file').evaluate(input => [...input.files].map(file => file.name)), ['保留.txt']);
  assert.equal(await source.evaluate(() => window.identity), identity);
  assert.equal(await source.evaluate(() => sent.length), 0);
  assert.equal(await chat.locator('body').evaluate(() => sent.length), 0);
  assert.equal(await source.locator('#sider-floating-launcher, #sider-selection-tools').count(), 0);
  const settings = await worker.evaluate(() => chrome.storage.local.get(['siderEnabledOrigins', 'sider.launcher.v1']));
  assert.deepEqual(settings.siderEnabledOrigins, []);
  assert.deepEqual(settings['sider.launcher.v1'].blacklist, ['chatgpt.com']);
  checked('manual capture preserves the AI draft, user file, document, blacklist and disabled automatic selection entry without sending');

  await source.reload(); await source.bringToFront(); await select('#quote');
  await panel.bringToFront();
  await eventually(async () => assert.equal((await snapshot()).context.selection?.content, 'ChatGPT 回答中的第一段划词。'));
  assert.equal(await source.locator('#sider-floating-launcher, #sider-selection-tools').count(), 0);
  checked('an already open sidebar reconnects after AI-source reload while automatic entries stay disabled');
  const performanceCDP = await context.newCDPSession(source);
  await source.evaluate(() => {
    const history = document.createElement('section'); history.id = 'history';
    history.innerHTML = Array.from({ length: 1200 }, (_, index) => `<article><h2>回答 ${index}</h2><p>${'已完成的历史回答与代码说明。'.repeat(60)}</p></article>`).join('');
    document.querySelector('main').prepend(history);
  });
  await source.bringToFront();
  await source.locator('#replacement').click();
  await worker.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => {
    globalThis.selectionMetrics = { pageIndexes: 0, walkedNodes: 0, styleReads: 0 };
    const walk = document.createTreeWalker.bind(document), style = getComputedStyle;
    document.createTreeWalker = (root, ...args) => {
      if (root === document.body) selectionMetrics.pageIndexes++;
      const walker = walk(root, ...args), next = walker.nextNode.bind(walker);
      walker.nextNode = () => { selectionMetrics.walkedNodes++; return next(); }; return walker;
    };
    globalThis.getComputedStyle = (...args) => { selectionMetrics.styleReads++; return style(...args); };
  } }), tab.id);
  await performanceCDP.send('Performance.enable');
  const taskDuration = async () => (await performanceCDP.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'TaskDuration').value;
  const started = await taskDuration();
  const drag = await source.evaluate(() => {
    const text = document.querySelector('#replacement').firstChild, selection = getSelection(), durations = [];
    for (let index = 1; index <= 12; index++) {
      const start = performance.now(), range = document.createRange(); range.setStart(text, 0); range.setEnd(text, index);
      selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
      durations.push(performance.now() - start);
    }
    return { totalMs: durations.reduce((sum, value) => sum + value, 0), maxEventMs: Math.max(...durations), finalText: selection.toString(), characters: document.body.textContent.length };
  });
  await eventually(async () => {
    const current = await worker.evaluate(key => chrome.storage.session.get(key), TAB_CONTEXT_PREFIX + tab.id);
    assert.equal(Object.values(current)[0]?.selection?.content, drag.finalText);
  });
  for (let index = 0; index < 5; index++) await snapshot();
  const metrics = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => globalThis.selectionMetrics }))[0].result, tab.id);
  const performanceResult = { ...drag, ...metrics, sourceTaskMs: ((await taskDuration()) - started) * 1000 };
  await writeFile(`tmp/browser/ai-source-performance-${process.env.SIDER_SELECTION_BASELINE ? 'baseline' : 'optimized'}.json`, JSON.stringify(performanceResult, null, 2));
  if (!process.env.SIDER_SELECTION_BASELINE) {
    assert.equal(metrics.pageIndexes, 0, 'Selection capture must not index the conversation body');
    assert.ok(metrics.styleReads < 2000, `Bounded style work: ${metrics.styleReads}`);
    checked('selection dragging and repeated sidebar reads in a million-character conversation avoid whole-page indexing and bound style work');
  }
  assert.deepEqual(errors, []);
  await writeFile('tmp/browser/ai-source-result.json', JSON.stringify({ fixtureOnly: true, browser: context.browser().version(), checks, errors, performance: performanceResult }, null, 2));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
}

async function eventually(check, timeout = 6000) {
  const until = Date.now() + timeout;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= until) throw error; await new Promise(resolve => setTimeout(resolve, 80)); } }
}
