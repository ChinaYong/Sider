import { TAB_CONTEXT_PREFIX, CONTEXT_SETTINGS_KEY, normalizeContext, normalizeContextSettings, composeContextPrompt, validateContextTemplate } from '../context.js';
import { fillComposer, findComposer, getComposerText } from './composer.js';
import { createAttachmentManager } from './attachments.js';

const CSS = `
:host{all:initial;display:block;position:relative;font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:12px;line-height:1.5;width:100%;min-width:0;z-index:30;--surface:#fff;--line:#e6e6e6;--muted:#888;--hover:#f4f4f4;--ink:#262626;color:var(--ink);color-scheme:light}
*{box-sizing:border-box}[hidden]{display:none!important}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer;border:0;background:transparent;padding:6px 8px;border-radius:7px;line-height:1.4;white-space:nowrap}button:hover{background:var(--hover)}button:disabled{opacity:.45;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #10a37f;outline-offset:1px}.bar{display:flex;gap:5px;align-items:center;min-height:32px;padding:4px 2px;border-top:1px solid var(--line);margin-top:5px;min-width:0}.bar>button{font-size:11px;padding:5px 7px;flex:none}.bar>button:last-child{margin-left:auto}.chips{display:flex;gap:5px;align-items:center;flex-wrap:wrap;min-width:0;flex:1}.chip{display:flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:7px;background:var(--hover);font-size:11px;padding-left:7px;max-width:100%;min-width:0}.chip button{font-size:15px;line-height:1;padding:4px 6px;flex:none;color:var(--muted)}.selection-chip{flex:0 1 auto;max-width:100%;color:var(--ink)}.selection-chip .excerpt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.selection-icon{color:#10a37f;flex:none}.popover{position:fixed;z-index:2147483646;width:380px;max-width:calc(100vw - 20px);max-height:min(600px,75dvh);background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:14px;box-shadow:0 8px 36px #0002;overflow:auto;color:var(--ink);overscroll-behavior:contain}.heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}.heading strong{font-size:13px;font-weight:600}.heading button{font-size:18px;padding:0 5px}.source{font-size:11px;color:var(--muted);line-height:1.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 0 9px}.note{font-size:11px;line-height:1.75;color:var(--muted);margin:8px 0;white-space:pre-line;overflow-wrap:anywhere}.attachment-actions{display:flex;gap:7px}.attachment-actions button{flex:1;border:1px solid var(--line);padding:9px}.attachment-actions button[aria-pressed="true"]{color:#10a37f;border-color:#10a37f;background:var(--hover)}.form label{display:block;font-size:11px;margin:10px 0 5px}.form input,.form textarea,.form select{display:block;width:100%;border:1px solid var(--line);border-radius:7px;padding:7px 9px;background:var(--surface);font-size:12px;line-height:1.8;resize:vertical}.form textarea{max-height:200px}.format-heading{font-size:12px;font-weight:600;margin:14px 0 5px}.format-heading:first-child{margin-top:0}.position-field{display:flex;align-items:center;gap:9px;margin:6px 0}.position-field label{margin:0;white-space:nowrap}.position-field select{width:auto;flex:1}.footer{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;margin-top:12px}.footer button{border:1px solid var(--line);font-size:11px}.footer .primary{background:var(--ink);color:var(--surface);border-color:var(--ink)}.status{font-size:11px;line-height:1.7;margin:2px 2px 6px;color:var(--muted);overflow-wrap:anywhere}.status.error{color:#b45c3c}.access{font-size:11px;color:#10a37f;border:1px solid var(--line);margin-bottom:6px}:host([data-dark]){--surface:#2f2f2f;--line:#454545;--hover:#383838;--muted:#aaa;--ink:#ececec;color-scheme:dark}
.popover{inset:auto;margin:0}
.chip button:disabled{cursor:pointer}
.default-options{min-width:0;border:0;margin:0 0 14px;padding:0;display:flex;flex-wrap:wrap;gap:8px 14px}.default-options legend{font-size:12px;font-weight:600;margin-bottom:7px}.form label.default-option{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;cursor:pointer}.form .default-option input{display:inline-block;width:auto;flex:none;margin:0;padding:0;accent-color:#10a37f}
.form [aria-invalid="true"]{border-color:#b45c3c}.form .field-error{color:#b45c3c;margin:5px 0}
`;

/** The original ChatGPT editor stays the only question editor. */
export function installEnhancement({ document, chrome, bridgeId, onReady = () => {}, attachmentManager }) {
  const view = document.defaultView;
  const attachments = attachmentManager || createAttachmentManager(document);
  let context = null;
  let settings = normalizeContextSettings();
  let composer;
  let pane;
  let disposed = false;
  let positioning = false;
  let ready = false;
  let statusTimer;
  let replaying = false;
  let delivering = false;
  let writing = false;
  let prepared = null;
  let requestSequence = 0;
  let lastAppliedRequest = 0;
  let settingsEpoch = 0;
  let polling = false;
  let needsAccess = false;
  let delivery = null;
  let ownedAttachment = null;
  const host = document.createElement('div');
  host.id = 'sider-enhancement';
  host.dataset.siderEnhancement = 'true';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style><div class="status" role="status" hidden></div><button type="button" id="source-access" class="access" hidden>允许当前网站</button><button type="button" id="page-retry" class="access" hidden>重试正文</button><div class="bar" aria-label="网页引用工具"><button type="button" data-pane="references" title="选择当前网页的链接或正文">引用</button><div class="chips" aria-label="当前网页引用"></div><button type="button" data-pane="settings" aria-label="引用设置" title="引用设置">⋯</button></div><section class="popover" popover="manual" role="dialog" aria-label="网页引用" hidden><div class="heading"><strong id="pane-title"></strong><button type="button" id="close-pane" aria-label="关闭">×</button></div><div id="pane-body"></div></section>`;
  const $ = selector => root.querySelector(selector);

  function report(message, error = false, accessRequired = needsAccess) {
    view.clearTimeout(statusTimer);
    $('.status').textContent = message;
    $('.status').classList.toggle('error', error);
    $('.status').hidden = !message;
    $('#source-access').hidden = !accessRequired;
    if (message && !error) statusTimer = view.setTimeout(() => { $('.status').hidden = true; }, 6500);
  }

  function applyResponse(result, sequence, startedEpoch) {
    if (disposed || sequence < lastAppliedRequest) return;
    lastAppliedRequest = sequence;
    const previousPageError = context?.pageError;
    if (result.context) {
      const next = normalizeContext(result.context, result.context.tabId);
      if (!context || next.tabId !== context.tabId || next.revision >= context.revision) {
        if (context && next.tabId !== context.tabId) prepared = null;
        context = next;
      }
    }
    if (result.settings && startedEpoch === settingsEpoch) settings = normalizeContextSettings(result.settings);
    if (typeof result.needsAccess === 'boolean') needsAccess = result.needsAccess;
    $('#source-access').hidden = !needsAccess;
    $('#page-retry').hidden = !context?.pageError || needsAccess;
    renderChips();
    if (context?.pageError && !delivering) report(context.pageError, true);
    else if (previousPageError && !context?.pageError && $('.status').textContent.includes(previousPageError)) report('');
    if (pane === 'references') renderReferences();
    if (delivery?.stamp && delivery.stamp !== contextStamp()) delivery.abort.abort();
    if (ownedAttachment && !delivering) {
      const next = composeContextPrompt('引用', context, settings).attachment;
      if (!sameAttachment(next, ownedAttachment)) void clearAttachment().catch(error => report(error.message, true));
    }
  }

  async function request(inner) {
    const sequence = ++requestSequence;
    const epoch = settingsEpoch;
    const result = await chrome.runtime.sendMessage({ type: 'SIDER_ENHANCEMENT_REQUEST', bridgeId, embedded: true, request: inner });
    if (!result?.ok) throw Object.assign(new Error(result?.error || '扩展没有响应，请刷新侧栏。'), { code: result?.code });
    applyResponse(result, sequence, epoch);
    return result;
  }

  async function run(element, action) {
    if (element?.disabled) return;
    if (element) element.disabled = true;
    try { await action(); }
    catch (error) { report(error.message || '操作失败。', true, error.code === 'SOURCE_ACCESS_REQUIRED' || needsAccess); }
    finally { if (element) element.disabled = false; }
  }

  function button(text, callback, className = '') {
    const element = document.createElement('button');
    element.type = 'button'; element.textContent = text; element.className = className;
    element.addEventListener('click', () => run(element, callback));
    return element;
  }

  function requestSitePermission(type) {
    const origin = chrome.runtime.getURL?.('/')?.replace(/\/$/, '') || Array.from(view.location.ancestorOrigins || [])[0];
    if (!origin?.startsWith('chrome-extension://')) throw new Error('请在扩展侧栏中授权网页访问。');
    view.parent.postMessage({ type, bridgeId }, origin);
  }

  function chip(kind, title, removeLabel, remove) {
    const element = document.createElement('div'); element.className = `chip ${kind === 'selection' ? 'selection-chip' : ''}`; element.dataset.chip = kind;
    const text = document.createElement('span'); text.className = 'excerpt'; text.textContent = title;
    if (kind === 'selection') { const icon = document.createElement('span'); icon.className = 'selection-icon'; icon.textContent = '❝'; icon.setAttribute('aria-hidden', 'true'); element.append(icon); }
    const cancel = button('×', remove); cancel.setAttribute('aria-label', removeLabel);
    element.title = title; element.append(text, cancel);
    return element;
  }

  function renderChips() {
    const chips = [];
    if (context?.selection && context.selectionIncluded !== false) chips.push(['selection', context.selection.content, '取消划词', () => request({ type: 'SIDER_TAB_SELECTION_CLEAR' })]);
    if (context?.attachments.url) chips.push(['url', 'URL', '取消 URL 引用', () => request({ type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'url', enabled: false })]);
    if (context?.pageRequested) {
      const asFile = composeContextPrompt('引用', context, settings).pageDelivery === 'file';
      const title = context.pageError ? '正文 · 未就绪' : !context.attachments.page ? '正文 · 准备中' : asFile ? '正文 · 附件' : '正文';
      chips.push(['page', title, '取消正文引用', async () => {
        delivery?.abort.abort();
        await request({ type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: false });
        await clearAttachment();
      }]);
    }
    const container = $('.chips');
    const kinds = new Set(chips.map(([kind]) => kind));
    // Polling must preserve focused controls and the disabled state of pending actions.
    for (const element of [...container.children]) if (!kinds.has(element.dataset.chip)) element.remove();
    for (const [index, [kind, title, removeLabel, remove]] of chips.entries()) {
      let element = container.querySelector(`[data-chip="${kind}"]`);
      if (!element) element = chip(kind, title, removeLabel, remove);
      if (element.title !== title) element.title = title;
      const excerpt = element.querySelector('.excerpt');
      if (excerpt.textContent !== title) excerpt.textContent = title;
      if (container.children[index] !== element) container.insertBefore(element, container.children[index] || null);
    }
  }

  function showPane(name) {
    pane = name;
    const popup = $('.popover');
    if (!name && popup.hidePopover && popup.matches(':popover-open')) popup.hidePopover();
    popup.hidden = !name;
    if (!name) return;
    $('#pane-title').textContent = name === 'settings' ? '引用设置' : '引用当前网页';
    $('#pane-body').replaceChildren();
    $('#pane-body').className = name === 'settings' ? 'form' : '';
    if (name === 'references') renderReferences();
    if (name === 'settings') renderSettings();
    if (popup.showPopover && !popup.matches(':popover-open')) popup.showPopover();
    positionPopover();
  }

  function renderReferences() {
    const body = $('#pane-body');
    let source = body.querySelector('.source');
    if (!source) {
      source = document.createElement('p'); source.className = 'source'; body.append(source);
      const actions = document.createElement('div'); actions.className = 'attachment-actions'; body.append(actions);
      for (const [kind, name] of [['url', 'URL'], ['page', '正文']]) {
        const entry = button(name, async () => {
          const active = kind === 'page' ? Boolean(context?.pageRequested) : Boolean(context?.attachments.url);
          if (kind === 'page' && !active) report('正在提取当前网页正文…');
          await request({ type: 'SIDER_TAB_ATTACHMENT_SET', kind, enabled: !active });
          if (context?.pageError) report(context.pageError, true);
          else report(active ? `已取消${name}引用。` : `发送时会附加${kind === 'url' ? '网页 URL' : '网页正文'}。`);
          showPane(null);
        });
        entry.dataset.attachment = kind; actions.append(entry);
      }
      const note = document.createElement('p'); note.className = 'note';
      note.textContent = '引用仅用于当前标签页。写好问题后，按回车或点击 ChatGPT 发送按钮，自动附加已选内容。'; body.append(note);
    }
    const title = context?.title || '当前网页';
    if (source.textContent !== title) source.textContent = title;
    if (source.title !== (context?.url || '')) source.title = context?.url || '';
    for (const kind of ['url', 'page']) {
      const active = kind === 'page' ? Boolean(context?.pageRequested) : Boolean(context?.attachments.url);
      body.querySelector(`[data-attachment="${kind}"]`).setAttribute('aria-pressed', String(active));
    }
    positionPopover();
  }

  function field(body, labelText, type, value, id) {
    const label = document.createElement('label'); label.textContent = labelText; label.htmlFor = id;
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input'); input.id = id;
    if (type === 'textarea') input.rows = 3; else input.type = type;
    input.value = value; body.append(label, input); return input;
  }

  function positionField(body, kind, value) {
    const row = document.createElement('div'); row.className = 'position-field';
    const label = document.createElement('label'); label.textContent = '添加位置'; label.htmlFor = `${kind}-position`;
    const select = document.createElement('select'); select.id = label.htmlFor;
    for (const [optionValue, text] of [['prepend', '问题前'], ['append', '问题后']]) { const option = document.createElement('option'); option.value = optionValue; option.textContent = text; select.append(option); }
    select.value = value; row.append(label, select); body.append(row); return select;
  }

  function renderSettings() {
    const body = $('#pane-body');
    const fields = {};
    const defaults = document.createElement('fieldset'); defaults.className = 'default-options';
    const legend = document.createElement('legend'); legend.textContent = '默认附加'; defaults.append(legend);
    for (const [key, kind, name] of [['defaultSelection', 'selection', '划词'], ['defaultUrl', 'url', '网页链接'], ['defaultPage', 'page', '网页正文']]) {
      const label = document.createElement('label'); label.className = 'default-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.id = `default-${kind}`; input.checked = settings[key];
      label.htmlFor = input.id; label.append(input, document.createTextNode(name)); defaults.append(label); fields[key] = input;
    }
    body.append(defaults);
    const defaultNote = document.createElement('p'); defaultNote.className = 'note'; defaultNote.textContent = '修改后保存，立即应用到当前网页，后续网页沿用。引用标签可临时取消；默认正文在打开侧栏时采集。'; body.append(defaultNote);
    for (const [kind, name, hint] of [['selection', '划词', '{{selection}} 划词 · {{context}} 附近段落'], ['url', '网页链接', '{{url}} 当前网页 URL · {{title}} 网页标题'], ['page', '网页正文', '{{content}} 网页正文 · {{url}} 当前网页 URL']]) {
      const heading = document.createElement('div'); heading.className = 'format-heading'; heading.textContent = name; body.append(heading);
      fields[`${kind}Template`] = field(body, kind === 'page' ? '正文格式（作为附件时写入文件）' : '附加文本格式', 'textarea', settings[`${kind}Template`], `${kind}-template`);
      fields[`${kind}Position`] = positionField(body, kind, settings[`${kind}Position`]);
      const note = document.createElement('p'); note.className = 'note'; note.textContent = hint; body.append(note);
    }
    const modeLabel = document.createElement('label'); modeLabel.textContent = '正文发送方式'; modeLabel.htmlFor = 'page-mode';
    const mode = document.createElement('select'); mode.id = 'page-mode';
    for (const [value, text] of [['auto', '自动：长正文转附件'], ['text', '始终作为文本'], ['file', '始终作为附件']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; mode.append(option); }
    mode.value = settings.pageMode; body.append(modeLabel, mode); fields.pageMode = mode;
    const threshold = field(body, '正文超过此字符数时转附件', 'number', settings.pageThreshold, 'page-threshold'); threshold.min = 1; threshold.max = 1000000; threshold.step = 1;
    const updateThreshold = () => { threshold.disabled = mode.value !== 'auto'; }; mode.addEventListener('change', updateThreshold); updateThreshold();
    fields.pageAttachmentTemplate = field(body, '附件引用说明（添加到问题中）', 'textarea', settings.pageAttachmentTemplate, 'page-attachment-template');
    const note = document.createElement('p'); note.className = 'note'; note.textContent = '{{filename}} 附件文件名 · {{title}} 网页标题 · {{url}} 网页 URL\n正文格式完整保留在附件中，问题仍留在输入框。变量只用于设置格式；附件上传完成后才发送。'; body.append(note);
    const footer = document.createElement('div'); footer.className = 'footer';
    const errorBox = document.createElement('p'); errorBox.id = 'settings-error'; errorBox.className = 'note field-error'; errorBox.setAttribute('role', 'alert'); errorBox.hidden = true;
    let invalidField;
    const clearError = () => {
      invalidField?.removeAttribute('aria-invalid'); invalidField?.removeAttribute('aria-describedby');
      invalidField = null; errorBox.hidden = true; errorBox.textContent = '';
    };
    const showError = (message, input) => {
      clearError(); errorBox.textContent = message; errorBox.hidden = false;
      if (input) {
        invalidField = input; input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', errorBox.id);
        input.after(errorBox); input.focus(); input.scrollIntoView?.({ block: 'nearest' });
      } else footer.before(errorBox);
    };
    body.append(errorBox);
    for (const input of [...Object.values(fields), threshold]) input.addEventListener('input', event => { if (event.target === invalidField) clearError(); });
    const save = button('保存', async () => {
      clearError();
      let pageThreshold = Number(threshold.value);
      if (!Number.isInteger(pageThreshold) || pageThreshold < 1 || pageThreshold > 1000000) {
        if (mode.value === 'auto') { showError('转换阈值须为 1 至 1,000,000 的整数。', threshold); return; }
        pageThreshold = settings.pageThreshold;
      }
      const patch = { pageThreshold };
      for (const [key, element] of Object.entries(fields)) patch[key] = element.type === 'checkbox' ? element.checked : element.value;
      for (const [key, label] of [['selectionTemplate', '划词'], ['urlTemplate', 'URL'], ['pageTemplate', '正文'], ['pageAttachmentTemplate', '正文附件说明']]) {
        if (key === 'pageAttachmentTemplate' && patch.pageMode === 'text') continue;
        const error = validateContextTemplate(patch[key], { label, attachment: key === 'pageAttachmentTemplate' })[0];
        if (error) { showError(error, fields[key]); return; }
      }
      try { await request({ type: 'SIDER_CONTEXT_SETTINGS_PATCH', patch }); }
      catch (error) { showError(error.message || '设置保存失败，请重试。'); throw error; }
      showPane(null); report(context?.pageError ? `设置已保存。${context.pageError}` : '设置已保存。', Boolean(context?.pageError));
    }, 'primary'); save.id = 'save-settings'; footer.append(save); body.append(footer);
    positionPopover();
  }

  function positionPopover() {
    if (!pane || !host.isConnected) return;
    const rect = host.getBoundingClientRect(); const popup = $('.popover');
    const width = Math.max(100, Math.min(380, view.innerWidth - 20)); const height = popup.offsetHeight;
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(10, Math.min(rect.left, view.innerWidth - width - 10))}px`;
    popup.style.top = `${Math.max(10, Math.min(rect.top - height - 8, view.innerHeight - height - 10))}px`;
  }

  function mount() {
    positioning = false;
    if (disposed) return;
    const current = findComposer(document);
    if (!current) { host.hidden = true; return; }
    if (composer && composer !== current) prepared = null;
    composer = current;
    // Composer forms treat clicks on a shadow host as clicks on their own
    // background and can steal focus from extension inputs. Keep our controls
    // outside that form, while remaining next to the original editor.
    const anchor = current.closest('form') || current.closest('[data-composer-body]') || current.parentElement;
    if (!anchor || anchor === document.body || anchor === document.documentElement) return;
    if (!host.isConnected || host.previousElementSibling !== anchor) anchor.after(host);
    host.hidden = false;
    host.toggleAttribute('data-dark', document.documentElement.classList.contains('dark') || view.matchMedia?.('(prefers-color-scheme:dark)').matches);
    if (!ready) { ready = true; onReady({ ready: true }); }
    positionPopover();
  }

  function scheduleMount() {
    if (positioning || disposed) return;
    positioning = true; view.requestAnimationFrame(mount);
  }

  function findSendButton() {
    const scope = findComposer(document)?.closest('form') || document;
    return [...scope.querySelectorAll('button[data-testid="send-button"],button[aria-label="Send"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="发送提示"],button[aria-label="发送消息"],button[aria-label="发送"]')].find(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true' && element.getClientRects().length);
  }

  function contextStamp() { return JSON.stringify({ context, settings, needsAccess }); }

  function sameAttachment(a, b) { return Boolean(a && b && a.name === b.name && a.content === b.content && a.mimeType === b.mimeType); }

  async function clearAttachment() {
    await attachments.clear();
    ownedAttachment = null;
  }

  async function writeDraft(text, expectedPrevious) {
    writing = true;
    try {
      const result = await fillComposer(document, text, 'replace', { expectedPrevious });
      if (!result.ok) throw new Error(result.error);
    } finally { writing = false; }
  }

  async function restoreQuestion(previous, question, originalEditor) {
    if (findComposer(document) === originalEditor && getComposerText(originalEditor) === previous) {
      await writeDraft(question, previous); prepared = null;
    }
  }

  function nativeSend(event) {
    if (replaying || !event.isTrusted) return;
    const current = findComposer(document); if (!current) return;
    let sendButton;
    if (event.type === 'keydown') {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229 || !current.contains(event.target)) return;
      sendButton = findSendButton();
    } else {
      sendButton = event.target.closest?.('button'); if (!sendButton || sendButton !== findSendButton()) return;
    }
    const draft = getComposerText(current);
    if (!draft.trim()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (delivering) return;
    delivering = true;
    const question = prepared?.editor === current && prepared.text === draft ? prepared.question : draft;
    const transaction = { editor: current, question, draft, url: view.location.href, stamp: null, abort: new view.AbortController(), written: null };
    delivery = transaction;
    void run(null, async () => {
      const unchanged = expected => !disposed && view.location.href === transaction.url && findComposer(document) === current && getComposerText(current) === expected;
      try {
        await request({ type: 'SIDER_TAB_CONTEXT_GET' });
        if (!unchanged(draft)) throw new Error('问题或会话已修改，请重新发送。');
        transaction.stamp = contextStamp();
        let compiled = composeContextPrompt(question, context, settings);
        const uploadSpec = compiled.attachment;
        if (compiled.errors.length) throw new Error(compiled.errors[0]);
        if (compiled.attachment) {
          report('正在准备正文附件…');
          ownedAttachment = uploadSpec;
          const uploaded = await attachments.prepare(uploadSpec, {
            signal: transaction.abort.signal,
            isCurrent: () => unchanged(draft) && transaction.stamp === contextStamp(),
          });
          if (uploaded?.name) compiled = composeContextPrompt(question, context, settings, { attachmentName: uploaded.name });
          if (compiled.errors.length) throw new Error(compiled.errors[0]);
        } else await clearAttachment();
        await request({ type: 'SIDER_TAB_CONTEXT_GET' });
        if (transaction.stamp !== contextStamp()) throw new Error('网页引用或设置已变化，请重新发送。');
        if (transaction.abort.signal.aborted || !unchanged(draft)) throw new Error('问题或会话已修改，请重新发送。');
        if (uploadSpec && !attachments.isReady(uploadSpec)) throw new Error('正文附件尚未就绪，请检查上传状态后重新发送。');
        if (compiled.text !== draft) { transaction.written = compiled.text; await writeDraft(compiled.text, draft); }
        if (!unchanged(compiled.text)) throw new Error('问题已修改，请检查后重新发送。');
        prepared = { editor: current, question, text: compiled.text, prefix: compiled.prefix || '', suffix: compiled.suffix || '' };
        await request({ type: 'SIDER_TAB_CONTEXT_GET' });
        if (transaction.stamp !== contextStamp()) throw new Error('网页引用或设置已变化，请重新发送。');
        if (transaction.abort.signal.aborted || !unchanged(compiled.text)) throw new Error('问题或会话已修改，请重新发送。');
        if (uploadSpec && !attachments.isReady(uploadSpec)) throw new Error('正文附件已取消，请重新发送。');
        const target = sendButton?.isConnected && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true' ? sendButton : findSendButton();
        if (!target) throw new Error('ChatGPT 发送按钮尚未就绪，请稍后重新发送。');
        report('');
        replaying = true;
        try { target.click(); } finally { replaying = false; }
      } catch (error) {
        // Restore only text that this transaction wrote; never overwrite edits
        // made while a file was uploading or a new conversation's draft.
        if (view.location.href === transaction.url) await restoreQuestion(transaction.written || draft, question, current);
        if (transaction.abort.signal.aborted || transaction.stamp !== contextStamp() || !unchanged(question)) {
          await clearAttachment();
        }
        throw error;
      }
    }).finally(() => { if (delivery === transaction) delivery = null; delivering = false; });
  }

  // Native editing/selecting must retain its default behavior, but these UI
  // events must not reach ChatGPT's composer focus and submit handlers.
  const uiEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'focusin', 'focusout', 'touchstart', 'touchend', 'wheel'];
  const containUIEvent = event => event.stopPropagation();
  for (const type of uiEvents) root.addEventListener(type, containUIEvent);
  for (const item of root.querySelectorAll('[data-pane]')) item.addEventListener('click', () => showPane(pane === item.dataset.pane ? null : item.dataset.pane));
  $('#close-pane').addEventListener('click', () => showPane(null));
  $('#source-access').addEventListener('click', () => run($('#source-access'), () => requestSitePermission('SIDER_SOURCE_ACCESS_REQUEST')));
  $('#page-retry').addEventListener('click', () => run($('#page-retry'), async () => {
    report('正在提取当前网页正文…');
    await request({ type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
    report(context?.pageError || '正文引用已就绪。', Boolean(context?.pageError));
  }));
  const outside = event => { if (!event.composedPath().includes(host)) showPane(null); };
  const keyboard = event => { if (event.key === 'Escape') showPane(null); };
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keyboard, true);
  document.addEventListener('keydown', nativeSend, true); document.addEventListener('click', nativeSend, true);
  const nativeAttachmentRemoved = event => {
    if (replaying || !event.isTrusted || !attachments.isOwnedRemoveButton?.(event.target.closest?.('button'))) return;
    delivery?.abort.abort();
    // Let ChatGPT remove its card before synchronizing our current-page chip.
    void run(null, async () => {
      await request({ type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: false });
      await clearAttachment();
      if (prepared) await restoreQuestion(prepared.text, prepared.question, prepared.editor);
    });
  };
  document.addEventListener('click', nativeAttachmentRemoved, true);
  const inputChanged = event => {
    const current = findComposer(document);
    if (!current?.contains(event.target) || writing) return;
    delivery?.abort.abort();
    $('.status').hidden = true;
    if (prepared?.editor !== current) { prepared = null; return; }
    const draft = getComposerText(current);
    if (draft === prepared.text) return;
    // Native send failures can leave the prepared prompt visible. Retain the
    // question if only its middle changed, so another send does not add it twice.
    if (prepared.prefix && draft.startsWith(prepared.prefix) && draft.endsWith(prepared.suffix)) {
      prepared = { ...prepared, question: draft.slice(prepared.prefix.length, prepared.suffix ? -prepared.suffix.length : undefined), text: draft };
    } else if (prepared.suffix && draft.startsWith(prepared.prefix) && draft.endsWith(prepared.suffix)) {
      prepared = { ...prepared, question: draft.slice(prepared.prefix.length, -prepared.suffix.length), text: draft };
    } else prepared = null;
  };
  document.addEventListener('input', inputChanged, true);
  const refresh = () => request({ type: 'SIDER_TAB_CONTEXT_GET' });
  const storageChanged = (changes, area) => {
    if (area === 'local' && changes[CONTEXT_SETTINGS_KEY]) {
      settingsEpoch++; settings = normalizeContextSettings(changes[CONTEXT_SETTINGS_KEY].newValue);
    }
    if (area === 'session' && context && changes[`${TAB_CONTEXT_PREFIX}${context.tabId}`]) void refresh().catch(() => {});
  };
  chrome.storage.onChanged.addListener(storageChanged);
  const observer = new view.MutationObserver(scheduleMount);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'contenteditable'] });
  view.addEventListener('resize', scheduleMount); view.addEventListener('scroll', positionPopover, true);
  const interval = view.setInterval(() => {
    scheduleMount();
    attachments.reconcile();
    if (polling || disposed) return;
    polling = true; void refresh().catch(() => {}).finally(() => { polling = false; });
  }, 1000);
  mount(); void refresh().catch(error => report(error.message, true, error.code === 'SOURCE_ACCESS_REQUIRED'));
  return { host, root, refresh, dispose() {
    delivery?.abort.abort(); attachments.dispose();
    disposed = true; observer.disconnect(); view.clearInterval(interval); view.clearTimeout(statusTimer);
    showPane(null);
    for (const type of uiEvents) root.removeEventListener(type, containUIEvent);
    chrome.storage.onChanged.removeListener(storageChanged); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true);
    document.removeEventListener('keydown', nativeSend, true); document.removeEventListener('click', nativeSend, true); document.removeEventListener('input', inputChanged, true);
    document.removeEventListener('click', nativeAttachmentRemoved, true);
    view.removeEventListener('resize', scheduleMount); view.removeEventListener('scroll', positionPopover, true); host.remove();
  } };
}
