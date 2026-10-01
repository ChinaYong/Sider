import { findComposer } from './composer.js';

const AREA = '[data-composer-attachments]';
const CARD = '[class~="group/composer-attachment"]';
const DEFAULT_TIMEOUT = 90000;

function sameSpec(first, second) {
  return Boolean(first && second && first.name === second.name && first.content === second.content && first.mimeType === second.mimeType);
}

function normalizeSpec(raw) {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim() || typeof raw.content !== 'string' || !raw.content.trim()) throw new Error('正文附件的名称或内容为空。');
  return { name: raw.name, content: raw.content, mimeType: raw.mimeType || 'text/plain' };
}

function uploadName(view, name) {
  const crypto = view.crypto;
  let marker;
  if (typeof crypto?.getRandomValues === 'function') {
    const bytes = new view.Uint8Array(8);
    crypto.getRandomValues(bytes);
    marker = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } else if (typeof crypto?.randomUUID === 'function') {
    const uuid = crypto.randomUUID().replaceAll('-', '').toLowerCase();
    if (/^[0-9a-f]{32}$/.test(uuid)) marker = uuid.slice(0, 12) + uuid.slice(-4);
  }
  if (!marker) throw new Error('当前浏览器没有可用的安全随机数，无法安全标识正文附件。');
  const suffix = name.endsWith('-网页正文.txt') ? '-网页正文.txt' : name.match(/\.[^.]+$/)?.[0] || '';
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  return `${stem}-sider-${marker}${suffix}`;
}

function removeLabels(name) {
  return [`Remove ${name}`, `Remove file ${name}`, `删除 ${name}`, `移除 ${name}`, `删除文件 ${name}`, `移除文件 ${name}`];
}

function exactButton(card, labels) {
  return [...card.querySelectorAll('button')].find(button => labels.includes(button.getAttribute('aria-label')));
}

function namesCard(card, name) {
  return Boolean(exactButton(card, [name, ...removeLabels(name)]) || [...card.querySelectorAll('[role="progressbar"]')].some(bar => [`Uploading ${name}`, `正在上传 ${name}`, `上传 ${name}`].includes(bar.getAttribute('aria-label'))));
}

function acceptsText(input) {
  if (input.disabled) return false;
  const accept = (input.getAttribute('accept') || '').trim().toLowerCase();
  return !accept || accept.split(',').some(part => ['*/*', 'text/*', 'text/plain', 'text/markdown', 'application/octet-stream', '.txt', '.md', '.markdown'].includes(part.trim()));
}

function composerScope(document, editor) {
  const form = editor.closest('form');
  let candidate = form || editor.parentElement;
  for (let depth = 0; candidate && candidate !== document.body && candidate !== document.documentElement && depth < 8; depth++, candidate = candidate.parentElement) {
    const inputs = [...candidate.querySelectorAll('input[type="file"]')].filter(acceptsText);
    if (!inputs.length) continue;
    const labelled = inputs.filter(input => /^(attach files|添加文件|上传文件|附加文件)$/i.test(input.getAttribute('aria-label') || ''));
    const choices = labelled.length ? labelled : inputs;
    if (choices.length !== 1) throw new Error('无法确定 ChatGPT 的正文附件上传入口，请检查原版附件控件。');
    return { scope: candidate, input: choices[0] };
  }
  throw new Error('没有找到可用的 ChatGPT 文件上传入口，请确认当前会话支持附件。');
}

function cards(scope) {
  return [...scope.querySelectorAll(`${AREA} ${CARD}`)];
}

function failed(card) {
  const indicator = card.querySelector('[role="alert"],[data-state="error"],[data-status="error"],[data-testid*="error"],[aria-invalid="true"]');
  // Filenames are user data and can contain words such as "Upload failed".
  // Only native error indicators/retry controls describe the upload status.
  return Boolean(indicator || [...card.querySelectorAll('button')].some(button => /^(retry upload|retry attachment|重试上传|重试附件)$/i.test(button.getAttribute('aria-label') || '')));
}

/** Operate only ChatGPT's visible attachment UI; no private state or upload API. */
export function createAttachmentManager(document, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const view = document.defaultView;
  const duration = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT);
  const listeners = new Set();
  const retired = new Set();
  let active = null;
  let epoch = 0;
  let disposed = false;

  const notify = () => { for (const listener of [...listeners]) listener(); };
  const sameSession = record => {
    if (record.invalidSession) return false;
    const current = record.href === view.location.href && record.editor === findComposer(document) && record.scope.isConnected;
    // Once a navigation/replacement was observed, returning to the same URL
    // cannot make a new user attachment part of the retired upload again.
    if (!current) record.invalidSession = true;
    return current;
  };

  function locate(record, allowClaim = true) {
    const exact = record.card?.isConnected && record.scope.contains(record.card) && namesCard(record.card, record.spec.name) ? record.card : null;
    if (exact) return exact;
    // A removed known card may be followed by a same-name user file. Ownership
    // follows the native node, never a later filename match.
    if (record.seen) return null;
    if (!allowClaim || !sameSession(record)) return null;
    const matching = cards(record.scope).filter(card => namesCard(card, record.spec.name));
    if (matching.length > 1) throw new Error('出现同名正文附件，无法安全识别扩展附件，请检查原版附件区域。');
    const candidate = matching[0];
    if (candidate && !record.baseline.has(candidate)) {
      record.card = candidate;
      record.seen = true;
      return candidate;
    }
    return null;
  }

  function state(record) {
    if (!record || record.retiring || !sameSession(record)) return { ready: false, name: record?.spec.name || '', invalidated: Boolean(record), removed: Boolean(record?.seen && !record.card?.isConnected) };
    try {
      const card = locate(record);
      const error = card && failed(card);
      const ready = Boolean(card && !error && !card.querySelector('[role="progressbar"]') && exactButton(card, [record.spec.name]));
      return { ready, name: record.spec.name, invalidated: Boolean(error || record.seen && !card), removed: Boolean(record.seen && !card) };
    } catch { return { ready: false, name: record.spec.name, invalidated: true, removed: false }; }
  }

  function waitFor(check, deadline, { signal, timeoutMessage } = {}) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (value, error) => {
        if (finished) return;
        finished = true;
        listeners.delete(tick);
        view.clearInterval(interval);
        signal?.removeEventListener('abort', tick);
        if (error) reject(error); else resolve(value);
      };
      const tick = () => {
        try {
          if (signal?.aborted) throw new Error('正文附件准备已取消，问题已保留。');
          const value = check();
          if (value) finish(value);
          else if (Date.now() >= deadline) throw new Error(timeoutMessage || '正文附件上传超时，问题已保留，请检查 ChatGPT 附件区域后重试。');
        } catch (error) { finish(null, error); }
      };
      const interval = view.setInterval(tick, 25);
      listeners.add(tick);
      signal?.addEventListener('abort', tick, { once: true });
      tick();
    });
  }

  async function cleanup(record) {
    if (record.cleanup) return record.cleanup;
    record.retiring = true;
    retired.add(record);
    notify();
    record.cleanup = (async () => {
      let removalAttempted = false;
      const deadline = Date.now() + Math.min(duration, 1500);
      await waitFor(() => {
        const card = locate(record, sameSession(record));
        if (!card) {
          if (record.seen || !record.dispatched) return true;
          if (!sameSession(record)) throw new Error('会话已切换，无法确认旧正文附件状态，请检查原版附件区域。');
          return false;
        }
        if (!removalAttempted) {
          const remove = exactButton(card, removeLabels(record.spec.name));
          if (!remove || remove.disabled) throw new Error('无法取消正文附件，请在 ChatGPT 附件区域手动移除后重试。');
          removalAttempted = true;
          remove.click();
        }
        return !card.isConnected || !record.scope.contains(card);
      }, deadline, { timeoutMessage: '取消正文附件超时，无法确认已清理，请检查 ChatGPT 附件区域后重试。' });
      retired.delete(record);
      if (active === record) active = null;
    })();
    try { await record.cleanup; }
    catch (error) {
      // Keep a tombstone until a late native card can be cancelled in its
      // original composer. Never identify a new conversation's file by name.
      record.cleanup = null;
      if (record.invalidSession && !record.card?.isConnected) {
        retired.delete(record);
        if (active === record) active = null;
      }
      throw error;
    }
  }

  function reconcile() {
    for (const record of retired) {
      if (record.cleanup) continue;
      try {
        if (locate(record, sameSession(record))) void cleanup(record).catch(() => {});
      } catch { /* Ambiguous cards must be left for the user to inspect. */ }
    }
    notify();
    return state(active);
  }

  const observer = new view.MutationObserver(reconcile);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });

  async function clear() {
    epoch++;
    if (active) await cleanup(active);
    for (const record of [...retired]) await cleanup(record);
  }

  async function prepare(raw, { signal, isCurrent = () => true } = {}) {
    if (disposed) throw new Error('正文附件管理已关闭。');
    const spec = normalizeSpec(raw);
    const assertCurrent = () => {
      if (signal?.aborted || !isCurrent()) throw new Error('问题或引用已修改，正文附件准备已取消，请重新发送。');
    };
    assertCurrent();
    if (active && !active.retiring && sameSpec(active.logicalSpec, spec) && sameSession(active) && !state(active).invalidated) {
      const record = active;
      await record.promise;
      assertCurrent();
      if (active !== record || !state(record).ready) throw new Error('正文附件已被移除，请重新发送。');
      return { name: record.spec.name };
    }
    const token = ++epoch;
    if (active) await cleanup(active);
    if (token !== epoch || disposed) throw new Error('正文附件准备已取消。');
    assertCurrent();
    const editor = findComposer(document);
    if (!editor) throw new Error('没有找到可用的 ChatGPT 输入框。');
    const { scope, input } = composerScope(document, editor);
    const baseline = new Set(cards(scope));
    if ([...baseline].some(card => namesCard(card, spec.name))) throw new Error(`已有同名附件“${spec.name}”，请先移除或重命名该附件。`);
    if (typeof view.DataTransfer !== 'function' || typeof view.File !== 'function') throw new Error('当前浏览器不支持自动准备文件附件。');
    const actualSpec = { ...spec, name: uploadName(view, spec.name) };
    if ([...baseline].some(card => namesCard(card, actualSpec.name))) throw new Error(`已有同名附件“${actualSpec.name}”，请先移除或重命名该附件。`);
    const record = { spec: actualSpec, logicalSpec: spec, editor, scope, href: view.location.href, baseline, card: null, seen: false, retiring: false, dispatched: false, deadline: Date.now() + duration, promise: null, cleanup: null };
    active = record;
    record.promise = (async () => {
      try {
        const transfer = new view.DataTransfer();
        transfer.items.add(new view.File([actualSpec.content], actualSpec.name, { type: actualSpec.mimeType }));
        input.files = transfer.files;
        record.dispatched = true;
        input.dispatchEvent(new view.Event('change', { bubbles: true }));
        await waitFor(() => {
          assertCurrent();
          if (disposed || record.retiring || active !== record) throw new Error('正文附件准备已取消。');
          if (!sameSession(record)) throw new Error('ChatGPT 会话已切换，正文附件准备已取消。');
          const card = locate(record);
          if (card && failed(card)) throw new Error('ChatGPT 未能上传正文附件，问题已保留，请检查附件后重试。');
          if (record.seen && !card) throw new Error('正文附件已被移除，问题已保留。');
          return state(record).ready;
        }, record.deadline, { signal });
        return { name: actualSpec.name };
      } catch (error) {
        try { await cleanup(record); }
        catch (cleanupError) { throw new Error(`${error.message} ${cleanupError.message}`); }
        throw error;
      }
    })();
    return record.promise;
  }

  return {
    prepare, clear, reconcile,
    isReady(raw) {
      let spec;
      try { spec = normalizeSpec(raw); } catch { return false; }
      return Boolean(active && sameSpec(active.logicalSpec, spec) && state(active).ready);
    },
    isOwnedRemoveButton(element) {
      return Boolean(active && !active.retiring && active.card?.isConnected && exactButton(active.card, removeLabels(active.spec.name)) === element);
    },
    dispose() {
      disposed = true;
      return clear().catch(() => {}).finally(() => { observer.disconnect(); listeners.clear(); });
    },
  };
}
