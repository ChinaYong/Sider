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

/** Read only native error indicators, never the filename or whole card text. */
export function attachmentFailureDetail(card, selector) {
  const indicator = card.querySelector(selector) || (card.matches(selector) ? card : null);
  if (!indicator) return '';
  const descriptions = (indicator.getAttribute('aria-describedby') || '').split(/\s+/)
    .map(id => card.ownerDocument.getElementById(id)?.textContent?.trim()).filter(Boolean);
  return (descriptions.join(' ') || indicator.getAttribute('title') || indicator.getAttribute('aria-label')
    || (indicator !== card || indicator.getAttribute('role') === 'alert' ? indicator.textContent?.trim() : '') || '').trim().slice(0, 1000);
}

/** Operate the site's native attachment UI; no private state or upload API. */
function createSingleAttachmentManager(document, { timeoutMs = DEFAULT_TIMEOUT, driver } = {}) {
  const view = document.defaultView;
  const siteName = driver?.siteName || 'ChatGPT';
  const locateComposer = driver?.findComposer || (() => findComposer(document));
  const attachmentCards = scope => driver ? driver.cards(scope) : cards(scope);
  const identifies = (card, name) => driver ? driver.namesCard(card, name) : namesCard(card, name);
  const removeButton = (card, name) => driver ? driver.removeButton(card, name) : exactButton(card, removeLabels(name));
  const duration = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT);
  const listeners = new Set();
  const retired = new Set();
  let active = null;
  let epoch = 0;
  let disposed = false;
  let clearing = null;
  let preparing = null;

  const progress = (record, phase) => {
    record.phase = phase;
    const message = phase === 'cleaning' ? '正在取消正文附件…' : '正在准备正文附件…';
    try { record.onProgress?.({ phase, message }); } catch { /* Progress cannot change the upload outcome. */ }
  };

  const notify = () => { for (const listener of [...listeners]) listener(); };
  const sameSession = record => {
    if (record.invalidSession) return false;
    const current = record.href === view.location.href && record.editor === locateComposer() && record.scope.isConnected && (!driver?.sessionKey || record.session === driver.sessionKey());
    // Once a navigation/replacement was observed, returning to the same URL
    // cannot make a new user attachment part of the retired upload again.
    if (!current) record.invalidSession = true;
    return current;
  };

  function locate(record, allowClaim = true) {
    const exact = record.card?.isConnected && record.scope.contains(record.card) && identifies(record.card, record.spec.name) ? record.card : null;
    if (exact) return exact;
    // A removed known card may be followed by a same-name user file. Ownership
    // follows the native node, never a later filename match.
    if (record.seen) return null;
    if (!allowClaim || !sameSession(record)) return null;
    const matching = attachmentCards(record.scope).filter(card => identifies(card, record.spec.name));
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
      const error = card && (driver ? driver.failed(card) : failed(card));
      const ready = Boolean(card && !error && (driver ? driver.ready(card, record.spec.name, { requireSendReady: record.requireSendReady }) : !card.querySelector('[role="progressbar"]') && exactButton(card, [record.spec.name])));
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
          else if (Date.now() >= deadline) throw new Error(timeoutMessage || `正文附件上传超时，问题已保留，请检查 ${siteName} 附件区域后重试。`);
        } catch (error) { finish(null, error); }
      };
      const interval = view.setInterval(tick, 25);
      listeners.add(tick);
      signal?.addEventListener('abort', tick, { once: true });
      tick();
    });
  }

  async function cleanup(record) {
    if (record.cleanupFailed) {
      const card = locate(record, sameSession(record));
      if (!card && record.seen) {
        retired.delete(record);
        if (active === record) active = null;
        return;
      }
      // A dispatched upload may arrive after cancellation timed out. Only this
      // newly observed owned card permits a fresh removal attempt.
      if (card && !record.cleanupCard) { record.cleanup = null; record.cleanupFailed = false; }
    }
    if (record.cleanup) return record.cleanup;
    record.retiring = true;
    retired.add(record);
    progress(record, 'cleaning');
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
          record.cleanupCard = card;
          const remove = removeButton(card, record.spec.name);
          if (!remove || remove.disabled) throw new Error(`无法取消正文附件，请在 ${siteName} 附件区域手动移除后重试。`);
          removalAttempted = true;
          remove.click();
        }
        return !card.isConnected || !record.scope.contains(card);
      }, deadline, { timeoutMessage: `取消正文附件超时，无法确认已清理，请检查 ${siteName} 附件区域后重试。` });
      retired.delete(record);
      if (active === record) active = null;
    })();
    try { await record.cleanup; }
    catch (error) {
      // Keep a tombstone until a late native card can be cancelled in its
      // original composer. Never identify a new conversation's file by name.
      record.cleanupFailed = true;
      error.code = 'ATTACHMENT_CLEANUP_FAILED';
      if (record.invalidSession && !record.card?.isConnected) {
        retired.delete(record);
        if (active === record) active = null;
      }
      throw error;
    }
  }

  function reconcile() {
    for (const record of retired) {
      if (record.cleanup && !record.cleanupFailed) continue;
      try {
        const card = locate(record, sameSession(record));
        if ((card && !record.cleanupCard) || (record.seen && !card)) void cleanup(record).catch(() => {});
      } catch { /* Ambiguous cards must be left for the user to inspect. */ }
    }
    notify();
    return state(active);
  }

  const observer = new view.MutationObserver(reconcile);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });

  function clear() {
    if (clearing) return clearing;
    epoch++;
    const records = new Set([active, ...retired].filter(Boolean));
    clearing = (async () => { for (const record of records) await cleanup(record); })()
      .finally(() => { clearing = null; });
    return clearing;
  }

  async function prepareOnce(raw, { signal, isCurrent = () => true, onProgress, requireSendReady = true } = {}) {
    if (disposed) throw new Error('正文附件管理已关闭。');
    const spec = normalizeSpec(raw);
    const deadline = Date.now() + duration;
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
    const editor = locateComposer();
    if (!editor) throw new Error(`没有找到可用的 ${siteName} 输入框。`);
    const href = view.location.href;
    const session = driver?.sessionKey?.();
    let target = driver ? driver.composerScope(document, editor, { signal, deadline, isCurrent: () => {
      try { assertCurrent(); } catch { return false; }
      return token === epoch && !disposed && editor === locateComposer() && href === view.location.href && (!driver.sessionKey || session === driver.sessionKey());
    } }) : composerScope(document, editor);
    // A native synchronous lookup must establish the active upload before a
    // second prepare call; an unnecessary await invalidates that first call.
    if (typeof target?.then === 'function') target = await target;
    const { scope, input } = target;
    assertCurrent();
    if (token !== epoch || disposed || editor !== locateComposer() || href !== view.location.href || driver?.sessionKey && session !== driver.sessionKey()) throw new Error('会话已切换，正文附件准备已取消。');
    const baseline = new Set(attachmentCards(scope));
    if ([...baseline].some(card => identifies(card, spec.name))) throw new Error(`已有同名附件“${spec.name}”，请先移除或重命名该附件。`);
    if (typeof view.DataTransfer !== 'function' || typeof view.File !== 'function') throw new Error('当前浏览器不支持自动准备文件附件。');
    const actualSpec = { ...spec, name: uploadName(view, spec.name) };
    if ([...baseline].some(card => identifies(card, actualSpec.name))) throw new Error(`已有同名附件“${actualSpec.name}”，请先移除或重命名该附件。`);
    const record = { spec: actualSpec, logicalSpec: spec, editor, scope, href, session, baseline, card: null, seen: false, retiring: false, dispatched: false, deadline, promise: null, cleanup: null, onProgress, requireSendReady };
    active = record;
    record.promise = (async () => {
      try {
        const transfer = new view.DataTransfer();
        transfer.items.add(new view.File([actualSpec.content], actualSpec.name, { type: actualSpec.mimeType }));
        assertCurrent();
        progress(record, 'uploading');
        assertCurrent();
        record.dispatched = true;
        if (driver?.upload) await driver.upload({ input, scope, transfer, editor });
        else { input.files = transfer.files; input.dispatchEvent(new view.Event('change', { bubbles: true })); }
        await waitFor(() => {
          assertCurrent();
          if (disposed || record.retiring || active !== record) throw new Error('正文附件准备已取消。');
          if (!sameSession(record)) throw new Error(`${siteName} 会话已切换，正文附件准备已取消。`);
          const card = locate(record);
          if (card && (driver ? driver.failed(card) : failed(card))) {
            const detail = driver ? driver.failureDetail?.(card) : attachmentFailureDetail(card, '[role="alert"],[data-state="error"],[data-status="error"],[data-testid*="error"],[aria-invalid="true"]');
            throw new Error(`${siteName} 正文附件上传失败${detail ? `：${detail}` : ''}。问题已保留，请重试或切换正文发送方式。`);
          }
          if (record.seen && !card) throw new Error('正文附件已被移除，问题已保留。');
          return state(record).ready;
        }, record.deadline, { signal });
        return { name: actualSpec.name };
      } catch (error) {
        try { await cleanup(record); }
        catch (cleanupError) { throw Object.assign(new Error(`${error.message}\n${cleanupError.message}`), { attachmentCleanupHandled: true, cleanupError }); }
        error.attachmentCleanupHandled = true;
        throw error;
      }
    })();
    return record.promise;
  }

  async function prepare(raw, options = {}) {
    const spec = normalizeSpec(raw), editor = locateComposer(), href = view.location.href, session = driver?.sessionKey?.();
    if (preparing && preparing.epoch === epoch && sameSpec(preparing.spec, spec) && preparing.editor === editor && preparing.href === href && preparing.session === session) {
      const result = await preparing.promise;
      if (options.signal?.aborted || options.isCurrent && !options.isCurrent()) throw new Error('问题或引用已修改，正文附件准备已取消，请重新发送。');
      if (!active || !sameSpec(active.logicalSpec, spec) || !state(active).ready) throw new Error('正文附件已被移除，请重新发送。');
      return result;
    }
    // Lazy native upload menus must share their initialization as well as the
    // upload. Otherwise two concurrent prepares invalidate each other's editor.
    const pending = { spec, editor, href, session, epoch: null, promise: null };
    pending.promise = prepareOnce(raw, options).finally(() => { if (preparing === pending) preparing = null; });
    pending.epoch = epoch;
    preparing = pending;
    return pending.promise;
  }

  return {
    prepare, clear, reconcile,
    isReady(raw) {
      let spec;
      try { spec = normalizeSpec(raw); } catch { return false; }
      return Boolean(active && sameSpec(active.logicalSpec, spec) && state(active).ready);
    },
    isOwnedRemoveButton(element) {
      return Boolean(active && !active.retiring && active.card?.isConnected && removeButton(active.card, active.spec.name) === element);
    },
    forget() {
      disposed = true; epoch++; active = null; retired.clear(); observer.disconnect(); listeners.clear();
    },
    dispose() {
      disposed = true;
      return clear().catch(() => {}).finally(() => { observer.disconnect(); listeners.clear(); });
    },
  };
}

/** Each template keeps its own native-card ownership; uploads share one queue. */
export function createAttachmentManager(document, options = {}) {
  const entries = new Map();
  let queue = Promise.resolve(), epoch = 0, disposed = false, lastId = 'default';
  const key = spec => spec?.id || 'default';
  const enqueue = action => {
    const operation = queue.then(action); queue = operation.catch(() => {}); return operation;
  };
  async function removeIds(ids) {
    const errors = [];
    for (const id of ids) {
      const entry = entries.get(id); if (!entry) continue;
      if (entry.cleared) continue;
      entry.removing = true;
      try { await entry.manager.clear(); entry.cleared = true; }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw Object.assign(new Error(errors.map(error => error.message).join('\n')), { cleanupError: errors[0] });
  }
  return {
    prepare(spec, settings = {}) {
      const id = key(spec), token = epoch;
      lastId = id;
      if (id === 'default') {
        let entry = entries.get(id);
        if (!entry) { entry = { manager: createSingleAttachmentManager(document, options), spec }; entries.set(id, entry); }
        entry.cleared = false; entry.removing = false; entry.spec = spec;
        return entry.manager.prepare(spec, settings);
      }
      return enqueue(async () => {
        if (disposed || token !== epoch || settings.signal?.aborted) throw new Error('预设附件准备已取消。');
        let entry = entries.get(id);
        if (!entry) { entry = { manager: createSingleAttachmentManager(document, options), spec }; entries.set(id, entry); }
        entry.spec = spec; entry.cleared = false; entry.removing = false;
        return entry.manager.prepare(spec, { ...settings, isCurrent: () => token === epoch && !disposed && (settings.isCurrent?.() ?? true) });
      });
    },
    isReady(spec) { return entries.get(key(spec))?.manager.isReady(spec) || false; },
    reconcile() {
      let last = { ready: false };
      for (const [id, entry] of entries) { const state = entry.manager.reconcile(); if (id === lastId) last = state; }
      return last;
    },
    ownedId(element) { for (const [id, entry] of entries) if (entry.manager.isOwnedRemoveButton(element)) return id; return null; },
    missingIds() { return [...entries].filter(([, entry]) => !entry.cleared && !entry.removing && entry.manager.reconcile().invalidated).map(([id]) => id); },
    isOwnedRemoveButton(element) { return this.ownedId(element) !== null; },
    remove(id) { return removeIds([id]); },
    adopt(stagingId, spec) {
      const entry = entries.get(stagingId), previous = entries.get(key(spec));
      if (!entry || !entry.manager.isReady(spec) || previous && !previous.cleared) throw new Error('预设附件尚未就绪或旧附件尚未清理。');
      if (previous) void previous.manager.dispose().catch(() => {});
      entries.delete(stagingId); entry.spec = spec; entries.set(key(spec), entry); lastId = key(spec);
    },
    retain(ids) { return removeIds([...entries.keys()].filter(id => !ids.includes(id))); },
    clear() {
      epoch++;
      if (entries.size === 1 && entries.has('default')) return entries.get('default').manager.clear();
      return removeIds([...entries.keys()]);
    },
    commit() { for (const entry of entries.values()) entry.manager.forget(); entries.clear(); },
    dispose() { disposed = true; epoch++; return Promise.allSettled([...entries.values()].map(entry => entry.manager.dispose())).then(() => {}); },
  };
}
