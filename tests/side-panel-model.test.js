import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_MODES, panelHostname, createPanelModel, reducePanelModel, assertPanelInvariants,
  restorePanelModel, createPanelModelController } from '../src/side-panel-model.js';
import { captureSourceToken, isSourceTokenCurrent } from '../src/side-panel-snapshot-contract.js';

const tab = (id, url = `https://example.test/${id}`, windowId = 9) => ({ id, windowId, url, title: `Page ${id}`, status: 'complete' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(mode = 'independent') {
  let state = createPanelModel(mode), effects = [];
  const dispatch = event => {
    const before = structuredClone(state), result = reducePanelModel(state, event);
    assert.deepEqual(state, before, 'the reducer must not mutate its input');
    state = result.state; effects = result.effects; return effects;
  };
  const complete = (effect, result = { ok: true, carrierId: effect.carrierId || `document:${effect.sessionId}` }) => dispatch({ type: 'EFFECT_COMPLETED', effect, result });
  const apply = event => { const next = dispatch(event); for (const effect of next) if (effect.token) complete(effect); return next; };
  return { get state() { return state; }, get effects() { return effects; }, dispatch, complete, apply,
    open: value => apply({ type: 'OPEN_REQUESTED', tab: value }),
    activate: value => apply({ type: 'TAB_ACTIVATED', tab: value }),
    mode: value => apply({ type: 'MODE_CHANGED', mode: value }),
    pin: (tabId, pinned = true, windowId = 9) => apply({ type: 'PIN_CHANGED', windowId, tabId, pinned }),
    id: tabId => state.tabs[tabId].sessionId,
  };
}

test('default and hostname rules reject guessing and normalize full HTTP(S) hostnames', () => {
  assert.equal(createPanelModel().mode, 'independent');
  assert.throws(() => createPanelModel('unknown'));
  assert.equal(panelHostname('HTTP://EXAMPLE.COM:8080/a'), 'example.com');
  assert.equal(panelHostname('https://食狮.com.cn/a'), 'xn--85x722f.com.cn');
  for (const url of [undefined, '', 'chrome://settings', 'file:///article.html', 'not a url']) assert.equal(panelHostname(url), '');
});

for (const mode of PANEL_MODES) test(`${mode}: a new tab follows policy only after carrier confirmation`, () => {
  const f = fixture(mode); f.open(tab(1)); const session = f.id(1);
  if (mode === 'manual') f.pin(1);
  const [effect] = f.dispatch({ type: 'TAB_ACTIVATED', tab: tab(2) });
  assert.equal(f.id(2), null, 'an unconfirmed association is never shared');
  assert.equal(f.state.windows[9].source, null, 'the previous source is unavailable while routing');
  assert.equal(effect.type, mode === 'independent' ? 'hide' : 'show');
  f.complete(effect);
  assert.equal(f.id(2), mode === 'independent' ? null : session);
  assert.equal(f.state.sessions[session].carrierId, `document:${session}`);
  f.activate(tab(1)); assert.equal(f.id(1), session);
});

test('existing A/B instances win; new C inherits the most recently used B without merging A', () => {
  const f = fixture(); f.open(tab(1)); const a = f.id(1); f.open(tab(2)); const b = f.id(2);
  f.mode('shared'); f.activate(tab(1)); f.activate(tab(2)); f.activate(tab(3));
  assert.equal(f.id(3), b); assert.equal(f.id(1), a); assert.notEqual(a, b);
  f.activate(tab(1)); assert.equal(f.state.windows[9].visibleSessionId, a);
  assert.equal(Object.values(f.state.sessions).filter(item => item.opened).length, 2);
});

test('same-site uses current full hostnames, ignores protocol/port/path, separates subdomains and unknown URLs', () => {
  const f = fixture('same-site'); f.open(tab(1, 'https://A.example.test/one')); const a = f.id(1);
  f.activate(tab(2, 'http://a.example.test:8080/two')); assert.equal(f.id(2), a);
  for (const [id, url] of [[3, 'https://b.example.test/'], [4, undefined], [5, 'chrome://settings']]) {
    f.activate({ ...tab(id), url }); assert.equal(f.id(id), null);
  }
  f.open(tab(3, 'https://b.example.test/')); const b = f.id(3);
  f.activate(tab(6, 'https://a.example.test/again')); assert.equal(f.id(6), a, 'a more recent different hostname is ineligible');
  f.activate(tab(7, 'https://b.example.test/again')); assert.equal(f.id(7), b);
});

for (const before of PANEL_MODES) for (const after of PANEL_MODES) test(`mode change ${before} → ${after} preserves every existing association`, () => {
  const f = fixture(); f.open(tab(1)); f.open(tab(2)); const bindings = [f.id(1), f.id(2)];
  f.mode(before); if (before === 'manual') f.pin(2);
  const carriers = Object.values(f.state.sessions).map(item => item.carrierId);
  f.mode(after);
  assert.deepEqual([f.id(1), f.id(2)], bindings); assert.deepEqual(Object.values(f.state.sessions).map(item => item.carrierId), carriers);
  if (before !== after) assert.equal(f.state.windows[9].pinnedSessionId, null);
  f.activate(tab(1)); assert.equal(f.id(1), bindings[0]); f.activate(tab(2)); assert.equal(f.id(2), bindings[1]);
});

test('manual pinned A does not replace B; unbound C inherits A; changing the pin preserves previous members', () => {
  const f = fixture(); f.open(tab(1)); const a = f.id(1); f.open(tab(2)); const b = f.id(2);
  f.mode('manual'); f.activate(tab(1)); f.pin(1); f.activate(tab(2));
  assert.equal(f.id(2), b); assert.equal(f.state.windows[9].pinnedSessionId, a);
  f.activate(tab(3)); assert.equal(f.id(3), a);
  f.activate(tab(2)); f.pin(2); f.activate(tab(4)); assert.equal(f.id(4), b);
  assert.equal(f.id(1), a); assert.equal(f.id(3), a);
  f.mode('independent'); f.mode('manual'); assert.equal(f.state.windows[9].pinnedSessionId, null);
  f.activate(tab(5)); assert.equal(f.id(5), null);
});

test('pin controls are accepted only on the active open session in manual mode', () => {
  const f = fixture(); f.open(tab(1)); assert.throws(() => f.pin(1), /manual mode/);
  f.mode('manual'); f.activate(tab(2)); assert.throws(() => f.pin(1), /active tab/); assert.throws(() => f.pin(2), /open session/);
});

test('unpin transfers the exact original instance to B only after confirmation; unrelated sessions survive', () => {
  const f = fixture(); f.open(tab(4)); const other = f.id(4); f.open(tab(1)); const shared = f.id(1);
  f.mode('manual'); f.pin(1); f.activate(tab(2)); f.activate(tab(3)); f.activate(tab(2));
  const [effect] = f.dispatch({ type: 'PIN_CHANGED', windowId: 9, tabId: 2, pinned: false });
  assert.equal(f.id(1), shared); assert.equal(f.id(3), shared);
  f.complete(effect, { ok: false, code: 'TRANSFER_UNSUPPORTED' });
  assert.equal(f.state.windows[9].pinnedSessionId, shared); assert.equal(f.id(1), shared);
  const [retry] = f.dispatch({ type: 'PIN_CHANGED', windowId: 9, tabId: 2, pinned: false }); f.complete(retry);
  assert.equal(f.id(2), shared); assert.equal(f.id(1), null); assert.equal(f.id(3), null);
  assert.equal(f.id(4), other); assert.equal(f.state.windows[9].pinnedSessionId, null);
  f.activate(tab(1)); assert.equal(f.state.windows[9].visibleSessionId, null);
});

test('closing a shared session closes all members and its pin but leaves other instances intact', () => {
  const f = fixture(); f.open(tab(4)); const other = f.id(4); f.open(tab(1)); const shared = f.id(1);
  f.mode('manual'); f.pin(1); f.activate(tab(2));
  const [effect] = f.dispatch({ type: 'CLOSE_REQUESTED', windowId: 9 });
  f.complete(effect, { ok: false }); assert.equal(f.id(1), shared); assert.equal(f.id(2), shared);
  f.apply({ type: 'CLOSE_REQUESTED', windowId: 9 });
  assert.equal(f.id(1), null); assert.equal(f.id(2), null); assert.equal(f.id(4), other);
  assert.equal(f.state.windows[9].pinnedSessionId, null); assert.equal(f.state.sessions[shared].opened, false);
  f.activate(tab(1)); assert.equal(f.id(1), null);
});

test('temporary invisibility is distinct from a confirmed carrier close and does not touch MRU', () => {
  const f = fixture('shared'); f.open(tab(1)); const id = f.id(1), carrierId = f.state.sessions[id].carrierId, clock = f.state.clock;
  f.apply({ type: 'CARRIER_VISIBILITY', windowId: 9, carrierId, visible: false });
  assert.equal(f.id(1), id); assert.equal(f.state.sessions[id].opened, true); assert.equal(f.state.clock, clock);
  f.apply({ type: 'CARRIER_VISIBILITY', windowId: 9, carrierId, visible: true });
  assert.equal(f.state.windows[9].source.tabId, 1); assert.equal(f.state.clock, clock);
  f.apply({ type: 'CARRIER_CLOSED', windowId: 9, carrierId }); assert.equal(f.id(1), null);
});

test('failed or replacement-instance sharing never commits B, rewrites A, or disposes A', () => {
  const f = fixture('shared'); f.open(tab(1)); const a = f.id(1), original = f.state.sessions[a].carrierId;
  let [effect] = f.dispatch({ type: 'TAB_ACTIVATED', tab: tab(2) });
  f.complete(effect, { ok: false, code: 'GESTURE_REQUIRED' });
  assert.equal(f.id(2), null); assert.equal(f.id(1), a); assert.equal(f.state.windows[9].source, null);
  [effect] = f.dispatch({ type: 'TAB_ACTIVATED', tab: tab(2) });
  const cleanup = f.complete(effect, { ok: true, carrierId: 'replacement-document' });
  assert.equal(f.id(2), null); assert.equal(f.state.sessions[a].carrierId, original);
  assert.equal(f.state.windows[9].failure.code, 'INSTANCE_REPLACED');
  assert.deepEqual(cleanup.map(item => item.carrierId), ['replacement-document']);
});

test('navigation preserves associations, invalidates the source, updates hostname eligibility, and does not touch MRU', () => {
  const f = fixture('same-site'); f.open(tab(1)); const id = f.id(1), clock = f.state.clock;
  const [effect] = f.dispatch({ type: 'TAB_NAVIGATED', tab: tab(1, 'https://new.test/article') });
  assert.equal(f.id(1), id); assert.equal(f.state.windows[9].source, null); f.complete(effect);
  assert.equal(f.state.windows[9].source.version, 1); assert.equal(f.state.clock, clock);
  f.activate(tab(2)); assert.equal(f.id(2), null);
  f.activate(tab(3, 'https://new.test/other')); assert.equal(f.id(3), id);
  f.apply({ type: 'TAB_NAVIGATED', tab: { ...tab(3, 'https://new.test/other'), status: 'loading' } });
  assert.equal(f.state.windows[9].source.available, false);
  f.apply({ type: 'TAB_NAVIGATED', tab: { ...tab(3), url: undefined } });
  assert.equal(f.state.windows[9].source.url, ''); assert.equal(f.state.windows[9].source.available, false);
});

test('stale completions cannot commit old sources after activation, navigation, mode changes or close', () => {
  for (const event of [{ type: 'TAB_ACTIVATED', tab: tab(3) }, { type: 'TAB_NAVIGATED', tab: tab(2, 'https://new.test/') },
    { type: 'MODE_CHANGED', mode: 'independent' }, { type: 'CARRIER_CLOSED', windowId: 9, carrierId: 'document:panel-9-1' }]) {
    const f = fixture('shared'); f.open(tab(1)); const [old] = f.dispatch({ type: 'TAB_ACTIVATED', tab: tab(2) });
    const newer = f.dispatch(event); const bindings = structuredClone(f.state.tabs);
    const followup = f.complete(old); assert.deepEqual(f.state.tabs, bindings);
    assert.equal(followup[0].type, 'inspect');
    if (newer[0]?.token) { f.complete(newer[0]); assert.notEqual(f.state.windows[9].source?.url, tab(2).url); }
  }
});

test('a stale create disposes only its newly created orphan, not a newer live instance', () => {
  const f = fixture(); const [old] = f.dispatch({ type: 'OPEN_REQUESTED', tab: tab(1) });
  f.open(tab(2)); const current = f.id(2);
  const effects = f.complete(old, { ok: true, carrierId: 'old-created-document' });
  assert.equal(f.id(1), null); assert.equal(f.id(2), current);
  assert.deepEqual(effects, [{ type: 'dispose', windowId: 9, sessionId: old.sessionId, carrierId: 'old-created-document' }]);
});

test('A → B → A invalidates old capture tokens even when the URL and material version are unchanged', () => {
  const f = fixture('shared'); f.open(tab(1)); const session = f.id(1), initial = f.state.windows[9].source;
  const token = captureSourceToken(session, initial);
  f.activate(tab(2)); f.activate(tab(1));
  const current = f.state.windows[9].source;
  assert.equal(current.url, initial.url); assert.equal(current.version, initial.version);
  assert.equal(isSourceTokenCurrent(token, session, current), false);
});

test('sharing stays within windows; removing one member preserves the carrier and the last member retires it', () => {
  const f = fixture('shared'); f.open(tab(1)); const a = f.id(1); f.activate(tab(2));
  f.activate(tab(3, 'https://example.test/3', 10)); assert.equal(f.id(3), null);
  f.open(tab(3, 'https://example.test/3', 10)); const other = f.id(3);
  f.apply({ type: 'TAB_REMOVED', tabId: 1 }); assert.equal(f.id(2), a); assert.equal(f.state.sessions[a].opened, true);
  const effects = f.apply({ type: 'TAB_REMOVED', tabId: 2 }); assert.equal(f.state.sessions[a].opened, false);
  assert.equal(effects[0].type, 'dispose'); assert.equal(f.id(3), other);
  f.apply({ type: 'WINDOW_REMOVED', windowId: 10 }); assert.equal(f.state.windows[10], undefined); assert.equal(f.state.tabs[3], undefined);
});

test('window transfers require live evidence for an exclusive carrier; shared members never move the entire group', () => {
  for (const preserve of [true, false]) {
    const f = fixture(); f.open(tab(1)); const id = f.id(1), carrierId = f.state.sessions[id].carrierId;
    f.apply({ type: 'TAB_MOVED', tabId: 1, windowId: 10, ...(preserve ? { carrier: { carrierId, windowId: 10 } } : {}) });
    assert.equal(f.id(1), preserve ? id : null);
    if (!preserve) assert.equal(f.state.windows[10].failure.code, 'WINDOW_TRANSFER_UNVERIFIED');
    else assert.equal(f.state.sessions[id].windowId, 10);
  }
  const f = fixture('shared'); f.open(tab(1)); const id = f.id(1); f.activate(tab(2));
  f.apply({ type: 'TAB_MOVED', tabId: 2, windowId: 10, carrier: { carrierId: f.state.sessions[id].carrierId, windowId: 10 } });
  assert.equal(f.id(1), id); assert.equal(f.id(2), null);
});

test('worker restore requires exact live carrier inventory; visibility, source and old intents are not trusted', () => {
  const f = fixture('manual'); f.open(tab(1)); const id = f.id(1); f.pin(1); f.activate(tab(2));
  f.dispatch({ type: 'TAB_ACTIVATED', tab: tab(3) });
  const live = [{ sessionId: id, windowId: 9, carrierId: f.state.sessions[id].carrierId }];
  const restored = restorePanelModel(f.state, live);
  assert.equal(restored.tabs[1].sessionId, id); assert.equal(restored.windows[9].pinnedSessionId, id);
  assert.equal(restored.windows[9].source, null); assert.equal(restored.windows[9].pending, null);
  for (const carriers of [[], [{ ...live[0], carrierId: 'replacement' }], [{ ...live[0], windowId: 10 }]]) {
    const missing = restorePanelModel(f.state, carriers);
    assert.equal(missing.tabs[1].sessionId, null); assert.equal(missing.windows[9].pinnedSessionId, null);
  }
  assert.throws(() => restorePanelModel(f.state), /inventory/);
});

test('the controller serializes a window, supersedes in-flight intents, and lets different windows progress', async () => {
  const gate = deferred(), started = deferred(), work = [];
  const controller = createPanelModelController({ perform: async effect => {
    work.push(effect);
    if (effect.type === 'create' && effect.tabId === 1) { started.resolve(); await gate.promise; }
    return { ok: true, carrierId: effect.carrierId || `document:${effect.sessionId}` };
  } });
  const old = controller.dispatch({ type: 'OPEN_REQUESTED', tab: tab(1) }); await started.promise;
  const next = controller.dispatch({ type: 'OPEN_REQUESTED', tab: tab(2) });
  await controller.dispatch({ type: 'OPEN_REQUESTED', tab: tab(3, 'https://other.test/', 10) });
  assert.ok(controller.getState().tabs[3].sessionId); assert.equal(controller.getState().tabs[2].sessionId, null);
  gate.resolve(); await Promise.all([old, next]); await controller.idle();
  const state = controller.getState(); assert.equal(state.tabs[1].sessionId, null); assert.ok(state.tabs[2].sessionId);
  assert.equal(work.filter(item => item.type === 'dispose').length, 1);
  const snapshot = controller.getState(); snapshot.mode = 'shared'; assert.equal(controller.getState().mode, 'independent');
});

test('late shared acknowledgements inspect carriers without cancelling a newer queued resolution', async () => {
  const gate = deferred(), started = deferred(); let hold = false;
  const controller = createPanelModelController({ state: createPanelModel('shared'), perform: async effect => {
    if (effect.type === 'show' && hold) { hold = false; started.resolve(); await gate.promise; }
    if (effect.type === 'inspect') return { ok: true, carriers: Object.values(controller.getState().sessions)
      .filter(item => item.opened).map(item => ({ sessionId: item.id, carrierId: item.carrierId, windowId: item.windowId })) };
    return { ok: true, carrierId: effect.carrierId || `document:${effect.sessionId}` };
  } });
  await controller.dispatch({ type: 'OPEN_REQUESTED', tab: tab(1) }); hold = true;
  const old = controller.dispatch({ type: 'TAB_ACTIVATED', tab: tab(2) }); await started.promise;
  const next = controller.dispatch({ type: 'TAB_ACTIVATED', tab: tab(3) }); gate.resolve(); await Promise.all([old, next]);
  assert.equal(controller.getState().tabs[2].sessionId, null); assert.ok(controller.getState().tabs[3].sessionId);
  assert.equal(controller.getState().windows[9].source.tabId, 3);
});

test('mixed event sequences preserve binding invariants across modes, navigation, closes and removal', () => {
  const f = fixture(); let seed = 591;
  const random = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  for (let i = 0; i < 400; i++) {
    const id = random(6) + 1, value = tab(id, `https://${random(2) ? 'a' : 'b'}.test/${id}`), operation = random(6);
    if (operation === 0) f.mode(PANEL_MODES[random(4)]);
    else if (operation === 1) f.open(value);
    else if (operation === 2) f.activate(value);
    else if (operation === 3) f.apply({ type: 'TAB_NAVIGATED', tab: value });
    else if (operation === 4) f.apply({ type: 'TAB_REMOVED', tabId: id });
    else if (f.state.windows[9]) f.apply({ type: 'CLOSE_REQUESTED', windowId: 9 });
    assertPanelInvariants(f.state);
  }
});
