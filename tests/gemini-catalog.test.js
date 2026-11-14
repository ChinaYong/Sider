import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGeminiCatalog, geminiLevelNumber, resolveGeminiModel, validateGeminiCatalog } from '../src/gemini-catalog.js';
import { normalizeAIWebSettings, validateAIWebSettings } from '../src/ai-web.js';
import { patchGeminiCatalog, patchGeminiPreferences } from '../src/content/gemini-preference-interceptor.js';

function status() {
  const data = [], flash = ['1111111111111111', 'Flash', '3.8 Flash'], carbon = ['2222222222222222', 'Carbon', '4 Carbon'];
  flash[17] = 1; carbon[17] = 8; data[15] = [flash, carbon];
  const choice = (category, variant, name, title, label, locked, levels, surfaces = [1]) => {
    const descriptor = []; descriptor[1] = category; descriptor[3] = variant; descriptor[4] = name;
    descriptor[5] = title; descriptor[12] = label; if (locked) descriptor[14] = [1, 'upgrade'];
    return [descriptor, levels, null, surfaces];
  };
  data[24] = [null, [
    choice(1, null, 'Flash', '3.8 Flash', '全方位帮助', false, [[1, '低', '快速'], [4, '中', '均衡'], [2, '高', '详细']]),
    choice(8, 'argon', 'Argon', '4 Argon', '代码与分析', false, [[1, '低', '快速'], [4, '中', '均衡'], [2, '高', '详细']]),
    choice(8, null, 'Carbon', '4 Carbon', '高难任务', true, [[1, '标准', '普通']]),
    choice(8, 'argon', 'Argon', '4 Argon', '代码与分析', false, [[1, '低']], [2]),
  ]];
  return data;
}

test('live status yields account-visible variants, per-model levels and locked entries', () => {
  const catalog = extractGeminiCatalog(status());
  assert.deepEqual(catalog.models.map(model => [model.id, model.label, model.available]), [
    ['1111111111111111', '3.8 Flash（全方位帮助）', true],
    ['argon', '4 Argon（代码与分析）', true],
    ['2222222222222222', '4 Carbon（高难任务）', false],
  ]);
  assert.deepEqual(catalog.models[1].levels.map(level => [level.id, level.label]), [[1, '低（快速）'], [4, '中（均衡）'], [2, '高（详细）']]);
  assert.equal(resolveGeminiModel(catalog.models, 'argon').id, 'argon');
  assert.equal(resolveGeminiModel(catalog.models, 'id:argon').id, 'argon');
});

test('dynamic IDs and levels persist, including values unknown to older releases', () => {
  const value = { activeSiteId: 'gemini', customSites: [], geminiModel: 'id:new-model-7', geminiThinkingLevel: 'level:7' };
  assert.equal(validateAIWebSettings(value).geminiModel, 'id:new-model-7');
  assert.equal(normalizeAIWebSettings(value).geminiThinkingLevel, 'level:7');
  assert.equal(geminiLevelNumber('level:7'), 7);
  assert.equal(validateAIWebSettings({ ...value, geminiThinkingLevel: 'site-default' }).geminiThinkingLevel, 'site-default');
  assert.throws(() => validateAIWebSettings({ ...value, geminiModel: 'id:../invalid' }), /默认模型/);
  assert.throws(() => validateAIWebSettings({ ...value, geminiThinkingLevel: 'level:0' }), /思考等级/);
});

test('automatic application uses current variant IDs and never selects an upgrade entry', () => {
  const data = status();
  const result = patchGeminiCatalog(data, { model: 'id:argon', thinkingLevel: 'level:4' });
  assert.deepEqual(result, { modelId: 'argon', thinkingLevel: 4 });
  assert.equal(data[24][1][0][2], 4);
  assert.equal(data[24][1][1][2], 4);
  assert.equal(data[24][1][2][2], null);
  const prefs = Array(208).fill(null); prefs[99] = '1111111111111111'; prefs[207] = { 265: 1 };
  assert.deepEqual(patchGeminiPreferences([prefs], result), result);
  assert.equal(prefs[99], 'argon'); assert.equal(prefs[207][265], 4);
  assert.equal(patchGeminiCatalog(status(), { model: 'id:2222222222222222', thinkingLevel: 'level:1' }), null);
});

test('a model without thinking choices follows the website default even with an older saved level', () => {
  for (const thinkingLevel of ['site-default', 'level:2']) {
    const data = status(); data[24][1][1][1] = [];
    const result = patchGeminiCatalog(data, { model: 'id:argon', thinkingLevel });
    assert.deepEqual(result, { modelId: 'argon', thinkingLevel: null });
    const prefs = Array(208).fill(null); prefs[99] = '1111111111111111'; prefs[207] = { 265: 1 };
    assert.deepEqual(patchGeminiPreferences([prefs], result), result);
    assert.equal(prefs[99], 'argon'); assert.equal(prefs[207][265], 1);
  }
});

test('a base model without a thinking-menu record remains selectable without invented levels', () => {
  const data = status(); data[15].push(['3333333333333333', 'Nova', '5 Nova']);
  const model = extractGeminiCatalog(data).models.find(item => item.id === '3333333333333333');
  assert.deepEqual(model, { id: '3333333333333333', label: '5 Nova', available: true, levels: [] });
  assert.deepEqual(patchGeminiCatalog(data, { model: 'id:3333333333333333', thinkingLevel: 'site-default' }), { modelId: '3333333333333333', thinkingLevel: null });
  assert.deepEqual(patchGeminiCatalog(data, { model: 'id:3333333333333333', thinkingLevel: 'level:7' }), { modelId: '3333333333333333', thinkingLevel: null });
});

test('catalog validation rejects unsafe, duplicate and excessive metadata', () => {
  const valid = { models: [{ id: 'model-1', label: 'New model', available: true, levels: [{ id: 7, label: 'New level' }] }] };
  assert.deepEqual(validateGeminiCatalog(valid), valid);
  assert.equal(validateGeminiCatalog({ models: [valid.models[0], valid.models[0]] }), null);
  assert.equal(validateGeminiCatalog({ models: [{ ...valid.models[0], id: '../bad' }] }), null);
  assert.equal(validateGeminiCatalog({ models: [{ ...valid.models[0], levels: [{ id: 0, label: 'bad' }] }] }), null);
  assert.equal(extractGeminiCatalog({}), null);
});
