import { createTabContext, normalizeContext } from './context.js';
import { initializeTemplates, syncTemplateDemand } from './context-store.js';

export const REFERENCE_SESSIONS_KEY = 'sider.referenceSessions.v1';
const isId = value => Number.isSafeInteger(value) && value >= 0;

// A sidebar owns its choices. A borrowed page supplies material only, never
// another sidebar's temporary preset choices. Storage survives worker suspension.
export function createReferenceSessions(api) {
  let queue = Promise.resolve();
  const read = async () => (await api.storage.session.get(REFERENCE_SESSIONS_KEY))[REFERENCE_SESSIONS_KEY] || {};
  function mutate(ownerTabId, operation) {
    if (!isId(ownerTabId)) throw new Error('侧栏所属标签页无效。');
    const pending = queue.then(async () => {
      const all = await read();
      const previous = all[ownerTabId];
      const next = operation(previous ? structuredClone(previous) : null);
      if (!next && !previous || JSON.stringify(next) === JSON.stringify(previous)) return previous || null;
      if (next) {
        next.context.revision = (previous?.context.revision ?? next.context.revision) + 1;
        all[ownerTabId] = next;
      } else delete all[ownerTabId];
      await api.storage.session.set({ [REFERENCE_SESSIONS_KEY]: all });
      return next;
    });
    queue = pending.catch(() => {});
    return pending;
  }
  function check(state, expectedEpoch) {
    if (!state || expectedEpoch !== undefined && state.epoch !== expectedEpoch) {
      throw Object.assign(new Error('引用来源已变化，请重新操作。'), { code: 'REFERENCE_CHANGED' });
    }
  }
  return {
    async get(ownerTabId) { const state = (await read())[ownerTabId]; return state ? structuredClone(state) : null; },
    async all() { return read(); },
    switch(ownerTabId, source, initialContext, templates) {
      return mutate(ownerTabId, previous => {
        const context = normalizeContext(previous?.context || initialContext, source.id);
        context.tabId = source.id;
        initializeTemplates(context, templates);
        Object.assign(context, { url: '', title: '', selection: null, attachments: { url: context.attachments.url, page: null }, pageError: '' });
        syncTemplateDemand(context, templates);
        return { ownerTabId, sourceTabId: source.id, epoch: (previous?.epoch || 0) + 1,
          title: source.title || source.url || '未命名标签页', status: 'loading', error: '', context };
      });
    },
    update(ownerTabId, expectedEpoch, operation) {
      return mutate(ownerTabId, state => { check(state, expectedEpoch); operation(state); return state; });
    },
    defaults(ownerTabId, templates, changedIds) {
      return mutate(ownerTabId, state => {
        if (!state) return null;
        initializeTemplates(state.context, templates);
        const context = state.context;
        for (const id of Object.keys(context.templateSelections)) if (!templates.some(item => item.id === id)) delete context.templateSelections[id];
        for (const item of templates) if (!Object.hasOwn(context.templateSelections, item.id) || changedIds?.includes(item.id)) {
          context.templateSelections[item.id] = changedIds?.includes(item.id) ? item.defaultIncluded : false;
          context.explicitTemplates = context.explicitTemplates.filter(id => id !== item.id);
        }
        syncTemplateDemand(context, templates);
        return state;
      });
    },
    invalidate(sourceTabId, status, error = '') {
      return queue.then(async () => {
        const owners = Object.values(await read()).filter(state => state.sourceTabId === sourceTabId).map(state => state.ownerTabId);
        await Promise.all(owners.map(owner => mutate(owner, state => {
          if (!state || state.sourceTabId !== sourceTabId || state.status === status && state.error === error && !state.context.url) return state;
          state.epoch++; state.status = status; state.error = error;
          const fresh = createTabContext(sourceTabId);
          Object.assign(state.context, { url: fresh.url, title: fresh.title, selection: null,
            attachments: { url: state.context.attachments.url, page: null }, pageError: state.context.pageRequested ? error : '' });
          return state;
        })));
      });
    },
    remove(ownerTabId) { return mutate(ownerTabId, () => null); },
  };
}

export function referenceSource(state) {
  return { ownerTabId: state.ownerTabId, tabId: state.sourceTabId, epoch: state.epoch,
    title: state.title, status: state.status, error: state.error };
}
