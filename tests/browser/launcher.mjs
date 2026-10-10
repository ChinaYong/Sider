import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from './browser.js';

await mkdir('tmp/browser', { recursive: true });
const tls = httpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>AI fixture</title><main><form><div data-composer-body><textarea id="prompt-textarea" aria-label="Ask ChatGPT"></textarea></div><button data-testid="send-button">Send</button></form></main>');
});
const server = httpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (req.url === '/frame') { res.end('<!doctype html><title>子框架</title><p>框架正文</p>'); return; }
  res.end('<!doctype html><html><head><title>悬浮球验证</title><style>body{font:16px system-ui;margin:60px;background:#f8faf9;color:#243b30}article{max-width:620px;line-height:1.9}input{padding:8px}</style></head><body><article><h1>网页侧栏入口</h1><p id="quote">这是一段保持未勾选状态的网页文字。</p><p>点击悬浮球可以打开当前标签页的侧栏，拖动可调整位置。</p><input aria-label="网页输入框" value="保留原输入"><iframe src="/frame" style="display:none"></iframe></article></body></html>');
});
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const extension = path.resolve(`tmp/browser/launcher-extension-${Date.now()}`);
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const checks = [], errors = [];
const pass = value => { checks.push(value); console.log('PASS ' + value); };
let context;
try {
  context = await chromium.launchPersistentContext(path.resolve(`tmp/browser/launcher-profile-${Date.now()}`), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, ignoreHTTPSErrors: true,
    viewport: { width: 820, height: 640 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${tls.address().port}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  await worker.evaluate(() => {
    globalThis.launcherOpened = [];
    globalThis.launcherClosed = [];
    chrome.sidePanel.onOpened.addListener(info => launcherOpened.push(info));
    chrome.sidePanel.onClosed.addListener(info => launcherClosed.push(info));
  });
  const source = await context.newPage(), sourceURL = `http://127.0.0.1:${server.address().port}/article`;
  await source.goto(sourceURL);
  const launcher = source.locator('#sider-floating-launcher'); await launcher.waitFor();
  assert.equal(await launcher.count(), 1);
  for (const frame of source.frames().filter(frame => frame !== source.mainFrame())) assert.equal(await frame.locator('#sider-floating-launcher').count(), 0);
  const ungranted = await context.newPage(); await ungranted.goto(`http://localhost:${server.address().port}/ungranted`);
  assert.equal(await ungranted.locator('#sider-floating-launcher').count(), 0);
  pass('authorized pages get one launcher; ungranted pages and child frames get none');
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), sourceURL);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/panel.html?sourceTab=${tab.id}`);
  const request = data => panel.evaluate(data => chrome.runtime.sendMessage(data), data);
  assert.equal((await request({ type: 'SIDER_TAB_ATTACHMENT_SET', tabId: tab.id, kind: 'selection', enabled: false })).ok, true);
  await source.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#quote')); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await source.bringToFront(); await launcher.click();
  await eventually(async () => assert.equal(await worker.evaluate(() => launcherOpened.at(-1)?.tabId), tab.id));
  const snapshot = await request({ type: 'SIDER_TAB_CONTEXT_GET', tabId: tab.id });
  assert.equal(snapshot.context.selectionIncluded, false); assert.equal(snapshot.context.attachments.page, null);
  assert.equal(await source.getByRole('textbox', { name: '网页输入框' }).inputValue(), '保留原输入');
  pass('a real mouse click opens the tab-specific native side panel without enabling references or editing page input');
  await launcher.click();
  await eventually(async () => assert.equal(await worker.evaluate(() => launcherClosed.at(-1)?.tabId), tab.id));
  const reopenCount = await worker.evaluate(() => launcherOpened.length);
  await launcher.click();
  await eventually(async () => assert.ok(await worker.evaluate(() => launcherOpened.length) > reopenCount));
  await source.reload(); await launcher.waitFor();
  const reloadCloseCount = await worker.evaluate(() => launcherClosed.length);
  await launcher.click();
  await eventually(async () => assert.ok(await worker.evaluate(() => launcherClosed.length) > reloadCloseCount));
  pass('second click closes, third click reopens, and reloading an open source page still allows the next click to close');

  const cdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const target = targetInfos.find(info => info.url === sourceURL); assert.ok(target);
  await source.bringToFront();
  const toolbarOpenCount = await worker.evaluate(() => launcherOpened.length);
  await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
  await eventually(async () => assert.ok(await worker.evaluate(() => launcherOpened.length) > toolbarOpenCount));
  const toolbarCloseCount = await worker.evaluate(() => launcherClosed.length);
  await launcher.click();
  await eventually(async () => assert.ok(await worker.evaluate(() => launcherClosed.length) > toolbarCloseCount));
  await launcher.click();
  const externalCloseCount = await worker.evaluate(() => launcherClosed.length);
  await worker.evaluate(tabId => chrome.sidePanel.close({ tabId }), tab.id);
  await eventually(async () => assert.ok(await worker.evaluate(() => launcherClosed.length) > externalCloseCount));
  const afterExternalClose = await worker.evaluate(() => launcherOpened.length);
  await launcher.click();
  await eventually(async () => assert.ok(await worker.evaluate(() => launcherOpened.length) > afterExternalClose));
  const finalCloseCount = await worker.evaluate(() => launcherClosed.length);
  await launcher.click();
  await eventually(async () => assert.ok(await worker.evaluate(() => launcherClosed.length) > finalCloseCount));
  pass('toolbar opening and external native closing synchronize with the floating toggle');
  await source.bringToFront();
  const openCount = await worker.evaluate(() => launcherOpened.length);
  const closeCount = await worker.evaluate(() => launcherClosed.length);
  const box = await launcher.boundingBox();
  await source.mouse.move(box.x + 20, box.y + 20); await source.mouse.down(); await source.mouse.move(28, 178, { steps: 12 }); await source.mouse.up();
  await eventually(async () => assert.equal(await launcher.evaluate(node => node.dataset.side), 'left'));
  assert.equal(await launcher.evaluate(node => node.style.left), '8px');
  assert.equal(await worker.evaluate(() => launcherOpened.length), openCount);
  assert.equal(await worker.evaluate(() => launcherClosed.length), closeCount);
  const saved = await panel.evaluate(async () => (await chrome.storage.local.get('sider.launcher.v1'))['sider.launcher.v1']);
  assert.equal(saved.side, 'left'); assert.ok(saved.y > 0 && saved.y < 1);
  await source.reload(); await launcher.waitFor(); assert.equal(await launcher.evaluate(node => node.style.left), '8px');
  await source.setViewportSize({ width: 320, height: 280 });
  const small = await launcher.boundingBox(); assert.ok(small.x >= 0 && small.x + small.width <= 320 && small.y + small.height <= 280);
  await source.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await source.screenshot({ path: 'tmp/browser/launcher-small-dark.png' });
  pass('drag snaps left without opening; position survives reload and stays visible after resizing');
  await panel.bringToFront(); await panel.setViewportSize({ width: 320, height: 640 });
  await panel.locator('#ai-settings-toggle').click(); await panel.locator('#launcher-settings > summary').click();
  await panel.locator('#launcher-floating').uncheck(); await launcher.waitFor({ state: 'detached' });
  await eventually(async () => assert.equal(await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['sider-floating-launcher'] })).length), 0));
  await panel.locator('#launcher-floating').check(); await launcher.waitFor();
  assert.equal(await launcher.evaluate(node => node.dataset.side), 'left');
  assert.equal(await panel.locator('#ai-settings-dialog').evaluate(node => node.scrollWidth > node.clientWidth), false);
  await panel.screenshot({ path: 'tmp/browser/launcher-settings-320.png' });
  pass('settings remove the launcher immediately, unregister future injection, and restore it on existing authorized tabs');
  const backup = (await request({ type: 'SIDER_CONFIGURATION_EXPORT' })).backup;
  assert.deepEqual(backup.configuration.launcher, saved);
  pass('configuration exports launcher preferences and the panel has no page errors');

  // CDP exposes the closed shadow tree for test inspection; interactions remain real mouse clicks.
  const pageCDP = await context.newCDPSession(source);
  async function shadowNode(selector) {
    const { root } = await pageCDP.send('DOM.getDocument', { depth: -1, pierce: true });
    function find(node) {
      if (node.attributes?.includes('sider-floating-launcher')) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const found = find(child); if (found) return found; }
    }
    const host = find(root); assert.ok(host?.shadowRoots?.[0]);
    const { nodeId } = await pageCDP.send('DOM.querySelector', { nodeId: host.shadowRoots[0].nodeId, selector });
    assert.ok(nodeId, selector); return nodeId;
  }
  async function shadowClick(selector) {
    const nodeId = await shadowNode(selector);
    await pageCDP.send('DOM.scrollIntoViewIfNeeded', { nodeId });
    const { model } = await pageCDP.send('DOM.getBoxModel', { nodeId });
    const [x1, y1, x2, , , y3] = model.border;
    await source.mouse.click((x1 + x2) / 2, (y1 + y3) / 2);
  }
  async function choiceOpen() {
    const { object } = await pageCDP.send('DOM.resolveNode', { nodeId: await shadowNode('dialog') });
    const { result } = await pageCDP.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){return this.open}', returnByValue: true });
    return result.value;
  }
  await source.bringToFront(); await shadowClick('.dismiss-button');
  assert.equal(await choiceOpen(), true);
  const { model: choiceBox } = await pageCDP.send('DOM.getBoxModel', { nodeId: await shadowNode('dialog') });
  assert.ok(choiceBox.border.every((value, i) => value >= 0 && value <= (i % 2 ? 280 : 320)));
  const { object: compactDialog } = await pageCDP.send('DOM.resolveNode', { nodeId: await shadowNode('dialog') });
  const { result: compactSize } = await pageCDP.send('Runtime.callFunctionOn', { objectId: compactDialog.objectId, functionDeclaration: 'function(){return {scroll:this.scrollHeight,client:this.clientHeight}}', returnByValue: true });
  assert.ok(compactSize.value.scroll <= compactSize.value.client);
  await source.screenshot({ path: 'tmp/browser/launcher-close-320-dark.png' });
  await source.keyboard.press('Escape'); assert.equal(await choiceOpen(), false);
  await source.setViewportSize({ width: 820, height: 640 }); await source.emulateMedia({ colorScheme: 'light' });
  await shadowClick('.dismiss-button'); await source.screenshot({ path: 'tmp/browser/launcher-close-choices.png' });
  await shadowClick('[data-scope=once]'); await launcher.waitFor({ state: 'detached' });
  await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, files: ['launcher-content.js'] }), tab.id);
  assert.equal(await launcher.count(), 0);
  await source.reload(); await launcher.waitFor();
  pass('close choice fits a small dark viewport, Escape cancels, and temporary close survives reinjection until refresh');

  const sibling = await context.newPage(); await sibling.goto(sourceURL + '?second');
  const siblingLauncher = sibling.locator('#sider-floating-launcher'); await siblingLauncher.waitFor();
  await source.bringToFront(); await shadowClick('.dismiss-button'); await shadowClick('[data-scope=global]');
  await launcher.waitFor({ state: 'detached' }); await siblingLauncher.waitFor({ state: 'detached' });
  await eventually(async () => assert.equal(await panel.locator('#launcher-floating').isChecked(), false));
  await panel.locator('#launcher-floating').check(); await launcher.waitFor(); await siblingLauncher.waitFor();
  pass('global close hides other open pages and the settings switch restores existing tabs');

  await source.bringToFront(); await shadowClick('.dismiss-button'); await shadowClick('[data-scope=site]');
  await launcher.waitFor({ state: 'detached' }); await siblingLauncher.waitFor({ state: 'detached' });
  await source.reload(); assert.equal(await launcher.count(), 0);
  await eventually(async () => assert.match(await panel.locator('#launcher-add-current').textContent(), /已在黑名单/));
  await panel.locator('.launcher-list-editor > summary').click();
  await panel.getByRole('button', { name: '从黑名单移除 127.0.0.1', exact: true }).click();
  await launcher.waitFor(); await siblingLauncher.waitFor();
  pass('site close persists across refresh and other pages of the same host; removing the blacklist rule restores them');

  await panel.locator('#launcher-mode').selectOption('whitelist');
  await launcher.waitFor({ state: 'detached' }); await siblingLauncher.waitFor({ state: 'detached' });
  await panel.locator('#launcher-add-current').click(); await launcher.waitFor(); await siblingLauncher.waitFor();
  await source.bringToFront(); await shadowClick('.dismiss-button'); await shadowClick('[data-scope=site]');
  await launcher.waitFor({ state: 'detached' }); await siblingLauncher.waitFor({ state: 'detached' });
  await eventually(async () => assert.deepEqual(await panel.evaluate(async () => (await chrome.storage.local.get('sider.launcher.v1'))['sider.launcher.v1'].whitelist), []));
  await panel.locator('#launcher-add-current').click(); await launcher.waitFor();
  await panel.locator('#launcher-mode').selectOption('blacklist'); await launcher.waitFor();
  await panel.locator('#launcher-add-current').click(); await launcher.waitFor({ state: 'detached' });
  await panel.locator('#launcher-mode').selectOption('whitelist'); await launcher.waitFor();
  const ruleBackup = (await request({ type: 'SIDER_CONFIGURATION_EXPORT' })).backup;
  assert.deepEqual(ruleBackup.configuration.launcher.blacklist, ['127.0.0.1']);
  assert.deepEqual(ruleBackup.configuration.launcher.whitelist, ['127.0.0.1']);
  assert.equal(ruleBackup.configuration.launcher.mode, 'whitelist');
  await panel.setViewportSize({ width: 320, height: 840 });
  assert.equal(await panel.locator('#ai-settings-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await panel.screenshot({ path: 'tmp/browser/launcher-list-settings-320.png' });
  pass('whitelist quick-add restores the current site, site close removes it, mode switches retain both lists, and backups include rules');
  assert.deepEqual(errors, []);
  await writeFile('tmp/browser/launcher-result.json', JSON.stringify({ browser: context.browser().version(), fixtureOnly: true, checks, errors }, null, 2));
} finally {
  await context?.close(); await new Promise(resolve => tls.close(resolve)); await new Promise(resolve => server.close(resolve));
}

async function eventually(check, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) { try { await check(); return; } catch (error) { if (Date.now() >= until) throw error; } await new Promise(resolve => setTimeout(resolve, 60)); }
}
