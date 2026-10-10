import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from './browser.js';
import { DEFAULT_FONT_FAMILY, fontFamily } from '../../src/font-settings.js';

// Real extension storage/worker/iframe, with local sites and an isolated profile.
await mkdir('tmp/browser', { recursive: true });
const tls = httpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>AI font fixture</title><style>body{font:16px serif}main{margin:20px}textarea{font:inherit;width:90%;height:60px}button{font:inherit}</style><main><form><div data-composer-body><textarea id="prompt-textarea" aria-label="Ask ChatGPT">保留原站草稿</textarea></div><button data-testid="send-button">Send</button></form></main>');
});
const sourceServer = httpServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>字体验证来源</title><style>body{font:16px serif;margin:60px}</style><main><p>字体更改应只作用于扩展控件。</p></main>');
});
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => sourceServer.listen(0, '127.0.0.1', resolve));
const extension = path.resolve(`tmp/browser/font-extension-${Date.now()}`);
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const errors = [], checks = [];
const pass = value => { checks.push(value); console.log('PASS ' + value); };
let context;
async function eventually(check) {
  const until = Date.now() + 10000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() > until) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}
try {
  context = await chromium.launchPersistentContext(path.resolve(`tmp/browser/font-profile-${Date.now()}`), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, ignoreHTTPSErrors: true,
    viewport: { width: 420, height: 760 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${tls.address().port}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const source = await context.newPage(), sourceURL = `http://127.0.0.1:${sourceServer.address().port}/article`;
  await source.goto(sourceURL); await source.locator('#sider-floating-launcher').waitFor();
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), sourceURL);
  const panel = await context.newPage(), panelURL = `chrome-extension://${id}/panel.html?sourceTab=${tab.id}`;
  await panel.goto(panelURL);
  const chat = panel.frameLocator('iframe');
  await chat.locator('#sider-enhancement [data-pane="templates"]').waitFor();
  await chat.locator('#sider-enhancement [data-pane="templates"]').click();
  const other = await context.newPage(); await other.goto(`chrome-extension://${id}/panel.html`);
  const request = data => panel.evaluate(data => chrome.runtime.sendMessage(data), data);
  const open = async () => { await panel.locator('#ai-settings-toggle').click(); await panel.locator('#font-settings > summary').click(); };
  await open();
  await panel.locator('#extension-font').selectOption('mono');
  await panel.waitForFunction(() => document.querySelector('#extension-font-status').textContent.includes('已保存'));
  const mono = fontFamily({ font: 'mono' });
  await eventually(async () => {
    assert.equal(await other.locator('html').evaluate(node => node.style.getPropertyValue('--sider-font-family')), mono);
    assert.equal(await chat.locator('#sider-enhancement').evaluate(node => node.style.getPropertyValue('--sider-font-family')), mono);
    assert.equal(await source.locator('#sider-floating-launcher').evaluate(node => node.style.getPropertyValue('--sider-font-family')), mono);
  });
  assert.match(await chat.locator('#sider-enhancement .bar').evaluate(node => getComputedStyle(node).fontFamily), /Consolas/);
  assert.equal(await chat.locator('#prompt-textarea').inputValue(), '保留原站草稿');
  assert.equal(await chat.locator('#prompt-textarea').evaluate(node => getComputedStyle(node).fontFamily), 'serif');
  assert.equal(await source.locator('body').evaluate(node => getComputedStyle(node).fontFamily), 'serif');
  pass('saved font immediately reaches another panel, real iframe controls and webpage launcher; native fonts/draft stay intact');

  await panel.locator('#extension-font').selectOption('custom');
  await panel.locator('#extension-font-apply').click();
  assert.match(await panel.locator('#extension-font-status').textContent(), /字体名称/);
  assert.equal((await request({ type: 'SIDER_CONFIGURATION_EXPORT' })).backup.configuration.font.font, 'mono');
  await panel.locator('#extension-font-name').fill('Arial');
  assert.match(await panel.locator('#extension-font-preview').evaluate(node => getComputedStyle(node).fontFamily), /Arial/);
  await panel.locator('#extension-font-name').press('Enter');
  await panel.waitForFunction(() => document.querySelector('#extension-font-status').textContent.includes('已保存'));
  await eventually(async () => assert.match(await chat.locator('#sider-enhancement .bar').evaluate(node => getComputedStyle(node).fontFamily), /Arial/));
  pass('custom name preview, blank-name validation and Enter save work with real extension storage');

  for (const width of [320, 420]) for (const colorScheme of ['light', 'dark']) {
    await panel.setViewportSize({ width, height: 640 }); await panel.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await panel.locator('#extension-font-preview').scrollIntoViewIfNeeded();
    assert.equal(await panel.locator('#ai-settings-dialog').evaluate(node => node.scrollWidth > node.clientWidth), false);
    await panel.screenshot({ path: `tmp/browser/font-settings-${width}-${colorScheme}.png` });
    pass(`${width}px ${colorScheme}: expanded font settings and custom preview have no horizontal overflow`);
  }
  await panel.keyboard.press('Escape'); await panel.reload(); await open();
  assert.equal(await panel.locator('#extension-font').inputValue(), 'custom');
  assert.equal(await panel.locator('#extension-font-name').inputValue(), 'Arial');
  let backup = (await request({ type: 'SIDER_CONFIGURATION_EXPORT' })).backup;
  assert.deepEqual(backup.configuration.font, { font: 'custom', customFont: 'Arial' });
  const old = structuredClone(backup); delete old.configuration.font;
  const result = await request({ type: 'SIDER_CONFIGURATION_IMPORT', backup: old, expected: backup.configuration });
  assert.equal(result.ok, true, result.error);
  await eventually(async () => assert.equal(await panel.locator('#extension-font').inputValue(), 'system'));
  pass('font persists after reload, exports from the real worker and old backups restore the system default');
  await panel.locator('#extension-font').selectOption('yahei');
  await panel.waitForFunction(() => document.querySelector('#extension-font-status').textContent.includes('已保存'));
  await panel.locator('#extension-font-reset').click();
  await eventually(async () => assert.equal(await panel.locator('html').evaluate(node => node.style.getPropertyValue('--sider-font-family')), DEFAULT_FONT_FAMILY));
  assert.equal(await panel.locator('#extension-font').inputValue(), 'system');
  pass('restore-default button resets the live UI and saved font');
  assert.deepEqual(errors, []);
  await writeFile('tmp/browser/font-settings-results.json', JSON.stringify({ fixtureOnly: true, checks, errors }, null, 2));
} finally {
  await context?.close(); await Promise.all([new Promise(resolve => tls.close(resolve)), new Promise(resolve => sourceServer.close(resolve))]);
}
