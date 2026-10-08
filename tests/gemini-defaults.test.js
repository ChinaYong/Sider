import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { applyGeminiDefaults, installGeminiDefaults } from '../src/content/gemini-defaults.js';

const defaults = { geminiModel: 'pro', geminiExtendedThinking: true };
const labels = { 'flash-lite': '3.5 Flash-Lite', flash: '3.8 Flash', pro: '3.1 Pro' };

function fixture(t, { model = 'flash-lite', thinking = false, native = false, compact = false, url = 'https://gemini.google.com/app', toggleDelay = 0, ignoreThinking = false } = {}) {
  const { window } = new JSDOM('<textarea id="draft">保留我的问题</textarea><button id="picker" aria-controls="menu" aria-expanded="false"></button><div id="menu" role="menu" hidden></div>', { url, pretendToBeVisual: true });
  const { document } = window;
  const picker = document.querySelector('#picker');
  const menu = document.querySelector('#menu');
  const counts = { opened: 0, models: 0, thinking: 0 };
  let current = model; let extended = thinking;
  if (compact) {
    const host = document.createElement('gem-button'); host.setAttribute('data-test-id', 'bard-mode-menu-button');
    picker.before(host); host.append(picker);
    picker.removeAttribute('aria-controls'); picker.removeAttribute('aria-expanded');
  }
  const renderPicker = () => {
    if (compact) {
      picker.setAttribute('aria-label', '打开模式选择器，当前模式为“Gemini ' + (current === 'flash-lite' ? 'Flash-Lite' : current === 'flash' ? 'Flash' : 'Pro') + '”');
      picker.innerHTML = '<span class="picker-primary-text">Gemini</span><span class="picker-secondary-text">' + (current === 'flash-lite' ? 'Flash-Lite' : current === 'flash' ? 'Flash' : 'Pro') + '</span>';
      for (const option of menu.querySelectorAll('[data-model]')) option.classList.toggle('selected', option.getAttribute('data-model') === current);
      return;
    }
    picker.setAttribute('aria-label', 'Open mode picker, currently ' + labels[current]);
    picker.textContent = 'Gemini ' + labels[current];
    if (native) {
      picker.setAttribute('data-test-id', 'bard-mode-menu-button');
      picker.classList.add('input-area-switch');
      if (extended) { const secondary = document.createElement('span'); secondary.className = 'picker-secondary-text'; secondary.textContent = '扩展思考'; picker.append(secondary); }
    }
  };
  const hideMenu = () => { menu.hidden = true; if (!compact) picker.setAttribute('aria-expanded', 'false'); };
  const showMenu = () => {
    counts.opened++;
    assert.ok(document.documentElement.hasAttribute('data-sider-gemini-auto'), 'auto menu is suppressed before it opens');
    menu.hidden = false; if (!compact) picker.setAttribute('aria-expanded', 'true');
    menu.focus();
  };
  picker.addEventListener('click', () => {
    if (compact && document.activeElement !== picker) return;
    if (compact ? !menu.hidden : picker.getAttribute('aria-expanded') === 'true') hideMenu(); else showMenu();
  });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') hideMenu(); });
  for (const [value, label] of Object.entries(labels)) {
    const option = document.createElement(native ? 'gem-menu-item' : 'button');
    option.setAttribute('role', 'menuitem'); option.setAttribute('data-model', value); option.textContent = label;
    option.addEventListener('click', () => { counts.models++; current = value; renderPicker(); hideMenu(); });
    menu.append(option);
  }
  const thinkingControl = document.createElement(native ? 'gem-menu-item' : 'button');
  thinkingControl.id = 'thinking';
  thinkingControl.setAttribute('role', native ? 'menuitem' : 'menuitemcheckbox');
  const renderThinking = () => {
    if (native) {
      thinkingControl.replaceChildren();
      const content = document.createElement('gem-menu-item-content');
      content.className = 'checkmark-only' + (extended ? ' selected' : '');
      content.textContent = '扩展思考 擅长解决复杂问题';
      if (extended) { const check = document.createElement('mat-icon'); check.setAttribute('fonticon', 'check'); content.prepend(check); }
      thinkingControl.append(content);
    } else { thinkingControl.textContent = 'Extended thinking'; thinkingControl.setAttribute('aria-checked', String(extended)); }
  };
  thinkingControl.addEventListener('click', () => {
    counts.thinking++;
    if (ignoreThinking) return;
    window.setTimeout(() => { extended = !extended; renderThinking(); renderPicker(); if (native) hideMenu(); }, toggleDelay);
  });
  menu.append(thinkingControl);
  renderPicker(); renderThinking();
  t.after(() => window.close());
  return { window, document, picker, menu, thinkingControl, counts, renderPicker, compact,
    set(model, thinking) { current = model; extended = thinking; renderPicker(); renderThinking(); },
  };
}

const apply = (f, settings = defaults, options = {}) => applyGeminiDefaults(f.document, settings, { timeoutMs: 700, stableMs: 0, ...options });
function clean(f) {
  assert.equal(f.picker.getAttribute('aria-expanded'), f.compact ? null : 'false');
  assert.equal(f.menu.hidden, true);
  assert.equal(f.document.documentElement.hasAttribute('data-sider-gemini-auto'), false);
  assert.equal(f.document.querySelector('[data-sider-gemini-auto-menu]'), null);
}

test('Gemini selects Pro, waits for thinking confirmation and closes the owned menu', async t => {
  const f = fixture(t, { toggleDelay: 80 });
  assert.equal((await apply(f)).complete, true);
  assert.match(f.picker.getAttribute('aria-label'), /3\.1 Pro/);
  assert.equal(f.thinkingControl.getAttribute('aria-checked'), 'true');
  assert.equal(f.counts.models, 1); assert.equal(f.counts.thinking, 1);
  clean(f);
});

test('native Chinese menuitems without aria-checked enable extended thinking exactly once', async t => {
  const f = fixture(t, { native: true, toggleDelay: 100 });
  const draft = f.document.querySelector('#draft'); draft.focus(); draft.setSelectionRange(2, 5);
  assert.equal((await apply(f)).complete, true);
  assert.ok(f.picker.querySelector('.picker-secondary-text'));
  assert.equal(f.counts.thinking, 1);
  assert.equal(draft.value, '保留我的问题'); assert.equal(f.document.activeElement, draft);
  assert.equal(draft.selectionStart, 2); assert.equal(draft.selectionEnd, 5);
  clean(f);
});

test('an already matching native model and thinking setting never opens the menu', async t => {
  const f = fixture(t, { native: true, model: 'pro', thinking: true });
  assert.equal((await apply(f)).complete, true);
  assert.equal(f.counts.opened, 0); assert.equal(f.counts.thinking, 0);
});

for (const model of ['flash', 'pro']) test('compact Gemini model badge is not mistaken for enabled extended thinking: ' + model, async t => {
  const f = fixture(t, { native: true, compact: true, model, thinking: false, toggleDelay: 80 });
  const draft = f.document.querySelector('#draft'); draft.focus(); draft.setSelectionRange(1, 3);
  assert.equal((await apply(f)).complete, true);
  assert.match(f.picker.getAttribute('aria-label'), /Gemini Pro/);
  assert.ok(f.thinkingControl.querySelector('[fonticon="check"]'));
  assert.equal(f.counts.models, model === 'pro' ? 0 : 1);
  assert.equal(f.counts.thinking, 1);
  assert.equal(f.document.activeElement, draft); assert.equal(draft.value, '保留我的问题');
  assert.equal(draft.selectionStart, 1); assert.equal(draft.selectionEnd, 3);
  clean(f);
});

test('compact picker verifies turning thinking off even though its model badge does not change', async t => {
  const f = fixture(t, { native: true, compact: true, model: 'pro', thinking: true });
  assert.equal((await apply(f, { geminiModel: 'pro', geminiExtendedThinking: false })).complete, true);
  assert.equal(f.thinkingControl.querySelector('[fonticon="check"]'), null);
  assert.equal(f.counts.thinking, 1); clean(f);
});

test('a noninteractive hydration placeholder is ignored until the real compact picker appears', async t => {
  const f = fixture(t, { native: true, compact: true, model: 'flash' });
  f.picker.parentElement.hidden = true;
  const placeholder = f.document.createElement('button'); placeholder.className = 'input-area-switch';
  placeholder.innerHTML = '<span>Gemini</span><span>Flash</span>'; f.document.body.append(placeholder);
  let loads = 0;
  let resolveResult;
  const completed = new Promise(resolve => { resolveResult = resolve; });
  const manager = installGeminiDefaults({ document:f.document, async getSettings() { loads++; return defaults; }, onResult:resolveResult });
  t.after(() => manager.dispose()); manager.start();
  await new Promise(resolve => f.window.setTimeout(resolve, 60));
  assert.equal(loads, 0, 'the placeholder must not consume the one-time default application');
  placeholder.remove(); f.picker.parentElement.hidden = false;
  assert.equal((await completed).complete, true);
  assert.equal(loads, 1); assert.equal(f.counts.thinking, 1); clean(f);
});

test('a rendered picker whose native menu is still hydrating is retried without reading settings twice', async t => {
  const f = fixture(t, { native: true });
  let first = true;
  f.picker.addEventListener('click', event => {
    if (first) { first = false; event.stopImmediatePropagation(); }
  }, true);
  let loads = 0;
  let resolveResult;
  const completed = new Promise(resolve => { resolveResult = resolve; });
  const manager = installGeminiDefaults({ document:f.document, applyTimeoutMs:700, retryDelayMs:30,
    async getSettings() { loads++; return defaults; }, onResult:resolveResult });
  t.after(() => manager.dispose()); manager.start();
  assert.equal((await completed).complete, true);
  assert.equal(loads, 1); assert.equal(f.counts.models, 1); assert.equal(f.counts.thinking, 1);
  clean(f);
});

test('hydration retries are bounded and disposal cancels the retry delay', async t => {
  const f = fixture(t, { native: true });
  let attempts = 0;
  f.picker.addEventListener('click', event => { attempts++; event.stopImmediatePropagation(); }, true);
  let resolveResult;
  const completed = new Promise(resolve => { resolveResult = resolve; });
  const manager = installGeminiDefaults({ document:f.document, applyTimeoutMs:70, retryDelayMs:20, onResult:resolveResult, settings:defaults });
  t.after(() => manager.dispose()); manager.start();
  assert.equal((await completed).reason, 'model-menu-missing'); assert.equal(attempts, 3); clean(f);
  let results = 0;
  const cancelled = installGeminiDefaults({ document:f.document, applyTimeoutMs:70, retryDelayMs:500, settings:defaults, onResult:()=>results++ });
  t.after(() => cancelled.dispose()); cancelled.start();
  await new Promise(resolve => f.window.setTimeout(resolve, 120));
  cancelled.dispose();
  await new Promise(resolve => f.window.setTimeout(resolve, 100));
  assert.equal(attempts, 4); assert.equal(results, 0); clean(f);
});

test('inline extended thinking can be turned off without re-toggling it', async t => {
  const f = fixture(t, { native: true, model: 'flash', thinking: true, toggleDelay: 90 });
  assert.equal((await apply(f, { geminiModel: 'flash', geminiExtendedThinking: false })).complete, true);
  assert.equal(f.picker.querySelector('.picker-secondary-text'), null);
  assert.equal(f.counts.thinking, 1);
  clean(f);
});

test('disabled models stop and clean up the menu', async t => {
  const f = fixture(t);
  f.document.querySelector('[data-model="pro"]').setAttribute('aria-disabled', 'true');
  assert.equal((await apply(f)).reason, 'model-unavailable');
  assert.equal(f.counts.models, 0); clean(f);
});

test('an unconfirmed thinking click is not repeatedly toggled, and timeout closes the menu', async t => {
  const f = fixture(t, { native: true, model: 'pro', ignoreThinking: true });
  const result = await apply(f, defaults, { timeoutMs: 180 });
  assert.equal(result.complete, false); assert.equal(result.reason, 'thinking-unconfirmed');
  assert.equal(f.counts.thinking, 1); clean(f);
});

test('a model menu already opened by the user is left alone', async t => {
  const f = fixture(t);
  f.menu.hidden = false; f.picker.setAttribute('aria-expanded', 'true');
  const result = await apply(f);
  assert.equal(result.reason, 'user-menu-open'); assert.equal(f.counts.models, 0);
  assert.equal(f.menu.hidden, false); assert.equal(f.counts.thinking, 0);
});

for (const wanted of [true, false]) test('two-stage thinking choices select the checked target for ' + wanted, async t => {
  const f = fixture(t, { model: 'pro', native: false });
  f.thinkingControl.remove();
  const level = f.document.createElement('button');
  level.setAttribute('role', 'menuitem'); level.setAttribute('aria-haspopup', 'menu'); level.setAttribute('aria-controls', 'thinking-menu'); level.textContent = 'Thinking level';
  f.menu.append(level);
  const sub = f.document.createElement('div'); sub.id = 'thinking-menu'; sub.setAttribute('role', 'menu'); sub.hidden = true;
  sub.innerHTML = '<button role="menuitemradio" aria-checked="' + wanted + '">Standard</button><button role="menuitemradio" aria-checked="' + !wanted + '">Extended</button>';
  f.document.body.append(sub);
  level.addEventListener('click', () => { f.menu.hidden = true; sub.hidden = false; });
  const choices = [...sub.children];
  for (const [index, choice] of choices.entries()) choice.addEventListener('click', () => {
    choices.forEach((node, i) => node.setAttribute('aria-checked', String(i === index)));
  });
  sub.addEventListener('keydown', event => { if (event.key === 'Escape') { sub.hidden = true; f.picker.setAttribute('aria-expanded', 'false'); } });
  const result = await apply(f, { geminiModel: 'pro', geminiExtendedThinking: wanted });
  assert.equal(result.complete, true);
  assert.equal(choices[wanted ? 1 : 0].getAttribute('aria-checked'), 'true');
  assert.equal(sub.hidden, true); clean(f);
});

test('only the controlled model menu is used when a hidden unrelated menu remains mounted', async t => {
  const f = fixture(t, { native: true });
  const other = f.document.createElement('div'); other.setAttribute('role', 'menu'); other.hidden = true;
  other.innerHTML = '<button role="menuitem">3.1 Pro</button>'; f.document.body.append(other);
  let wrongClicks = 0; other.addEventListener('click', () => wrongClicks++);
  assert.equal((await apply(f)).complete, true); assert.equal(wrongClicks, 0);
  assert.equal(other.hasAttribute('data-sider-gemini-auto-menu'), false);
});

test('Spark to app SPA navigation starts defaults even after the initial hydration timeout', async t => {
  const f = fixture(t, { native: true, url: 'https://gemini.google.com/spark' });
  let loads = 0;
  let resolveResult;
  const completed = new Promise(resolve => { resolveResult = resolve; });
  const manager = installGeminiDefaults({ document: f.document, timeoutMs: 30, routeIntervalMs: 10,
    async getSettings() { loads++; return defaults; }, onResult: resolveResult });
  t.after(() => manager.dispose());
  manager.start();
  await new Promise(resolve => f.window.setTimeout(resolve, 70));
  assert.equal(loads, 0); assert.equal(f.counts.opened, 0);
  f.window.history.pushState({}, '', '/app');
  const result = await completed;
  assert.equal(result.complete, true); assert.equal(loads, 1);
  clean(f);
  f.set('flash-lite', false);
  f.window.history.pushState({}, '', '/app/existing-conversation');
  await new Promise(resolve => f.window.setTimeout(resolve, 70));
  assert.equal(loads, 1);
  assert.match(f.picker.getAttribute('aria-label'), /Flash-Lite/);
});

test('delayed app hydration is applied once and SPA re-entry reads the latest defaults', async t => {
  const f = fixture(t, { native: true, url: 'https://gemini.google.com/spark' });
  f.picker.hidden = true;
  const results = [];
  let nextSettings = defaults;
  let completed;
  let waiting = new Promise(resolve => { completed = resolve; });
  const manager = installGeminiDefaults({ document: f.document, routeIntervalMs: 10,
    async getSettings() { return nextSettings; }, onResult: result => { results.push(result); completed(result); } });
  t.after(() => manager.dispose()); manager.start();
  f.window.history.pushState({}, '', '/app');
  await new Promise(resolve => f.window.setTimeout(resolve, 30));
  assert.equal(f.counts.opened, 0);
  f.picker.hidden = false;
  assert.equal((await waiting).complete, true);
  assert.equal(results.length, 1); assert.equal(results[0].complete, true);
  f.document.body.append(f.document.createElement('div'));
  await new Promise(resolve => f.window.setTimeout(resolve, 50));
  assert.equal(results.length, 1); assert.equal(f.counts.thinking, 1);
  f.window.history.pushState({}, '', '/spark');
  f.window.dispatchEvent(new f.window.PopStateEvent('popstate'));
  nextSettings = { geminiModel: 'flash', geminiExtendedThinking: false };
  waiting = new Promise(resolve => { completed = resolve; });
  f.window.history.pushState({}, '', '/app');
  f.window.dispatchEvent(new f.window.PopStateEvent('popstate'));
  assert.equal((await waiting).complete, true);
  assert.equal(results.length, 2); assert.match(f.picker.getAttribute('aria-label'), /3\.8 Flash/);
  assert.equal(f.picker.querySelector('.picker-secondary-text'), null);
  clean(f);
});

test('disposing during a pending state change aborts and removes temporary suppression', async t => {
  const f = fixture(t, { native: true, model: 'pro', ignoreThinking: true });
  const controller = new f.window.AbortController();
  const pending = apply(f, defaults, { signal: controller.signal });
  f.window.setTimeout(() => controller.abort('disposed'), 50);
  assert.equal((await pending).reason, 'disposed'); clean(f);
});
