import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { newTemplate } from '../../src/prompt-templates.js';

import { chromium } from './browser.js';
const fixture = `<!doctype html><html lang="zh-CN"><head><title>ChatGPT native attachment fixture</title><style>html,body{margin:0;background:white;color:#222;font:14px system-ui}header{padding:12px 16px;border-bottom:1px solid #ddd}main{padding:14px;min-height:650px;display:flex;flex-direction:column;justify-content:center}.shell{border:1px solid #ddd;border-radius:18px;padding:12px;transform:translateZ(0);overflow:hidden}form{margin:0}textarea{display:block;width:100%;box-sizing:border-box;min-height:70px;resize:none;border:0;font:inherit}button{font:inherit}.native-controls{display:flex;justify-content:flex-end;margin-top:8px}[data-composer-attachments]{display:flex;flex-wrap:wrap;gap:6px}.card{padding:5px;border:1px solid #ddd;border-radius:8px;max-width:100%;overflow-wrap:anywhere}#result{font-size:11px;overflow-wrap:anywhere}</style></head><body><header>ChatGPT local upload fixture</header><main><div class="shell"><form><div data-composer-body><textarea id="prompt-textarea" aria-label="Ask ChatGPT"></textarea></div><div data-composer-attachments></div><input type="file" aria-label="Attach files" accept="text/plain,.txt" multiple hidden><div class="native-controls"><button type="submit" data-testid="send-button" aria-label="Send prompt">发送</button></div></form></div><p id="result"></p></main><script>
window.sent=[];window.uploads=[];window.removed=[];window.formEvents=[];window.holdUploads=false;window.failNext=false;window.releaseWaiters=[];
const form=document.querySelector('form'),editor=document.querySelector('#prompt-textarea'),area=document.querySelector('[data-composer-attachments]'),input=document.querySelector('input[type=file]');
window.releaseUploads=()=>{window.holdUploads=false;for(const release of window.releaseWaiters.splice(0))release()};
input.addEventListener('change',()=>{for(const file of Array.from(input.files)){
 const record={name:file.name,content:null,ready:false,failed:false,removed:false};window.uploads.push(record);
 const card=document.createElement('div');card.className='group/composer-attachment card';card.dataset.name=file.name;card.record=record;
 const progress=document.createElement('span');progress.setAttribute('role','progressbar');progress.setAttribute('aria-label','Uploading '+file.name);progress.textContent='Uploading '+file.name;
 const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove '+file.name);remove.textContent='×';remove.addEventListener('click',()=>{record.removed=true;window.removed.push(file.name);card.remove()});card.append(progress,remove);area.append(card);
 const shouldFail=window.failNext;window.failNext=false;
 void(async()=>{record.content=await file.text();if(window.holdUploads)await new Promise(resolve=>window.releaseWaiters.push(resolve));else await new Promise(resolve=>setTimeout(resolve,200));if(!card.isConnected)return;progress.remove();if(shouldFail){record.failed=true;const alert=document.createElement('span');alert.setAttribute('role','alert');alert.textContent='Upload failed';card.append(alert)}else{record.ready=true;const preview=document.createElement('button');preview.type='button';preview.setAttribute('aria-label',file.name);preview.textContent=file.name;card.prepend(preview)}})();
 }});
function manageComposerFocus(event){if(event.target===editor||event.target.closest('button,input'))return;window.formEvents.push({type:event.type,target:event.target.id});event.preventDefault();editor.focus()}
for(const type of ['pointerdown','mousedown','click','keydown','wheel'])form.addEventListener(type,manageComposerFocus);
form.addEventListener('submit',event=>{event.preventDefault();window.sent.push({text:editor.value,files:Array.from(area.children).map(card=>({name:card.record.name,content:card.record.content,ready:card.record.ready})),pending:area.querySelectorAll('[role=progressbar]').length});document.querySelector('#result').textContent='Native fixture sends: '+window.sent.length});
editor.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();form.requestSubmit(document.querySelector('[data-testid=send-button]'))}});
</script></body></html>`;
const marker = 'END-MARKER-FULL-ARTICLE-20261001';
const largeBody = '正文包含关键事实和例子，必须完整读取才能完成分析。'.repeat(2800);
const tls = createHttpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'none'; script-src 'unsafe-inline'", 'x-frame-options': 'DENY' }); res.end(fixture);
});
const article = createHttpServer((req, res) => {
  const other = req.url.startsWith('/other');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="zh-CN"><title>Sider ${other ? '第二页' : '附件测试网页'}</title><main><article><h1>长正文测试 ${other ? 'B' : 'A'}</h1><p>${largeBody}${marker}${other ? '-B' : '-A'}</p></article></main></html>`);
});
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => article.listen(0, '127.0.0.1', resolve));
let context, panel, worker, sourceTabId;
const checks = [], consoleErrors = [], results = { fixture: true, genuineInteraction: true };
function checked(message) { checks.push(message); console.log('PASS ' + message); }
try {
  const extension = path.resolve('dist');
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  results.version = manifest.version;
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.ok((await readFile(path.join(extension, 'chatgpt-content.js'), 'utf8')).includes('data-composer-attachments'), 'Built extension must include current attachment adapter');
  context = await chromium.launchPersistentContext(path.resolve(`tmp/browser/fresh-send-profile-${Date.now()}`), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, ignoreHTTPSErrors: true,
    viewport: { width: 420, height: 840 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${tls.address().port}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.clear()); await worker.evaluate(() => chrome.storage.session.clear());
  const extensionId = new URL(worker.url()).hostname;
  await worker.evaluate(() => {
    const nativeSend = chrome.tabs.sendMessage.bind(chrome.tabs);
    globalThis.freshGate = { held: false, reached: false, count: 0, release: null, synchronizations: 0, measuredBridge: null };
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === 'SIDER_ENHANCEMENT_REQUEST' && message.bridgeId === freshGate.measuredBridge && message.request?.type === 'SIDER_TAB_CONTEXT_GET') freshGate.synchronizations++;
    });
    chrome.tabs.sendMessage = async (...args) => {
      if (args[1]?.type === 'SIDER_PAGE_CAPTURE') {
        freshGate.count++;
        if (freshGate.held) { freshGate.reached = true; await new Promise(resolve => { freshGate.release = resolve; }); }
      }
      return nativeSend(...args);
    };
  });
  const browserCDP = await context.browser().newBrowserCDPSession();
  const source = await context.newPage();
  const sourceURL = `http://127.0.0.1:${article.address().port}/article`;
  await source.goto(sourceURL); await source.bringToFront();
  assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].url), sourceURL);
  assert.equal(await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })), false);
  const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const target = targetInfos.find(info => info.url === sourceURL); assert.ok(target);
  await browserCDP.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  const sourceTab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]); sourceTabId = sourceTab.id;
  assert.equal(sourceTab.url, sourceURL);
  panel = await context.newPage();
  panel.on('console', event => { if (event.type() === 'error') consoleErrors.push(event.text()); }); panel.on('pageerror', error => consoleErrors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/panel.html?sourceTab=${sourceTab.id}`);
  const chat = panel.frameLocator('iframe'); await chat.locator('#sider-enhancement').waitFor({ timeout: 15000 });
  const editor = chat.getByRole('textbox', { name: 'Ask ChatGPT', exact: true });
  const send = chat.getByRole('button', { name: 'Send prompt', exact: true });
  const body = chat.locator('body'), cards = chat.locator('[data-composer-attachments] [class~="group/composer-attachment"]');
  const readFixture = () => body.evaluate(() => ({ sent: window.sent, uploads: window.uploads, removed: window.removed, formEvents: window.formEvents }));
  const state = () => worker.evaluate(async tabId => (await chrome.storage.session.get(`sider.tabContext.${tabId}`))[`sider.tabContext.${tabId}`], sourceTab.id);
  const ownedUploads = fixture => fixture.uploads.filter(upload => upload.name.includes('-预设') && /sider-[0-9a-f]{16}\.txt$/.test(upload.name));
  async function enableBody() {
    if ((await state())?.templateSelections?.['preset-page']) {
      await assertEventually(async () => assert.ok((await state()).attachments.page)); return;
    }
    await chat.locator('[data-chip="page"]').waitFor({ state: 'hidden' });
    if (await chat.locator('.popover').isVisible()) await chat.getByRole('button', { name: '关闭', exact: true }).click();
    await chat.getByRole('button', { name: '预设', exact: true }).click(); await chat.getByRole('checkbox', { name: '发送时引用 网页正文', exact: true }).setChecked(true);
    await chat.locator('[data-chip="page"]').waitFor();
    await assertEventually(async () => assert.ok((await state()).attachments.page));
    if (await chat.locator('.popover').isVisible()) await chat.getByRole('button', { name: '关闭', exact: true }).click();
  }
  const hold = () => body.evaluate(() => { window.holdUploads = true; });
  const release = () => body.evaluate(() => window.releaseUploads());
  await enableBody();
  const snapshot = await state();
  assert.ok(snapshot.attachments.page.content.length > 48000); assert.ok(snapshot.attachments.page.content.includes(marker + '-A'));
  assert.equal(await chat.locator('[data-chip="page"] .excerpt').innerText(), '网页正文 · 附件');
  assert.equal(await editor.inputValue(), '');
  checked('production manifest + trusted toolbar grant + actual long-page extraction retains >48k body/end_marker; composer remains a plain question');

  await chat.locator('input[type=file][aria-label="Attach files"]').setInputFiles({ name: 'user-note.txt', mimeType: 'text/plain', buffer: Buffer.from('user provided attachment') });
  await chat.getByRole('button', { name: 'user-note.txt', exact: true }).waitFor();
  await source.evaluate(() => document.querySelector('article p').append(' FRESH-AT-FIRST-SEND'));
  await worker.evaluate(() => { freshGate.count = 0; freshGate.held = true; });
  await hold(); await editor.fill('请结合网页正文和用户附件总结'); await editor.press('Enter');
  await assertEventually(async () => assert.equal(await worker.evaluate(() => freshGate.reached), true));
  assert.equal((await readFixture()).sent.length, 0);
  assert.equal(ownedUploads(await readFixture()).length, 0);
  assert.equal(await editor.inputValue(), '请结合网页正文和用户附件总结');
  await editor.press('Enter'); await send.click();
  assert.equal(await worker.evaluate(() => freshGate.count), 1);
  await worker.evaluate(() => { freshGate.held = false; freshGate.release(); });
  checked('trusted send waits for delayed source extraction; repeated Enter and Send do not start another extraction or send');
  await assertEventually(async () => assert.equal(ownedUploads(await readFixture()).length, 1));
  await chat.getByRole('progressbar').waitFor();
  assert.equal((await readFixture()).sent.length, 0); assert.equal(await editor.inputValue(), '请结合网页正文和用户附件总结');
  await source.evaluate(() => document.querySelector('article p').append(' ADDED-DURING-UPLOAD'));
  await panel.waitForTimeout(1300);
  assert.equal(await worker.evaluate(() => freshGate.count), 1);
  await send.click(); assert.equal((await readFixture()).sent.length, 0);
  await release(); await assertEventually(async () => assert.equal((await readFixture()).sent.length, 1));
  let saved = await readFixture();
  assert.equal(saved.sent[0].pending, 0); assert.equal(saved.sent[0].files.length, 2);
  assert.ok(saved.sent[0].files.every(file => file.ready));
  const autoFile = ownedUploads({ uploads: saved.sent[0].files })[0];
  assert.ok(autoFile.content.length > 48000); assert.ok(autoFile.content.includes(marker + '-A'));
  assert.ok(autoFile.content.includes(`来源 URL：${sourceURL}`)); assert.ok(autoFile.content.includes('采集时间：'));
  assert.ok(autoFile.content.includes('FRESH-AT-FIRST-SEND'));
  assert.equal(autoFile.content.includes('ADDED-DURING-UPLOAD'), false);
  assert.equal(await worker.evaluate(() => freshGate.count), 1);
  assert.equal(saved.sent[0].text.includes(marker), false); assert.ok(saved.sent[0].text.includes(autoFile.name));
  checked('trusted Enter waits for native upload readiness, preserves user attachment, sends only short file note with full source metadata/body in file');

  await source.evaluate(() => document.querySelector('article p').append(' FRESH-AT-SECOND-SEND'));
  await assertEventually(async () => assert.equal((await state()).templateSelections['preset-page'], false));
  await enableBody();
  const secondCaptureStart = await worker.evaluate(() => freshGate.count);
  await send.click(); await assertEventually(async () => assert.equal((await readFixture()).sent.length, 2));
  saved = await readFixture();
  assert.equal(ownedUploads(saved).length, 2);
  const secondFile = ownedUploads({ uploads: saved.sent[1].files })[0];
  assert.ok(secondFile.content.includes('ADDED-DURING-UPLOAD'));
  assert.ok(secondFile.content.includes('FRESH-AT-SECOND-SEND'));
  assert.ok(saved.sent[1].text.includes(secondFile.name));
  assert.equal(saved.sent[1].text.includes(autoFile.name), false);
  assert.equal(saved.sent[1].text.split('请结合网页正文和用户附件总结').length, 2);
  assert.equal(await worker.evaluate(() => freshGate.count) - secondCaptureStart, 1);
  assert.equal(await chat.getByRole('button', { name: 'user-note.txt', exact: true }).count(), 1);
  checked('next trusted Send captures new page content and replaces only the owned file without duplicating the question');

  const sourceMarkup = await source.locator('article').innerHTML();
  await enableBody();
  await source.locator('article').evaluate(element => { element.innerHTML = ''; });
  await editor.fill('新正文提取失败必须保留这个问题'); await send.click();
  await chat.locator('.status.error').waitFor();
  assert.equal((await readFixture()).sent.length, 2);
  assert.equal(await editor.inputValue(), '新正文提取失败必须保留这个问题');
  assert.equal((await state()).attachments.page, null);
  await assertEventually(async () => assert.equal(await cards.count(), 1));
  assert.equal(await chat.getByRole('button', { name: 'user-note.txt', exact: true }).count(), 1);
  await source.locator('article').evaluate((element, html) => { element.innerHTML = html; }, sourceMarkup);
  checked('fresh extraction failure blocks partial send, clears the old owned file and preserves the question/user file');

  await chat.getByRole('button', { name: '取消正文引用', exact: true }).click();
  await assertEventually(async () => assert.equal((await state()).pageRequested, false));
  await chat.locator('[data-chip="page"]').waitFor({ state: 'hidden' });
  await assertEventually(async () => assert.equal(await cards.count(), 1));
  assert.equal(await chat.getByRole('button', { name: 'user-note.txt', exact: true }).count(), 1);
  assert.equal((await state()).attachments.page, null);
  checked('cancel body chip removes only extension-owned native card and preserves the user file');

  await enableBody(); await body.evaluate(() => { window.failNext = true; }); await editor.fill('上传失败时保留这个问题'); await send.click();
  await chat.locator('.status.error').filter({ hasText: '正文附件上传失败' }).waitFor();
  assert.equal((await readFixture()).sent.length, 2); assert.equal(await editor.inputValue(), '上传失败时保留这个问题');
  assert.ok((await state()).attachments.page); assert.equal(await cards.count(), 1);
  checked('native upload failure blocks partial send, restores plain question and keeps body reference for retry');

  await hold(); await editor.fill('等待上传时会编辑的问题'); await send.click(); await chat.getByRole('progressbar').waitFor();
  await editor.fill('用户编辑后的问题必须保留'); await release();
  await assertEventually(async () => assert.equal(await cards.count(), 1));
  await chat.locator('.status.error').waitFor();
  assert.equal((await readFixture()).sent.length, 2); assert.equal(await editor.inputValue(), '用户编辑后的问题必须保留');
  assert.ok((await state()).attachments.page);
  checked('editing the native question during upload aborts delivery and cleans owned card without overwriting the new question');

  await hold(); await editor.fill('引用变化时不得发送旧网页'); await send.click(); await chat.getByRole('progressbar').waitFor();
  await source.goto(`http://127.0.0.1:${article.address().port}/other`); await release(); await panel.bringToFront();
  await assertEventually(async () => assert.equal((await state()).attachments.page, null));
  await assertEventually(async () => assert.equal(await cards.count(), 1));
  assert.equal((await readFixture()).sent.length, 2); assert.equal(await editor.inputValue(), '引用变化时不得发送旧网页');
  await assertEventually(async () => assert.equal(await chat.locator('[data-chip="page"]').count(), 0));
  checked('bound-source navigation changes context, aborts pending upload and prevents sending stale page material');

  await enableBody();
  async function settingsMode(mode, threshold) {
    await chat.getByRole('button', { name: '预设', exact: true }).click();
    await chat.getByRole('button', { name: '编辑预设 网页正文', exact: true }).click();
    await chat.locator('summary').filter({ hasText: '高级' }).click();
    const popup = chat.locator('.popover'), field = chat.locator('#template-delivery');
    await reveal(field, popup); await field.click();
    assert.equal(await field.evaluate(element => element.getRootNode().activeElement === element), true);
    await field.press('Home');
    for (let index = 0; index < ['text', 'auto', 'file'].indexOf(mode); index++) await field.press('ArrowDown');
    await field.press('Enter'); assert.equal(await field.inputValue(), mode);
    const limit = chat.locator('#template-threshold');
    assert.equal(await limit.isDisabled(), mode !== 'auto');
    if (threshold !== undefined) {
      await reveal(limit, popup); await limit.click(); await limit.press('ControlOrMeta+A'); await limit.pressSequentially(String(threshold));
      const format = chat.locator('#template-attachment-text'); await reveal(format, popup); await format.click();
      await format.press('ControlOrMeta+A'); await format.pressSequentially('读取 {{filename}} 并回答问题', { delay: 1 });
      await assertEventually(async () => assert.equal(await format.evaluate(element => element.getRootNode().activeElement === element), true));
      assert.equal(await format.inputValue(), '读取 {{filename}} 并回答问题');
    }
    const save = chat.getByRole('button', { name: '保存预设', exact: true }); await reveal(save, popup); await save.click();
    await assertEventually(async () => assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('sider.templates.v3'))['sider.templates.v3'])).find(item => item.preset === 'page').delivery, mode));
    await chat.getByRole('button', { name: '编辑预设 网页正文', exact: true }).waitFor();
    await chat.getByRole('button', { name: '关闭', exact: true }).click();
    await popup.waitFor({ state: 'hidden' });
  }
  async function reveal(field, popup) {
    for (let index = 0; index < 14; index++) {
      const [box, outer] = await Promise.all([field.boundingBox(), popup.boundingBox()]); assert.ok(box && outer);
      if (box.y >= outer.y + 22 && box.y + box.height <= outer.y + outer.height - 8) return;
      await panel.mouse.move(outer.x + outer.width - 9, outer.y + Math.min(95, outer.height / 2));
      await panel.mouse.wheel(0, box.y < outer.y + 22 ? -220 : 220);
      await panel.waitForTimeout(80);
    }
    throw new Error('Could not reveal settings field');
  }
  await settingsMode('text');
  assert.equal(await chat.locator('[data-chip="page"] .excerpt').innerText(), '网页正文');
  const uploadCount = ownedUploads(await readFixture()).length;
  await editor.fill('直接发送完整正文'); await send.click(); await assertEventually(async () => assert.equal((await readFixture()).sent.length, 3));
  saved = await readFixture(); assert.equal(ownedUploads(saved).length, uploadCount);
  assert.ok(saved.sent[2].text.length > 48000); assert.ok(saved.sent[2].text.includes(marker + '-B'));
  checked('settings switch to manual text keeps focus and sends full >48k body/end_marker without an attachment or send budget');

  await panel.setViewportSize({ width: 320, height: 840 });
  await settingsMode('auto', 1000); await settingsMode('file');
  await enableBody();
  assert.equal(await chat.locator('[data-chip="page"] .excerpt').innerText(), '网页正文 · 附件');
  await editor.fill('手动附件模式发送'); await editor.press('Enter'); await assertEventually(async () => assert.equal((await readFixture()).sent.length, 4));
  saved = await readFixture();
  const manualFile = ownedUploads({ uploads: saved.sent[3].files })[0];
  assert.ok(manualFile);
  assert.ok(saved.sent[3].text.includes(`读取 ${manualFile.name} 并回答问题`));
  assert.equal(saved.sent[3].text.includes(marker), false);
  assert.ok(manualFile.content.includes(marker + '-B'));
  assert.deepEqual(saved.formEvents, [], 'Extension settings interactions must not enter native composer focus handlers');
  checked('320px genuine mode/threshold/file-note edits stay focused, persist settings, and manual file mode sends the customized short note');

  await enableBody(); await editor.fill('手动移除前的问题');
  await chat.getByRole('button', { name: '预设', exact: true }).click();
  await chat.locator('#pane-body [data-template-id="preset-page"]').click();
  await chat.locator('.status').filter({ hasText: '已追加' }).waitFor();
  const filledFile = ownedUploads(await readFixture()).at(-1);
  await chat.getByRole('button', { name: `Remove ${filledFile.name}`, exact: true }).click();
  await chat.locator('.status').filter({ hasText: '附件已移除' }).waitFor();
  assert.equal(await cards.count(), 1); assert.equal(await chat.locator('[data-chip="page"]').count(), 1);
  assert.ok((await editor.inputValue()).includes('手动移除前的问题'));
  const sendsBeforeRemoval = (await readFixture()).sent.length; await editor.press('Enter');
  await chat.locator('.status').filter({ hasText: '对应标签' }).waitFor(); assert.equal((await readFixture()).sent.length, sendsBeforeRemoval);
  await chat.getByRole('button', { name: '取消正文引用', exact: true }).click();
  await assertEventually(async () => assert.equal((await state()).templateSelections['preset-page'], false));
  await chat.locator('[data-chip="page"]').waitFor({ state: 'hidden' });
  checked('native Remove marks a missing template file, blocks sending its stale note and preserves the user attachment');

  await enableBody();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const displayed = (await state()).attachments.page.content;
  const measuredBridge = new URL(await panel.locator('iframe').getAttribute('src')).searchParams.get('sider_bridge');
  await worker.evaluate(bridge => { freshGate.measuredBridge = bridge; freshGate.synchronizations = 0; }, measuredBridge);
  const countBeforePreview = await worker.evaluate(() => freshGate.count);
  await chat.getByRole('button', { name: '查看网页正文', exact: true }).click();
  await chat.getByRole('button', { name: '查看正文快照', exact: true }).click();
  assert.equal(await chat.locator('.page-body').textContent(), displayed);
  await chat.getByRole('button', { name: '复制正文', exact: true }).click();
  await chat.locator('.status').filter({ hasText: '正文已复制' }).waitFor();
  // Windows clipboard text uses CRLF; the copied characters and lines are intact.
  assert.equal((await panel.evaluate(() => navigator.clipboard.readText())).replace(/\r\n?/g, '\n'), displayed);
  const bodyDownload = panel.waitForEvent('download'); await chat.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const markdown = await bodyDownload; assert.ok(markdown.suggestedFilename().endsWith('.md'));
  assert.equal(await readFile(await markdown.path(), 'utf8'), displayed);
  await source.evaluate(() => {
    document.querySelector('article p').append(' MANUAL-PREVIEW-REFRESH');
    window.sourceChanges = setInterval(() => document.querySelector('article p').append(' 持续变化'), 40);
  });
  await panel.waitForTimeout(2200); assert.equal(await worker.evaluate(() => freshGate.count), countBeforePreview);
  await source.evaluate(() => clearInterval(window.sourceChanges));
  const idleRequests = await worker.evaluate(() => freshGate.synchronizations);
  const responseSize = await panel.evaluate(async tabId => {
    const response = await chrome.runtime.sendMessage({ type: 'SIDER_TAB_CONTEXT_GET', tabId });
    const small = await chrome.runtime.sendMessage({ type: 'SIDER_TAB_CONTEXT_GET', tabId, knownContext: { tabId, revision: response.context.revision } });
    return { fullBytes: new TextEncoder().encode(JSON.stringify(response)).length, unchangedBytes: new TextEncoder().encode(JSON.stringify(small)).length, fullBodyReturned: Boolean(small.context?.attachments.page) };
  }, sourceTab.id);
  results.idle = { durationMs: 2200, synchronizationRequests: idleRequests, bodyCaptures: 0, ...responseSize };
  assert.ok(idleRequests >= 1);
  assert.equal(responseSize.fullBodyReturned, false); assert.ok(responseSize.unchangedBytes < responseSize.fullBytes / 100);
  console.log('Idle measurement ' + JSON.stringify(results.idle));
  assert.equal(await chat.locator('.page-body').textContent(), displayed);
  await chat.getByRole('button', { name: '刷新正文', exact: true }).click();
  await assertEventually(async () => assert.ok((await chat.locator('.page-body').textContent()).includes('MANUAL-PREVIEW-REFRESH')));
  assert.equal(await worker.evaluate(() => freshGate.count), countBeforePreview + 1);
  await panel.screenshot({ path: 'tmp/browser/page-preview-320.png' });
  assert.equal(await chat.locator('.popover').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
  await editor.press('Escape'); checked('cached preview, real clipboard, UTF-8 Markdown download, explicit single refresh and 320px layout preserve complete identical text');

  const currentPage = (await state()).attachments.page.content;
  const promptTemplates = [
    newTemplate({ id: 'template-manual-1234', name: '网址预设', text: '读 {{url.host}} {{title}}' }),
    newTemplate({ id: 'template-full-1234', name: '全文直发', text: '总结\n{{page.content}}', action: 'send' }),
    newTemplate({ id: 'template-missing-1234', name: '缺失作者', text: '{{page.author}}', action: 'send' }),
  ];
  await worker.evaluate(async templates => { const previous = (await chrome.storage.local.get('sider.templates.v3'))['sider.templates.v3']; await chrome.storage.local.set({ 'sider.templates.v3': [...previous, ...templates] }); }, promptTemplates);
  await editor.fill('前缀旧词后缀'); await editor.focus();
  await editor.evaluate(node => node.setSelectionRange(2, 4));
  await chat.getByRole('button', { name: '预设', exact: true }).click();
  await chat.locator('[data-template-id="template-manual-1234"]').click();
  await assertEventually(async () => assert.ok((await editor.inputValue()).startsWith('前缀旧词后缀\n\n读 127.0.0.1')));
  assert.equal((await readFixture()).sent.length, 4);
  checked('fill templates preserve the full native draft and append at the configured position without sending');

  await editor.fill('已有问题\n'); await editor.focus(); await editor.evaluate(node => node.setSelectionRange(node.value.length, node.value.length));
  const captures = await worker.evaluate(() => freshGate.count); const uploadsBeforeTemplate = ownedUploads(await readFixture()).length;
  await chat.getByRole('button', { name: '预设', exact: true }).click(); await chat.locator('[data-template-id="template-full-1234"]').click();
  await assertEventually(async () => assert.equal((await readFixture()).sent.length, 5));
  const direct = (await readFixture()).sent.at(-1);
  assert.ok(direct.text.startsWith('已有问题')); assert.ok(direct.text.includes('总结\n' + currentPage)); assert.equal(direct.files.length, 2);
  assert.equal(ownedUploads(await readFixture()).length, uploadsBeforeTemplate + 1);
  assert.equal(await worker.evaluate(() => freshGate.count), captures + 1); await assertEventually(async () => assert.equal((await state()).pageRequested, false));
  checked('distinct body templates share one fresh capture and remain independent; direct send happens once with its inline text and the preset file');

  await editor.fill('作者缺失时保留草稿'); await editor.focus();
  await chat.getByRole('button', { name: '预设', exact: true }).click(); await chat.locator('[data-template-id="template-missing-1234"]').click();
  await chat.locator('.status').filter({ hasText: 'page.author' }).waitFor(); assert.equal((await readFixture()).sent.length, 5);
  assert.equal(await editor.inputValue(), '作者缺失时保留草稿'); checked('missing variables block direct send before changing the existing draft');
  await editor.press('Escape');

  const message = value => panel.evaluate(value => chrome.runtime.sendMessage(value), value);
  const exported = (await message({ type: 'SIDER_CONFIGURATION_EXPORT' })).backup;
  await panel.getByRole('button', { name: 'AI 网站设置', exact: true }).click();
  await panel.locator('#configuration-open').click();
  const configDownload = panel.waitForEvent('download'); await panel.locator('#configuration-export').click();
  const savedConfig = JSON.parse(await readFile(await (await configDownload).path(), 'utf8'));
  assert.deepEqual(savedConfig.configuration, exported.configuration);
  await panel.locator('#configuration-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await panel.locator('#configuration-status').filter({ hasText: '无法解析' }).waitFor(); assert.equal(await panel.locator('#configuration-apply').isEnabled(), false);
  assert.deepEqual((await message({ type: 'SIDER_CONFIGURATION_EXPORT' })).backup.configuration, exported.configuration);
  const replacement = structuredClone(exported); replacement.configuration.templates = replacement.configuration.templates.filter(item => item.preset); replacement.configuration.templates.find(item => item.preset === 'url').defaultIncluded = true;
  await panel.locator('#configuration-file').setInputFiles({ name: 'replacement.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });
  await assertEventually(async () => assert.equal(await panel.locator('#configuration-apply').isEnabled(), true));
  assert.ok((await panel.locator('#configuration-preview').textContent()).includes('全文直发'));
  await panel.screenshot({ path: 'tmp/browser/configuration-320.png' });
  assert.equal(await panel.locator('#configuration-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
  await panel.locator('#configuration-apply').click(); await panel.locator('#configuration-status').filter({ hasText: '已完整替换' }).waitFor();
  assert.deepEqual((await message({ type: 'SIDER_CONFIGURATION_EXPORT' })).backup.configuration, replacement.configuration);
  assert.equal(await editor.inputValue(), '作者缺失时保留草稿'); assert.equal((await readFixture()).sent.length, 5);
  checked('configuration export download and reviewed full import roundtrip; malformed JSON retains settings; old templates disappear and the native draft survives at 320px');

  assert.deepEqual(consoleErrors, []);
  Object.assign(results, { browser: context.browser().version(), checks, consoleErrors, sourceContentCharacters: snapshot.attachments.page.content.length, uploadedBodyCharacters: autoFile.content.length, sourceTabId });
  await panel.screenshot({ path: path.resolve('tmp/browser/fresh-send-success.png') });
  await writeFile('tmp/browser/fresh-send-results.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  Object.assign(results, { checks, consoleErrors, error: error.stack || error.message });
  if (panel) {
    try { await panel.screenshot({ path: path.resolve('tmp/browser/fresh-send-failure.png') }); } catch {}
    try { results.fixtureState = await panel.frameLocator('iframe').locator('body').evaluate(() => ({ sent: window.sent, uploads: window.uploads.map(upload => ({ ...upload, content: upload.content?.slice(-120) })), removed: window.removed })); } catch {}
  }
  await writeFile('tmp/browser/fresh-send-results.json', JSON.stringify(results, null, 2));
  console.error(JSON.stringify(results, null, 2)); throw error;
} finally {
  await context?.close(); await new Promise(resolve => tls.close(resolve)); await new Promise(resolve => article.close(resolve));
}

async function assertEventually(check, timeout = 6000) {
  const until = Date.now() + timeout;
  for (;;) { try { await check(); return; } catch (error) { if (Date.now() >= until) throw error; } await new Promise(resolve => setTimeout(resolve, 50)); }
}
