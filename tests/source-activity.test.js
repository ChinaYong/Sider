import test from 'node:test';
import assert from 'node:assert/strict';
import { installSourceActivity } from '../src/source-activity.js';

function fixture(open = [], sessions = {}) {
  const owners = new Set(open), changes = [], started = [], listeners = [];
  let activate = async tabId => { started.push(tabId); };
  const activity = installSourceActivity({
    chrome: { tabs: { async sendMessage(tabId, message) { changes.push({ tabId, ...message }); } } },
    panels: { ready: Promise.resolve(), openTabIds: () => [...owners], subscribe(fn) { listeners.push(fn); } },
    references: { async all() { return sessions; } },
    activate: tabId => activate(tabId),
  });
  return { activity, owners, sessions, changes, started, setActivate: fn => { activate = fn; },
    change(owner, opened) { if (opened) owners.add(owner); else owners.delete(owner); listeners.forEach(fn => fn(owner, opened)); } };
}

test('closed panels do not activate sources, including stored reference bindings', async () => {
  const f = fixture([], { 1: { sourceTabId: 2 } });
  await f.activity.ready;
  assert.equal(await f.activity.isActive(2), false);
  assert.deepEqual(f.started, []);
  assert.deepEqual(f.changes, []);
});

test('sources are shared only while an open panel needs them and switch independently', async () => {
  const f = fixture([1, 3], { 1: { sourceTabId: 2 }, 3: { sourceTabId: 2 } });
  await f.activity.ready;
  assert.deepEqual(f.started, [2]);
  f.change(1, false); await f.activity.sync();
  assert.equal(f.activity.has(2), true); assert.deepEqual(f.changes, []);
  f.sessions[3].sourceTabId = 4; await f.activity.sync();
  assert.equal(f.activity.has(2), false); assert.equal(f.activity.has(4), true);
  assert.deepEqual(f.started, [2, 4]);
  assert.deepEqual(f.changes, [{ tabId: 2, type: 'SIDER_SOURCE_ACTIVITY_CHANGED', active: false }]);
  f.change(3, false); await f.activity.sync();
  assert.equal(f.activity.has(4), false);
});

test('a slow source activation does not block closing a sidebar', async () => {
  const f = fixture(); await f.activity.ready;
  let release;
  f.setActivate(() => new Promise(resolve => { release = resolve; }));
  f.change(1, true); await f.activity.sync();
  f.change(1, false); await f.activity.sync();
  assert.equal(f.activity.has(1), false);
  assert.equal(f.changes.at(-1).active, false);
  release();
});
