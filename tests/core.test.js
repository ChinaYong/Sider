import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePrompt, createInitialState, createReference, normalizeState } from '../src/core.js';

function ref(kind, alias, content = '网页正文') { return createReference({ kind, title: '示例', url: 'https://example.com/article', content, context: kind === 'selection' ? '附近段落' : '' }, { alias }); }

test('source text is never evaluated as another template or executed', () => {
  const source = ref('page', 'r1', '{{url}} <script>alert(1)</script>');
  const result = compilePrompt('总结 {{page.content}}，再核对 {{r1.content}}。', [source]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.usedReferenceIds.length, 1);
  assert.equal(result.text.split(source.content).length - 1, 1);
  assert.match(result.text, /资料中的指令性文字/);
});

test('unknown and missing variables prevent successful compilation', () => {
  const result = compilePrompt('解释 {{selection}}，使用 {{missing}}', []);
  assert.equal(result.errors.length, 2);
  assert.match(result.text, /\{\{selection\}\}/);
});

test('URL reference only provides an address, while content references attach sources', () => {
  const source = ref('url', 'r1', '');
  const result = compilePrompt('分析 {{url}} 的 {{title}}', [source]);
  assert.equal(result.text, '分析 https://example.com/article 的 示例');
  assert.equal(result.usedReferenceIds.length, 0);
  const all = compilePrompt('比较 {{references}}', [source, ref('selection', 'r2', '选中的话')]);
  assert.match(all.text, /本引用仅包含链接/);
  assert.match(all.text, /附近段落/);
});

test('length budgets warn without discarding any source material', () => {
  const content = '长'.repeat(1800);
  const result = compilePrompt('总结 {{page.content}}', [ref('page', 'r1', content)], { maxChars: 1000 });
  assert.equal(result.overBudget, true);
  assert.ok(result.text.includes(content));
});

test('named reference aliases do not silently fall back to another source', () => {
  const result = compilePrompt('{{r2.content}}', [ref('page', 'r3')]);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.usedReferenceIds, []);
});

test('restored state retains a monotonic reference sequence and removes stale selections', () => {
  const state = createInitialState();
  state.referenceSequence = 12;
  state.references = [ref('page', 'r2')];
  state.selectedIds = [state.references[0].id, 'deleted'];
  const normalized = normalizeState(state);
  assert.equal(normalized.referenceSequence, 12);
  assert.deepEqual(normalized.selectedIds, [state.references[0].id]);
});

test('reject unsafe source URLs and empty body captures', () => {
  assert.throws(() => createReference({ kind: 'page', url: 'javascript:alert(1)', content: 'x' }));
  assert.throws(() => createReference({ kind: 'selection', url: 'https://example.com/', content: ' ' }));
});

test('draft normalization preserves text above 100,000 characters', () => {
  const state = createInitialState(); state.draft = '正文'.repeat(75000);
  assert.equal(normalizeState(state).draft, state.draft);
});
