import { createServer } from 'node:http';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from './browser.js';

const root = path.resolve('tmp/browser'), stamp = Date.now(), loads = {};
const server = createServer((request, response) => {
  const name = new URL(request.url, 'http://localhost').searchParams.get('name') || 'source';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (!request.url.startsWith('/ai')) { response.end('<!doctype html><title>Carrier source</title><p>Local source page</p>'); return; }
  loads[name] = (loads[name] || 0) + 1;
  response.end(`<!doctype html><meta charset="utf-8"><title>Local AI ${name}</title>
<textarea aria-label="Draft"></textarea><input type="file" multiple><div id="files"></div><details><summary>Original page state</summary></details>
<script>
const iframeId=crypto.randomUUID(),editor=document.querySelector('textarea'),input=document.querySelector('input'),details=document.querySelector('details');
let uploads=[],generation={active:false,chunk:''};
function report(){parent.postMessage({type:'AI_REPORT',state:{iframeId,draft:editor.value,uploads,inputFiles:[...input.files].map(file=>file.name),expanded:details.open,generation}},'*')}
editor.addEventListener('input',report);details.addEventListener('toggle',report);
input.addEventListener('change',async()=>{uploads=await Promise.all([...input.files].map(async file=>({name:file.name,content:await file.text(),size:file.size})));document.querySelector('#files').textContent=uploads.map(file=>file.name).join(',');report()});
window.addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='SEED_AI')return;editor.value=event.data.draft;editor.dispatchEvent(new Event('input',{bubbles:true}));details.open=event.data.expanded;generation=event.data.generation;const transfer=new DataTransfer();for(const file of event.data.files)transfer.items.add(new File([file.content],file.name,{type:'text/plain'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))});report();
</script>`);
});

const results = { fixtureOnly: true, productionCarrierChanged: false, realAISitesTested: false, checks: [], capabilities: [],
  nativeEvents: [], observations: [], gatePassed: false };
let context, worker, controls;
async function eventually(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { return await check(); }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
  }
}
const pass = message => { results.checks.push(message); console.log('PASS ' + message); };
const capability = (id, status, evidence) => {
  results.capabilities.push({ id, status, evidence }); console.log(`${status} ${id}`);
};
const snapshot = async (name, instanceId) => eventually(async () => {
  const value = await worker.evaluate(({ name, instanceId }) => Object.values(carrierProbe.documents)
    .filter(value => value.name === name && value.ai && (!instanceId || value.instanceId === instanceId)).at(-1), { name, instanceId });
  assert.ok(value?.documentId && value.ai?.iframeId, `Waiting for native carrier ${name}`); return value;
});
const seed = async (name, label, instanceId) => {
  const carrier = await snapshot(name, instanceId), data = { draft: `Unsent ${label} 草稿`, expanded: true,
    generation: { active: true, chunk: `in-progress ${label}` }, files: [{ name: `${label}.txt`, content: `${label} original UTF-8 材料` }] };
  await controls.evaluate(({ instanceId, seed }) => chrome.runtime.sendMessage({ type: 'SEED_CARRIER', instanceId, seed }), { instanceId: carrier.instanceId, seed: data });
  return eventually(async () => {
    const current = await snapshot(name, carrier.instanceId); assert.equal(current.ai.draft, data.draft);
    assert.equal(current.ai.uploads[0]?.content, data.files[0].content); assert.equal(current.ai.expanded, true);
    assert.deepEqual(current.ai.generation, data.generation); return current;
  });
};
const click = async (operation, config) => {
  await controls.bringToFront(); await controls.evaluate(value => { probeConfig = value; probeResult = null; }, config);
  await controls.locator('#' + operation).click();
  await eventually(async () => { const result = await controls.evaluate(() => probeResult); assert.ok(result); assert.equal(result.ok, true, result.error); });
};
const preserve = async (before, after) => {
  assert.equal(after.documentId, before.documentId); assert.equal(after.instanceId, before.instanceId);
  assert.deepEqual(after.ai, before.ai);
  const live = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
  assert.ok(live.some(context => context.documentId === before.documentId), 'stored telemetry must correspond to an actually live native document');
};

try {
  await mkdir(root, { recursive: true }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const extension = path.join(root, `carrier-extension-${stamp}`);
  await cp('tests/browser/fixtures/side-panel-carrier', extension, { recursive: true });
  context = await chromium.launchPersistentContext(path.join(root, `carrier-profile-${stamp}`), {
    ...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}), headless: true, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server'],
  });
  results.browser = context.browser().version();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname, origin = `http://127.0.0.1:${server.address().port}`;
  const carrierPath = name => `carrier.html?name=${name}&site=${encodeURIComponent(`${origin}/ai?name=${name}`)}`;
  controls = await context.newPage(); await controls.goto(`chrome-extension://${extensionId}/controls.html`);
  const a = await context.newPage(), b = await context.newPage(), independent = await context.newPage(), differentSite = await context.newPage();
  await a.goto(origin + '/a'); await b.goto(origin + '/b'); await independent.goto(origin + '/independent');
  await differentSite.goto(`http://localhost:${server.address().port}/different-host`);
  const tabs = await worker.evaluate(async () => chrome.tabs.query({}));
  const aTab = tabs.find(tab => tab.url === origin + '/a'), bTab = tabs.find(tab => tab.url === origin + '/b'),
    independentTab = tabs.find(tab => tab.url === origin + '/independent'), differentTab = tabs.find(tab => tab.url?.includes('/different-host'));
  assert.ok(aTab && bTab && independentTab && differentTab);
  await worker.evaluate(value => chrome.sidePanel.setOptions(value), { path: carrierPath('global'), enabled: true });
  await click('open-global', { windowId: aTab.windowId }); await a.bringToFront();
  const global = await seed('global', 'shared');
  const globalLoadCount = loads.global;
  await b.bringToFront(); await a.bringToFront();
  await preserve(global, await snapshot('global')); assert.equal(loads.global, globalLoadCount);
  await a.bringToFront(); await eventually(async () => assert.ok(await a.evaluate(() => innerWidth < outerWidth - 150)));
  await b.bringToFront(); await eventually(async () => assert.ok(await b.evaluate(() => innerWidth < outerWidth - 150)));
  capability('shared-instance-across-tabs', '通过', { documentId: global.documentId, iframeId: global.ai.iframeId, loads: globalLoadCount });
  pass('the same native window document, iframe, draft, FileList, file contents and page state survive A/B switching');

  await worker.evaluate(value => chrome.sidePanel.setOptions(value), { tabId: independentTab.id, path: carrierPath('independent'), enabled: true });
  await click('open-tab', { tabId: independentTab.id }); await independent.bringToFront();
  const originalIndependent = await seed('independent', 'independent');
  await a.bringToFront(); await independent.bringToFront(); await a.bringToFront();
  await preserve(global, await snapshot('global')); await preserve(originalIndependent, await snapshot('independent'));
  assert.equal(loads.global, globalLoadCount); assert.equal(loads.independent, 1);
  capability('shared-and-existing-independent-coexist', '通过', { globalDocumentId: global.documentId, independentDocumentId: originalIndependent.documentId });
  pass('native global and contextual carriers retain distinct original documents and unsent state');

  // Promotion creates a new global document rather than moving the tab document.
  await worker.evaluate(value => chrome.sidePanel.setOptions(value), { path: carrierPath('independent'), enabled: true });
  await click('open-global', { windowId: aTab.windowId }); await b.bringToFront();
  const promoted = await eventually(async () => {
    const values = await worker.evaluate(() => Object.values(carrierProbe.documents).filter(value => value.name === 'independent' && value.ai && value.documentId));
    assert.equal(values.length, 2, 'waiting for both native instances with exactly the same URL'); return values.at(-1);
  });
  const promotedPreserved = promoted.documentId === originalIndependent.documentId && promoted.ai.iframeId === originalIndependent.ai.iframeId;
  capability('promote-existing-independent-without-reload', promotedPreserved ? '通过' : '不支持', {
    originalDocumentId: originalIndependent.documentId, newDocumentId: promoted.documentId, originalDraft: originalIndependent.ai.draft, newDraft: promoted.ai.draft });
  await preserve(originalIndependent, await snapshot('independent', originalIndependent.instanceId));
  pass('promotion is measured by live document identity; the original independent carrier is preserved');

  const pinned = await seed('independent', 'pinned', promoted.instanceId);
  // Demotion uses exactly the same URL. It must retain the same instance to pass.
  await worker.evaluate(value => chrome.sidePanel.setOptions(value), { tabId: bTab.id, path: carrierPath('independent'), enabled: true });
  await click('open-tab', { tabId: bTab.id }); await b.bringToFront();
  const demoted = await eventually(async () => {
    const values = await worker.evaluate(() => Object.values(carrierProbe.documents).filter(value => value.name === 'independent' && value.ai && value.documentId));
    assert.equal(values.length, 3, 'waiting for the contextual carrier with the same path'); return values.at(-1);
  });
  capability('unpin-transfer-to-current-tab-without-reload', demoted.documentId === pinned.documentId && demoted.ai.iframeId === pinned.ai.iframeId ? '通过' : '不支持', {
    originalDocumentId: pinned.documentId, newDocumentId: demoted.documentId, originalDraft: pinned.ai.draft, newDraft: demoted.ai.draft });
  pass('using the same panel URL in a tab is measured separately from preserving the window instance');

  await a.bringToFront();
  await worker.evaluate(value => chrome.sidePanel.setOptions(value), { tabId: differentTab.id, enabled: false });
  await differentSite.bringToFront();
  const width = await eventually(async () => { const value = await differentSite.evaluate(() => ({ inner: innerWidth, outer: outerWidth })); assert.ok(value.outer > 0); return value; });
  const hidden = width.inner > width.outer - 150;
  results.observations.push({ type: 'disabled-tab-window-carrier-width', ...width });
  await click('close-global', { windowId: aTab.windowId }); await differentSite.bringToFront();
  await eventually(async () => assert.ok(await differentSite.evaluate(() => innerWidth > outerWidth - 150)));
  await worker.evaluate(() => { carrierProbe.activationAttempt = null; carrierProbe.attemptOnActivation = true; });
  // Expire the prior extension click. Worker evaluations do not create a user gesture.
  await new Promise(resolve => setTimeout(resolve, 6500)); await a.bringToFront();
  const activation = await eventually(async () => { const value = await worker.evaluate(() => carrierProbe.activationAttempt); assert.ok(value); return value; });
  capability('same-site-hide-and-automatic-restore', hidden && activation.ok ? '通过' : '不支持', { disabledTabHidden: hidden, dimensions: width, activation });
  if (!activation.ok) assert.match(activation.error, /user gesture/i);
  pass('cross-domain hiding and gesture-free restoration are checked after the extension gesture expires');

  // A global API close has no tabId; cached contextual instances are separate.
  const closeEvents = await worker.evaluate(() => carrierProbe.events.filter(event => event.type === 'closed' && event.tabId === undefined));
  assert.ok(closeEvents.length > 0); await preserve(originalIndependent, await snapshot('independent', originalIndependent.instanceId));
  results.observations.push({ type: 'global-close-event', event: closeEvents.at(-1), independentDocumentId: originalIndependent.documentId });
  capability('native-close-button-group-classification', '尚未验证', {
    apiCloseConfirmed: true, reason: 'The browser-chrome close button was not clicked; API close events alone do not verify native button behavior.' });
  pass('API window-close emits a window-scoped native event and leaves the existing contextual carrier intact');

  results.nativeEvents = await worker.evaluate(() => carrierProbe.events);
  results.documentInventory = await worker.evaluate(() => carrierProbe.documents);
  results.loads = loads;
  results.gatePassed = results.capabilities.every(item => item.status === '通过');
  console.log('Native carrier implementation gate: ' + (results.gatePassed ? 'PASS' : 'NOT PASSED'));
  if (process.argv.includes('--require-gate') && !results.gatePassed) process.exitCode = 1;
} catch (error) {
  results.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  if (worker) {
    results.nativeEvents = await worker.evaluate(() => carrierProbe.events).catch(() => results.nativeEvents);
    results.documentInventory = await worker.evaluate(() => carrierProbe.documents).catch(() => ({}));
    results.nativeContexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).catch(() => []);
  }
  results.loads = loads;
  await writeFile(path.join(root, 'side-panel-capabilities-result.json'), JSON.stringify(results, null, 2));
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
