import test from 'node:test';
import assert from 'node:assert/strict';
import { installSidePanelState } from '../src/side-panel-state.js';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { this.listeners.forEach(fn => fn(value)); } });
function fixture(initial, deferred = false) {
  let resolve;
  const stored = { 'sider.openPanels.v1': initial };
  const read = deferred ? new Promise(done => { resolve = done; }) : Promise.resolve(structuredClone(stored));
  const messages = [];
  const chrome = {
    storage: { session: { get: () => read, async set(update) { Object.assign(stored, structuredClone(update)); } } },
    sidePanel: { onOpened: event(), onClosed: event() },
    tabs: { onRemoved: event(), async sendMessage(tabId, message) { messages.push({ tabId, ...message }); } },
  };
  return { chrome, stored, messages, state: installSidePanelState(chrome), resolve: () => resolve(structuredClone(stored)) };
}

test('native events win over an older session read and a late open result', async () => {
  const f = fixture({ 1: true, 2: true }, true);
  const opening = f.state.revision(1);
  f.chrome.sidePanel.onClosed.emit({ tabId: 1 });
  f.resolve(); await f.state.ready;
  assert.equal(f.state.isOpen(1), false); assert.equal(f.state.isOpen(2), true);
  assert.equal(f.state.commit(1, opening, true), false);
  assert.deepEqual(f.messages, [{ tabId: 1, type: 'SIDER_PANEL_STATE_CHANGED', opened: false }]);
});

test('tab removal prevents restoring stale state and open hints cover a cold worker before storage returns', async () => {
  const f = fixture({ 1: true }, true);
  assert.equal(f.state.isOpen(2, true), true); assert.equal(f.state.isOpen(2, false), false);
  f.chrome.tabs.onRemoved.emit(1); f.resolve(); await f.state.ready;
  assert.equal(f.state.isOpen(1), false);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.stored['sider.openPanels.v1'], {});
});
