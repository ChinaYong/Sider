import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from './browser.js';

await mkdir('tmp/browser', { recursive: true });
const bundle = await build({ stdin: { contents: `
import { applyGeminiDefaults } from './src/content/gemini-defaults.js';
import { mountGeminiMenu } from './tests/fixtures/gemini-menu.js';
window.mount = options => { document.querySelector('#native-controls')?.remove(); window.fixture = mountGeminiMenu(document, options); };
window.apply = settings => applyGeminiDefaults(document, settings);
`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife' });
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html; charset=utf-8');
  res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : `<!doctype html><style>
body{font:16px system-ui;margin:12px}textarea{width:240px;height:60px}button{padding:10px}gem-menu{display:block;width:270px}gem-menu-item{display:block;padding:8px;cursor:pointer}.selected{font-weight:bold}[hidden]{display:none!important}
</style><textarea id="draft">保留我的问题</textarea><script src="/fixture.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const checks = [];
let browser;
try {
  browser = await chromium.launchPersistentContext(path.resolve('tmp/browser/gemini-defaults-' + Date.now()), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true,
  });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/app`);
  for (const compact of [false, true]) {
    await page.setViewportSize({ width: compact ? 320 : 1000, height: 840 });
    await page.evaluate(options => mount(options), { compact, inline: compact, changeDelay: 50, submenuDelay: 50 });
    for (const [model, thinkingLevel] of [['pro', 'high'], ['argon', 'medium'], ['flash', 'low'], ['flash-lite', 'high']]) {
      await page.locator('#draft').focus();
      await page.locator('#draft').evaluate(node => node.setSelectionRange(1, 3));
      const result = await page.evaluate(settings => apply(settings), { geminiModel: model, geminiThinkingLevel: thinkingLevel });
      assert.equal(result.complete, true, JSON.stringify(result));
      assert.equal(await page.locator('[role="menu"]').count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'draft');
      assert.deepEqual(await page.locator('#draft').evaluate(node => [node.value, node.selectionStart, node.selectionEnd]), ['保留我的问题', 1, 3]);
      // Verify through independently opened native controls, including checkmarks.
      await page.locator('#native-picker').click();
      assert.equal(await page.locator('[data-model].selected').getAttribute('data-model'), model);
      await page.locator('[value="thinking_level"]').click();
      await page.locator('[data-level="' + thinkingLevel + '"]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-level].selected').getAttribute('data-level'), thinkingLevel);
      if (model === 'argon') await page.screenshot({ path: `tmp/browser/gemini-menu-${compact ? 'compact' : 'desktop'}.png` });
      await page.locator('#native-picker').click();
      const before = await page.evaluate(() => ({ ...fixture.counts }));
      assert.equal((await page.evaluate(settings => apply(settings), { geminiModel: model, geminiThinkingLevel: thinkingLevel })).complete, true);
      const after = await page.evaluate(() => ({ ...fixture.counts }));
      assert.equal(after.models, before.models); assert.equal(after.thinking, before.thinking);
      checks.push(`${compact ? 'compact inline' : 'desktop submenu'}: ${model}/${thinkingLevel}, native checkmarks, idempotence and draft/focus`);
    }
  }
  await page.evaluate(() => mount({ submenuDelay: 1000 }));
  await page.locator('#draft').focus();
  await page.evaluate(() => { window.pending = apply({ geminiModel: 'flash-lite', geminiThinkingLevel: 'high' }); });
  await page.locator('html[data-sider-gemini-auto]').waitFor();
  await page.locator('#draft').press('ArrowRight');
  assert.equal((await page.evaluate(() => pending)).reason, 'user-interaction');
  assert.equal(await page.locator('[role="menu"]').count(), 0);
  assert.equal(await page.evaluate(() => fixture.counts.thinking), 0);
  assert.equal(await page.locator('#draft').inputValue(), '保留我的问题');
  checks.push('trusted keyboard interaction cancels pending hydration and removes owned menus');
  assert.deepEqual(errors, []);
  await writeFile('tmp/browser/gemini-defaults-result.json', JSON.stringify({ checks, errors, fixtureOnly: true }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
