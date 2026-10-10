import test from 'node:test';
import assert from 'node:assert/strict';
import { TemplateDraft } from '../src/content/template-draft.js';
import { presetSourceKey, createPresetSnapshotIdentity, currentSourcePresetIds, captureSourceToken,
  isSourceTokenCurrent } from '../src/side-panel-snapshot-contract.js';

const source = (tabId, url = 'https://example.test/article', version = 0) => ({ tabId, url, version, epoch: 0, title: `Page ${tabId}`, available: true });

test('same preset on A and B owns separate snapshots and attachment IDs; only same-source re-append matches', () => {
  const a = createPresetSnapshotIdentity('preset-page', source(1), 'snapshot-a');
  const b = createPresetSnapshotIdentity('preset-page', source(2), 'snapshot-b');
  assert.notEqual(a.sourceKey, b.sourceKey); assert.notEqual(a.attachmentId, b.attachmentId);
  assert.equal(presetSourceKey('preset-page', source(1)), a.sourceKey);
  assert.notEqual(presetSourceKey('preset-page', source(1, 'https://example.test/new')), a.sourceKey);
  assert.equal(presetSourceKey('preset-page', source(1, undefined, 7)), a.sourceKey, 'source freshness does not create an unrelated re-append slot');
});

test('A snapshots do not suppress B expansion and unsupported sources do not inherit an old source', () => {
  const a = createPresetSnapshotIdentity('preset-page', source(1), 'snapshot-a');
  assert.deepEqual([...currentSourcePresetIds([a], source(2))], []);
  assert.deepEqual([...currentSourcePresetIds([a], source(1))], ['preset-page']);
  assert.deepEqual([...currentSourcePresetIds([a], { tabId: 2, url: 'chrome://settings' })], []);
});

test('existing draft tracking supports independent source snapshot IDs and protects only the user-edited block', () => {
  const draft = new TemplateDraft(), editor = {}, a = createPresetSnapshotIdentity('preset-page', source(1), 'snapshot-a'),
    b = createPresetSnapshotIdentity('preset-page', source(2), 'snapshot-b');
  draft.reset(editor, 'same-ai-session', '');
  draft.applyEdit(0, 0, 'A body\n'); draft.add(a, 0, 'A body\n');
  draft.applyEdit(7, 7, 'B body'); draft.add(b, 7, 'B body');
  draft.reconcile('A edited body\nB body', editor, 'same-ai-session');
  assert.throws(() => draft.removable(a.id, draft.text), /已被编辑/);
  assert.equal(draft.removable(b.id, draft.text).block, 'B body');
  assert.equal(draft.snapshots().length, 2); assert.equal(a.source.title, 'Page 1');
});

test('in-flight source tokens fail on tab changes, navigation, session changes, lost access and pending routing', () => {
  const original = source(1), token = captureSourceToken('session-a', original);
  assert.equal(isSourceTokenCurrent(token, 'session-a', original), true);
  for (const next of [source(2), source(1, 'https://other.test/'), source(1, undefined, 1),
    { ...original, epoch: 2 }, { ...original, available: false }, null]) assert.equal(isSourceTokenCurrent(token, 'session-a', next), false);
  assert.equal(isSourceTokenCurrent(token, 'session-b', original), false);
  assert.throws(() => captureSourceToken('session-a', { ...original, available: false }));
});

test('invalid snapshot identities are rejected instead of becoming source-less attachment ownership', () => {
  for (const value of [{ tabId: -1, url: 'https://example.test/' }, { tabId: 1, url: 'file:///article' }, { tabId: 1, url: '' }])
    assert.throws(() => createPresetSnapshotIdentity('preset-page', value, 'snapshot-a'));
  assert.throws(() => createPresetSnapshotIdentity('preset-page', source(1), ''));
});
