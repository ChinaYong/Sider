import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractChatGPTCatalog, chatgptPresetValue, validateChatGPTCatalog } from '../src/chatgpt-catalog.js';
import { normalizeAIWebSettings, validateAIWebSettings } from '../src/ai-web.js';
import { chatgptPreferenceStateSpan, installChatGPTPreferenceInterceptor, isChatGPTNewChat, patchChatGPTInitRequest, patchChatGPTModelDefaults, patchChatGPTPreferences } from '../src/content/chatgpt-preference-interceptor.js';

function models() {
  return {
    default_model_slug: 'new-auto',
    models: [
      { slug: 'new-instant', tags: [] }, { slug: 'new-thinking', tags: [], configurable_thinking_effort: true, thinking_efforts: [{ thinking_effort: 'standard' }, { thinking_effort: 'extended' }] },
      { slug: 'old-thinking', tags: [], configurable_thinking_effort: true, thinking_efforts: [{ thinking_effort: 'standard' }, { thinking_effort: 'extended' }] }, { slug: 'work-only', is_work_mode_model: true },
      { slug: 'hidden-only', tags: ['hidden'] },
    ],
    versions: [
      { id: 'latest', display_text_for_intelligence: 'GPT New', enabled: true,
        slugs: ['new-instant', 'new-thinking', 'work-only', 'hidden-only'], intelligence_presets: [
          { model_slug: 'new-instant', title: 'Instant', preset_type: 'available' },
          { model_slug: 'new-thinking', thinking_effort: 'standard', title: 'Medium', preset_type: 'available' },
          { model_slug: 'new-thinking', thinking_effort: 'extended', title: 'High', preset_type: 'available' },
          { model_slug: 'work-only', title: 'Work', preset_type: 'available' },
          { model_slug: 'hidden-only', title: 'Hidden', preset_type: 'available' },
        ] },
      { id: 'old', display_text_for_intelligence: 'GPT Old', enabled: true, slugs: ['old-thinking'], intelligence_presets: [
        { model_slug: 'old-thinking', thinking_effort: 'standard', title: 'Standard', preset_type: 'available' },
        { model_slug: 'old-thinking', thinking_effort: 'extended', title: 'Locked', preset_type: 'locked' },
      ] },
    ],
    privateAccountData: 'not published',
  };
}

function preferences() {
  return { settings: { last_used_model_config: { slugs: { default: 'new-thinking', web: 'new-thinking', ios_app: 'ios-model' },
    juices: { default: { 'new-thinking': 'extended' }, web: { 'new-thinking': 'extended' }, ios_app: { 'new-thinking': 'extended' } } }, unrelated: 'keep' }, other: 'keep' };
}

const selected = { model: 'version:old', preset: 'preset:old-thinking:standard' };
const initPayload = () => ({ conversation_id: null, conversation_origin: null, gizmo_id: null, requested_default_model: null,
  system_hints: null, timezone: 'Asia/Shanghai', timezone_offset_min: -480 });

test('new chat init requests carry the configured model without rewriting other raw JSON', () => {
  const catalog = extractChatGPTCatalog(models());
  const body = `{ "large": 9007199254740993, "conversation_id": null, "conversation_origin": null, "gizmo_id": null, "requested_default_model" : null, "system_hints": null, "timezone": "Asia/Shanghai", "timezone_offset_min": -480 }`;
  const updated = patchChatGPTInitRequest(body, catalog, selected);
  assert.equal(updated?.model, 'old-thinking');
  assert.equal(updated?.body, body.replace('"requested_default_model" : null', '"requested_default_model" : "old-thinking"'));
});

test('quota checks, custom contexts, explicit models and unknown payloads are not changed', () => {
  const catalog = extractChatGPTCatalog(models());
  const quota = { conversation_id: null, system_hints: null, timezone: 'Asia/Shanghai', timezone_offset_min: -480 };
  const cases = [quota, { ...initPayload(), conversation_id: 'existing' }, { ...initPayload(), gizmo_id: 'custom' },
    { ...initPayload(), conversation_origin: 'project' }, { ...initPayload(), requested_default_model: 'explicit' },
    { ...initPayload(), system_hints: ['special'] }, { ...initPayload(), requested_default_model: 42 }];
  for (const body of cases) assert.equal(patchChatGPTInitRequest(JSON.stringify(body), catalog, selected), null);
  assert.equal(patchChatGPTInitRequest('{"conversation_id":null,"conversation_id":"existing"}', catalog, selected), null);
  assert.equal(patchChatGPTInitRequest('not JSON', catalog, selected), null);
  assert.equal(patchChatGPTInitRequest(JSON.stringify(initPayload()), catalog, { ...selected, preset: 'preset:old-thinking:extended' }), null);
});

test('model default applies only the selected supported thinking effort and preserves other metadata', () => {
  const source = models(), catalog = extractChatGPTCatalog(source);
  const raw = JSON.stringify(source).replace(/}$/, ',"large":9007199254740993}');
  const updated = patchChatGPTModelDefaults(raw, source, catalog, selected);
  const parsed = JSON.parse(updated);
  assert.equal(parsed.models.find(model => model.slug === 'old-thinking').default_thinking_effort, 'standard');
  assert.equal(Object.hasOwn(parsed.models.find(model => model.slug === 'new-thinking'), 'default_thinking_effort'), false);
  assert.deepEqual(parsed.versions, source.versions);
  assert.ok(updated.endsWith('"large":9007199254740993}'));
  assert.equal(patchChatGPTModelDefaults(raw, source, catalog, { model: 'version:latest', preset: 'preset:new-instant:' }), null);
  assert.equal(patchChatGPTModelDefaults(raw, source, catalog, { ...selected, preset: 'preset:old-thinking:extended' }), null, 'the locked preset must not be applied');
  const unknown = models(); unknown.models[2].thinking_efforts = [{ thinking_effort: 'extended' }];
  assert.equal(patchChatGPTModelDefaults(JSON.stringify(unknown), unknown, catalog, selected), null);
});

test('catalog uses web picker versions and presets, excluding internal and Work models', () => {
  const catalog = extractChatGPTCatalog(models());
  assert.deepEqual(catalog.versions.map(item => item.label), ['GPT New', 'GPT Old']);
  assert.deepEqual(catalog.versions[0].presets.map(item => [item.label, chatgptPresetValue(item)]), [
    ['Instant', 'preset:new-instant:'], ['Medium', 'preset:new-thinking:standard'], ['High', 'preset:new-thinking:extended'],
  ]);
  assert.equal(catalog.versions[1].presets[1].available, false);
  assert.equal(JSON.stringify(catalog).includes('privateAccountData'), false);
  assert.equal(extractChatGPTCatalog({ models: [], versions: [] }), null);
  assert.equal(validateChatGPTCatalog({ versions: [{ ...catalog.versions[0], id: '../bad' }] }), null);
});

test('new settings default to the website and validate dynamically supplied identifiers', () => {
  assert.equal(normalizeAIWebSettings().chatgptModel, 'site-default');
  assert.equal(normalizeAIWebSettings().chatgptPreset, 'site-default');
  const settings = validateAIWebSettings({ activeSiteId: 'chatgpt', customSites: [], chatgptModel: selected.model, chatgptPreset: selected.preset });
  assert.equal(settings.chatgptModel, selected.model); assert.equal(settings.chatgptPreset, selected.preset);
  assert.throws(() => validateAIWebSettings({ ...settings, chatgptModel: 'version:../bad' }), /ChatGPT 默认模型/);
  assert.throws(() => validateAIWebSettings({ ...settings, chatgptPreset: 'preset:bad:../unsafe' }), /ChatGPT 推理档位/);
});

test('preferences change only the target web/default model and effort, not other settings', () => {
  const data = preferences(), catalog = extractChatGPTCatalog(models());
  assert.deepEqual(patchChatGPTPreferences(data, catalog, selected), { slug: 'old-thinking', effort: 'standard' });
  assert.equal(data.settings.last_used_model_config.slugs.default, 'old-thinking');
  assert.equal(data.settings.last_used_model_config.slugs.web, 'old-thinking');
  assert.equal(data.settings.last_used_model_config.slugs.ios_app, 'ios-model');
  assert.equal(data.settings.last_used_model_config.juices.web['old-thinking'], 'standard');
  assert.deepEqual(data.settings.last_used_model_config.juices.ios_app, { 'new-thinking': 'extended' });
  assert.equal(data.settings.unrelated, 'keep'); assert.equal(data.other, 'keep');
  const instant = preferences();
  assert.deepEqual(patchChatGPTPreferences(instant, catalog, { model: 'version:latest', preset: 'preset:new-instant:' }), { slug: 'new-instant', effort: null });
  assert.deepEqual(instant.settings.last_used_model_config.juices.web, { 'new-thinking': 'extended' });
});

test('unavailable choices, stale values and unrecognised settings are left untouched', () => {
  const catalog = extractChatGPTCatalog(models()), data = preferences(), original = JSON.stringify(data);
  for (const settings of [
    { model: 'version:missing', preset: selected.preset },
    { model: 'version:old', preset: 'preset:old-thinking:extended' },
    { model: 'version:old', preset: 'preset:new-thinking:standard' },
  ]) assert.equal(patchChatGPTPreferences(data, catalog, settings), null);
  assert.equal(JSON.stringify(data), original);
  const unknown = preferences(); unknown.settings.last_used_model_config.juices.web = 'unknown';
  assert.equal(patchChatGPTPreferences(unknown, catalog, selected), null);
  assert.equal(unknown.settings.last_used_model_config.slugs.web, 'new-thinking');
});

test('new chat route does not override existing chats or explicitly selected URLs', () => {
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/?temporary-chat=true']) assert.equal(isChatGPTNewChat(new URL(url)), true);
  for (const url of ['https://chatgpt.com/c/existing', 'https://chatgpt.com/?model=explicit', 'https://other.example/']) assert.equal(isChatGPTNewChat(new URL(url)), false);
});

test('fetch publishes sanitised dynamic choices and prepares preferences without clicking', async t => {
  const dom = new JSDOM('<button id="picker">Model</button>', { url: 'https://chatgpt.com/', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.assign(window, { Response, Request, Headers, URLSearchParams });
  let clicks = 0; window.document.querySelector('#picker').addEventListener('click', () => { clicks++; });
  window.fetch = async input => new Response(JSON.stringify(String(input).includes('/models') ? models() : preferences()), { headers: { 'content-type': 'application/json' } });
  const controller = installChatGPTPreferenceInterceptor(window);
  controller.receive({ chatgptModel: selected.model, chatgptPreset: selected.preset });
  const pending = window.fetch('https://chatgpt.com/backend-api/settings/user');
  const modelResponse = await window.fetch('https://chatgpt.com/backend-api/models');
  const catalog = JSON.parse(window.document.documentElement.getAttribute('data-sider-chatgpt-catalog'));
  assert.equal(catalog.versions[0].label, 'GPT New'); assert.equal(JSON.stringify(catalog).includes('privateAccountData'), false);
  assert.equal((await modelResponse.json()).privateAccountData, 'not published');
  const result = await (await pending).json();
  assert.equal(result.settings.last_used_model_config.slugs.web, 'old-thinking');
  assert.equal(result.settings.last_used_model_config.juices.web['old-thinking'], 'standard');
  assert.equal(result.settings.unrelated, 'keep'); assert.equal(clicks, 0);
  assert.equal(window.document.documentElement.getAttribute('data-sider-chatgpt-defaults'), 'prepared');
});

test('a new-chat init waits for the live catalog and forwards only a supported requested model', async t => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' }); t.after(() => dom.window.close());
  const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
  const calls = [];
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, body: init?.body ?? (input instanceof Request ? await input.clone().text() : null) });
    return new Response(JSON.stringify(url.includes('/models') ? models() : { intended_default_model_slug: 'old-thinking', model_limits: [] }));
  };
  const controller = installChatGPTPreferenceInterceptor(window);
  controller.receive({ chatgptModel: selected.model, chatgptPreset: selected.preset });
  const pending = window.fetch('https://chatgpt.com/backend-api/conversation/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(initPayload()) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0, 'the init request waits for account-specific model availability');
  await window.fetch('https://chatgpt.com/backend-api/models');
  assert.equal((await (await pending).json()).intended_default_model_slug, 'old-thinking');
  assert.equal(JSON.parse(calls[1].body).requested_default_model, 'old-thinking');
  assert.equal(window.document.documentElement.getAttribute('data-sider-chatgpt-init'), 'requested');
});

test('slow startup still applies a valid preference, but requests after the startup window remain unchanged', async t => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' }); t.after(() => dom.window.close());
  const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const calls = [];
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, body: init?.body });
    return new Response(JSON.stringify(url.includes('/models') ? models() : url.includes('/settings/') ? preferences() : {}));
  };
  const controller = installChatGPTPreferenceInterceptor(window);
  controller.receive({ chatgptModel: selected.model, chatgptPreset: selected.preset });
  await window.fetch('https://chatgpt.com/backend-api/models');
  now += 12000;
  const settings = await (await window.fetch('https://chatgpt.com/backend-api/settings/user')).json();
  assert.equal(settings.settings.last_used_model_config.slugs.web, 'old-thinking');
  const request = () => window.fetch('https://chatgpt.com/backend-api/conversation/init', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(initPayload()),
  });
  await request();
  assert.equal(JSON.parse(calls.at(-1).body).requested_default_model, 'old-thinking');
  now += 49000;
  await request();
  assert.equal(JSON.parse(calls.at(-1).body).requested_default_model, null);
});

test('host sync receives a validated in-memory model selection without writing storage or other messages', async t => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' }); t.after(() => dom.window.close());
  const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
  window.fetch = async () => new Response(JSON.stringify(models()));
  const messages = [];
  window.addEventListener('message', event => messages.push(event.data));
  const controller = installChatGPTPreferenceInterceptor(window);
  controller.receive({ chatgptModel: selected.model, chatgptPreset: selected.preset });
  const state = { 'chatgpt-last-selected-model-v1': { slug: 'new-thinking', thinkingEffort: 'extended', versionId: 'latest' }, other: 'keep' };
  window.dispatchEvent(new window.MessageEvent('message', { source: window, origin: window.location.origin, data: { type: 'persisted-atom-sync', state } }));
  await window.fetch('https://chatgpt.com/backend-api/models');
  const updates = messages.filter(data => data.type === 'persisted-atom-updated');
  assert.deepEqual(updates, ['chatgpt-last-selected-model-v1', 'chatgpt-last-selected-home-model-v1'].map(key => ({
    type: 'persisted-atom-updated', key,
    value: { slug: 'old-thinking', thinkingEffort: 'standard', versionId: 'old' }, deleted: false })));
  assert.equal(state['chatgpt-last-selected-model-v1'].slug, 'new-thinking');
  assert.equal(state.other, 'keep'); assert.equal(window.localStorage.length, 0); assert.equal(window.document.cookie, '');
  assert.equal(window.document.documentElement.getAttribute('data-sider-chatgpt-selection'), 'prepared');
});

test('a late host sync applies the selection after the site processes its original sync', async t => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' }); t.after(() => dom.window.close());
  const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
  window.fetch = async () => new Response(JSON.stringify(models()));
  const controller = installChatGPTPreferenceInterceptor(window);
  controller.receive({ chatgptModel: selected.model, chatgptPreset: selected.preset });
  await window.fetch('https://chatgpt.com/backend-api/models');
  const received = [];
  window.addEventListener('message', event => received.push(event.data.type));
  window.dispatchEvent(new window.MessageEvent('message', { source: window, origin: window.location.origin,
    data: { type: 'persisted-atom-sync', state: {} } }));
  await Promise.resolve();
  assert.deepEqual(received, ['persisted-atom-sync', 'persisted-atom-updated', 'persisted-atom-updated']);
});

test('SPA navigation from an existing chat reapplies defaults after the initial startup window', async t => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/c/existing' }); t.after(() => dom.window.close());
  const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
  let now = 0; t.mock.method(Date, 'now', () => now);
  const calls = [], updates = [];
  let releaseSettings;
  window.fetch = async (input, init) => {
    calls.push({ input, init });
    if (String(input).includes('/settings/user')) return new Promise(resolve => { releaseSettings = () => resolve(new Response(JSON.stringify(preferences()))); });
    return new Response(JSON.stringify(String(input).includes('/models') ? models() : {}));
  };
  window.addEventListener('message', event => { if (event.data?.type === 'persisted-atom-updated') updates.push(event.data); });
  installChatGPTPreferenceInterceptor(window).receive(selected);
  window.dispatchEvent(new window.MessageEvent('message', { source: window, origin: window.location.origin,
    data: { type: 'persisted-atom-sync', state: {} } }));
  await window.fetch('https://chatgpt.com/backend-api/models');
  assert.equal(updates.length, 0, 'loading an existing conversation must not select another model');
  const staleSettings = window.fetch('https://chatgpt.com/backend-api/settings/user');
  now = 120000;
  window.history.pushState({ route: 'new' }, '', '/');
  await Promise.resolve();
  assert.deepEqual(updates.map(item => item.key).sort(), ['chatgpt-last-selected-home-model-v1', 'chatgpt-last-selected-model-v1']);
  for (const item of updates) assert.deepEqual(item.value, { slug: 'old-thinking', thinkingEffort: 'standard', versionId: 'old' });
  releaseSettings();
  assert.equal((await (await staleSettings).json()).settings.last_used_model_config.slugs.web, 'new-thinking', 'a delayed settings response from the previous route is not rewritten');
  await window.fetch('https://chatgpt.com/backend-api/conversation/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(initPayload()) });
  assert.equal(JSON.parse(calls.at(-1).init.body).requested_default_model, 'old-thinking');
  assert.equal(window.localStorage.length, 0);
  window.history.replaceState({}, '', '/c/another');
  const count = updates.length;
  await Promise.resolve();
  assert.equal(updates.length, count, 'other existing conversations remain unchanged');
  window.history.replaceState({}, '', '/?model=explicit');
  await Promise.resolve();
  assert.equal(updates.length, count, 'explicit model URLs remain unchanged');
  window.history.replaceState({}, '', '/');
  await Promise.resolve();
  assert.equal(updates.length, count + 2);
  const travel = direction => new Promise(resolve => { window.addEventListener('popstate', resolve, { once: true }); window.history[direction](); });
  await travel('back');
  assert.equal(updates.length, count + 2);
  await travel('forward');
  await Promise.resolve();
  assert.equal(updates.length, count + 4, 'history navigation back to the new-chat route reapplies defaults');
});

test('a prepared default survives composing and late first-turn init but yields to manual interaction', async t => {
  for (const [selector, type, expected] of [
    ['#prompt-textarea', 'input', 'old-thinking'],
    ['#prompt-textarea', 'keydown', 'old-thinking'],
    ['#send-icon', 'pointerdown', 'old-thinking'],
    ['#manual', 'pointerdown', null],
    ['#manual', 'keydown', null],
  ]) {
    const dom = new JSDOM('<textarea id="prompt-textarea"></textarea><button data-testid="send-button"><span id="send-icon"></span></button><button id="manual">Other model</button>', { url: 'https://chatgpt.com/' });
    const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
    const calls = [], handlers = new Map(), originalAdd = window.document.addEventListener;
    // jsdom cannot create trusted user events; capture the installed handlers.
    window.document.addEventListener = function (type, handler, options) {
      if (['pointerdown', 'keydown', 'input'].includes(type)) handlers.set(type, handler);
      return originalAdd.call(this, type, handler, options);
    };
    let now = 0;
    const clock = t.mock.method(Date, 'now', () => now);
    window.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(String(input).includes('/models') ? models() : {}));
    };
    try {
      const controller = installChatGPTPreferenceInterceptor(window);
      controller.receive(selected);
      window.dispatchEvent(new window.MessageEvent('message', { source: window, origin: window.location.origin,
        data: { type: 'persisted-atom-sync', state: {} } }));
      await window.fetch('https://chatgpt.com/backend-api/models');
      assert.equal(window.document.documentElement.getAttribute('data-sider-chatgpt-selection'), 'prepared');
      now = 120000;
      handlers.get(type)({ isTrusted: true, type, target: window.document.querySelector(selector) });
      const sendInit = body => window.fetch('https://chatgpt.com/backend-api/conversation/init', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      await sendInit(initPayload());
      assert.equal(JSON.parse(calls.at(-1).init.body).requested_default_model, expected, selector + '/' + type);
      const existing = { ...initPayload(), conversation_id: 'existing' };
      await sendInit(existing);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), existing);
      const explicit = { ...initPayload(), requested_default_model: 'manual-model' };
      await sendInit(explicit);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), explicit);
      window.history.replaceState(null, '', '/c/local-chatgpt%3A00000000-0000-4000-8000-000000000001');
      await sendInit(initPayload());
      assert.equal(JSON.parse(calls.at(-1).init.body).requested_default_model, expected);
      window.history.replaceState(null, '', '/c/local-chatgpt%3A00000000-0000-4000-8000-000000000001?model=explicit');
      await sendInit(initPayload());
      assert.equal(JSON.parse(calls.at(-1).init.body).requested_default_model, null);
      window.history.replaceState(null, '', '/c/existing');
      await sendInit(initPayload());
      assert.equal(JSON.parse(calls.at(-1).init.body).requested_default_model, null);
    } finally { clock.mock.restore(); window.close(); }
  }
});

test('host selection is skipped for unknown syncs, unavailable presets, site defaults and existing conversations', async t => {
  for (const [url, raw, event] of [
    ['https://chatgpt.com/', { ...selected, preset: 'preset:old-thinking:extended' }, { type: 'persisted-atom-sync', state: {} }],
    ['https://chatgpt.com/', { model: 'site-default', preset: 'site-default' }, { type: 'persisted-atom-sync', state: {} }],
    ['https://chatgpt.com/c/existing', selected, { type: 'persisted-atom-sync', state: {} }],
    ['https://chatgpt.com/', selected, { type: 'persisted-atom-sync', state: 'unknown' }],
    ['https://chatgpt.com/', selected, { type: 'unrelated', state: {} }],
  ]) {
    const dom = new JSDOM('', { url });
    const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
    window.fetch = async () => new Response(JSON.stringify(models()));
    const messages = []; window.addEventListener('message', item => messages.push(item.data));
    const controller = installChatGPTPreferenceInterceptor(window);
    controller.receive(raw);
    window.dispatchEvent(new window.MessageEvent('message', { source: window, origin: window.location.origin, data: event }));
    await window.fetch('https://chatgpt.com/backend-api/models');
    await Promise.resolve();
    assert.equal(messages.some(item => item.type === 'persisted-atom-updated'), false, url);
    assert.equal(window.document.documentElement.getAttribute('data-sider-chatgpt-selection'), null);
    dom.window.close();
  }
});

test('Request objects preserve explicit settings and server fallback instead of spoofing availability', async t => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' }); t.after(() => dom.window.close());
  const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
  const calls = [];
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/models')) return new Response(JSON.stringify(models()));
    const request = new Request(input, init);
    calls.push({ body: await request.text(), fixtureHeader: request.headers.get('x-fixture') });
    return new Response(JSON.stringify({ intended_default_model_slug: 'new-thinking', model_limits: [{ model_slug: 'old-thinking' }] }));
  };
  const controller = installChatGPTPreferenceInterceptor(window);
  controller.receive({ chatgptModel: selected.model, chatgptPreset: selected.preset });
  await window.fetch('https://chatgpt.com/backend-api/models');
  const request = new Request('https://chatgpt.com/backend-api/conversation/init', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture': 'preserved' }, body: JSON.stringify(initPayload()) });
  const result = await (await window.fetch(request)).json();
  assert.equal(JSON.parse(calls[0].body).requested_default_model, 'old-thinking');
  assert.equal(calls[0].fixtureHeader, 'preserved');
  assert.equal(result.intended_default_model_slug, 'new-thinking');
  assert.deepEqual(result.model_limits, [{ model_slug: 'old-thinking' }]);
  const explicit = JSON.stringify({ ...initPayload(), requested_default_model: 'explicit' });
  await window.fetch('https://chatgpt.com/backend-api/conversation/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: explicit });
  assert.equal(calls[1].body, explicit);
});

test('quota requests do not wait for configuration, and aborting a pending init preserves native cancellation', async t => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' }); t.after(() => dom.window.close());
  const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
  const calls = [];
  window.fetch = async (input, init) => {
    calls.push(init);
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Response('{}');
  };
  installChatGPTPreferenceInterceptor(window, { configTimeoutMs: 5000 });
  const quota = JSON.stringify({ conversation_id: null, system_hints: null, timezone: 'Asia/Shanghai', timezone_offset_min: -480 });
  await window.fetch('https://chatgpt.com/backend-api/conversation/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: quota });
  assert.equal(calls.length, 1); assert.equal(calls[0].body, quota);
  const abort = new AbortController(), body = JSON.stringify(initPayload());
  const pending = window.fetch('https://chatgpt.com/backend-api/conversation/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls.length, 2); assert.equal(calls[1].body, body);
});

test('unrecognised catalogs and unsafe numbers inside the preference state fall back to the original response', async t => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' }); t.after(() => dom.window.close());
  const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
  let currentModels = models(), data = preferences(); data.settings.last_used_model_config.unknown = 2 ** 60;
  window.fetch = async input => new Response(JSON.stringify(String(input).includes('/models') ? currentModels : data));
  const controller = installChatGPTPreferenceInterceptor(window);
  controller.receive({ chatgptModel: selected.model, chatgptPreset: selected.preset });
  await window.fetch('https://chatgpt.com/backend-api/models');
  assert.equal((await (await window.fetch('https://chatgpt.com/backend-api/settings/user')).json()).settings.last_used_model_config.slugs.web, 'new-thinking');
  currentModels = {};
  await window.fetch('https://chatgpt.com/backend-api/models');
  assert.deepEqual(JSON.parse(window.document.documentElement.getAttribute('data-sider-chatgpt-catalog')), { unavailable: true });
});

test('preference rewriting preserves unrelated raw JSON and exact large integers', async t => {
  const dom = new JSDOM('', { url: 'https://chatgpt.com/' }); t.after(() => dom.window.close());
  const window = dom.window; Object.assign(window, { Response, Request, Headers, URLSearchParams });
  const raw = `{ "other": 9007199254740993, "settings": ${JSON.stringify(preferences().settings)} , "suffix": [1, 2] }`;
  window.fetch = async input => new Response(String(input).includes('/models') ? JSON.stringify(models()) : raw);
  const controller = installChatGPTPreferenceInterceptor(window);
  controller.receive({ chatgptModel: selected.model, chatgptPreset: selected.preset });
  await window.fetch('https://chatgpt.com/backend-api/models');
  const changed = await (await window.fetch('https://chatgpt.com/backend-api/settings/user')).text();
  assert.ok(changed.startsWith('{ "other": 9007199254740993, "settings": '));
  assert.ok(changed.endsWith(' , "suffix": [1, 2] }'));
  assert.equal(JSON.parse(changed).settings.last_used_model_config.slugs.web, 'old-thinking');
  const duplicate = '{"settings":{"last_used_model_config":{}},"settings":{"last_used_model_config":{"keep":true}}}';
  const span = chatgptPreferenceStateSpan(duplicate);
  assert.deepEqual(JSON.parse(duplicate.slice(...span)), { keep: true });
});
