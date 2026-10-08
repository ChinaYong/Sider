import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from './browser.js';

// Same source, fixtures and workload for before/after measurements. Instrumentation
// is bundled only into this harness; no measurement hooks ship in the extension.
const baseline = process.argv.includes('--baseline');
const label = baseline ? 'baseline' : 'optimized';
await mkdir('tmp/browser', { recursive: true });
const bundle = await build({ stdin: { contents: `
import { installEnhancement } from './src/content/enhancement.js';
import { createWebAdapter } from './src/content/adapters.js';
import { BUILTIN_AI_SITES } from './src/ai-web.js';
import { createTabContext } from './src/context.js';
import { presetTemplates, newTemplate } from './src/prompt-templates.js';
window.metrics={mounts:0,positions:0,chipRenders:0,expansions:0,mutations:0,scans:0};
const query=document.querySelectorAll.bind(document);
document.querySelectorAll=(...args)=>{metrics.scans++;return query(...args)};
const site=BUILTIN_AI_SITES.find(item=>item.id===new URL(location.href).searchParams.get('site'))||BUILTIN_AI_SITES[0];
const state={...createTabContext(1),revision:1,title:'长正文来源',url:'https://example.com/article',pageRequested:true,attachments:{url:false,page:{content:'正文资料与关键事实。'.repeat(7000),title:'长正文来源',url:'https://example.com/article',characterCount:70000}},templateSelections:{'preset-page':true}};
let templates=[...presetTemplates(),...Array.from({length:100},(_,i)=>newTemplate({id:'motion-item-'+i,name:'预设 '+i,text:'短提示 '+i,action:'append'}))];
window.calls=[];
const chrome={runtime:{async sendMessage(message){const r=message.request;calls.push(r.type);
if(r.type==='SIDER_TAB_TEMPLATE_SET'){state.templateSelections[r.id]=r.enabled;state.revision++}
if(r.type==='SIDER_PROMPT_TEMPLATES_SAVE'){templates=r.templates;state.revision++}
return {ok:true,context:structuredClone(state),templates:structuredClone(templates),needsAccess:false};}},storage:{onChanged:{addListener(){},removeListener(){}}}};
window.api=installEnhancement({document,chrome,bridgeId:'motion-fixture',adapter:createWebAdapter(document,site)});
new MutationObserver(records=>metrics.mutations+=records.length).observe(api.root,{subtree:true,childList:true,attributes:true,characterData:true});
window.resetMetrics=()=>{for(const key in metrics)metrics[key]=0};
`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife', plugins: [{ name: 'motion-measurements', setup(builder) {
  builder.onLoad({ filter: /enhancement\.js$/ }, async args => {
    let source = await readFile(args.path, 'utf8');
    for (const [name, metric] of [['mount', 'mounts'], ['positionPopover', 'positions'], ['renderChips', 'chipRenders']]) {
      source = source.replace(`function ${name}() {`, `function ${name}() { window.metrics && window.metrics.${metric}++;`);
    }
    source = source.replaceAll('expandTemplateItem(template, context,', '(window.metrics.expansions++, expandTemplateItem)(template, context,');
    return { contents: source, loader: 'js', resolveDir: path.dirname(args.path) };
  });
} }] });
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px system-ui}main{padding:12px;height:750px;display:flex;flex-direction:column;justify-content:flex-end}textarea{width:100%;height:70px;box-sizing:border-box}button{font:inherit}#stream{height:50px;overflow:auto}</style><main><div id="stream"></div><form><div data-composer-body><textarea id="prompt-textarea" aria-label="Ask ChatGPT"></textarea></div><button data-testid="send-button" type="button" aria-label="Send message">发送</button></form></main><button id="outside">外部按钮</button><script src="/harness.js"></script>`;
const assets = new Map(await Promise.all(['panel.html', 'panel.js', 'styles.css'].map(async name => ['/' + name, await readFile('dist/' + name)])));
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  res.setHeader('content-type', url.endsWith('.js') ? 'text/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
  res.end(url === '/harness.js' ? bundle.outputFiles[0].text : assets.get(url) || html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const results = { fixtureOnly: true, sourceHarness: true, label, scenarios: {} };
const checked = message => console.log('PASS ' + message);
try {
  browser = await chromium.launchPersistentContext(path.resolve('tmp/browser/motion-profile-' + Date.now()), { ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, viewport: { width: 420, height: 840 } });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?site=chatgpt`);
  await page.locator('[data-chip="page"]').waitFor();
  const cdp = await browser.newCDPSession(page);
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' });
  async function measure(name, action) {
    await page.waitForTimeout(250); await page.evaluate(() => resetMetrics());
    const start = performance.now(); await action(); await page.waitForTimeout(100);
    results.scenarios[name] = { ...await page.evaluate(() => metrics), wallMs: Math.round(performance.now() - start) };
  }
  await measure('idle', () => page.waitForTimeout(1200));
  await measure('typing', async () => { await page.locator('#prompt-textarea').pressSequentially('abcdefghijklmnopqrstuvwxyz0123456789', { delay: 12 }); });
  await measure('stream', () => page.evaluate(async () => { for (let i = 0; i < 60; i++) { document.querySelector('#stream').textContent = '正在回答 ' + i; await new Promise(requestAnimationFrame); } }));
  await page.locator('[data-pane="templates"]').click(); await page.waitForTimeout(250);
  await measure('scroll', () => page.locator('.popover').evaluate(async node => { for (let i = 0; i < 60; i++) { node.scrollTop += 3; await new Promise(requestAnimationFrame); } }));
  await page.locator('.popover').evaluate(node => { node.scrollTop = 0; });
  await measure('sort', async () => {
    const from = await page.locator('[data-sort-id="preset-selection"] [data-sort-handle]').boundingBox();
    await page.mouse.move(from.x + 5, from.y + 5); await page.mouse.down();
    await page.mouse.move(from.x + 5, from.y + 135, { steps: 25 }); await page.mouse.up();
  });
  const traceReady = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end'); const { stream } = await traceReady;
  let trace = ''; for (;;) { const part = await cdp.send('IO.read', { handle: stream }); trace += part.data; if (part.eof) break; } await cdp.send('IO.close', { handle: stream });
  await writeFile(`tmp/browser/motion-${label}-trace.json`, trace);
  if (!baseline) {
    assert.equal(results.scenarios.idle.expansions, 0);
    assert.equal(results.scenarios.typing.expansions, 0);
    assert.equal(results.scenarios.idle.mutations, 0);
    checked('unchanged sync and ordinary typing never expand long-body chips or rewrite their DOM');
    await page.locator('#close-pane').click();
    await page.locator('[data-pane="templates"]').evaluate(node => { node.click(); node.getRootNode().querySelector('#close-pane').click(); node.click(); });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.popover').evaluate(node => node.hidden || node.inert), false);
    checked('rapid close and reopen cancels stale exit completion');
    await page.locator('#outside').click(); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'outside');
    checked('outside close preserves the newly clicked focus');
    await page.locator('[data-pane="templates"]').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    assert.equal(await page.locator('[data-pane="templates"]').evaluate(node => node.getRootNode().activeElement === node), true);
    checked('Escape restores the popover opener');
    await page.locator('[data-pane="templates"]').click(); await page.waitForTimeout(220);
    await page.evaluate(() => resetMetrics());
    await page.evaluate(async () => { for (let i=0;i<200;i++) { dispatchEvent(new Event('scroll')); dispatchEvent(new Event('resize')); } await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    const positions = await page.evaluate(() => metrics.positions); assert.ok(positions <= 2, 'viewport events must coalesce to at most one position per frame');
    await page.locator('#close-pane').click(); await page.waitForTimeout(150); await page.evaluate(() => resetMetrics());
    await page.evaluate(async () => { for (let i=0;i<200;i++) dispatchEvent(new Event('scroll')); await new Promise(requestAnimationFrame); });
    assert.equal((await page.evaluate(() => metrics)).positions, 0);
    checked('viewport event bursts coalesce to one position per frame and closed popovers do no positioning');
    for (const width of [320, 420]) for (const colorScheme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 840 }); await page.emulateMedia({ colorScheme });
      await page.locator('[data-pane="templates"]').click(); await page.waitForTimeout(220);
      assert.equal(await page.locator('.popover').evaluate(node => node.scrollWidth > node.clientWidth), false);
      await page.screenshot({ path: `tmp/browser/motion-${width}-${colorScheme}.png` });
      await page.locator('#close-pane').click(); await page.waitForTimeout(150);
    }
    checked('320/420px light/dark popovers fit without horizontal overflow');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-pane="templates"]').click();
    assert.equal(await page.locator('.popover').evaluate(node => node.getAnimations().length), 0);
    await page.locator('#close-pane').click();
    assert.equal(await page.locator('.popover').evaluate(node => node.hidden), true);
    checked('reduced motion opens and closes immediately without animations');
    await page.evaluate(() => { api.dispose(); resetMetrics(); }); await page.waitForTimeout(1100);
    assert.equal(await page.locator('#sider-enhancement').count(), 0);
    assert.equal((await page.evaluate(() => metrics)).mounts, 0);
    checked('dispose removes the host and all scheduled mounting work');
    for (const site of ['gemini', 'claude']) {
      await page.goto(`http://127.0.0.1:${server.address().port}/?site=${site}`);
      await page.locator('[data-pane="templates"]').click(); await page.locator('#close-pane').click();
      await page.locator('#prompt-textarea').fill('保留草稿');
      assert.equal(await page.locator('#prompt-textarea').inputValue(), '保留草稿');
    }
    checked('Gemini/Claude adapters keep the native draft while opening and closing controls');
    const panel = await browser.newPage(); panel.on('pageerror', error => errors.push(error.message));
    await panel.addInitScript(() => { window.chrome = { runtime: { sendMessage: () => new Promise(resolve => { window.finishExport = resolve; }) } }; });
    await panel.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
    await panel.locator('#diagnostics-toggle').click();
    assert.equal(await panel.locator('#diagnostics-dialog').evaluate(node => node.open), true);
    await panel.keyboard.press('Escape');
    await panel.waitForFunction(() => !document.querySelector('#diagnostics-dialog').open);
    assert.equal(await panel.evaluate(() => document.activeElement.id), 'diagnostics-toggle');
    await panel.evaluate(() => { const dialog = document.querySelector('#diagnostics-dialog'); dialog.showModal(); dialog.close(); dialog.showModal(); });
    await panel.waitForTimeout(220);
    assert.equal(await panel.locator('#diagnostics-dialog').evaluate(node => node.open && !node.inert), true);
    await panel.locator('#close-diagnostics').click(); await panel.waitForTimeout(150);
    checked('built panel dialogs preserve native Escape/focus and cancel stale close completion');
    await panel.locator('#ai-settings-toggle').click();
    await panel.locator('#configuration-open').click();
    await panel.locator('#configuration-export').click(); await panel.keyboard.press('Escape');
    assert.equal(await panel.locator('#configuration-dialog').evaluate(node => node.open && !node.inert), true);
    await panel.evaluate(() => finishExport({ ok: false, error: 'fixture export failed' }));
    await panel.locator('#configuration-close').click(); await panel.waitForTimeout(150);
    assert.equal(await panel.locator('#configuration-dialog').evaluate(node => node.open), false);
    checked('busy configuration export keeps its Escape veto with animated modal closing');
    await panel.emulateMedia({ reducedMotion: 'reduce' });
    await panel.locator('#ai-close-settings').click();
    assert.equal(await panel.locator('#ai-settings-dialog').evaluate(node => node.open), false);
    checked('built panel respects reduced motion for modal completion');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results.scenarios, null, 2));
  await writeFile(`tmp/browser/motion-${label}-results.json`, JSON.stringify(results, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
