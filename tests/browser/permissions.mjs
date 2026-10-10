import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

import { chromium } from './browser.js';
const html = `<!doctype html><html><head><title>ChatGPT permission fixture</title></head><body><main><form><div data-composer-body><textarea id="prompt-textarea" aria-label="Ask ChatGPT"></textarea></div><button type="submit" data-testid="send-button">Send</button></form></main><script>window.sent=[];document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();sent.push(document.querySelector('textarea').value)});</script></body></html>`;
const tls = createHttpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'none'; script-src 'unsafe-inline'", 'x-frame-options': 'DENY' }); res.end(html);
});
const article = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>权限回归测试网页</title></head><body><main><article><h1>正文标题</h1><p id="quote">这是未预先授权网页中的选段。</p><p>第二段正文，包含页面提取需要保留的信息。</p><pre>const permission = "activeTab";</pre></article></main></body></html>');
});
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => article.listen(0, '127.0.0.1', resolve));
let context;
try {
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext(path.resolve(`tmp/browser/permission-profile-${Date.now()}`), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, ignoreHTTPSErrors: true,
    viewport: { width: 420, height: 840 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${tls.address().port}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const browserCDP = await context.browser().newBrowserCDPSession();
  const source = await context.newPage();
  const sourceURL = `http://127.0.0.1:${article.address().port}/article`;
  await source.goto(sourceURL); await source.bringToFront();
  const initial = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/panel.html?sourceTab=${initial.id}`);
  const chat = panel.frameLocator('iframe');
  await chat.locator('#sider-enhancement').waitFor({ timeout: 15000 });
  await source.bringToFront();
  const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const targetInfo = targetInfos.find(info => info.url === sourceURL);
  assert.ok(targetInfo, 'Expected a browser tab target for the fixture source');
  const trigger = async () => {
    await source.bringToFront();
    await browserCDP.send('Extensions.triggerAction', { id, targetId: targetInfo.targetId });
  };
  const sourceTab = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]);
  const before = await sourceTab();
  assert.equal(before.url, sourceURL);
  assert.equal(await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })), false);
  const denied = await worker.evaluate(async tabId => {
    try { await chrome.scripting.executeScript({ target: { tabId }, func: () => document.title }); return false; }
    catch { return true; }
  }, before.id);
  assert.equal(denied, true);

  // Reproduce the old automatic-toggle path with the actual browser action.
  await worker.evaluate(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));
  await trigger();
  assert.equal((await sourceTab()).url, sourceURL);
  await panel.evaluate(tabId => chrome.runtime.sendMessage({ type: 'SIDER_TAB_CONTEXT_GET', tabId }), initial.id);
  await chat.getByRole('button', { name: '允许当前网站', exact: true }).waitFor();
  assert.equal((await panel.evaluate(tabId => chrome.runtime.sendMessage({ type: 'SIDER_TAB_CONTEXT_GET', tabId }), initial.id)).needsAccess, true);
  // Metadata permission identifies the correct origin without granting content access.
  await chat.getByRole('button', { name: '允许当前网站', exact: true }).click();
  await panel.locator('#site-dialog').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#grant-site').textContent(), '允许此网站');
  assert.match(await panel.locator('#site-description').textContent(), /127\.0\.0\.1/);
  await panel.locator('#close-site').click();
  await panel.locator('#site-dialog').waitFor({ state: 'hidden' });
  const accessRequest = await panel.evaluate(tabId => chrome.runtime.sendMessage({ type: 'SIDER_SOURCE_ACCESS_REQUEST', tabId }), initial.id);
  assert.equal(accessRequest.ok, true); assert.equal(accessRequest.requested, true);

  // Restore production behavior, then use the same native action on the source.
  await worker.evaluate(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }));
  await source.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#quote'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await trigger();
  assert.equal((await sourceTab()).url, sourceURL);
  await assertEventually(async () => assert.equal(await worker.evaluate(async tabId => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => Boolean(globalThis.__siderPageCaptureInstalled) });
    return result.result;
  }, before.id), true));
  const contextSnapshot = () => panel.evaluate(tabId => chrome.runtime.sendMessage({ type: 'SIDER_TAB_CONTEXT_GET', tabId }), initial.id);
  await assertEventually(async () => assert.equal((await contextSnapshot()).context.selection?.content, '这是未预先授权网页中的选段。'));
  const editor = chat.getByRole('textbox', { name: 'Ask ChatGPT' });
  await editor.waitFor();
  await panel.evaluate(async tabId => {
    await chrome.runtime.sendMessage({ type: 'SIDER_TAB_ATTACHMENT_SET', tabId, kind: 'url', enabled: true });
    await chrome.runtime.sendMessage({ type: 'SIDER_TAB_ATTACHMENT_SET', tabId, kind: 'page', enabled: true });
  }, initial.id);
  const captured = (await contextSnapshot()).context;
  assert.equal(captured.url, sourceURL);
  assert.ok(captured.attachments.page.content.includes('const permission = "activeTab";'));
  assert.equal(await editor.inputValue(), '');
  assert.equal(await chat.locator('body').evaluate(() => sent.length), 0);

  // Navigation to another origin revokes temporary access; it must never read
  // an old source just because that source was granted earlier.
  const otherURL = `http://localhost:${article.address().port}/other`;
  await source.goto(otherURL); await source.bringToFront();
  assert.equal((await sourceTab()).url, otherURL);
  let deniedContext;
  await assertEventually(async () => { deniedContext = await contextSnapshot(); assert.equal(deniedContext.ok, true); });
  assert.equal(deniedContext.ok, true, JSON.stringify(deniedContext));
  assert.equal(deniedContext.needsAccess, true); assert.equal(deniedContext.context.attachments.page, null);
  await chat.getByRole('button', { name: '允许当前网站', exact: true }).waitFor();
  await trigger();
  assert.equal((await sourceTab()).url, otherURL);
  await panel.evaluate(tabId => chrome.runtime.sendMessage({ type: 'SIDER_TAB_ATTACHMENT_SET', tabId, kind: 'page', enabled: true }), initial.id);
  const last = (await contextSnapshot()).context.attachments.page;
  assert.equal(last.url, otherURL);
  console.log(JSON.stringify({ browser: context.browser().version(), version: JSON.parse(await readFile('dist/manifest.json', 'utf8')).version, fixture: true, addedHostPermissions: false, checks: ['tabs permission exposes metadata without page access', 'old automatic sidebar toggle reproduces missing activeTab', 'request selected site access reaches actual browser API', 'native action grants activeTab and preinstalls selection snapshot', 'selection URL and Readability body capture succeed', 'captures do not submit', 'cross-origin navigation revokes access without stale capture', 'next native action authorizes the new origin'] }, null, 2));
} finally {
  await context?.close(); await new Promise(resolve => tls.close(resolve)); await new Promise(resolve => article.close(resolve));
}

async function assertEventually(check, timeout = 3000) {
  const until = Date.now() + timeout;
  for (;;) {
    try { await check(); return; }
    catch (error) { if (Date.now() >= until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}
