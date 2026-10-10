/**
 * Carrier-independent sidebar rules. This module is deliberately not installed
 * by the production background: a carrier must pass the native capability gate
 * before it can fulfill these effects without replacing a live AI document.
 * A session here identifies a sidebar page instance, not an AI conversation.
 * Conversations and their contents remain owned by the original AI website.
 */
export const PANEL_MODES = Object.freeze(['shared', 'independent', 'same-site', 'manual']);
const isId = value => Number.isSafeInteger(value) && value >= 0;
const own = (record, key) => Object.hasOwn(record, key) ? record[key] : undefined;
const openSession = (state, id) => {
  const session = own(state.sessions, id);
  return session?.opened && session.carrierId ? session : null;
};

export function panelHostname(url) {
  try { const value = new URL(url); return /^https?:$/.test(value.protocol) ? value.hostname : ''; }
  catch { return ''; }
}

export function createPanelModel(mode = 'independent') {
  if (!PANEL_MODES.includes(mode)) throw new Error('Unknown panel mode.');
  return { version: 1, mode, sequence: 0, clock: 0, sessions: {}, tabs: {}, windows: {} };
}

function getWindow(state, id) {
  if (!isId(id)) throw new Error('Invalid window ID.');
  return state.windows[id] ||= { windowId: id, activeTabId: null, pinnedSessionId: null, revision: 0,
    visibleSessionId: null, source: null, pending: null, failure: null };
}

function observeTab(state, tab, navigating = false) {
  if (!isId(tab?.id) || !isId(tab.windowId)) throw new Error('Invalid tab identity.');
  const previous = own(state.tabs, tab.id);
  if (previous && previous.windowId !== tab.windowId) throw new Error('Use TAB_MOVED to change windows.');
  getWindow(state, tab.windowId);
  const url = typeof tab.url === 'string' ? tab.url : '';
  const changed = previous && (previous.url !== url || previous.readable !== (tab.readable !== false)
    || previous.loading !== (tab.status === 'loading'));
  state.tabs[tab.id] = { tabId: tab.id, windowId: tab.windowId, url,
    hostname: panelHostname(url), title: typeof tab.title === 'string' ? tab.title : '',
    sourceVersion: (previous?.sourceVersion || 0) + (navigating || changed ? 1 : 0),
    readable: tab.readable !== false, loading: tab.status === 'loading', sessionId: previous?.sessionId || null };
  return state.tabs[tab.id];
}

function invalidate(window, invalidateSource = true) {
  window.revision++; window.pending = null; window.failure = null;
  if (invalidateSource) window.source = null;
  else if (window.source) window.source.epoch = window.revision;
}

function sourceFor(tab, window) {
  return { tabId: tab.tabId, url: tab.url, title: tab.title, version: tab.sourceVersion,
    epoch: window.revision,
    available: Boolean(tab.hostname && tab.readable && !tab.loading) };
}

function candidateFor(state, tab, window) {
  const bound = openSession(state, tab.sessionId);
  if (bound) return bound;
  if (state.mode === 'independent') return null;
  if (state.mode === 'manual') return openSession(state, window.pinnedSessionId);
  if (state.mode === 'same-site' && !tab.hostname) return null;
  return Object.values(state.sessions).filter(session => session.windowId === tab.windowId
    && openSession(state, session.id) && Object.values(state.tabs).some(member => member.sessionId === session.id
      && (state.mode !== 'same-site' || member.hostname === tab.hostname)))
    .sort((a, b) => b.lastUsed - a.lastUsed || a.id.localeCompare(b.id))[0] || null;
}

function begin(state, effects, window, type, tab, session, touch = false) {
  const requestId = ++state.sequence;
  const token = { windowId: window.windowId, revision: window.revision, requestId };
  const effect = { type, token, windowId: window.windowId, tabId: tab?.tabId ?? null,
    sourceVersion: tab?.sourceVersion ?? null,
    sessionId: session?.id || (type === 'create' ? `panel-${window.windowId}-${requestId}` : null),
    carrierId: session?.carrierId || null, touch };
  window.pending = effect; effects.push(effect);
}

function resolve(state, effects, tab, explicit, touch) {
  const window = getWindow(state, tab.windowId), candidate = candidateFor(state, tab, window);
  begin(state, effects, window, candidate ? 'show' : explicit ? 'create' : 'hide', tab, candidate, touch);
}

export function isCurrentPanelEffect(state, effect) {
  const window = own(state.windows, effect.windowId), pending = window?.pending;
  return Boolean(pending && pending.token.requestId === effect.token?.requestId
    && window.revision === effect.token.revision);
}

function retire(state, session) {
  session.opened = false;
  for (const tab of Object.values(state.tabs)) if (tab.sessionId === session.id) tab.sessionId = null;
  for (const window of Object.values(state.windows)) {
    if (window.pinnedSessionId === session.id) window.pinnedSessionId = null;
    if (window.visibleSessionId === session.id) { window.visibleSessionId = null; window.source = null; }
    if (window.pending?.sessionId === session.id) invalidate(window);
  }
}

function retireIfOrphan(state, effects, sessionId) {
  const session = openSession(state, sessionId);
  if (!session || Object.values(state.tabs).some(tab => tab.sessionId === sessionId)) return;
  retire(state, session);
  effects.push({ type: 'dispose', windowId: session.windowId, sessionId, carrierId: session.carrierId });
}

function complete(state, effects, effect, result) {
  const window = own(state.windows, effect.windowId);
  if (!isCurrentPanelEffect(state, effect)) {
    // A stale create owns only its new carrier. Never dispose a shared candidate.
    if (result?.ok && effect.type === 'create' && result.carrierId
      && !Object.values(state.sessions).some(session => session.carrierId === result.carrierId)) {
      effects.push({ type: 'dispose', windowId: effect.windowId, sessionId: effect.sessionId, carrierId: result.carrierId });
    } else if (result?.ok) effects.push({ type: 'inspect', windowId: effect.windowId });
    return;
  }
  const pending = window.pending;
  window.pending = null;
  if (!result?.ok) {
    window.failure = { code: result?.code || 'CARRIER_FAILED', operation: pending.type,
      message: result?.error || 'The carrier did not complete the operation.' };
    return;
  }
  // Accept the stored intent, never caller-provided alternate tab/session IDs.
  const tab = own(state.tabs, pending.tabId), session = openSession(state, pending.sessionId);
  if (['create', 'show', 'unpin'].includes(pending.type)) {
    const duplicate = Object.values(state.sessions).some(item => item.opened && item.carrierId === result.carrierId);
    const validCarrier = typeof result.carrierId === 'string' && result.carrierId.length > 0
      && (pending.type === 'create' ? !duplicate : session?.carrierId === result.carrierId);
    if (!validCarrier) {
      window.failure = { code: 'INSTANCE_REPLACED', operation: pending.type,
        message: 'A shared carrier must retain the same live document identity.' };
      if (result.carrierId && result.carrierId !== session?.carrierId && !duplicate)
        effects.push({ type: 'dispose', windowId: pending.windowId, sessionId: pending.sessionId, carrierId: result.carrierId });
      return;
    }
    if (!tab || tab.sourceVersion !== pending.sourceVersion || window.activeTabId !== tab.tabId)
      throw new Error('Current intent has an invalid source.');
    if (pending.type === 'create') state.sessions[pending.sessionId] = {
      id: pending.sessionId, windowId: pending.windowId, carrierId: result.carrierId, opened: true, lastUsed: 0 };
    if (pending.type === 'unpin') {
      for (const member of Object.values(state.tabs)) if (member.sessionId === pending.sessionId && member.tabId !== tab.tabId) member.sessionId = null;
      window.pinnedSessionId = null;
    }
    tab.sessionId = pending.sessionId;
    window.visibleSessionId = pending.sessionId; window.source = sourceFor(tab, window);
    if (pending.touch) state.sessions[pending.sessionId].lastUsed = ++state.clock;
  } else if (pending.type === 'close') {
    if (session) retire(state, session);
    window.visibleSessionId = null; window.source = null;
  } else if (pending.type === 'hide') {
    window.visibleSessionId = null; window.source = null;
  }
}

/** Pure reducer: returns an independent state and the carrier work still needed. */
export function reducePanelModel(previous, event) {
  const state = structuredClone(previous), effects = [];
  switch (event.type) {
    case 'MODE_CHANGED': {
      if (!PANEL_MODES.includes(event.mode)) throw new Error('Unknown panel mode.');
      if (event.mode === state.mode) break;
      const wasManual = state.mode === 'manual'; state.mode = event.mode;
      for (const window of Object.values(state.windows)) {
        invalidate(window, false); if (wasManual) window.pinnedSessionId = null;
      }
      break;
    }
    case 'TAB_ACTIVATED':
    case 'OPEN_REQUESTED': {
      const tab = observeTab(state, event.tab), window = getWindow(state, tab.windowId);
      invalidate(window); window.activeTabId = tab.tabId;
      resolve(state, effects, tab, event.type === 'OPEN_REQUESTED', true);
      break;
    }
    case 'TAB_NAVIGATED': {
      const tab = observeTab(state, event.tab, true), window = getWindow(state, tab.windowId);
      if (window.activeTabId === tab.tabId) { invalidate(window); resolve(state, effects, tab, false, false); }
      break;
    }
    case 'PIN_CHANGED': {
      if (state.mode !== 'manual') throw new Error('Pin control is available only in manual mode.');
      const window = getWindow(state, event.windowId), tab = own(state.tabs, event.tabId), session = openSession(state, tab?.sessionId);
      if (!tab || tab.windowId !== window.windowId || window.activeTabId !== tab.tabId || !session)
        throw new Error('Pin control requires the active tab and an open session.');
      if (typeof event.pinned !== 'boolean') throw new Error('Invalid pin value.');
      if (event.pinned) { invalidate(window, false); window.pinnedSessionId = session.id; }
      else if (window.pinnedSessionId === session.id) {
        invalidate(window); begin(state, effects, window, 'unpin', tab, session);
      }
      break;
    }
    case 'CLOSE_REQUESTED': {
      const window = getWindow(state, event.windowId), tab = own(state.tabs, window.activeTabId), session = openSession(state, tab?.sessionId);
      if (session) { invalidate(window); begin(state, effects, window, 'close', tab, session); }
      break;
    }
    case 'EFFECT_COMPLETED': complete(state, effects, event.effect, event.result); break;
    case 'CARRIER_VISIBILITY': {
      const session = Object.values(state.sessions).find(item => item.opened && item.carrierId === event.carrierId && item.windowId === event.windowId);
      if (!session) break;
      const window = getWindow(state, session.windowId), tab = own(state.tabs, window.activeTabId);
      if (!event.visible && window.visibleSessionId === session.id) { window.visibleSessionId = null; window.source = null; }
      // A visibility event cannot silently bind a new tab or finish an intent.
      if (event.visible && !window.pending && tab?.sessionId === session.id) {
        window.visibleSessionId = session.id; window.source = sourceFor(tab, window);
      }
      break;
    }
    case 'CARRIER_CLOSED': {
      const session = Object.values(state.sessions).find(item => item.opened && item.windowId === event.windowId && item.carrierId === event.carrierId);
      if (session) retire(state, session);
      break;
    }
    case 'TAB_REMOVED': {
      const tab = own(state.tabs, event.tabId); if (!tab) break;
      delete state.tabs[tab.tabId]; const window = getWindow(state, tab.windowId);
      if (window.activeTabId === tab.tabId) { invalidate(window); window.activeTabId = null; window.visibleSessionId = null; }
      retireIfOrphan(state, effects, tab.sessionId);
      break;
    }
    case 'TAB_MOVED': {
      const tab = own(state.tabs, event.tabId); if (!tab) break;
      if (!isId(event.windowId)) throw new Error('Invalid destination window.');
      if (tab.windowId === event.windowId) break;
      const oldWindow = getWindow(state, tab.windowId), newWindow = getWindow(state, event.windowId), session = openSession(state, tab.sessionId);
      const exclusive = session && Object.values(state.tabs).filter(item => item.sessionId === session.id).length === 1;
      const preserved = exclusive && event.carrier?.carrierId === session.carrierId && event.carrier.windowId === event.windowId;
      invalidate(oldWindow); invalidate(newWindow);
      if (oldWindow.activeTabId === tab.tabId) { oldWindow.activeTabId = null; oldWindow.visibleSessionId = null; }
      if (oldWindow.pinnedSessionId === session?.id) oldWindow.pinnedSessionId = null;
      const oldSessionId = tab.sessionId; tab.windowId = event.windowId; tab.sourceVersion++;
      if (preserved) session.windowId = event.windowId;
      else {
        tab.sessionId = null; retireIfOrphan(state, effects, oldSessionId);
        newWindow.failure = { code: 'WINDOW_TRANSFER_UNVERIFIED', operation: 'move',
          message: 'No evidence that the same carrier survived the window transfer.' };
      }
      break;
    }
    case 'WINDOW_REMOVED': {
      const window = own(state.windows, event.windowId); if (!window) break;
      for (const session of Object.values(state.sessions)) if (session.windowId === event.windowId && session.opened) {
        retire(state, session); effects.push({ type: 'dispose', windowId: session.windowId, sessionId: session.id, carrierId: session.carrierId });
      }
      for (const tab of Object.values(state.tabs)) if (tab.windowId === event.windowId) delete state.tabs[tab.tabId];
      delete state.windows[event.windowId]; break;
    }
    case 'CARRIERS_RECONCILED': {
      if (!Array.isArray(event.carriers)) throw new Error('Live carrier inventory is required.');
      if (event.invalidateIntents) for (const window of Object.values(state.windows))
        if (event.windowId === undefined || window.windowId === event.windowId) invalidate(window);
      for (const session of Object.values(state.sessions)) if (session.opened && (event.windowId === undefined || session.windowId === event.windowId)) {
        if (!event.carriers.some(live => live.sessionId === session.id && live.carrierId === session.carrierId && live.windowId === session.windowId)) retire(state, session);
      }
      break;
    }
    default: throw new Error(`Unknown panel event: ${event.type}`);
  }
  assertPanelInvariants(state);
  return { state, effects };
}

export function assertPanelInvariants(state) {
  if (state.version !== 1 || !PANEL_MODES.includes(state.mode) || !isId(state.clock) || !isId(state.sequence)) throw new Error('Invalid panel model.');
  const carriers = new Set();
  for (const session of Object.values(state.sessions)) if (session.opened) {
    if (!own(state.windows, session.windowId) || typeof session.carrierId !== 'string' || !session.carrierId
      || carriers.has(session.carrierId)) throw new Error('Invalid or duplicate live carrier.');
    carriers.add(session.carrierId);
    if (!Object.values(state.tabs).some(tab => tab.sessionId === session.id)) throw new Error('Open session has no members.');
  }
  for (const tab of Object.values(state.tabs)) {
    if (!isId(tab.tabId) || !isId(tab.sourceVersion) || !own(state.windows, tab.windowId)) throw new Error('Invalid tab binding.');
    if (tab.sessionId && openSession(state, tab.sessionId)?.windowId !== tab.windowId) throw new Error('Dangling or cross-window binding.');
  }
  for (const window of Object.values(state.windows)) {
    if (!isId(window.windowId) || !isId(window.revision)) throw new Error('Invalid window state.');
    if (window.activeTabId !== null && own(state.tabs, window.activeTabId)?.windowId !== window.windowId) throw new Error('Invalid active tab.');
    if (window.pinnedSessionId && (state.mode !== 'manual' || openSession(state, window.pinnedSessionId)?.windowId !== window.windowId)) throw new Error('Invalid pin.');
    if (window.visibleSessionId && openSession(state, window.visibleSessionId)?.windowId !== window.windowId) throw new Error('Invalid visible carrier.');
    if (window.source && (window.source.tabId !== window.activeTabId
      || window.source.version !== own(state.tabs, window.activeTabId)?.sourceVersion
      || window.source.epoch !== window.revision
      || own(state.tabs, window.activeTabId)?.sessionId !== window.visibleSessionId)) throw new Error('Stale source binding.');
  }
}

/** Saved associations are accepted only after comparing actual live identities. */
export function restorePanelModel(saved, liveCarriers) {
  assertPanelInvariants(saved);
  const state = structuredClone(saved);
  for (const window of Object.values(state.windows)) window.visibleSessionId = null;
  return reducePanelModel(state, { type: 'CARRIERS_RECONCILED', carriers: liveCarriers, invalidateIntents: true }).state;
}

/** Serialize carrier work per window while allowing newer intents to supersede it. */
export function createPanelModelController({ state = createPanelModel(), perform, onChange = () => {} }) {
  if (typeof perform !== 'function') throw new Error('A carrier adapter is required.');
  let current = structuredClone(state);
  assertPanelInvariants(current);
  const queues = new Map();
  const apply = event => {
    const transition = reducePanelModel(current, event); current = transition.state;
    onChange(structuredClone(current)); return transition.effects;
  };
  async function execute(effect) {
    if (effect.token && !isCurrentPanelEffect(current, effect)) return;
    let result;
    try { result = await perform(structuredClone(effect)); }
    catch (error) { result = { ok: false, error: error.message, code: error.code }; }
    if (effect.token) {
      for (const followup of apply({ type: 'EFFECT_COMPLETED', effect, result })) await execute(followup);
    } else if (effect.type === 'inspect' && result?.ok && Array.isArray(result.carriers)) {
      apply({ type: 'CARRIERS_RECONCILED', windowId: effect.windowId, carriers: result.carriers });
    } else if (!result?.ok && own(current.windows, effect.windowId)) {
      current = structuredClone(current);
      current.windows[effect.windowId].failure = { code: result?.code || 'CARRIER_FAILED', operation: effect.type, message: result?.error || 'Carrier cleanup failed.' };
      onChange(structuredClone(current));
    }
  }
  return {
    getState: () => structuredClone(current),
    dispatch(event) {
      return Promise.all(apply(event).map(effect => {
        const queued = (queues.get(effect.windowId) || Promise.resolve()).then(() => execute(effect));
        queues.set(effect.windowId, queued.catch(() => {})); return queued;
      }));
    },
    async idle() { await Promise.all([...queues.values()]); },
  };
}
