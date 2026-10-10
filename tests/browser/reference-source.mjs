import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from './browser.js';
import { presetTemplates, newTemplate, UNIFIED_TEMPLATES_KEY, PRESET_IDS } from '../../src/prompt-templates.js';

const nativeFixture = String.raw`<!doctype html><meta charset="utf-8"><title>ChatGPT reference picker fixture</title><style>
body{margin:0;font:14px system-ui;background:#fff;color:#222}main{padding:14px;min-height:650px;display:flex;flex-direction:column;justify-content:center}.shell{border:1px solid #ddd;border-radius:16px;padding:12px}textarea{box-sizing:border-box;width:100%;min-height:90px;font:inherit;white-space:pre-wrap}button{font:inherit}.card{border:1px solid #ddd;padding:4px;overflow-wrap:anywhere}#uploads{display:flex;gap:4px;flex-wrap:wrap}@media(prefers-color-scheme:dark){body{background:#171717;color:#eee}textarea{background:#272727;color:#eee}.shell,.card{border-color:#454545}}
</style><main><div class="shell"><form><div data-composer-body><textarea id="prompt-textarea" aria-label="Ask ChatGPT"></textarea></div><div id="uploads" data-composer-attachments></div><input type="file" aria-label="Attach files" accept="text/plain,.txt" hidden><button data-testid="send-button" type="submit" aria-label="Send prompt">发送</button></form></div></main><script>
window.sent=[];window.uploads=[];window.documentIdentity=crypto.randomUUID();
const editor=document.querySelector('textarea'),area=document.querySelector('#uploads');
document.querySelector('input[type=file]').addEventListener('change',event=>{for(const file of event.target.files){
const item={name:file.name,content:null,ready:false};uploads.push(item);
const card=document.createElement('div');card.className='group/composer-attachment card';card.item=item;
const progress=document.createElement('span');progress.setAttribute('role','progressbar');progress.setAttribute('aria-label','Uploading '+file.name);
const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove '+file.name);remove.textContent='×';remove.onclick=()=>card.remove();card.append(progress,remove);area.append(card);
void(async()=>{item.content=await file.text();await new Promise(resolve=>setTimeout(resolve,60));if(!card.isConnected)return;progress.remove();item.ready=true;const label=document.createElement('button');label.type='button';label.setAttribute('aria-label',file.name);label.textContent=file.name;card.prepend(label)})();
}event.target.value=''});
document.querySelector('form').onsubmit=event=>{event.preventDefault();sent.push({text:editor.value,files:[...area.children].map(card=>card.item),pending:area.querySelectorAll('[role=progressbar]').length})};
editor.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();document.querySelector('form').requestSubmit()}};
</script>`;
const tls = httpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(nativeFixture);
});
const article = httpServer((req, res) => {
  const key = req.url.includes('/b') ? 'B' : req.url.includes('/denied') ? 'D' : 'A';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>来源 ${key} 的文章</title><article><h1>来源 ${key} 的文章</h1><p id="quote">${key} 的独立划词</p><p>${key}-BODY-START ${('来源 ' + key + ' 的正文资料。').repeat(50)} ${key}-BODY-END</p></article>`);
});
await mkdir('tmp/browser', { recursive: true });
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => article.listen(0, '127.0.0.1', resolve));
let context, panel;
const checks = [], errors = [];
const checked = message => { checks.push(message); console.log('PASS ' + message); };
const eventually = async check => {
  const until = Date.now() + 12000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() > until) throw error; await new Promise(resolve => setTimeout(resolve, 60)); } }
};
try {
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext(path.resolve('tmp/browser/reference-profile-' + Date.now()), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, ignoreHTTPSErrors: true,
    viewport: { width: 420, height: 840 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${tls.address().port}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  await worker.evaluate(() => chrome.storage.local.clear()); await worker.evaluate(() => chrome.storage.session.clear());
  const templates = presetTemplates().map(item => ({ ...item, defaultIncluded: false }));
  templates.push(newTemplate({ id: 'reference-snapshot-001', name: '资料快照', text: '保留资料快照。\n<attachment>{{content}}</attachment>', delivery: 'file', action: 'append' }),
    newTemplate({ id: 'reference-variables-001', name: '变量来源', text: '变量来源 {{title}}\n链接 {{url}}\n划词 {{selection}}\n正文 {{content}}', action: 'append' }),
    newTemplate({ id: 'reference-title-001', name: '追加标题', text: '标题追加 {{title}}', action: 'append' }));
  await worker.evaluate(({ key, templates }) => chrome.storage.local.set({ [key]: templates }), { key: UNIFIED_TEMPLATES_KEY, templates });
  const sourceA = await context.newPage(), sourceB = await context.newPage(), denied = await context.newPage();
  const rootURL = `http://127.0.0.1:${article.address().port}`;
  await sourceA.goto(rootURL + '/a'); await sourceB.goto(rootURL + '/b'); await denied.goto(`http://localhost:${article.address().port}/denied`);
  const findTab = url => worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), url);
  const tabA = await findTab(sourceA.url()), tabB = await findTab(sourceB.url());
  const secondWindow = await worker.evaluate(tabId => chrome.windows.create({ tabId, focused: false }), tabB.id);
  assert.notEqual(secondWindow.id, tabA.windowId);
  const cdp = await context.browser().newBrowserCDPSession();
  const grantAction = async source => {
    await source.bringToFront();
    const targets = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: targets.targetInfos.find(target => target.url === source.url()).targetId });
    await source.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#quote')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
  };
  await grantAction(sourceB); await grantAction(sourceA);
  panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
  await panel.goto('about:blank#reference-panel');
  const panelTab = await findTab(panel.url());
  await worker.evaluate(({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }), { tabId: panelTab.id, windowId: tabA.windowId });
  await panel.goto(`chrome-extension://${extensionId}/panel.html?sourceTab=${tabA.id}`);
  const chat = panel.frameLocator('iframe'), editor = chat.locator('textarea');
  await chat.locator('#sider-enhancement').waitFor();
  await panel.locator('#connection-status').filter({ hasText: '网页引用已就绪' }).waitFor();
  const frameIdentity = await chat.locator('body').evaluate(() => window.documentIdentity);
  const frameURL = await panel.locator('iframe').getAttribute('src');
  const state = () => worker.evaluate(owner => chrome.storage.session.get('sider.referenceSessions.v1').then(data => data['sider.referenceSessions.v1']?.[owner]), tabA.id);
  const openPresets = async () => { if (!await chat.locator('.popover').isVisible()) await chat.getByRole('button', { name: '预设', exact: true }).click(); };
  const openPicker = async () => { await openPresets(); if (!await chat.locator('.source-menu').isVisible()) await chat.getByRole('button', { name: '切换引用来源标签页', exact: true }).click(); await chat.getByRole('combobox', { name: '搜索标签页' }).waitFor(); };
  const choose = async title => { await openPicker(); await chat.getByRole('combobox', { name: '搜索标签页' }).fill(title); await chat.getByRole('option').filter({ hasText: title }).click(); await chat.locator('.source-menu').waitFor({ state: 'hidden' }); };
  const files = () => chat.locator('#uploads').evaluate(area => [...area.children].map(card => card.item));
  const settleMotion = () => chat.locator('#sider-enhancement').evaluate(async host => {
    await Promise.all(host.shadowRoot.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  await editor.fill('手动问题');
  await chat.getByLabel('Attach files', { exact: true }).setInputFiles({ name: '用户资料.txt', mimeType: 'text/plain', buffer: Buffer.from('用户上传的资料') });
  await eventually(async () => assert.ok((await files()).every(file => file.ready)));
  await openPresets(); await chat.getByRole('button', { name: '资料快照 · 追加', exact: true }).click();
  await eventually(async () => { assert.match(await editor.inputValue(), /保留资料快照/); assert.equal((await files()).length, 2); });
  await chat.locator('.status').filter({ hasText: '已追加' }).waitFor();
  await chat.locator('.popover').waitFor({ state: 'hidden' });
  await editor.fill((await editor.inputValue()) + '\n用户补充');
  await openPresets(); await chat.getByRole('checkbox', { name: '发送时引用 变量来源', exact: true }).check();
  await chat.getByRole('checkbox', { name: '发送时引用 网页链接', exact: true }).check();
  const beforeDraft = await editor.inputValue(), beforeFiles = await files();
  assert.ok(beforeFiles.some(file => file.content.includes('A-BODY-END')));
  await openPicker();
  await eventually(async () => assert.ok(await chat.getByRole('group', { name: '窗口 2', exact: true }).count()));
  await chat.getByRole('combobox', { name: '搜索标签页' }).fill('/b');
  const activeBefore = await worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(tab => tab.id).sort());
  await chat.getByRole('option').filter({ hasText: '来源 B 的文章' }).click();
  await chat.locator('.source-menu').waitFor({ state: 'hidden' });
  await eventually(async () => assert.equal((await state()).status, 'ready'));
  assert.equal(await editor.inputValue(), beforeDraft); assert.deepEqual(await files(), beforeFiles);
  assert.equal(await chat.locator('body').evaluate(() => window.documentIdentity), frameIdentity);
  assert.equal(await panel.locator('iframe').getAttribute('src'), frameURL);
  assert.deepEqual(await worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(tab => tab.id).sort()), activeBefore);
  assert.equal(await chat.getByRole('checkbox', { name: '发送时引用 变量来源', exact: true }).isChecked(), true);
  assert.equal(await chat.getByRole('checkbox', { name: '发送时引用 网页链接', exact: true }).isChecked(), true);
  assert.equal((await state()).context.selection.content, 'B 的独立划词');
  checked('cross-window source selection preserves draft, generated and user attachments, preset choices, active tabs and the live AI document');

  await chat.getByRole('button', { name: '追加标题 · 追加', exact: true }).click();
  await eventually(async () => assert.match(await editor.inputValue(), /标题追加 来源 B 的文章/));
  await chat.locator('.status').filter({ hasText: '已追加' }).waitFor();
  await chat.locator('.popover').waitFor({ state: 'hidden' });
  checked('subsequent preset application expands the selected tab title');
  await openPicker();
  const search = chat.getByRole('combobox', { name: '搜索标签页' });
  await search.fill('不存在的标签'); await chat.getByText('没有匹配的标签页。', { exact: true }).waitFor();
  await search.press('Escape'); assert.equal(await chat.locator('.popover').isVisible(), true); assert.equal(await chat.locator('.source-menu').isVisible(), false);
  await openPicker(); await search.fill('来源 B');
  await chat.locator('.source-menu').waitFor({ state: 'visible' });
  await chat.getByRole('option').filter({ hasText: '来源 B 的文章' }).waitFor();
  await search.focus();
  await settleMotion();
  await panel.screenshot({ path: 'tmp/browser/reference-source-420-light.png' });
  await panel.setViewportSize({ width: 320, height: 700 });
  await panel.emulateMedia({ colorScheme: 'dark' });
  await chat.locator('html').evaluate(node => node.classList.add('dark'));
  await eventually(async () => assert.equal(await chat.locator('#sider-enhancement').getAttribute('data-dark'), ''));
  await settleMotion();
  await panel.screenshot({ path: 'tmp/browser/reference-source-320-dark.png' });
  const overflow = await chat.locator('.popover').evaluate(node => ({ overflow: node.scrollWidth > node.clientWidth + 1, right: node.getBoundingClientRect().right, width: innerWidth }));
  assert.equal(overflow.overflow, false); assert.ok(overflow.right <= overflow.width);
  await search.press('Enter'); await chat.locator('.source-menu').waitFor({ state: 'hidden' });
  checked('search by URL and title, no-match feedback, keyboard selection and Escape work at 420px and 320px without overflow');

  await worker.evaluate(() => {
    const native = chrome.tabs.sendMessage.bind(chrome.tabs);
    globalThis.holdCapture = true; globalThis.captureWaiting = false;
    chrome.tabs.sendMessage = async (...args) => { if (args[1]?.type === 'SIDER_PAGE_CAPTURE' && holdCapture) { captureWaiting = true; await new Promise(resolve => { globalThis.releaseCapture = resolve; }); holdCapture = false; } return native(...args); };
  });
  await chat.locator('#close-pane').click(); await chat.locator('.popover').waitFor({ state: 'hidden' });
  await editor.press('Enter');
  await eventually(async () => assert.equal(await worker.evaluate(() => globalThis.captureWaiting), true));
  assert.equal(await chat.locator('.source-trigger').isDisabled(), true);
  await worker.evaluate(() => globalThis.releaseCapture());
  await eventually(async () => assert.equal(await chat.locator('body').evaluate(() => sent.length), 1));
  const sent = await chat.locator('body').evaluate(() => window.sent[0]);
  assert.match(sent.text, /变量来源 来源 B 的文章/); assert.ok(sent.text.includes(rootURL + '/b'));
  assert.match(sent.text, /B 的独立划词/); assert.match(sent.text, /B-BODY-END/); assert.match(sent.text, /用户补充/);
  assert.deepEqual(sent.files, beforeFiles); assert.equal(sent.pending, 0);
  await eventually(async () => { const current = await state(); assert.equal(current.sourceTabId, tabB.id); assert.ok(Object.values(current.context.templateSelections).every(enabled => !enabled)); });
  checked('send preparation blocks source switching, uses fresh selected-source variables and body, preserves earlier snapshots, and clears choices while retaining the source');

  await choose('来源 D');
  await eventually(async () => assert.equal((await state()).status, 'needs-access'));
  const deniedDraft = await editor.inputValue(), deniedFiles = await files();
  assert.equal((await state()).context.url, ''); assert.equal((await state()).context.attachments.page, null);
  await chat.getByRole('button', { name: '允许来源网站', exact: true }).click();
  await panel.locator('#site-dialog').waitFor({ state: 'visible' });
  assert.match(await panel.locator('#site-description').textContent(), /localhost/);
  assert.equal(await editor.inputValue(), deniedDraft); assert.deepEqual(await files(), deniedFiles);
  await panel.locator('#close-site').click(); await openPresets(); await chat.getByRole('button', { name: '切回当前标签页', exact: true }).click();
  await eventually(async () => assert.equal((await state()).sourceTabId, tabA.id));
  checked('an ungranted borrowed tab has no stale material and its authorization dialog names the selected origin; quick return restores the owner');

  await choose('来源 B'); await sourceB.close(); await panel.bringToFront();
  await eventually(async () => { const current = await state(); assert.equal(current.status, 'closed'); assert.equal(current.context.url, ''); });
  await eventually(async () => assert.match(await chat.locator('.source-title').textContent(), /已关闭/));
  assert.equal(await editor.inputValue(), deniedDraft); assert.deepEqual(await files(), deniedFiles);
  await settleMotion();
  await panel.screenshot({ path: 'tmp/browser/reference-source-closed.png', timeout: 5000 });
  await chat.getByRole('button', { name: '切回当前标签页', exact: true }).click();
  await eventually(async () => assert.equal((await state()).status, 'ready'));
  assert.equal((await state()).sourceTabId, tabA.id);
  checked('closing the selected source invalidates variables, retains existing site content and leaves quick return available');
  assert.deepEqual(errors, []);
  await writeFile('tmp/browser/reference-source-result.json', JSON.stringify({ fixtureOnly: true, browser: context.browser().version(), checks, errors }, null, 2));
} finally {
  await context?.close(); await new Promise(resolve => tls.close(resolve)); await new Promise(resolve => article.close(resolve));
}
