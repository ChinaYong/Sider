import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { composeTemplatePrompt } from '../../src/context.js';

import { chromium } from './browser.js';
const tlsDelay = 1250;
const tlsRequests = [];
const interactionProbe = `<script>window.fixtureClicks=[];for(const type of ['pointerdown','pointerup','click','submit'])document.addEventListener(type,event=>fixtureClicks.push({type,target:event.target.tagName,id:event.target.id,label:event.target.getAttribute('aria-label'),trusted:event.isTrusted,prevented:event.defaultPrevented}),true);</script>`;
const fixture = `<!doctype html><html lang="zh-CN"><head><title>ChatGPT current-page context fixture</title><style>html,body{margin:0;font:14px system-ui;background:white;color:#222}header{padding:12px 16px;border-bottom:1px solid #ddd}main{padding:14px;min-height:680px;display:flex;flex-direction:column;justify-content:center}.shell{border:1px solid #ddd;border-radius:18px;padding:12px}form{margin:0}textarea{display:block;width:100%;min-height:70px;box-sizing:border-box;resize:vertical;border:0;background:#fafafa;font:inherit}button{font:inherit}.native-controls{display:flex;justify-content:flex-end;margin-top:8px}#result{white-space:pre-wrap;font-size:11px;overflow-wrap:anywhere;max-height:110px;overflow:auto}</style></head><body><header>ChatGPT</header><main><div class="shell"><form><div data-composer-body><textarea id="prompt-textarea" aria-label="Ask ChatGPT"></textarea></div><div class="native-controls"><button type="submit" data-testid="send-button" aria-label="Send prompt">发送</button></div></form></div><p id="result"></p></main><script>window.sent=[];window.nativeKeys=[];const form=document.querySelector('form');const input=document.querySelector('textarea');form.addEventListener('submit',event=>{event.preventDefault();sent.push(input.value);document.querySelector('#result').textContent='fixture received: '+input.value});input.addEventListener('keydown',event=>{nativeKeys.push({key:event.key,isComposing:event.isComposing,isTrusted:event.isTrusted,shiftKey:event.shiftKey});if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();form.requestSubmit(document.querySelector('[data-testid="send-button"]'))}});</script></body></html>`;
const tls = createHttpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, (req, res) => {
  tlsRequests.push(req.url);
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'none'; script-src 'unsafe-inline'", 'x-frame-options': 'DENY' });
    if (req.url.startsWith('/nested-fixture')) res.end('<!doctype html><title>Nested ChatGPT fixture</title><main><p>嵌套 ChatGPT 框架，不应安装侧栏增强层。</p></main>');
    else res.end(fixture.replace('</main>', '<iframe id="nested-chatgpt" title="Nested ChatGPT fixture" src="/nested-fixture" hidden></iframe></main>') + interactionProbe);
  }, tlsDelay);
});
const quotes = { a: '网页 A 当前选中的词汇', b: '网页 B 没有选区', c: '网页 C 当前选中的另一词汇' };
const article = createHttpServer((req, res) => {
  const key = req.url.slice(1).split(/[?#]/)[0] || 'a';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="zh-CN"><head><title>测试网页 ${key.toUpperCase()}</title></head><body><main><article><h1>当前网页 ${key.toUpperCase()}</h1><p id="quote">${quotes[key] || '导航后的内容'}</p><p>网页 ${key.toUpperCase()} 的正文段落，提取时必须保留其中的信息。</p><pre>const currentPage = "${key}";</pre></article></main></body></html>`);
});
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => article.listen(0, '127.0.0.1', resolve));
let context;
const checks = [];
const consoleErrors = [];
const cdpLogs = [];
const observedPages = new WeakMap();
const limitations = [];
const nativePanels = [];
function checked(message) { checks.push(message); console.log(`PASS ${message}`); }
function collectPage(page, label) {
  if (observedPages.has(page)) return observedPages.get(page);
  const ready = (async () => {
    page.on('console', event => { if (event.type() === 'error') consoleErrors.push(`${label}: ${event.text()}`); });
    page.on('pageerror', error => consoleErrors.push(`${label}: ${error.message}`));
    const session = await context.newCDPSession(page);
    session.on('Log.entryAdded', ({ entry }) => cdpLogs.push({ label, level: entry.level, source: entry.source, text: entry.text, url: entry.url }));
    await session.send('Log.enable');
    return session;
  })();
  observedPages.set(page, ready);
  return ready;
}
const settings = {
  maxChars: 48000,
  selectionTemplate: '【网页选词】\n{{selection}}\n【选词结束】', selectionPosition: 'prepend',
  urlTemplate: '网页url为：{{url}}', urlPosition: 'append',
  pageTemplate: '网页正文开始\n{{content}}\n网页正文结束', pagePosition: 'append',
};
try {
  const extension = path.resolve('dist');
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*'], 'QA must use the real production host permissions');
  context = await chromium.launchPersistentContext(path.resolve(`tmp/browser/context-profile-${Date.now()}`), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, ignoreHTTPSErrors: true,
    viewport: { width: 420, height: 840 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${tls.address().port}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const browserCDP = await context.browser().newBrowserCDPSession();
  context.on('page', page => { void collectPage(page, `auto-${Date.now()}`).catch(() => {}); });
  await worker.evaluate(() => chrome.storage.local.clear());
  await worker.evaluate(() => chrome.storage.session.clear());
  const sources = {};
  const panels = {};
  const sourceTabIds = {};
  for (const key of ['a', 'b', 'c']) {
    const page = await context.newPage();
    const url = `http://127.0.0.1:${article.address().port}/${key}`;
    await page.goto(url); await page.bringToFront();
    const currentBefore = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]);
    assert.equal(currentBefore.url, undefined, 'Source must start without website access');
    const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const tabTarget = targetInfos.find(info => info.url === url);
    assert.ok(tabTarget, `Source ${key} must have a native browser tab target`);
    await browserCDP.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
    const current = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]);
    assert.equal(current.url, url);
    sourceTabIds[key] = current.id;
    sources[key] = page;
    await assertEventually(async () => {
      const options = await worker.evaluate(tabId => chrome.sidePanel.getOptions({ tabId }), current.id);
      assert.equal(options.path, `panel.html?sourceTab=${current.id}`);
      assert.equal(options.enabled, true);
    });
  }
  assert.equal(await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })), false);
  const lastEvent = (await worker.evaluate(() => chrome.storage.local.get('siderLastEvent'))).siderLastEvent;
  assert.ok(!lastEvent || lastEvent.ok !== false, `Native sidePanel.open failed: ${lastEvent?.error}`);
  const nativeTargets = await browserCDP.send('Target.getTargets');
  nativePanels.push(...nativeTargets.targetInfos.filter(target => target.url.startsWith(`chrome-extension://${extensionId}/panel.html`)).map(target => ({ type: target.type, url: target.url })));
  for (const tabId of Object.values(sourceTabIds)) assert.ok(nativePanels.some(target => target.url === `chrome-extension://${extensionId}/panel.html?sourceTab=${tabId}`), `Native sidePanel.open must create the panel belonging to source tab ${tabId}`);
  checked('native browser action grants activeTab and configures a distinct sourceTab sidebar path for A, B and C');

  for (const key of ['a', 'b', 'c']) {
    // Ordinary extension tabs render the actual panel pages to make frame UI
    // inspectable. Each panel is bound to its corresponding real source tab.
    const panel = await context.newPage();
    await collectPage(panel, key);
    await panel.goto(`chrome-extension://${extensionId}/panel.html?sourceTab=${sourceTabIds[key]}`, { waitUntil: 'domcontentloaded' });
    await panel.waitForFunction(() => document.querySelector('iframe').src.startsWith('https://chatgpt.com/'));
    const pendingFrameURL = await panel.evaluate(() => { try { return document.querySelector('iframe').contentWindow.location.href; } catch { return 'cross-origin'; } });
    assert.equal(pendingFrameURL, 'about:blank', 'Delayed HTTPS response must keep the initial iframe at about:blank long enough to exercise the race');
    const chat = panel.frameLocator('iframe');
    await chat.locator('#sider-enhancement').waitFor({ timeout: 15000 });
    panels[key] = { page: panel, chat, editor: chat.getByRole('textbox', { name: 'Ask ChatGPT' }) };
  }
  checked('1250 ms HTTPS response delay exercises initial about:blank frames and all three enhancement layers connect');
  for (const key of ['a', 'b', 'c']) {
    const nested = panels[key].chat.frameLocator('#nested-chatgpt');
    await nested.getByText('嵌套 ChatGPT 框架，不应安装侧栏增强层。').waitFor({ state: 'attached' });
    assert.equal(await nested.locator('#sider-enhancement').count(), 0);
  }
  checked('nested ChatGPT iframes are not treated as direct sidebar children and receive no enhancement');

  const select = async key => {
    await sources[key].bringToFront();
    await sources[key].evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('#quote'));
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await panels[key].chat.locator('.selection-chip .excerpt').filter({ hasText: quotes[key] }).waitFor();
  };
  const selectionPreview = key => panels[key].chat.locator('.selection-chip .excerpt');
  const contextSnapshot = async key => {
    const values = await worker.evaluate(tabId => chrome.storage.session.get(`sider.tabContext.${tabId}`), sourceTabIds[key]);
    return values[`sider.tabContext.${sourceTabIds[key]}`];
  };
  const nativeSent = key => panels[key].chat.locator('body').evaluate(() => window.sent);
  const expected = async (key, question) => {
    const templates = await worker.evaluate(async () => (await chrome.storage.local.get('sider.templates.v3'))['sider.templates.v3']);
    const compiled = composeTemplatePrompt(question, templates, await contextSnapshot(key));
    assert.deepEqual(compiled.errors, []);
    return compiled.text;
  };
  const openReferences = async key => {
    const chat = panels[key].chat;
    await chat.locator('[data-pane="templates"]').click();
    assert.deepEqual(await chat.locator('#pane-body [data-template-id]').evaluateAll(entries => entries.map(entry => entry.dataset.templateId)), ['preset-selection', 'preset-url', 'preset-page']);
  };
  const toggleAttachment = async (key, kind, included) => {
    const chat = panels[key].chat;
    await openReferences(key);
    const action = chat.locator(`#pane-body [data-template-id="preset-${kind}"]`).locator('..').locator('input[type=checkbox]');
    await action.setChecked(included);
    await assertEventually(async () => assert.equal((await contextSnapshot(key)).templateSelections[`preset-${kind}`], included));
    const close = chat.getByRole('button', { name: '关闭', exact: true });
    if (await close.isVisible()) await close.click();
  };

  await select('a');
  assert.equal(await selectionPreview('b').count(), 0);
  await select('c');
  assert.equal(await selectionPreview('a').textContent(), quotes.a);
  assert.equal(await selectionPreview('b').count(), 0);
  assert.equal(await selectionPreview('c').textContent(), quotes.c);
  await sources.a.bringToFront(); await panels.a.page.bringToFront(); await panels.a.editor.focus();
  assert.equal(await selectionPreview('a').textContent(), quotes.a);
  if (!await sources.a.evaluate(() => document.hasFocus())) {
    await sources.a.evaluate(() => getSelection().removeAllRanges());
    await assertEventually(async () => assert.equal((await contextSnapshot('a')).selection.content, quotes.a));
  } else limitations.push('Headless inspector tabs retain document.hasFocus() on source pages; artificial focus-loss range collapse is covered by unit tests, not this browser fixture');
  checked('live selection A, empty B, selection C, then restored A remain independent without capture clicks');

  const chatA = panels.a.chat;
  await chatA.locator('[data-pane="templates"]').click();
  for (const [kind, name] of [['selection', '划词'], ['url', '网页链接'], ['page', '网页正文']]) {
    await chatA.getByRole('button', { name: '编辑预设 ' + name, exact: true }).click();
    await chatA.locator('#template-text').fill(settings[kind + 'Template']);
    await chatA.locator('#template-position').selectOption(settings[kind + 'Position']);
    await chatA.getByRole('button', { name: '保存预设', exact: true }).click();
    await chatA.getByRole('button', { name: '编辑预设 ' + name, exact: true }).waitFor();
  }
  const closeSettings = chatA.getByRole('button', { name: '关闭', exact: true });
  if (await closeSettings.isVisible()) await closeSettings.click();
  await assertEventually(async () => {
    const values = await worker.evaluate(() => chrome.storage.local.get('sider.templates.v3'));
    assert.equal(values['sider.templates.v3'].find(item => item.preset === 'url').text, settings.urlTemplate);
  });
  await panels.a.editor.fill('请解释这个词，问题本身没有变量');
  assert.equal(await panels.a.editor.inputValue(), '请解释这个词，问题本身没有变量');
  assert.equal((await nativeSent('a')).length, 0);
  const firstExpected = await expected('a', '请解释这个词，问题本身没有变量');
  await chatA.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await assertEventually(async () => assert.equal((await nativeSent('a')).length, 1));
  assert.equal((await nativeSent('a'))[0], firstExpected);
  assert.equal((await nativeSent('a'))[0].split(quotes.a).length - 1, 1);
  checked('plain question remains untouched until native Send, then receives the configured selection prefix exactly once');

  await toggleAttachment('a', 'url', true);
  await toggleAttachment('a', 'page', true);
  assert.equal(await chatA.locator('[data-chip="url"]').count(), 1);
  assert.equal(await chatA.locator('[data-chip="page"]').count(), 1);
  assert.equal((await contextSnapshot('b')).attachments.url, false);
  assert.equal((await contextSnapshot('c')).attachments.page, null);
  assert.ok((await contextSnapshot('a')).attachments.page.content.includes('const currentPage = "a";'));
  await panels.a.editor.fill('结合当前网页解释');
  assert.equal(await panels.a.editor.inputValue(), '结合当前网页解释');
  const bodyExpected = await expected('a', '结合当前网页解释');
  await panels.a.editor.press('Enter');
  await assertEventually(async () => assert.equal((await nativeSent('a')).length, 2));
  const actualBody = (await nativeSent('a'))[1], actualCapturedAt = actualBody.match(/采集时间：([^\n]+)/)[1];
  assert.ok(Date.parse(actualCapturedAt) >= Date.parse(bodyExpected.match(/采集时间：([^\n]+)/)[1]));
  assert.equal(actualBody, bodyExpected.replace(/采集时间：[^\n]+/, '采集时间：' + actualCapturedAt));
  assert.ok((await nativeSent('a'))[1].includes(`网页url为：${sources.a.url()}`));
  checked('URL and body chips enable page-bound attachments; native Enter appends custom URL and extracted body formats');

  await assertEventually(async () => assert.ok(Object.values((await contextSnapshot('a')).templateSelections).every(value => value === false)));
  await toggleAttachment('a', 'url', true); await toggleAttachment('a', 'page', true);
  await chatA.getByRole('button', { name: '取消 URL 引用', exact: true }).click();
  await chatA.getByRole('button', { name: '取消正文引用', exact: true }).click();
  await assertEventually(async () => {
    const snapshot = await contextSnapshot('a');
    assert.equal(snapshot.attachments.url, false); assert.equal(snapshot.attachments.page, null);
  });
  assert.equal(await chatA.locator('[data-chip="url"]').count(), 0);
  assert.equal(await chatA.locator('[data-chip="page"]').count(), 0);
  await toggleAttachment('a', 'selection', true);
  const selectionExpected = await expected('a', '取消引用后只讨论划词');
  await panels.a.editor.fill('取消引用后只讨论划词');
  await chatA.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await assertEventually(async () => assert.equal((await nativeSent('a')).length, 3));
  assert.equal((await nativeSent('a'))[2], selectionExpected);
  assert.ok(!(await nativeSent('a'))[2].includes(sources.a.url()));
  await toggleAttachment('a', 'selection', true);
  await chatA.getByRole('button', { name: '取消划词', exact: true }).click();
  await assertEventually(async () => assert.equal((await contextSnapshot('a')).templateSelections['preset-selection'], false));
  assert.equal(await selectionPreview('a').count(), 0);
  await panels.a.page.waitForTimeout(1200);
  assert.equal((await contextSnapshot('a')).templateSelections['preset-selection'], false);
  assert.equal(await selectionPreview('a').count(), 0);
  await panels.a.editor.fill('已经取消划词的普通问题');
  await panels.a.editor.press('Enter');
  await assertEventually(async () => assert.equal((await nativeSent('a')).length, 4));
  assert.equal((await nativeSent('a'))[3], '已经取消划词的普通问题');
  assert.equal((await contextSnapshot('c')).selection.content, quotes.c);
  checked('chip removal excludes URL/body/selection on the next send and never affects another source tab');

  await panels.b.editor.fill('网页 B 的普通问题');
  await panels.b.editor.press('Enter');
  await assertEventually(async () => assert.equal((await nativeSent('b')).length, 1));
  assert.equal((await nativeSent('b'))[0], '网页 B 的普通问题');
  await panels.c.editor.fill('解释网页 C 的词');
  const otherExpected = await expected('c', '解释网页 C 的词');
  await panels.c.chat.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await assertEventually(async () => assert.equal((await nativeSent('c')).length, 1));
  assert.equal((await nativeSent('c'))[0], otherExpected);
  checked('sending from B and C uses their own current context rather than the browser active tab');

  await panels.c.editor.fill('换行仍然是草稿');
  const sentBeforeShift = (await nativeSent('c')).length;
  await panels.c.editor.press('Shift+Enter');
  assert.equal((await nativeSent('c')).length, sentBeforeShift);
  assert.ok((await panels.c.editor.inputValue()).startsWith('换行仍然是草稿'));
  assert.ok(!(await panels.c.editor.inputValue()).includes(quotes.c));
  const pageCDP = await context.newCDPSession(panels.c.page);
  await panels.c.editor.fill('输入法组合中');
  await pageCDP.send('Input.imeSetComposition', { text: '词', selectionStart: 1, selectionEnd: 1 });
  await panels.c.editor.press('Enter');
  const composingKeys = await panels.c.chat.locator('body').evaluate(() => window.nativeKeys.filter(event => event.isComposing));
  assert.ok(composingKeys.some(event => event.key === 'Enter' && event.isTrusted), 'Native IME Enter must reach the website as a composing key');
  assert.equal((await nativeSent('c')).length, sentBeforeShift);
  await pageCDP.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  checked('native Shift+Enter and trusted composing Enter reach the website without sending or injecting context');

  const noBridgeURL = 'https://chatgpt.com/navigation-no-bridge';
  await Promise.all([
    panels.c.page.waitForEvent('framenavigated', { predicate: frame => frame.url() === noBridgeURL }),
    panels.c.chat.locator('body').evaluate((_body, url) => { location.href = url; }, noBridgeURL),
  ]);
  await panels.c.chat.locator('#sider-enhancement').waitFor({ timeout: 15000 });
  assert.equal(await panels.c.chat.locator('body').evaluate(() => new URL(location.href).searchParams.has('sider_bridge')), false);
  await panels.c.editor.fill('ChatGPT 跳转后继续解释网页 C 划词');
  await panels.c.chat.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await assertEventually(async () => assert.equal((await nativeSent('c')).length, 1));
  assert.equal((await nativeSent('c'))[0], await expected('c', 'ChatGPT 跳转后继续解释网页 C 划词'));
  checked('full ChatGPT navigation without sider_bridge reconnects the enhancement and preserves deselected presets');

  await Promise.all([
    panels.c.page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith('https://chatgpt.com/') && new URL(frame.url()).searchParams.has('sider_bridge') }),
    panels.c.page.locator('#reload-chatgpt').click(),
  ]);
  await panels.c.chat.locator('#sider-enhancement').waitFor({ timeout: 15000 });
  await panels.c.editor.fill('侧栏刷新后问题仍然不需要变量');
  await panels.c.editor.press('Enter');
  await assertEventually(async () => assert.equal((await nativeSent('c')).length, 1));
  assert.equal((await nativeSent('c'))[0], await expected('c', '侧栏刷新后问题仍然不需要变量'));
  checked('sidebar reload with another delayed initial frame reconnects and native Enter composes a plain question');

  await panels.c.page.reload({ waitUntil: 'domcontentloaded' });
  await panels.c.chat.locator('#sider-enhancement').waitFor({ timeout: 15000 });
  await panels.c.page.locator('#connection-status').filter({ hasText: '网页引用已就绪' }).waitFor();
  await assertEventually(async () => assert.equal(await selectionPreview('c').count(), 0));
  await panels.c.page.bringToFront();
  await panels.c.editor.fill('整个扩展页面重载后继续提问');
  await panels.c.chat.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await assertEventually(async () => assert.equal((await nativeSent('c')).length, 1));
  assert.equal((await nativeSent('c'))[0], await expected('c', '整个扩展页面重载后继续提问'));
  checked('extension panel document reload obtains a new bridge and reconnects native Send');

  await toggleAttachment('c', 'url', true);
  await sources.c.bringToFront();
  await sources.c.evaluate(() => history.pushState({}, '', '/c?another-page=1'));
  await assertEventually(async () => {
    const snapshot = await contextSnapshot('c');
    assert.equal(snapshot.url, sources.c.url());
    assert.equal(snapshot.selection, null);
    assert.equal(snapshot.attachments.url, false);
    assert.equal(snapshot.attachments.page, null);
  });
  await assertEventually(async () => assert.equal(await selectionPreview('c').count(), 0));
  await panels.c.editor.fill('导航后没有沿用旧网页划词');
  await panels.c.chat.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await assertEventually(async () => assert.equal((await nativeSent('c')).length, sentBeforeShift + 1));
  assert.equal((await nativeSent('c')).at(-1), '导航后没有沿用旧网页划词');
  checked('same-tab SPA URL navigation clears both its old selection and URL/body attachments before the next send');

  for (const key of ['a', 'b', 'c']) {
    const chat = panels[key].chat;
    assert.equal(await chat.getByRole('button', { name: '展开', exact: true }).count(), 0);
    assert.equal(await chat.getByRole('button', { name: '撤回', exact: true }).count(), 0);
    assert.equal(await chat.getByRole('button', { name: '预设', exact: true }).count(), 1);
  }
  if (!process.argv.includes('--handshake-only')) {
  const longSelection = `${quotes.a}，${'这是一段用于侧栏布局压力测试的很长文本，包含当前网页的详细内容。'.repeat(45)}`;
  await openReferences('a');
  await panels.a.chat.locator('#pane-body [data-template-id="preset-selection"]').locator('..').locator('input[type=checkbox]').setChecked(true);
  await panels.a.chat.getByRole('button', { name: '关闭', exact: true }).click();
  await sources.a.evaluate(text => { document.querySelector('#quote').textContent = text; }, longSelection);
  await toggleAttachment('a', 'selection', true);
  await select('a');
  await assertEventually(async () => assert.equal(await selectionPreview('a').textContent(), longSelection));
  await toggleAttachment('a', 'url', true);
  await toggleAttachment('a', 'page', true);
  await panels.a.page.setViewportSize({ width: 320, height: 760 });
  await panels.a.page.waitForTimeout(200);
  await panels.a.page.screenshot({ path: path.resolve('tmp/browser/context-320.png') });
  const toolbarGeometry = await panels.a.chat.locator('#sider-enhancement').evaluate(host => {
    const root = host.shadowRoot;
    const rect = element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; };
    return { innerWidth, documentWidth: document.documentElement.clientWidth, host: rect(host), bar: rect(root.querySelector('.bar')), chips: rect(root.querySelector('.chips')), form: rect(document.querySelector('form')), nativeSend: rect(document.querySelector('[data-testid="send-button"]')), buttons: [...root.querySelectorAll('.bar button')].map(button => ({ label: button.getAttribute('aria-label') || button.textContent, ...rect(button) })) };
  });
  console.log(JSON.stringify({ toolbarGeometry }, null, 2));
  assert.ok(toolbarGeometry.buttons.every(button => button.left >= 0 && button.right <= toolbarGeometry.innerWidth), 'Every toolbar action and chip cancel button must fit within the iframe viewport');
  assert.ok([toolbarGeometry.host, toolbarGeometry.bar, toolbarGeometry.chips, toolbarGeometry.form, toolbarGeometry.nativeSend].every(element => element.left >= 0 && element.right <= toolbarGeometry.innerWidth), 'Host, form and native send must fit within the iframe viewport');
  assert.equal(await panels.a.chat.locator('body').evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  checked('settled 320 px layout with template entry, long selection, URL and body chips keeps cancel/settings/native send controls in bounds');
  }
  const originMismatches = [...consoleErrors, ...cdpLogs.map(entry => entry.text)].filter(text => /postMessage.*(?:origin|DOMWindow)|target origin.*does not match|recipient window.?s origin/i.test(text));
  assert.deepEqual(originMismatches, [], 'No browser CDP Log, console, or page error may report a DOMWindow target origin mismatch');
  assert.deepEqual(consoleErrors, []);
  checked('CDP Log.entryAdded, console and pageerror contain no postMessage target-origin mismatch during slow initial load, queryless navigation and reload');
  console.log(JSON.stringify({ browser: context.browser().version(), version: manifest.version, fixture: true, tlsDelayMs: tlsDelay, tlsRequestCount: tlsRequests.length, nativeAction: true, productionHostPermissions: true, nativePanels, panelInspection: 'three actual extension panel pages bound to real source tab ids', checks, limitations, consoleErrors, cdpLogs, originMismatches }, null, 2));
} catch (error) {
  console.error(error);
  for (const page of context.pages()) if (page.url().includes('panel.html?')) console.error(JSON.stringify(await page.frameLocator('iframe').locator('body').evaluate(() => ({ sent: window.sent, clicks: window.fixtureClicks, text: document.querySelector('textarea')?.value, status: document.querySelector('#sider-enhancement')?.shadowRoot.querySelector('.status')?.textContent })).catch(() => null)));
  console.error(JSON.stringify({ completedChecks: checks, consoleErrors, cdpLogs }, null, 2));
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => tls.close(resolve));
  await new Promise(resolve => article.close(resolve));
}

async function assertEventually(check, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    try { await check(); return; }
    catch (error) { if (Date.now() >= until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}
