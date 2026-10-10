import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from './browser.js';

// Real panel markup/styles with an isolated settings backend; no account or permissions are changed.
await mkdir('tmp/browser', { recursive: true });
const bundle = await build({ stdin: { contents: `
import { installAIWebSettings } from './src/ai-web-settings.js';
import { createMotion, installDialogMotion } from './src/motion.js';
import { normalizeAIWebSettings } from './src/ai-web.js';
let settings=normalizeAIWebSettings();
window.saved=[];
const chrome={runtime:{id:'ui-fixture',async sendMessage(message){
  if(message.type==='SIDER_AI_WEB_SETTINGS_SAVE') {
    await new Promise(resolve=>setTimeout(resolve,250));
    settings=message.settings; window.saved.push(settings);
  }
  return {ok:true,settings};
}},permissions:{async request(){return true}}};
installDialogMotion(document, createMotion(window));
installAIWebSettings({document,chrome});
`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife' });
const assets = new Map(await Promise.all(['panel.html', 'styles.css'].map(async name => ['/' + name, await readFile('dist/' + name)])));
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
  res.end(req.url === '/panel.js' ? bundle.outputFiles[0].text : assets.get(req.url) || '');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launchPersistentContext(path.resolve('tmp/browser/ui-profile-' + Date.now()), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true,
  });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
  for (const width of [320, 420]) for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 640 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.locator('#ai-settings-toggle').click();
    await page.locator('#ai-save-settings').waitFor({ state: 'visible' });
    await page.screenshot({ path: `tmp/browser/ui-settings-${width}-${colorScheme}.png` });
    await page.locator('#ai-site-settings > summary').click();
    await page.locator('[data-site-id="gemini"] > summary').click();
    await page.locator('#ai-gemini-spark').check();
    await page.locator('[data-site-id="claude"] > summary').click();
    await page.locator('[data-site-id="claude"] button').click();
    if (!await page.locator('#ai-selector-send').isVisible()) await page.locator('#ai-custom-fields details > summary').click();
    await page.locator('#ai-selector-send').fill('#unsaved-send');
    await page.locator('#ai-active-site').selectOption('gemini');
    assert.equal(await page.locator('#ai-active-site').inputValue(), 'chatgpt');
    assert.equal(await page.locator('#ai-selector-send').inputValue(), '#unsaved-send');
    assert.equal(await page.locator('#ai-settings-dialog').evaluate(node => node.scrollWidth > node.clientWidth), false);
    // Footer remains usable when long nested settings overflow a short side panel.
    const rect = await page.locator('#ai-save-settings').boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 640);
    await page.screenshot({ path: `tmp/browser/ui-editor-${width}-${colorScheme}.png` });
    await page.locator('#ai-cancel-edit').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#ai-settings-dialog').open);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ai-settings-toggle');
    console.log(`PASS ${width}px ${colorScheme}: no overflow, sticky save, preserved draft, Escape and focus`);
  }
  await page.locator('#ai-settings-toggle').click();
  await page.locator('#ai-active-site').selectOption('gemini');
  await page.locator('#ai-save-settings').click();
  assert.equal(await page.locator('#ai-save-settings').getAttribute('aria-busy'), 'true');
  await page.waitForFunction(() => !document.querySelector('#ai-settings-dialog').open);
  await page.locator('#ai-settings-toggle').click();
  assert.equal(await page.locator('#ai-active-site').inputValue(), 'gemini');
  assert.equal(await page.evaluate(() => saved.length), 1);
  console.log('PASS saving feedback and a single persisted change survive reopening');
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
