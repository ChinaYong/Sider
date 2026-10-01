import { createInitialState, createReference, normalizeState } from './core.js';

const DEMO_STORAGE_KEY = 'sider-demo-state-v1';
const MESSAGE_ALIASES = new Set(['ADD_REFERENCE', 'REMOVE_REFERENCE', 'UPDATE_REFERENCE', 'REFERENCE_SELECTION', 'CAPTURE', 'CHAT_FILL', 'CHAT_OPEN', 'SOURCE_OPEN', 'ENABLE_SITE', 'DISABLE_SITE']);
let demoQueue = Promise.resolve();

function readDemoState() {
  const saved = localStorage.getItem(DEMO_STORAGE_KEY);
  if (saved) {
    try {
      return normalizeState(JSON.parse(saved));
    } catch {
      // A stale demo draft should not stop the preview from opening.
    }
  }
  return createInitialState();
}

function saveDemoState(state) {
  state.revision = (Number(state.revision) || 0) + 1;
  localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
  return state;
}

function addDemoReference(state, raw) {
  const candidate = createReference(raw, { alias: `r${state.referenceSequence + 1}` });
  const existing = state.references.find((reference) => reference.kind === candidate.kind && reference.url === candidate.url && reference.content === candidate.content && reference.context === candidate.context);
  if (!existing && state.references.length >= 50) throw new Error('引用篮子已满（50 份），请先移除不需要的引用。');
  const reference = existing || candidate;
  const nextState = saveDemoState({
    ...state,
    referenceSequence: state.referenceSequence + (existing ? 0 : 1),
    references: existing ? state.references : [...state.references, reference],
    selectedIds: [...new Set([...state.selectedIds, reference.id])],
  });
  return { ok: true, state: nextState, reference };
}

async function captureDemo(kind) {
  if (!['selection', 'url', 'page'].includes(kind)) throw new Error('不支持的引用类型。');
  const url = new URL('/demo/article.html', location.origin).href;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('演示资料读取失败，请确认本地预览服务正在运行。');
  const document = new DOMParser().parseFromString(await response.text(), 'text/html');
  const article = document.querySelector('[data-demo-article]');
  const selected = document.querySelector('[data-demo-selection]');
  if (!article || !selected) throw new Error('演示资料缺少正文或划词示例。');
  const title = document.querySelector('h1')?.textContent.trim() || document.title;
  const selectedText = selected.textContent.trim();
  const blocks = [...article.querySelectorAll('h1, h2, h3, p, li, pre, blockquote')]
    .filter((element) => !element.parentElement?.closest('li, pre, blockquote'))
    .map((element) => element.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const content = kind === 'selection' ? selectedText : kind === 'url' ? url : blocks.join('\n\n');
  return {
    kind,
    title,
    url,
    content,
    context: kind === 'selection' ? selected.parentElement.textContent.replace(/\s+/g, ' ').trim() : '',
    locator: kind === 'selection' ? { exact: selectedText } : null,
    capturedAt: new Date().toISOString(),
    extraction: { method: 'demo-article', scope: 'loaded-content', charCount: content.length, truncated: false },
  };
}

function openDemoUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('来源链接无效，无法打开。'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('只能打开 HTTP 或 HTTPS 来源链接。');
  const opened = window.open(url.href, '_blank');
  if (!opened) throw new Error('浏览器拦截了新窗口，请允许此站点打开弹出窗口后重试。');
  opened.opener = null;
  return { ok: true };
}

async function sendDemo(message) {
  const state = readDemoState();
  switch (message.type) {
    case 'SIDER_STATE_GET':
      return { ok: true, state };
    case 'SIDER_STATE_PATCH': {
      const patch = message.patch || {};
      for (const key of ['selectedIds', 'templates', 'draft', 'settings', 'activeTemplateId']) {
        if (Object.hasOwn(patch, key)) state[key] = key === 'settings' ? { ...state.settings, ...patch.settings } : patch[key];
      }
      return { ok: true, state: saveDemoState(normalizeState(state)) };
    }
    case 'SIDER_ADD_REFERENCE':
      return addDemoReference(state, message.reference);
    case 'SIDER_REFERENCE_SELECTION': {
      if (!state.references.some((reference) => reference.id === message.id)) throw new Error('引用已不存在。');
      const selectedIds = message.selected
        ? [...new Set([...state.selectedIds, message.id])]
        : state.selectedIds.filter((id) => id !== message.id);
      return { ok: true, state: saveDemoState({ ...state, selectedIds }) };
    }
    case 'SIDER_REMOVE_REFERENCE': {
      const nextState = saveDemoState({
        ...state,
        references: state.references.filter((reference) => reference.id !== message.id),
        selectedIds: state.selectedIds.filter((id) => id !== message.id),
      });
      return { ok: true, state: nextState };
    }
    case 'SIDER_UPDATE_REFERENCE': {
      const existing = state.references.find((reference) => reference.id === message.id);
      if (!existing) throw new Error('找不到这条引用，可能已被删除。');
      const reference = { ...existing };
      const changes = message.changes || {};
      for (const key of ['title', 'content', 'context']) {
        if (Object.hasOwn(changes, key)) reference[key] = String(changes[key]);
      }
      if (reference.content.length > 1000000) throw new Error('引用超过 100 万字符，修改没有保存。');
      if (reference.kind !== 'url' && !reference.content.trim()) throw new Error('引用内容不能为空。');
      if (Object.hasOwn(changes, 'includeContext')) reference.includeContext = Boolean(changes.includeContext);
      const nextState = saveDemoState({
        ...state,
        references: state.references.map((item) => item.id === reference.id ? reference : item),
      });
      return { ok: true, state: nextState, reference };
    }
    case 'SIDER_CAPTURE':
      return addDemoReference(state, await captureDemo(message.kind));
    case 'SIDER_CHAT_FILL':
      return { ok: false, error: '演示模式不会连接或填入真实 ChatGPT。请复制提示词；安装扩展后即可使用填入功能。' };
    case 'SIDER_CHAT_OPEN':
      return openDemoUrl('https://chatgpt.com/');
    case 'SIDER_SOURCE_OPEN':
      return openDemoUrl(message.reference?.url);
    case 'SIDER_ENABLE_SITE':
    case 'SIDER_DISABLE_SITE':
      return { ok: false, error: '演示模式无法修改浏览器站点权限。请在 Chrome 或 Edge 中安装扩展后管理划词按钮。' };
    default:
      return { ok: false, error: '无法识别此操作。' };
  }
}

/** Route panel actions to the extension worker, or the explicitly labelled demo. */
export async function send(message) {
  message = { ...message, type: MESSAGE_ALIASES.has(message?.type) ? `SIDER_${message.type}` : message?.type };
  if (globalThis.chrome?.runtime?.id) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      return response ?? { ok: false, error: '扩展后台没有返回结果，请重新打开侧栏。' };
    } catch (error) {
      return { ok: false, error: error.message || '无法连接扩展后台，请重新加载扩展后重试。' };
    }
  }
  const result = demoQueue.then(() => sendDemo(message)).catch((error) => ({ ok: false, error: error.message || '演示操作失败。' }));
  demoQueue = result.then(() => undefined);
  return result;
}
