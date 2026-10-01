import test from 'node:test';
import assert from 'node:assert/strict';
import { getState, addReference, removeReference, updateReference, patchState, setReferenceSelected } from '../src/store.js';

let data = {};
globalThis.chrome = { storage: { local: {
  get: async key => structuredClone({ [key]: data[key] }),
  set: async value => { data = structuredClone({ ...data, ...value }); }
} } };

test('concurrent captures persist without losing either source', async () => {
  data = {};
  await Promise.all(['A', 'B'].map(content => addReference({ kind: 'selection', content, title: '页面', url: 'https://example.com/' })));
  const state = await getState();
  assert.equal(state.references.length, 2);
  assert.deepEqual(state.references.map(ref => ref.alias), ['r1', 'r2']);
  assert.equal(state.selectedIds.length, 2);
});

test('deleted source aliases never bind to a newly collected source', async () => {
  data = {};
  const { reference } = await addReference({ kind: 'page', content: '第一份', url: 'https://example.com/' });
  await removeReference(reference.id);
  const added = await addReference({ kind: 'page', content: '第二份', url: 'https://example.com/' });
  assert.equal(added.reference.alias, 'r2');
});

test('duplicate collection selects an existing snapshot and edits cannot change identity', async () => {
  data = {};
  const raw = { kind: 'selection', content: '选中的话', url: 'https://example.com/' };
  const first = await addReference(raw);
  const second = await addReference(raw);
  assert.equal(first.reference.id, second.reference.id);
  await updateReference(first.reference.id, { content: '编辑后的话', alias: 'r9', id: 'replace' });
  const state = await getState();
  assert.equal(state.references.length, 1);
  assert.equal(state.references[0].alias, 'r1');
  assert.equal(state.references[0].id, first.reference.id);
});

test('invalid edits leave persisted snapshot intact and settings patches preserve fields', async () => {
  data = {};
  const added = await addReference({ kind: 'page', content: '原始正文', url: 'https://example.com/' });
  await assert.rejects(updateReference(added.reference.id, { content: '' }));
  await patchState({ settings: { language: 'English' } });
  const state = await getState();
  assert.equal(state.references[0].content, '原始正文');
  assert.equal(state.settings.language, 'English');
  assert.equal(state.settings.maxChars, 48000);
});

test('selection changes remain atomic with a concurrent capture', async () => {
  data = {};
  const first = await addReference({ kind: 'selection', content: 'A', url: 'https://example.com/' });
  const second = await addReference({ kind: 'selection', content: 'B', url: 'https://example.com/' });
  await Promise.all([setReferenceSelected(first.reference.id, false), addReference({ kind: 'page', content: 'C', url: 'https://example.com/' }), setReferenceSelected(second.reference.id, false)]);
  const state = await getState();
  assert.equal(state.selectedIds.length, 1);
  assert.equal(state.references.find(ref => ref.id === state.selectedIds[0]).content, 'C');
});
