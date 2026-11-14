import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  automaticPreferenceWrite, installGeminiPreferenceInterceptor, isGeminiAppRoute,
  patchGeminiCatalog, patchGeminiPreferences, rewriteGeminiFrame,
} from '../src/content/gemini-preference-interceptor.js';

const ids = { 'flash-lite': '1111111111111111', flash: '2222222222222222', pro: '3333333333333333', argon: '4444444444444444' };
const labels = { 'flash-lite': 'Flash-Lite', flash: 'Flash', pro: 'Pro', argon: 'Argon' };
const levels = { low: 1, medium: 4, high: 2 };

function catalog() {
  const data = [];
  data[15] = Object.entries(ids).map(([name, id]) => [id, labels[name]]);
  data[24] = [null, Object.values(labels).map(label => [[null, null, null, null, label], [[1, '低'], [4, '中'], [2, '高']], 1])];
  return data;
}

function preferences() {
  const prefs = Array(208).fill(null);
  prefs[0] = '保留😀';
  prefs[99] = ids.flash;
  prefs[164] = null;
  prefs[207] = { 265: 1, 280: 42 };
  return [prefs];
}

function frame(rpc, data) {
  const row = JSON.stringify([['wrb.fr', rpc, JSON.stringify(data), null, null, null, 'generic']]);
  return ")]}'\n\n" + (row.length + 2) + '\n' + row + '\n';
}

function decoded(body, rpc) {
  for (const line of body.split('\n')) {
    try {
      const rows = JSON.parse(line);
      const row = Array.isArray(rows) && rows.find(item => item?.[0] === 'wrb.fr' && item?.[1] === rpc);
      if (row) return JSON.parse(row[2]);
    } catch { /* Other lines contain framing or XSSI prefix. */ }
  }
  return null;
}

function preferenceWrite(field, value) {
  const prefs = Array(field).fill(null);
  prefs[field - 1] = value;
  const input = JSON.stringify([prefs, null, [field]]);
  return new URLSearchParams({ 'f.req': JSON.stringify([[['L5adhe', input, null, 'generic']]]), at: 'not-a-real-token' }).toString();
}

for (const model of Object.keys(ids)) for (const [thinkingLevel, expected] of Object.entries(levels)) {
  test(`catalog prepares ${model} and preserves the configured ${thinkingLevel} across the initial model change`, () => {
    const input = catalog();
    const result = patchGeminiCatalog(input, { model, thinkingLevel });
    assert.deepEqual(result, { modelId: ids[model], thinkingLevel: expected });
    for (const choice of input[24][1]) assert.equal(choice[2], expected);
  });
}

test('catalog leaves unrelated or unsupported model levels alone', () => {
  const input = catalog();
  input[24][1].push([[null, null, null, null, 'Other service'], [[1, '低'], [2, '高']], 1]);
  input[24][1].push([[null, null, null, null, 'Flash'], [[1, '低']], 1]);
  assert.deepEqual(patchGeminiCatalog(input, { model: 'argon', thinkingLevel: 'high' }), { modelId: ids.argon, thinkingLevel: 2 });
  assert.equal(input[24][1][4][2], 1);
  assert.equal(input[24][1][5][2], 1);
});

test('unknown, duplicate, and unavailable model choices remain untouched', () => {
  const unknown = catalog();
  assert.equal(patchGeminiCatalog(unknown, { model: 'unknown', thinkingLevel: 'high' }), null);
  const duplicate = catalog(); duplicate[15].push([ids.argon, 'Argon']);
  assert.equal(patchGeminiCatalog(duplicate, { model: 'argon', thinkingLevel: 'high' }), null);
  const unavailable = catalog(); unavailable[24][1][3][1] = [[1, '低']];
  assert.equal(patchGeminiCatalog(unavailable, { model: 'argon', thinkingLevel: 'high' }), null);
  assert.equal(unavailable[24][1][0][2], 1);
});

test('preference replacement preserves unrelated fields and recognises sparse thinking values', () => {
  const input = preferences();
  assert.deepEqual(patchGeminiPreferences(input, { modelId: ids.argon, thinkingLevel: 4 }), { modelId: ids.argon, thinkingLevel: 4 });
  assert.equal(input[0][0], '保留😀');
  assert.equal(input[0][99], ids.argon);
  assert.equal(input[0][164], ids.argon);
  assert.deepEqual(input[0][207], { 265: 4, 280: 42 });
  const invalid = preferences(); invalid[0][99] = 'invalid/model';
  assert.equal(patchGeminiPreferences(invalid, { modelId: ids.argon, thinkingLevel: 4 }), null);
  assert.equal(invalid[0][164], null);
});

test('thinking preference uses the correct dense or sparse position without losing other fields', () => {
  const target = { modelId: ids.argon, thinkingLevel: 2 };
  const absent = preferences();
  absent[0][207] = null;
  assert.deepEqual(patchGeminiPreferences(absent, target), target);
  assert.deepEqual(absent[0][208], { 265: 2 });
  assert.equal(absent[0][0], '保留😀');

  const dense = preferences();
  dense[0].length = 270;
  dense[0][207] = null;
  dense[0][264] = 1;
  dense[0][269] = { 280: 42 };
  assert.deepEqual(patchGeminiPreferences(dense, target), target);
  assert.equal(dense[0][264], 2);
  assert.deepEqual(dense[0][269], { 280: 42 });

  const incompatible = preferences();
  incompatible[0][207] = { notANumericField: true };
  assert.equal(patchGeminiPreferences(incompatible, target), null);
  assert.equal(incompatible[0][99], ids.flash);
  assert.equal(incompatible[0][164], null);
  const incompatibleLevel = preferences();
  incompatibleLevel[0][207][265] = 'unrecognised';
  assert.equal(patchGeminiPreferences(incompatibleLevel, target), null);
  assert.equal(incompatibleLevel[0][99], ids.flash);
});

test('a delayed catalog does not prevent a recognised thinking preference from being set', async t => {
  const dom = new JSDOM('', { url: 'https://gemini.google.com/app' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.assign(window, { Response, Request, Headers, URLSearchParams });
  const calls = [];
  window.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    return new Response(url.includes('otAQ7b') ? frame('otAQ7b', catalog()) : frame('ESY5D', preferences()));
  };
  const controller = installGeminiPreferenceInterceptor(window, { catalogTimeoutMs: 20 });
  controller.receive({ geminiModel: 'argon', geminiThinkingLevel: 'high' });
  const base = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=';
  const response = await window.fetch(base + 'ESY5D');
  const prefs = decoded(await response.text(), 'ESY5D')[0];
  assert.equal(prefs[207][265], 2);
  assert.equal(prefs[99], ids.flash, 'the unknown model ID must not be guessed');
  assert.equal(window.document.documentElement.getAttribute('data-sider-gemini-defaults'), 'thinking-prepared');
  const write = new Request(base + 'L5adhe', { method: 'POST', body: preferenceWrite(265, 2) });
  await window.fetch(write);
  assert.equal(calls.length, 1, 'the automatic thinking write must not escape');
  await window.fetch(base + 'otAQ7b');
  assert.equal(window.document.documentElement.getAttribute('data-sider-gemini-defaults'), 'thinking-prepared');
});

test('length-delimited frames preserve unrelated data and reject unknown lengths', () => {
  const original = frame('ESY5D', preferences());
  const updated = rewriteGeminiFrame(original, 'ESY5D', data => patchGeminiPreferences(data, { modelId: ids.pro, thinkingLevel: 2 }));
  assert.ok(updated);
  const lines = updated.body.split('\n');
  assert.equal(Number(lines[2]), lines[3].length + 2);
  assert.equal(decoded(updated.body, 'ESY5D')[0][0], '保留😀');
  assert.equal(decoded(updated.body, 'ESY5D')[0][99], ids.pro);
  assert.equal(rewriteGeminiFrame(original.replace(/\n\d+\n/, '\n1\n'), 'ESY5D', data => patchGeminiPreferences(data, { modelId: ids.pro, thinkingLevel: 2 })), null);
  assert.equal(rewriteGeminiFrame(original, 'other', () => true), null);
  const unsafe = preferences(); unsafe[0][20] = 2 ** 60;
  assert.equal(rewriteGeminiFrame(frame('ESY5D', unsafe), 'ESY5D', data => patchGeminiPreferences(data, { modelId: ids.pro, thinkingLevel: 2 })), null);
});

test('only matching single automatic model or thinking writes are acknowledged', () => {
  const target = { modelId: ids.argon, thinkingLevel: 4 };
  assert.equal(automaticPreferenceWrite(preferenceWrite(100, ids.argon), target), 100);
  assert.equal(automaticPreferenceWrite(preferenceWrite(165, ids.argon), target), 165);
  assert.equal(automaticPreferenceWrite(preferenceWrite(265, 4), target), 265);
  assert.equal(automaticPreferenceWrite(preferenceWrite(100, ids.pro), target), null);
  assert.equal(automaticPreferenceWrite(preferenceWrite(265, 2), target), null);
  assert.equal(automaticPreferenceWrite(preferenceWrite(5, true), target), null);
  assert.equal(automaticPreferenceWrite(preferenceWrite(100, ids.argon), { thinkingLevel: 4 }), null);
  const sparsePrefs = Array(264).fill(null); sparsePrefs.push({ 265: 4 });
  const sparseWrite = new URLSearchParams({ 'f.req': JSON.stringify([[['L5adhe', JSON.stringify([sparsePrefs, null, [265]])]]]) }).toString();
  assert.equal(automaticPreferenceWrite(sparseWrite, target), 265);
  const batched = new URLSearchParams({ 'f.req': JSON.stringify([[['L5adhe', '[]'], ['other', '[]']]]) }).toString();
  assert.equal(automaticPreferenceWrite(batched, target), null);
});

test('ordinary app routes are recognised while Spark and downloads are excluded', () => {
  for (const route of ['/app', '/app/conversation', '/u/1/app', '/u/1/app/conversation']) assert.equal(isGeminiAppRoute(route), true);
  for (const route of ['/spark', '/u/1/spark', '/app/download', '/settings']) assert.equal(isGeminiAppRoute(route), false);
});

test('fetch startup applies model and thinking without clicking or sending the automatic preference write', async t => {
  const dom = new JSDOM('<button id="picker">Model</button>', { url: 'https://gemini.google.com/app', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.assign(window, { Response, Request, Headers, URLSearchParams });
  const calls = [];
  let shortPreference = false;
  let clicks = 0;
  window.document.querySelector('#picker').addEventListener('click', () => { clicks++; });
  window.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url.includes('otAQ7b')) return new Response(frame('otAQ7b', catalog()), { status: 200 });
    if (url.includes('ESY5D')) return new Response(frame('ESY5D', shortPreference ? [[null, null, true]] : preferences()), { status: 200 });
    return new Response('forwarded', { status: 200 });
  };
  const controller = installGeminiPreferenceInterceptor(window);
  controller.receive({ geminiModel: 'argon', geminiThinkingLevel: 'medium' });
  const base = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=';
  const status = await window.fetch(base + 'otAQ7b');
  assert.equal(decoded(await status.text(), 'otAQ7b')[24][1][3][2], 4);
  const prefs = await window.fetch(base + 'ESY5D');
  const saved = decoded(await prefs.text(), 'ESY5D')[0];
  assert.equal(saved[99], ids.argon);
  assert.equal(saved[164], ids.argon);
  assert.equal(saved[207][265], 4);
  const write = new Request(base + 'L5adhe', { method: 'POST', body: preferenceWrite(100, ids.argon) });
  const result = await window.fetch(write);
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(clicks, 0);
  assert.equal(window.document.documentElement.getAttribute('data-sider-gemini-defaults'), 'prepared');
  await window.fetch(new Request(base + 'L5adhe', { method: 'POST', body: preferenceWrite(100, ids.pro) }));
  assert.equal(calls.length, 3, 'a different manual selection must reach Gemini');
  const aborted = new AbortController();
  const cancelledWrite = new Request(base + 'L5adhe', { method: 'POST', body: preferenceWrite(100, ids.argon), signal: aborted.signal });
  aborted.abort();
  await window.fetch(cancelledWrite);
  assert.equal(calls.length, 4, 'an aborted request must not receive a synthetic success');
  await window.fetch(base + 'otAQ7b');
  assert.equal(window.document.documentElement.getAttribute('data-sider-gemini-defaults'), 'prepared');
  shortPreference = true;
  const otherPreference = await window.fetch(base + 'ESY5D');
  assert.deepEqual(decoded(await otherPreference.text(), 'ESY5D'), [[null, null, true]]);
  assert.equal(window.document.documentElement.getAttribute('data-sider-gemini-defaults'), 'prepared');
});

test('unknown account catalog falls back to the original response', async t => {
  const dom = new JSDOM('', { url: 'https://gemini.google.com/app' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.assign(window, { Response, Request, Headers, URLSearchParams });
  const data = catalog(); data[15] = [];
  const original = frame('otAQ7b', data);
  window.fetch = async () => new Response(original, { status: 200 });
  const controller = installGeminiPreferenceInterceptor(window);
  controller.receive({ geminiModel: 'argon', geminiThinkingLevel: 'high' });
  const response = await window.fetch('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b');
  assert.equal(await response.text(), original);
  assert.equal(window.document.documentElement.getAttribute('data-sider-gemini-defaults'), 'catalog-unavailable');
  assert.deepEqual(JSON.parse(window.document.documentElement.getAttribute('data-sider-gemini-catalog')), { unavailable: true });
});

test('the current catalog is published even if the saved model is no longer available', async t => {
  const dom = new JSDOM('', { url: 'https://gemini.google.com/app' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.assign(window, { Response, Request, Headers, URLSearchParams });
  const data = catalog(); data[2] = 'private-account-data';
  const original = frame('otAQ7b', data);
  window.fetch = async () => new Response(original, { status: 200 });
  const controller = installGeminiPreferenceInterceptor(window);
  controller.receive({ geminiModel: 'id:retired-model', geminiThinkingLevel: 'level:2' });
  const response = await window.fetch('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b');
  assert.equal(await response.text(), original);
  const published = window.document.documentElement.getAttribute('data-sider-gemini-catalog');
  assert.equal(JSON.parse(published).models.length, 4);
  assert.equal(published.includes('private-account-data'), false);
});

test('a batched model catalog and preference response uses configuration published before startup', async t => {
  const dom = new JSDOM('', { url: 'https://gemini.google.com/app' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.assign(window, { Response, Request, Headers, URLSearchParams });
  window.document.documentElement.setAttribute('data-sider-gemini-preferences', JSON.stringify({ geminiModel: 'pro', geminiThinkingLevel: 'high' }));
  const rows = JSON.stringify([
    ['wrb.fr', 'otAQ7b', JSON.stringify(catalog()), null, null, null, 'generic'],
    ['wrb.fr', 'ESY5D', JSON.stringify(preferences()), null, null, null, 'generic'],
  ]);
  window.fetch = async () => new Response(")]}'\n\n" + (rows.length + 2) + '\n' + rows + '\n', { status: 200 });
  installGeminiPreferenceInterceptor(window);
  const response = await window.fetch(new window.URL('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b,ESY5D'));
  const body = await response.text();
  assert.equal(decoded(body, 'otAQ7b')[24][1][2][2], 2);
  assert.equal(decoded(body, 'ESY5D')[0][99], ids.pro);
  assert.equal(window.document.documentElement.hasAttribute('data-sider-gemini-preferences'), false);
});
