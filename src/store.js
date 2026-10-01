import { STATE_KEY, createReference, normalizeState } from './core.js';

let queue = Promise.resolve();
export async function getState() { const result = await chrome.storage.local.get(STATE_KEY); return normalizeState(result[STATE_KEY]); }
function mutate(fn) {
  const operation = queue.then(async () => {
    const state = await getState();
    const extra = fn(state);
    state.revision += 1;
    await chrome.storage.local.set({ [STATE_KEY]: state });
    return { state, ...extra };
  });
  queue = operation.catch(() => {});
  return operation;
}
export async function patchState(patch = {}) {
  const { state } = await mutate(state => {
    for (const key of ['selectedIds', 'templates', 'draft', 'settings', 'activeTemplateId']) if (Object.hasOwn(patch, key)) state[key] = key === 'settings' ? { ...state.settings, ...patch.settings } : patch[key];
    Object.assign(state, normalizeState(state));
  });
  return state;
}
export function addReference(raw) {
  return mutate(state => {
    const candidate = createReference(raw, { alias: `r${state.referenceSequence + 1}` });
    const existing = state.references.find(ref => ref.kind === candidate.kind && ref.url === candidate.url && ref.content === candidate.content && ref.context === candidate.context);
    if (!existing && state.references.length >= 50) throw new Error('引用篮子已满（50 份），请先移除不需要的引用。');
    const reference = existing || candidate;
    if (!existing) { state.references.push(reference); state.referenceSequence += 1; }
    if (!state.selectedIds.includes(reference.id)) state.selectedIds.push(reference.id);
    return { reference };
  });
}
export async function removeReference(id) {
  const { state } = await mutate(state => { state.references = state.references.filter(ref => ref.id !== id); state.selectedIds = state.selectedIds.filter(value => value !== id); });
  return state;
}
export async function setReferenceSelected(id, selected) {
  const { state } = await mutate(state => {
    if (!state.references.some(reference => reference.id === id)) throw new Error('引用已不存在。');
    state.selectedIds = selected ? [...new Set([...state.selectedIds, id])] : state.selectedIds.filter(value => value !== id);
  });
  return state;
}
export function updateReference(id, changes = {}) {
  return mutate(state => {
    const reference = state.references.find(ref => ref.id === id);
    if (!reference) throw new Error('引用已不存在。');
    for (const key of ['title', 'content', 'context']) if (Object.hasOwn(changes, key)) reference[key] = String(changes[key]);
    if (reference.content.length > 1000000) throw new Error('引用超过 100 万字符，修改没有保存。');
    if (reference.context.length > 1000000) throw new Error('附近段落超过 100 万字符，修改没有保存。');
    if (reference.kind !== 'url' && !reference.content.trim()) throw new Error('引用内容不能为空。');
    if (Object.hasOwn(changes, 'includeContext')) reference.includeContext = Boolean(changes.includeContext);
    return { reference };
  });
}
