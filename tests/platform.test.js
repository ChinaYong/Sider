import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { send } from '../src/platform.js';

test('demo keeps stable references and applies concurrent selection changes atomically', async (t) => {
  const { window } = new JSDOM('', { url: 'http://127.0.0.1:4173/' });
  const names = ['window', 'location', 'localStorage', 'DOMParser', 'chrome'];
  const original = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, { window, location: window.location, localStorage: window.localStorage, DOMParser: window.DOMParser });
  delete globalThis.chrome;
  t.after(() => {
    window.close();
    for (const name of names) {
      if (original.get(name)) Object.defineProperty(globalThis, name, original.get(name));
      else delete globalThis[name];
    }
  });

  const add = (url) => send({ type: 'SIDER_ADD_REFERENCE', reference: { kind: 'url', url, title: url, content: url } });
  const first = await add('https://example.com/a');
  const second = await add('https://example.com/b');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.state.revision, first.state.revision + 1);
  await Promise.all([
    send({ type: 'SIDER_REFERENCE_SELECTION', id: first.reference.id, selected: false }),
    send({ type: 'SIDER_REFERENCE_SELECTION', id: second.reference.id, selected: false }),
  ]);
  const unselected = await send({ type: 'SIDER_STATE_GET' });
  assert.deepEqual(unselected.state.selectedIds, []);
  assert.equal(unselected.state.revision, second.state.revision + 2);

  const repeated = await add('https://example.com/a');
  assert.equal(repeated.reference.id, first.reference.id);
  assert.equal(repeated.state.references.length, 2);
  assert.equal(repeated.state.referenceSequence, 2);
  assert.deepEqual(repeated.state.selectedIds, [first.reference.id]);

  await send({ type: 'SIDER_REMOVE_REFERENCE', id: second.reference.id });
  const third = await add('https://example.com/c');
  assert.equal(third.reference.alias, 'r3');
  const stale = await send({ type: 'SIDER_REFERENCE_SELECTION', id: second.reference.id, selected: true });
  assert.equal(stale.ok, false);
  const unchanged = await send({ type: 'SIDER_STATE_GET' });
  assert.ok(!unchanged.state.selectedIds.includes(second.reference.id));

  const longDraft = '字'.repeat(150000);
  const saved = await send({ type: 'SIDER_STATE_PATCH', patch: { draft: longDraft, settings: { maxChars: 200000 } } });
  assert.equal(saved.state.draft, longDraft);
  const restored = await send({ type: 'SIDER_STATE_GET' });
  assert.equal(restored.state.draft, longDraft);

  const fill = await send({ type: 'SIDER_CHAT_FILL', text: 'test' });
  assert.equal(fill.ok, false);
  assert.match(fill.error, /演示模式/);
});
