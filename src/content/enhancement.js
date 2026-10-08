import { TAB_CONTEXT_PREFIX, normalizeContext, normalizeContextSettings, composeTemplatePrompt, expandTemplateItem, applyAttachmentFilename } from '../context.js';
import { createWebAdapter } from './adapters.js';
import { installTextDrop } from './text-drop.js';
import { downloadText, safeFilename } from '../export-file.js';
import { VARIABLES, needsPageVariables, needsTemplateSelection } from '../variables.js';
import { UNIFIED_TEMPLATES_KEY, PRESET_IDS, newTemplate, presetTemplates, validateTemplates, migrateTemplates } from '../prompt-templates.js';
import { TemplateDraft } from './template-draft.js';
import { installPresetSort } from './preset-sort.js';
import { createMotion } from '../motion.js';

const SEND_CONTROL_GRACE_MS = 500;

const CSS = `
:host{all:initial;display:block;position:relative;font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:12px;line-height:1.5;width:100%;min-width:0;z-index:30;--surface:#fff;--line:#e6e6e6;--muted:#888;--hover:#f4f4f4;--ink:#262626;color:var(--ink);color-scheme:light}
*{box-sizing:border-box}[hidden]{display:none!important}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer;border:0;background:transparent;padding:6px 8px;border-radius:7px;line-height:1.4;white-space:nowrap}button:hover{background:var(--hover)}button:disabled{opacity:.45;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #10a37f;outline-offset:1px}.bar{display:flex;gap:5px;align-items:center;min-height:32px;padding:4px 2px;border-top:1px solid var(--line);margin-top:5px;min-width:0}.bar>button{font-size:11px;padding:5px 7px;flex:none}.bar>button:last-child{margin-left:auto}.chips{display:flex;gap:5px;align-items:center;flex-wrap:wrap;min-width:0;flex:1}.chip{display:flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:7px;background:var(--hover);font-size:11px;padding-left:7px;max-width:100%;min-width:0}.chip button{font-size:15px;line-height:1;padding:4px 6px;flex:none;color:var(--muted)}.selection-chip{flex:0 1 auto;max-width:100%;color:var(--ink)}.selection-chip .excerpt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.selection-icon{color:#10a37f;flex:none}.popover{position:fixed;z-index:2147483646;width:380px;max-width:calc(100vw - 20px);max-height:min(600px,75dvh);background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:14px;box-shadow:0 8px 36px #0002;overflow:auto;color:var(--ink);overscroll-behavior:contain}.heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}.heading strong{font-size:13px;font-weight:600}.heading button{font-size:18px;padding:0 5px}.source{font-size:11px;color:var(--muted);line-height:1.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 0 9px}.note{font-size:11px;line-height:1.75;color:var(--muted);margin:8px 0;white-space:pre-line;overflow-wrap:anywhere}.attachment-actions{display:flex;gap:7px}.attachment-actions button{flex:1;border:1px solid var(--line);padding:9px}.attachment-actions button[aria-pressed="true"]{color:#10a37f;border-color:#10a37f;background:var(--hover)}.form label{display:block;font-size:11px;margin:10px 0 5px}.form input,.form textarea,.form select{display:block;width:100%;border:1px solid var(--line);border-radius:7px;padding:7px 9px;background:var(--surface);font-size:12px;line-height:1.8;resize:vertical}.form textarea{max-height:200px}.format-heading{font-size:12px;font-weight:600;margin:14px 0 5px}.format-heading:first-child{margin-top:0}.position-field{display:flex;align-items:center;gap:9px;margin:6px 0}.position-field label{margin:0;white-space:nowrap}.position-field select{width:auto;flex:1}.footer{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;margin-top:12px}.footer button{border:1px solid var(--line);font-size:11px}.footer .primary{background:var(--ink);color:var(--surface);border-color:var(--ink)}.status{font-size:11px;line-height:1.7;margin:2px 2px 6px;color:var(--muted);overflow-wrap:anywhere}.status.error{color:#b45c3c}.access{font-size:11px;color:#10a37f;border:1px solid var(--line);margin-bottom:6px}:host([data-dark]){--surface:#2f2f2f;--line:#454545;--hover:#383838;--muted:#aaa;--ink:#ececec;color-scheme:dark}
:host{flex:0 0 auto;align-self:stretch;box-sizing:border-box}
.popover{inset:auto;margin:0}
.chip button:disabled{cursor:default}
.template-row .template-use{flex:1;min-width:75px;white-space:normal;text-align:left;overflow-wrap:anywhere}.template-row>button:first-child{flex:0 0 auto;min-width:0}.template-row [data-sort-handle]{cursor:grab;touch-action:none;user-select:none;font-size:16px}.sorting [data-sort-handle]{cursor:grabbing}.template-row.dragging{opacity:.6;background:var(--hover)}.drop-before{box-shadow:0 -2px #10a37f}.drop-after{box-shadow:0 2px #10a37f}button:disabled:not([data-busy]){cursor:default}button:disabled:hover{background:transparent}button[data-busy]{cursor:wait}
.default-options{min-width:0;border:0;margin:0 0 14px;padding:0;display:flex;flex-wrap:wrap;gap:8px 14px}.default-options legend{font-size:12px;font-weight:600;margin-bottom:7px}.form label.default-option{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;cursor:pointer}.form .default-option input{display:inline-block;width:auto;flex:none;margin:0;padding:0;accent-color:#10a37f}
.form [aria-invalid="true"]{border-color:#b45c3c}.form .field-error{color:#b45c3c;margin:5px 0}
.page-body{white-space:pre-wrap;overflow-wrap:anywhere;max-height:36dvh;overflow:auto;font:12px/1.8 ui-monospace,monospace;user-select:text}.page-meta{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;color:var(--muted)}[data-chip="page"] .excerpt{cursor:pointer}[data-chip="page"] .excerpt:focus-visible{outline:2px solid #10a37f}
.template-row{display:flex;gap:3px;align-items:center;flex-wrap:wrap;margin:8px 0}.form .template-row>input{width:auto;flex:none;accent-color:#10a37f}.template-row>button{font-size:11px;padding:4px}.template-row>button:first-child{flex-basis:110px}.chip .excerpt{cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.chip{min-width:0}.template-row>button:first-child{flex:1;min-width:0;white-space:normal;text-align:left;overflow-wrap:anywhere}.variables{font-size:11px}.variables summary{cursor:pointer;padding:8px 0}.variable{border-top:1px solid var(--line);padding:7px 0;overflow-wrap:anywhere}.variable p{margin:3px 0}.template-toggle{display:flex!important;align-items:center;gap:6px}.template-toggle input{width:auto!important}
.template-row>[data-sort-handle]:first-child{flex:0 0 auto;min-width:0}
button,summary{transition:background-color 120ms cubic-bezier(.2,.8,.2,1),color 120ms cubic-bezier(.2,.8,.2,1),opacity 120ms cubic-bezier(.2,.8,.2,1)}button:active:not(:disabled){background:var(--line)}[data-motion-closing]{pointer-events:none}.template-row{transition:background-color 120ms ease,opacity 120ms ease}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}}
.preset-list button{transition-property:background-color,color}
`;

/** The original site's editor stays the only question editor. */
export function installEnhancement({ document, chrome, bridgeId, onReady = () => {}, attachmentManager, adapter = createWebAdapter(document) }) {
  const view = document.defaultView;
  const motion = createMotion(view);
  const attachments = attachmentManager || adapter.createAttachmentManager();
  const findComposer = () => adapter.findComposer();
  const getComposerText = element => adapter.readDraft(element);
  const supportsAttachments = () => Boolean(attachmentManager || adapter.supportsAttachments());
  let context = null;
  let settings = normalizeContextSettings();
  let composer;
  let pane;
  let disposed = false;
  let mountFrame = null, positionFrame = null;
  let chipInputs = null, templatesIdentity = '', previewInputs = null;
  let statusPersistent = false;
  let ready = false;
  let readinessDetail = '';
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
  let clearingAttachment = null;
  let cleanupIssue = null;
  let sendGap = null;
  let previewSnapshot = null;
  let paneOpener = null;
  let templates = [];
  let renderedTemplates = '';
  let renderedTemplateItems = new Map();
  let insertion = null;
  let templateApplying = false;
  let sorting = null;
  const filled = new TemplateDraft();
  let previewTemplateId = null;
  const missingAttachments = new Set();
  let refreshPending = null;
  let refreshAgain = false;
  const host = document.createElement('div');
  host.id = 'sider-enhancement';
  host.dataset.siderEnhancement = 'true';
  const root = host.attachShadow({ mode: 'open' });
  // DOM construction also works on sites enforcing Trusted Types. No policy
  // creation or HTML-string sink is needed to render our static controls.
  const element = (tag, attributes = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.textContent = text;
    return node;
  };
  const bar = element('div', { class: 'bar', 'aria-label': '网页引用工具' });
  bar.append(
    element('button', { type: 'button', 'data-pane': 'templates', title: '选择或编辑预设与引用' }, '预设'),
    element('div', { class: 'chips', 'aria-label': '当前附加预设' }),
  );
  const popup = element('section', { class: 'popover', popover: 'manual', role: 'dialog', 'aria-label': '网页引用', hidden: '' });
  const heading = element('div', { class: 'heading' });
  heading.append(element('strong', { id: 'pane-title' }), element('button', { type: 'button', id: 'close-pane', 'aria-label': '关闭' }, '×'));
  popup.append(heading, element('div', { id: 'pane-body' }));
  root.append(
    element('style', {}, CSS),
    element('div', { class: 'status', role: 'status', hidden: '' }),
    element('button', { type: 'button', id: 'source-access', class: 'access', hidden: '' }, '允许当前网站'),
    element('button', { type: 'button', id: 'page-retry', class: 'access', hidden: '' }, '重试正文'),
    bar, popup,
  );
  const $ = selector => root.querySelector(selector);
  const setHidden = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  // Compare large strings directly rather than serializing/expanding the body
  // on every input. Include all source metadata consumed by variable expansion.
  function visualInputs() {
    const reference = value => value ? [value.url, value.title, value.content, value.context, value.capturedAt, JSON.stringify(value.metadata), JSON.stringify(value.extraction)] : [];
    return [templatesIdentity, context?.tabId, context?.revision, context?.url, context?.title, context?.pageError, context?.pageRequested,
      ...reference(context?.selection), ...reference(context?.attachments.page), JSON.stringify(context?.templateSelections),
      ...[...filled.records].flatMap(([id, record]) => [id, record]), [...missingAttachments].join('|'), supportsAttachments()];
  }
  const equalInputs = (a, b) => a && a.length === b.length && a.every((value, index) => value === b[index]);
  function hideStatus() { motion.setVisible($('.status'), false, { fadeOnly: true }); }

  function compile(question, options = {}) {
    return composeTemplatePrompt(question, templates, context, { snapshots: filled.snapshots(), supportsAttachments: supportsAttachments(), ...options });
  }

  function selectedTemplates(explicitId) {
    const fixed = new Set(filled.snapshots().filter(item => item.id !== explicitId).map(item => item.id));
    return templates.filter(item => !fixed.has(item.id) && (context?.templateSelections?.[item.id] || item.id === explicitId)
      && (item.id === explicitId || !needsTemplateSelection(item) || context?.selection?.content));
  }

  function report(message, error = false, accessRequired = needsAccess, { persistent = false } = {}) {
    const status = $('.status');
    setHidden($('#source-access'), !accessRequired);
    if (status.textContent === message && status.classList.contains('error') === error && statusPersistent === persistent && motion.isVisible(status) === Boolean(message)) return;
    view.clearTimeout(statusTimer);
    statusPersistent = persistent;
    const changed = status.textContent !== message;
    if (message) setText(status, message);
    if (status.classList.contains('error') !== error) status.classList.toggle('error', error);
    const wasVisible = !status.hidden;
    motion.setVisible(status, Boolean(message), { fadeOnly: true });
    if (message && changed && wasVisible) motion.enter(status, { fadeOnly: true, duration: 120 });
    if (message && !error && !persistent) statusTimer = view.setTimeout(hideStatus, 6500);
  }

  function reportProgress(message, transaction = delivery) {
    if (disposed || transaction && transaction !== delivery) return;
    if (transaction) transaction.progress = message;
    report(message, false, needsAccess, { persistent: true });
  }

  function applyResponse(result, sequence, startedEpoch) {
    if (!result.context && !result.contextUnchanged && !result.settings && !result.templates && typeof result.needsAccess !== 'boolean') return;
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
    if (result.templates && startedEpoch === settingsEpoch) {
      const identity = JSON.stringify(result.templates);
      if (templatesIdentity !== identity) {
        templates = result.templates.some(item => Object.hasOwn(item, 'action')) ? validateTemplates(result.templates) : migrateTemplates(settings, result.templates);
        templatesIdentity = JSON.stringify(templates);
      }
    }
    if (!templates.length && result.settings) { templates = presetTemplates(settings); templatesIdentity = JSON.stringify(templates); }
    // Older in-memory contexts are mapped once; the background persists this map.
    if (context && context.templateSelections === null) context.templateSelections = Object.fromEntries(templates.map(item => [item.id, item.preset === 'selection' ? context.selectionIncluded : item.preset === 'url' ? context.attachments.url : item.preset === 'page' ? context.pageRequested : item.defaultIncluded]));
    if (typeof result.needsAccess === 'boolean') needsAccess = result.needsAccess;
    setHidden($('#source-access'), !needsAccess);
    setHidden($('#page-retry'), !context?.pageError || needsAccess);
    renderChips();
    if (context?.pageError && !delivering) report(context.pageError, true);
    else if (!delivering && previousPageError && !context?.pageError && $('.status').textContent.includes(previousPageError)) report('');
    if (pane === 'template-preview') renderTemplatePreview();
    if (pane === 'templates' && !$('#template-name')) syncTemplateList();
    if (pane === 'page') renderPagePreview();
    if (delivery?.stamp && !delivery.replayed && delivery.stamp !== contextStamp()) delivery.abort.abort();
    if (ownedAttachment && !delivering && !templateApplying && !cleanupIssue) {
      const retained = new Set([...selectedTemplates().map(item => item.id), ...filled.snapshots().map(item => item.id)]);
      if (attachments.retain) void attachments.retain([...retained]).catch(error => report(error.message, true));
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

  async function run(element, action, transaction = null) {
    if (element?.disabled) return;
    if (element) { element.disabled = true; element.dataset.busy = 'true'; }
    try { await action(); }
    catch (error) {
      // The sending transaction reports the upload and cleanup result together.
      // A concurrent cancel action must not publish the same cleanup error again.
      if (!disposed && !(delivering && !transaction && error.code === 'ATTACHMENT_CLEANUP_FAILED')) {
        report(error.message || '操作失败。', true, error.code === 'SOURCE_ACCESS_REQUIRED' || needsAccess);
      }
    }
    finally { if (element) { element.disabled = false; delete element.dataset.busy; } }
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
    if (kind === 'page') {
      text.setAttribute('role', 'button'); text.tabIndex = 0; text.setAttribute('aria-label', '查看网页正文');
      text.addEventListener('click', () => showPane('page'));
      text.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); showPane('page'); } });
    }
    if (kind === 'selection') { const icon = document.createElement('span'); icon.className = 'selection-icon'; icon.textContent = '❝'; icon.setAttribute('aria-hidden', 'true'); element.append(icon); }
    const cancel = button('×', remove); cancel.setAttribute('aria-label', removeLabel);
    element.title = title; element.append(text, cancel);
    return element;
  }

  function renderChips() {
    const inputs = visualInputs(); if (equalInputs(chipInputs, inputs)) return; chipInputs = inputs;
    const container = $('.chips');
    const ids = new Set([...templates.filter(item => context?.templateSelections?.[item.id]).map(item => item.id), ...filled.records.keys()]);
    const before = motion.capture(container.children), added = [];
    const existing = new Map([...container.children].map(node => [node.dataset.templateId, node]));
    for (const [id, node] of existing) if (!ids.has(id)) { motion.cancel(node); node.remove(); }
    for (const template of templates.filter(item => ids.has(item.id))) {
      const snapshot = filled.records.get(template.id);
      const waiting = !snapshot && needsTemplateSelection(template) && !context?.selection;
      const block = snapshot || expandTemplateItem(template, context, { supportsAttachments: supportsAttachments() });
      const title = template.name + (missingAttachments.has(template.id) ? ' · 附件缺失' : snapshot ? ' · 快照' : waiting ? ' · 等待划词' : block.errors?.length ? ' · 未就绪' : block.delivery === 'file' ? ' · 附件' : '');
      let node = existing.get(template.id);
      if (!node) {
        node = element('div', { class: 'chip' }); node.dataset.templateId = template.id; node.dataset.chip = template.preset || template.id;
        const label = element('span', { class: 'excerpt', role: 'button', tabindex: '0', 'aria-label': template.preset === 'page' ? '查看网页正文' : '查看预设 ' + template.name });
        const open = () => { previewTemplateId = template.id; showPane('template-preview'); };
        label.addEventListener('click', open);
        label.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); open(); } });
        node.append(label, button('×', () => removeTemplate(template.id)));
        node.lastChild.setAttribute('aria-label', ({ selection: '取消划词', url: '取消 URL 引用', page: '取消正文引用' })[template.preset] || '取消预设 ' + template.name); container.append(node); added.push(node);
      }
      const selectionLabel = template.preset === 'selection' && !snapshot && Boolean(context?.selection) && needsTemplateSelection(template) && block.delivery === 'text' && !block.errors?.length;
      if (node.classList.contains('selection-chip') !== selectionLabel) node.classList.toggle('selection-chip', selectionLabel);
      setText(node.querySelector('.excerpt'), selectionLabel ? context.selection.content : title);
      if (node.title !== title) node.title = title;
    }
    motion.rearrange(before, container.children); for (const node of added) motion.enter(node);
    schedulePosition();
  }

  async function toggleTemplate(template, enabled = !context?.templateSelections?.[template.id]) {
    delivery?.abort.abort();
    await request({ type: 'SIDER_TAB_TEMPLATE_SET', id: template.id, enabled });
    if (!enabled && !filled.records.has(template.id)) await removeAttachmentId(template.id);
    if (pane === 'templates') syncTemplateList();
  }

  async function removeTemplate(id) {
    delivery?.abort.abort();
    const record = filled.records.get(id);
    if (record) {
      const current = findComposer(), text = getComposerText(current);
      filled.reconcile(text, current, adapter.sessionKey());
      let removable;
      try { removable = filled.removable(id, text); }
      catch { filled.records.delete(id); report('已移除快照关联，保留你编辑后的文字。请检查草稿中的附件说明。', true); }
      if (removable) {
        const next = text.slice(0, removable.start) + text.slice(removable.end);
        await writeDraft(next, text); filled.records.delete(id); filled.applyEdit(removable.start, removable.end, '');
      }
    }
    missingAttachments.delete(id);
    await request({ type: 'SIDER_TAB_TEMPLATE_SET', id, enabled: false });
    await removeAttachmentId(id); renderChips();
  }
  async function removeAttachmentId(id) {
    if (attachments.remove) return attachments.remove(id);
    if (ownedAttachment?.id === id) return clearAttachment();
  }

  function showPane(name, { restoreFocus = true, immediate = false } = {}) {
    if (name !== 'templates') sorting?.cancel();
    const previous = pane;
    if (name && !pane) paneOpener = root.activeElement || document.activeElement;
    pane = name;
    const popup = $('.popover');
    if (!name) {
      if (positionFrame !== null) { view.cancelAnimationFrame(positionFrame); positionFrame = null; }
      motion.cancel($('#pane-body'));
      motion.setVisible(popup, false, { immediate, close: () => { if (popup.hidePopover && popup.matches(':popover-open')) popup.hidePopover(); setHidden(popup, true); } });
      if (previous && restoreFocus) paneOpener?.focus?.({ preventScroll: true });
      previewSnapshot = null; previewInputs = null; return;
    }
    $('#pane-title').textContent = name === 'page' ? '网页正文快照' : name === 'templates' ? '预设' : '预设预览';
    $('#pane-body').replaceChildren();
    delete $('#pane-body').dataset.previewIdentity; previewInputs = null;
    $('#pane-body').className = name === 'templates' ? 'form' : '';
    if (name === 'template-preview') renderTemplatePreview(true);
    if (name === 'page') renderPagePreview(true);
    if (name === 'templates') renderTemplates();
    motion.setVisible(popup, true, { open: () => { setHidden(popup, false); if (popup.showPopover && !popup.matches(':popover-open')) popup.showPopover(); } });
    if (previous) motion.enter($('#pane-body'), { fadeOnly: true, duration: 120 });
    schedulePosition();
    $('#close-pane').focus({ preventScroll: true });
  }

  function variableDirectory(body) {
    const details = element('details', { class: 'variables' }); details.append(element('summary', {}, '查看全部变量'));
    const places = { reference: '预设内容', shortcut: '预设内容', attachment: '附件说明' };
    for (const variable of VARIABLES) {
      const row = element('div', { class: 'variable' });
      row.append(button(`{{${variable.name}}} · 复制`, async () => { await view.navigator.clipboard.writeText(`{{${variable.name}}}`); report('变量已复制。'); }),
        element('p', {}, `${variable.description}${variable.alias ? `（别名：${variable.alias}）` : ''}\n例：${variable.example}\n位置：${[...new Set(variable.places.map(place => places[place]))].join('、')}\n条件：${variable.requirement}\n时点：${variable.timing}`));
      details.append(row);
    }
    body.append(details);
  }

  function saveTemplates(next, expected = templates) {
    validateTemplates(next);
    return request({ type: 'SIDER_PROMPT_TEMPLATES_SAVE', templates: next, expected }).then(result => { templates = result.templates; });
  }

  function selectField(body, label, id, value, options) {
    body.append(element('label', { for: id }, label));
    const input = element('select', { id });
    for (const [key, title] of options) input.append(element('option', { value: key }, title));
    input.value = value; body.append(input); return input;
  }
  function checkboxField(body, label, id, value) {
    const row = element('label', { class: 'template-toggle' });
    const input = element('input', { id, type: 'checkbox' }); input.checked = value;
    row.append(input, document.createTextNode(label)); body.append(row); return input;
  }
  function renderTemplates(edit = null) {
    const previousSort = sorting; sorting = null; previousSort?.dispose();
    const body = $('#pane-body'); body.replaceChildren();
    if (edit) {
      const expected = structuredClone(templates);
      const name = field(body, '预设名称', 'text', edit.name, 'template-name'); name.maxLength = 80;
      const text = field(body, '预设内容（文本＋变量）', 'textarea', edit.text, 'template-text'); text.rows = 5;
      body.append(button('设为附件区域', () => {
        const from = text.selectionStart, to = text.selectionEnd, selected = text.value.slice(from, to);
        text.setRangeText('<attachment>' + selected + '</attachment>', from, to, 'end');
        text.focus(); text.setSelectionRange(from + 12, from + 12 + selected.length);
        text.dispatchEvent(new view.Event('input', { bubbles: true }));
      }));
      body.append(element('p', { class: 'note' }, '用 <attachment>…</attachment> 标记一个附件区域；区域外保留为提示词。不标记时，附件规则作用于整条内容。'));
      const position = selectField(body, '位置（插入及发送时引用）', 'template-position', edit.position, [['prepend', '问题前'], ['append', '问题后']]);
      const defaultIncluded = checkboxField(body, '默认勾选（发送时引用，不会自动执行）', 'template-default', edit.defaultIncluded);
      const action = selectField(body, '点击行为', 'template-action', edit.action, [['replace', '替换'], ['append', '追加'], ['send', '直接发送']]);
      const advanced = element('details', { class: 'variables' }); advanced.append(element('summary', {}, '高级：发送方式与附件'));
      const delivery = selectField(advanced, '发送方式', 'template-delivery', edit.delivery, [['text', '始终文本'], ['auto', '超出阈值转附件'], ['file', '始终附件']]);
      const fileFields = element('div'); advanced.append(fileFields);
      const threshold = field(fileFields, '超过此字符数时转附件', 'number', edit.threshold, 'template-threshold'); threshold.min = 1; threshold.max = 1000000;
      const attachmentText = field(fileFields, '附件说明（添加到问题中）', 'textarea', edit.attachmentText, 'template-attachment-text');
      fileFields.append(element('p', { class: 'note' }, '{{template.name}} 预设名称 · {{filename}} 实际文件名。每条预设生成独立附件。'));
      const update = () => { fileFields.hidden = delivery.value === 'text'; threshold.disabled = delivery.value !== 'auto'; };
      delivery.addEventListener('change', update); update(); body.append(advanced);
      const error = element('p', { id: 'template-error', class: 'note field-error', role: 'alert' }); body.append(error);
      const footer = element('div', { class: 'footer' });
      footer.append(button('取消编辑', () => renderTemplates()), button('保存预设', async () => {
        try {
          const item = { ...edit, name: name.value, text: text.value, position: position.value, defaultIncluded: defaultIncluded.checked,
            action: action.value, delivery: delivery.value, threshold: Number(threshold.value), attachmentText: attachmentText.value };
          const next = expected.some(item => item.id === edit.id) ? expected.map(old => old.id === edit.id ? item : old) : [...expected, item];
          await saveTemplates(next, expected); renderTemplates(); report('预设已保存。');
        } catch (cause) { error.textContent = cause.message; throw cause; }
      }, 'primary'));
      if (edit.preset) footer.append(button('恢复默认', async () => {
        const defaults = presetTemplates().find(item => item.preset === edit.preset);
        await saveTemplates(expected.map(item => item.id === edit.id ? defaults : item), expected); renderTemplates(defaults); report('已恢复默认预设。');
      }));
      body.append(footer);
    } else {
      renderedTemplates = templatesIdentity;
      renderedTemplateItems = new Map(templates.map(item => [item.id, JSON.stringify(item)]));
      body.append(element('p', { class: 'source' }, context?.title || '当前网页'));
      body.append(element('p', { class: 'note' }, '勾选表示发送时引用，发送后自动取消勾选。点击名称执行替换、追加或直接发送，追加遵循问题前／后位置并保留当时快照。拖动手柄可调整顺序。'));
      const list = element('div', { class: 'preset-list', 'aria-label': '预设顺序' }); body.append(list);
      for (const template of templates) {
        const row = element('div', { class: 'template-row', 'data-sort-id': template.id });
        const handle = element('button', { type: 'button', 'data-sort-handle': '', 'aria-label': '拖动预设 ' + template.name, title: '拖动排序' }, '⠿');
        const use = button(template.name + ' · ' + ({ replace: '替换', append: '追加', send: '直接发送' })[template.action], () => useTemplate(template), 'template-use'); use.dataset.templateId = template.id;
        const toggle = element('input', { type: 'checkbox', 'aria-label': '发送时引用 ' + template.name }); toggle.checked = Boolean(context?.templateSelections?.[template.id]); toggle.title = '发送时引用';
        toggle.addEventListener('change', () => run(toggle, () => toggleTemplate(template, toggle.checked)));
        const editButton = button('编辑', () => renderTemplates(template)); editButton.setAttribute('aria-label', '编辑预设 ' + template.name);
        row.append(handle, use, toggle, editButton);
        if (!template.preset) { const remove = button('删除', async () => { await removeTemplate(template.id); await saveTemplates(templates.filter(item => item.id !== template.id)); renderTemplates(); }); remove.setAttribute('aria-label', '删除预设 ' + template.name); row.append(remove); }
        list.append(row);
      }
      installSorting(list);
      body.append(button('新增预设', () => renderTemplates(newTemplate({ id: view.crypto.randomUUID() }))));
    }
    variableDirectory(body); schedulePosition(); motion.enter(body, { fadeOnly: true, duration: 120 });
  }
  function installSorting(list) {
    sorting = installPresetSort(list, { scroller: popup, items: structuredClone(templates), save: saveTemplates,
      changed: active => { if (!active && !disposed && pane === 'templates') syncTemplateList(); }, error: cause => report(cause.message, true) });
  }
  function syncTemplateList() {
    if (sorting?.active) return;
    if (renderedTemplates !== templatesIdentity) {
      const list = $('#pane-body .preset-list');
      const orderOnly = list && templates.length === renderedTemplateItems.size && templates.every(item => renderedTemplateItems.get(item.id) === JSON.stringify(item));
      if (!orderOnly) { renderTemplates(); return; }
      const previousSort = sorting; sorting = null; previousSort?.dispose();
      const rows = new Map([...list.children].map(row => [row.dataset.sortId, row]));
      const before = motion.capture(list.children);
      templates.forEach((item, index) => { const row = rows.get(item.id); if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null); });
      motion.rearrange(before, list.children); renderedTemplates = templatesIdentity; installSorting(list);
    }
    const source = $('#pane-body .source'); if (source) setText(source, context?.title || '当前网页');
    for (const row of root.querySelectorAll('.template-row')) {
      const use = row.querySelector('[data-template-id]');
      const template = templates.find(item => item.id === use?.dataset.templateId);
      const toggle = row.querySelector('input'), checked = Boolean(context?.templateSelections?.[template.id]);
      if (template && toggle.checked !== checked) toggle.checked = checked;
    }
  }

  function rememberInsertion() {
    const editor = findComposer(); if (!editor) { insertion = null; return; }
    insertion = { editor, session: adapter.sessionKey(), draft: getComposerText(editor), tabId: context?.tabId, url: context?.url };
  }
  function checkInsertion(saved) {
    if (disposed || !saved || saved.editor !== findComposer() || saved.session !== adapter.sessionKey() || getComposerText(saved.editor) !== saved.draft
      || saved.tabId !== context?.tabId || saved.url !== context?.url) throw new Error('问题、来源或会话已变化，请重新打开预设菜单。');
  }
  async function useTemplate(template) {
    if (templateApplying || delivering) throw new Error('正在准备预设或发送，请等待完成。');
    const saved = insertion; checkInsertion(saved);
    if (template.action === 'send') { startSend(saved.editor, { template, insertion: saved }); showPane(null); return; }
    templateApplying = true;
    const transaction = { editor: saved.editor, session: saved.session, abort: new view.AbortController(), stamp: null, progress: '' }; delivery = transaction;
    reportProgress('正在准备预设…', transaction);
    try {
      filled.reconcile(saved.draft, saved.editor, saved.session);
      const replacing = template.action === 'replace';
      const previous = replacing ? null : filled.removable(template.id, saved.draft);
      const base = replacing ? '' : previous ? saved.draft.slice(0, previous.start) + saved.draft.slice(previous.end) : saved.draft;
      const result = await request({ type: 'SIDER_TEMPLATE_CONTEXT_GET', ids: [template.id], needPage: needsPageVariables(template.text) || template.delivery !== 'text' && needsPageVariables(template.attachmentText) });
      checkInsertion(saved);
      if (JSON.stringify(templates.find(item => item.id === template.id)) !== JSON.stringify(template)) throw new Error('预设设置已变化，请重新打开菜单后追加。');
      transaction.stamp = contextStamp();
      const now = new Date(); const block = expandTemplateItem(template, context, { page: result.variablePage || context?.attachments.page, now, supportsAttachments: supportsAttachments() });
      if (block.errors.length) throw new Error(block.errors[0]);
      if (block.attachment) {
        const staged = attachments.adopt ? { ...block.attachment, id: 'staging-' + view.crypto.randomUUID() } : block.attachment;
        transaction.staged = staged; ownedAttachment = staged;
        const uploaded = await attachments.prepare(staged, { signal: transaction.abort.signal, requireSendReady: false, isCurrent: () => !disposed && contextStamp() === transaction.stamp && findComposer() === saved.editor && adapter.sessionKey() === saved.session && getComposerText(saved.editor) === saved.draft,
          onProgress: ({ message }) => reportProgress(message, transaction) });
        applyUploadName(block, uploaded?.name, result.variablePage || context?.attachments.page, now);
      }
      checkInsertion(saved);
      if (transaction.abort.signal.aborted || transaction.stamp !== contextStamp()) throw new Error('预设、来源或草稿已变化，请重新追加。');
      const insertionText = template.position === 'prepend' ? block.text + (base ? '\n\n' : '') : (base ? '\n\n' : '') + block.text;
      const next = template.position === 'prepend' ? insertionText + base : base + insertionText;
      if (next.length > 1000000) throw new Error('追加后超过 100 万字符，请减少内容或使用附件。');
      if (replacing && attachments.retain) await attachments.retain(transaction.staged ? [transaction.staged.id] : []);
      else if (!transaction.staged || transaction.staged.id !== template.id) await removeAttachmentId(template.id);
      checkInsertion(saved);
      if (transaction.abort.signal.aborted || transaction.stamp !== contextStamp()) throw new Error('预设、来源或草稿已变化，请重新追加。');
      if (transaction.staged && attachments.adopt) { attachments.adopt(transaction.staged.id, block.attachment); transaction.adopted = true; ownedAttachment = block.attachment; }
      transaction.written = next;
      await writeDraft(next, saved.draft);
      if (transaction.abort.signal.aborted || transaction.stamp !== contextStamp() || findComposer() !== saved.editor || adapter.sessionKey() !== saved.session || getComposerText(saved.editor) !== next
        || block.attachment && !attachments.isReady(block.attachment)) throw new Error('追加期间草稿、来源或附件已变化，请检查后重试。');
      if (replacing) { filled.reset(saved.editor, saved.session, ''); missingAttachments.clear(); }
      if (previous) { filled.records.delete(template.id); filled.applyEdit(previous.start, previous.end, ''); }
      filled.applyEdit(template.position === 'prepend' ? 0 : base.length, template.position === 'prepend' ? 0 : base.length, insertionText);
      filled.add({ ...block, context: structuredClone(context), page: result.variablePage, now }, template.position === 'prepend' ? 0 : base.length, insertionText);
      missingAttachments.delete(template.id); prepared = null; renderChips(); showPane(null); saved.editor.focus({ preventScroll: true });
      report(block.notice || (replacing ? '预设已替换，可继续编辑后发送。' : '预设已追加，可继续编辑后发送。'));
    } catch (error) {
      if (transaction.written && adapter.sessionKey() === saved.session) await restoreQuestion(transaction.written, saved.draft, saved.editor);
      let cleanupError;
      if (transaction.staged) try { await removeAttachmentId(transaction.adopted ? template.id : transaction.staged.id); } catch (cause) { cleanupError = cause; }
      for (const snapshot of filled.snapshots()) if (snapshot.attachment && !attachments.isReady(snapshot.attachment)) missingAttachments.add(snapshot.id);
      renderChips();
      if (cleanupError) throw new Error(error.message + '\n' + cleanupError.message);
      throw error;
    } finally { templateApplying = false; if (delivery === transaction) delivery = null; }
  }
  function applyUploadName(block, filename, page, now) {
    applyAttachmentFilename(block, filename);
  }
  function renderTemplatePreview(force = false) {
    const inputs = [previewTemplateId, ...visualInputs()];
    if (!force && equalInputs(previewInputs, inputs)) return; previewInputs = inputs;
    const template = templates.find(item => item.id === previewTemplateId); if (!template) { showPane(null); return; }
    const snapshot = filled.records.get(template.id);
    const block = snapshot || expandTemplateItem(template, context, { supportsAttachments: supportsAttachments() });
    const body = $('#pane-body');
    const identity = template.id + ':' + (snapshot ? snapshot.block : block.content) + ':' + (context?.pageError || '') + ':' + missingAttachments.has(template.id);
    if (!force && body.dataset.previewIdentity === identity) return;
    body.dataset.previewIdentity = identity; body.replaceChildren();
    body.append(element('p', { class: 'page-meta' }, template.name + ' · ' + (block.regions?.marked ? '附件区域 ' : '') + block.characterCount + ' 字符 · ' + (block.delivery === 'file' ? '附件' : '文本') + (snapshot ? ' · 追加时快照' : ' · 发送时更新')));
    if (block.errors?.length) body.append(element('p', { class: 'note field-error' }, block.errors.join('\n')));
    body.append(element('strong', {}, '最终提示词'), element('pre', { class: 'page-body', tabindex: '0', 'aria-label': '最终提示词' }, block.text));
    if (block.attachment) body.append(element('strong', {}, '附件内容'), element('pre', { class: 'page-body', tabindex: '0', 'aria-label': '附件内容' }, block.attachment.content));
    if (missingAttachments.has(template.id)) {
      body.append(element('p', { class: 'note field-error' }, '此预设的附件已移除。请重试上传或移除该项。'));
      body.append(button('重试附件', async () => {
        if (!snapshot) { missingAttachments.delete(template.id); report('下一次发送将重新准备附件。'); renderTemplatePreview(true); return; }
        if (delivering || templateApplying) throw new Error('正在准备预设，请等待完成。');
        const current = findComposer(), draft = getComposerText(current), session = adapter.sessionKey();
        filled.reconcile(draft, current, session);
        const old = filled.removable(template.id, draft);
        templateApplying = true;
        const transaction = { editor: current, session, stamp: contextStamp(), abort: new view.AbortController(), written: null }; delivery = transaction;
        reportProgress('正在恢复预设附件…', transaction);
        try {
          const uploaded = await attachments.prepare(snapshot.attachment, { signal: transaction.abort.signal, requireSendReady: false, isCurrent: () => !disposed && current === findComposer() && session === adapter.sessionKey() && draft === getComposerText(current) && transaction.stamp === contextStamp() });
          const updated = { ...snapshot }; applyAttachmentFilename(updated, uploaded.name);
          const prompt = updated.text;
          const replacement = old.block.replace(snapshot.text, prompt);
          const next = draft.slice(0, old.start) + replacement + draft.slice(old.end);
          transaction.written = next; await writeDraft(next, draft);
          if (transaction.abort.signal.aborted || transaction.stamp !== contextStamp() || !attachments.isReady(snapshot.attachment)) throw new Error('恢复期间预设或附件已变化，请重新尝试。');
          filled.records.delete(template.id); filled.applyEdit(old.start, old.end, replacement); filled.add(updated, old.start, replacement);
          missingAttachments.delete(template.id); renderTemplatePreview(true); renderChips(); report('附件已恢复，可以发送。');
        } catch (error) {
          if (transaction.written && session === adapter.sessionKey()) await restoreQuestion(transaction.written, draft, current);
          missingAttachments.add(template.id);
          try { await removeAttachmentId(template.id); }
          catch (cleanup) { throw new Error(error.message + '\n' + cleanup.message); }
          renderChips();
          throw error;
        } finally { templateApplying = false; if (delivery === transaction) delivery = null; }
      }));
    }
    if (needsPageVariables((snapshot?.template || template).text)) body.append(button('查看正文快照', () => showPane('page')));
    body.append(button('移除该项', () => removeTemplate(template.id).then(() => showPane(null)))); schedulePosition();
  }

  function renderPagePreview(force = false) {
    const fixed = filled.records.get(previewTemplateId);
    const page = fixed ? fixed.page || fixed.context?.attachments.page : context?.attachments.page;
    const valid = Boolean(fixed ? page?.content : context?.pageRequested && page?.url === context.url && !context.pageError);
    const identity = valid ? `${fixed?.id || context.tabId}:${page.url}:${page.capturedAt}` : context?.pageError || 'unavailable';
    if (!force && previewSnapshot?.identity === identity && previewSnapshot?.content === page?.content) {
      const refresh = $('#refresh-page'); if (refresh) refresh.disabled = delivering || Boolean(fixed);
      return;
    }
    const body = $('#pane-body'); body.replaceChildren();
    previewSnapshot = { identity, content: page?.content };
    const meta = element('p', { class: 'page-meta' }, valid
      ? `${page.title || context.title}\n${page.url}\n采集时间：${page.capturedAt || '未记录'} · ${page.content.length} 字符\n${(page.extraction?.warnings || []).join('\n')}`
      : context?.pageError || '正文引用已取消，或来源已变化。请重新开启正文引用。');
    body.append(meta, element('p', { class: 'note' }, fixed ? '这是追加时保留的正文快照。复制与下载使用原内容；重新追加该预设可以更新，后续发送不会改写它。' : '这是采集时的快照。发送前会重新采集，来源页面变化不会自动刷新。'));
    if (valid) body.append(element('pre', { class: 'page-body', tabindex: '0', 'aria-label': '正文 Markdown 源文本' }, page.content));
    const footer = element('div', { class: 'footer' });
    const copy = button('复制正文', async () => {
      if (fixed ? filled.records.get(previewTemplateId) !== fixed : context?.url !== page.url || context.attachments.page?.content !== page.content) throw new Error('来源或正文已变化，请查看最新快照。');
      await view.navigator.clipboard.writeText(page.content); report('正文已复制。');
    }); copy.disabled = !valid;
    const download = button('下载 Markdown', () => {
      if (fixed ? filled.records.get(previewTemplateId) !== fixed : context?.url !== page.url || context.attachments.page?.content !== page.content) throw new Error('来源或正文已变化，请查看最新快照。');
      downloadText(document, page.content, safeFilename(page.title || context.title), 'text/markdown;charset=utf-8');
    }); download.disabled = !valid;
    const refresh = button('刷新正文', async () => {
      if (delivering) throw new Error('正在准备发送，请完成后刷新正文。');
      await request({ type: 'SIDER_TAB_CONTEXT_GET', refreshPage: true });
    }); refresh.id = 'refresh-page'; refresh.disabled = delivering || Boolean(fixed) || !context?.pageRequested;
    footer.append(copy, download, refresh); body.append(footer); schedulePosition();
  }



  function field(body, labelText, type, value, id) {
    const label = document.createElement('label'); label.textContent = labelText; label.htmlFor = id;
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input'); input.id = id;
    if (type === 'textarea') input.rows = 3; else input.type = type;
    input.value = value; body.append(label, input); return input;
  }



  function positionPopover() {
    if (!pane || !host.isConnected) return;
    const rect = host.getBoundingClientRect(); const popup = $('.popover');
    const width = Math.max(100, Math.min(380, view.innerWidth - 20));
    // Width must settle before reading height, especially after a narrow resize.
    if (popup.style.width !== `${width}px`) popup.style.width = `${width}px`;
    const height = popup.offsetHeight;
    const coordinates = { left: `${Math.max(10, Math.min(rect.left, view.innerWidth - width - 10))}px`, top: `${Math.max(10, Math.min(rect.top - height - 8, view.innerHeight - height - 10))}px` };
    for (const [key, value] of Object.entries(coordinates)) if (popup.style[key] !== value) popup.style[key] = value;
  }
  function schedulePosition() {
    if (!pane || disposed || positionFrame !== null) return;
    positionFrame = view.requestAnimationFrame(() => { positionFrame = null; positionPopover(); });
  }

  function clearSendGap() {
    view.clearTimeout(sendGap?.timer);
    sendGap = null;
  }

  function displayAvailability(current, availability) {
    if (!['claude', 'generic'].includes(adapter.site.adapter) || availability.reason !== 'send-missing'
      || !current || current !== composer || sendGap && (sendGap.editor !== current || sendGap.session !== adapter.sessionKey())) {
      clearSendGap();
      return availability;
    }
    if (!sendGap && ready) {
      sendGap = { editor: current, session: adapter.sessionKey(), deadline: Date.now() + SEND_CONTROL_GRACE_MS };
      sendGap.timer = view.setTimeout(scheduleMount, SEND_CONTROL_GRACE_MS);
    }
    // Keep the original deadline during repeated input and DOM mutations.
    return sendGap && Date.now() < sendGap.deadline ? { ready: true, detail: '' } : availability;
  }

  function mount() {
    mountFrame = null;
    if (disposed) return;
    const current = findComposer(document);
    const availability = displayAvailability(current, adapter.availability());
    if (ready !== availability.ready || readinessDetail !== availability.detail) {
      if (availability.ready && readinessDetail && $('.status').textContent === readinessDetail) report('');
      ready = availability.ready; readinessDetail = availability.detail;
      onReady({ ready: availability.ready, detail: availability.detail });
    }
    if (!current) { setHidden(host, true); showPane(null, { immediate: true, restoreFocus: false }); delivery?.abort.abort(); return; }
    if (delivery && (delivery.editor !== current || delivery.session !== adapter.sessionKey())) delivery.abort.abort();
    if (composer && (composer !== current || filled.session !== null && filled.session !== adapter.sessionKey())) {
      prepared = null; filled.reset(current, adapter.sessionKey(), getComposerText(current)); missingAttachments.clear();
      void clearAttachment().catch(error => report(error.message, true));
    }
    composer = current;
    // Composer forms treat clicks on a shadow host as clicks on their own
    // background and can steal focus from extension inputs. Keep our controls
    // outside that form, while remaining next to the original editor.
    const anchor = adapter.findMountAnchor();
    if (!anchor) { setHidden(host, true); showPane(null, { immediate: true, restoreFocus: false }); return; }
    if (!host.isConnected || host.previousElementSibling !== anchor) anchor.after(host);
    setHidden(host, false);
    host.toggleAttribute('data-dark', document.documentElement.classList.contains('dark') || view.matchMedia?.('(prefers-color-scheme:dark)').matches);
    if (!availability.ready && !delivering) report(availability.detail, true);
    schedulePosition();
  }

  function scheduleMount() {
    if (mountFrame !== null || disposed) return;
    mountFrame = view.requestAnimationFrame(mount);
  }

  function findSendButton() {
    return adapter.findSendButton();
  }

  function contextStamp() { return JSON.stringify({ context, templates, needsAccess }); }

  function clearAttachment() {
    if (clearingAttachment) return clearingAttachment.promise;
    const status = $('.status');
    const previousStatus = { text: status.textContent, error: status.classList.contains('error'), hidden: status.hidden };
    const task = { settled: false, promise: null };
    clearingAttachment = task;
    task.promise = Promise.resolve().then(() => {
      if (ownedAttachment) reportProgress('正在取消正文附件…');
      return attachments.clear();
    }).then(() => {
      ownedAttachment = null; cleanupIssue = null;
      if (!disposed && !delivering && status.textContent === '正在取消正文附件…') {
        report(previousStatus.error && !previousStatus.hidden ? previousStatus.text : '正文附件已取消。', previousStatus.error && !previousStatus.hidden);
      }
    }).catch(error => {
      cleanupIssue = error;
      error.code = 'ATTACHMENT_CLEANUP_FAILED';
      throw error;
    }).finally(() => {
      task.settled = true;
      if (!delivering && clearingAttachment === task) clearingAttachment = null;
    });
    return task.promise;
  }

  async function writeDraft(text, expectedPrevious) {
    const expectedEditor = findComposer(); const session = adapter.sessionKey();
    writing = true;
    try {
      const result = await adapter.writeDraft(text, { expectedPrevious, expectedEditor, isCurrent: () => !disposed && findComposer() === expectedEditor && adapter.sessionKey() === session });
      if (!result.ok) throw new Error(result.error);
    } finally { writing = false; }
  }

  async function restoreQuestion(previous, question, originalEditor) {
    if (findComposer(document) === originalEditor && getComposerText(originalEditor) === previous) {
      await writeDraft(question, previous); prepared = null;
    }
  }

  function waitForSendControl(transaction, expected, deadline) {
    return new Promise((resolve, reject) => {
      const signal = transaction.abort.signal;
      const stamp = contextStamp();
      const finish = (target, error) => {
        view.clearInterval(timer);
        signal.removeEventListener('abort', tick);
        if (error) reject(error); else resolve(target);
      };
      const tick = () => {
        try {
          if (disposed || signal.aborted || contextStamp() !== stamp || adapter.sessionKey() !== transaction.session
            || findComposer() !== transaction.editor || getComposerText(transaction.editor) !== expected) {
            throw new Error('问题、引用或会话已修改，请重新发送。');
          }
          const availability = adapter.availability();
          const target = findSendButton();
          if (target && availability.ready) return finish(target);
          if (availability.reason !== 'send-missing' || Date.now() >= deadline) {
            throw new Error(availability.detail || `${adapter.site.name} 发送按钮尚未就绪，请稍后重新发送。`);
          }
        } catch (error) { finish(null, error); }
      };
      const timer = view.setInterval(tick, 25);
      signal.addEventListener('abort', tick, { once: true });
      tick();
    });
  }

  function nativeSend(event) {
    if (replaying || !event.isTrusted) return;
    const current = findComposer(document); if (!current) return;
    if (!adapter.isSendIntent(event, current)) return;
    const draft = getComposerText(current);
    if (!draft.trim()) return;
    const rawAvailability = adapter.availability();
    const availability = displayAvailability(current, rawAvailability);
    if (!delivering && !availability.ready) {
      if (sendGap || availability.reason === 'site-connection-error') { event.preventDefault(); event.stopImmediatePropagation(); report(availability.detail, true); }
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    if (delivering) { reportProgress(delivery?.progress || '正在准备发送，请等待或取消正文引用…'); return; }
    if (templateApplying) { report('正在追加预设，请等待完成后发送。', true); return; }
    startSend(current);
  }

  function startSend(current, templateOptions = null) {
    if (delivering) return;
    const draft = getComposerText(current);
    const rawAvailability = adapter.availability();
    if (!rawAvailability.ready && !sendGap && !(templateOptions && rawAvailability.reason === 'send-missing')) { report(rawAvailability.detail, true); return; }
    filled.reconcile(draft, current, adapter.sessionKey());
    let question = prepared?.editor === current && prepared.text === draft ? prepared.question : draft;
    const transaction = { editor: current, question, draft, session: adapter.sessionKey(), stamp: null, abort: new view.AbortController(), written: null, progress: '' };
    delivering = true; delivery = transaction;
    reportProgress('正在准备预设…', transaction);
    void run(null, async () => {
      const unchanged = expected => !disposed && adapter.sessionKey() === transaction.session && findComposer() === current && getComposerText(current) === expected;
      try {
        if (!rawAvailability.ready && sendGap) await waitForSendControl(transaction, draft, sendGap.deadline);
        const explicitId = templateOptions?.template.id;
        const previous = explicitId ? filled.removable(explicitId, draft) : null;
        if (previous) question = draft.slice(0, previous.start) + draft.slice(previous.end);
        const snapshots = filled.snapshots().filter(item => item.id !== explicitId);
        for (const id of missingAttachments) if (filled.records.has(id) || context?.templateSelections?.[id]) throw new Error('预设附件已移除，请在对应标签中重试上传或移除该项。');
        const chosen = selectedTemplates(templateOptions?.template.id);
        const result = await request({ type: 'SIDER_TEMPLATE_CONTEXT_GET', refreshPage: true, ids: chosen.map(item => item.id), needPage: chosen.some(item => needsPageVariables(item.text) || item.delivery !== 'text' && needsPageVariables(item.attachmentText)) });
        if (!unchanged(draft)) throw new Error('问题或会话已修改，请重新发送。');
        if (templateOptions) checkInsertion(templateOptions.insertion);
        if (templateOptions && JSON.stringify(templates.find(item => item.id === explicitId)) !== JSON.stringify(templateOptions.template)) throw new Error('预设设置已变化，请重新打开菜单后发送。');
        transaction.stamp = contextStamp();
        const page = result.variablePage || context?.attachments.page, now = new Date();
        const compiled = compile(question, { page, now, explicitId, snapshots });
        if (compiled.errors.length) throw new Error(compiled.errors[0]);
        const specs = compiled.attachments;
        if (attachments.retain) await attachments.retain([...specs.map(spec => spec.id), ...filled.snapshots().filter(item => item.attachment).map(item => item.id)]);
        else if (!specs.length) await clearAttachment();
        for (const spec of specs) {
          const snapshot = snapshots.find(item => item.id === spec.id);
          if (snapshot) {
            if (!attachments.isReady(spec)) throw new Error('已追加预设的附件不再就绪，请在预设标签中重试或移除。');
            continue;
          }
          const staged = spec.id === explicitId && previous?.attachment && attachments.adopt ? { ...spec, id: 'staging-' + view.crypto.randomUUID() } : spec;
          if (staged !== spec) transaction.staged = staged;
          ownedAttachment = staged;
          reportProgress('正在准备预设附件…', transaction);
          const uploaded = await attachments.prepare(staged, { signal: transaction.abort.signal, requireSendReady: Boolean(draft.trim()), isCurrent: () => unchanged(draft) && transaction.stamp === contextStamp(),
            onProgress: ({ message }) => reportProgress(message, transaction) });
          applyUploadName(compiled.blocks.find(block => block.id === spec.id), uploaded?.name, page, now);
        }
        const final = composeTemplatePrompt(question, templates, context, { blocks: compiled.blocks, snapshots });
        if (final.errors.length) throw new Error(final.errors[0]);
        await request({ type: 'SIDER_TAB_CONTEXT_GET' });
        if (transaction.stamp !== contextStamp() || transaction.abort.signal.aborted || !unchanged(draft)) throw new Error('问题、预设、来源或会话已变化，请重新发送。');
        if (previous?.attachment) {
          await removeAttachmentId(explicitId);
          if (transaction.staged) { attachments.adopt(transaction.staged.id, compiled.blocks.find(item => item.id === explicitId).attachment); transaction.adopted = true; }
        }
        if (specs.some(spec => !attachments.isReady(spec))) throw new Error('预设附件尚未就绪，请检查附件状态。');
        if (final.text !== draft) { transaction.written = final.text; await writeDraft(final.text, draft); }
        if (!unchanged(final.text)) throw new Error('问题已修改，请检查后重新发送。');
        prepared = { editor: current, question, text: final.text, prefix: final.prefix, suffix: final.suffix };
        await request({ type: 'SIDER_TAB_CONTEXT_GET' });
        if (transaction.stamp !== contextStamp() || transaction.abort.signal.aborted || !unchanged(final.text)) throw new Error('预设或草稿已变化，请重新发送。');
        if (specs.some(spec => !attachments.isReady(spec))) throw new Error('预设附件已取消，请重新发送。');
        const availability = adapter.availability();
        if (availability.reason === 'site-connection-error' || availability.reason === 'generating') throw new Error(availability.detail);
        let target = findSendButton();
        if (!target && availability.reason === 'send-missing') target = await waitForSendControl(transaction, final.text, sendGap?.deadline || Date.now() + SEND_CONTROL_GRACE_MS);
        if (!target) throw new Error(adapter.site.name + ' 发送按钮尚未就绪，请稍后重新发送。');
        const sentContext = { tabId: context.tabId, url: context.url, revision: context.revision };
        report(compiled.notice || ''); transaction.replayed = true; replaying = true;
        try { adapter.send(target); } finally { replaying = false; }
        if (templateOptions && getComposerText(current) === final.text) {
          // Sites can clear asynchronously. Keep the updated block associated
          // with its new file while the native draft still exists.
          if (previous) { filled.records.delete(explicitId); filled.applyEdit(previous.start, previous.end, ''); }
          if (filled.text !== question) filled.reconcile(question, current, transaction.session);
          filled.applyEdit(0, 0, final.prefix);
          filled.applyEdit(final.prefix.length + question.length, final.prefix.length + question.length, final.suffix);
          const block = compiled.blocks.find(item => item.id === explicitId);
          const group = compiled.blocks.filter(item => item.template.position === block.template.position);
          const index = group.indexOf(block), preceding = group.slice(0, index).reduce((sum, item) => sum + item.text.length + 2, 0);
          let start, end;
          if (block.template.position === 'prepend') {
            start = preceding; end = start + block.text.length + (index < group.length - 1 || question || final.suffix ? 2 : 0);
          } else {
            start = final.prefix.length + question.length + (question ? 2 : 0) + preceding;
            end = start + block.text.length; if (index || question) start -= 2;
          }
          filled.add({ ...block, context: structuredClone(context), page, now }, start, final.text.slice(start, end)); renderChips();
        }
        if (!getComposerText(current).trim()) { prepared = null; filled.reset(current, adapter.sessionKey(), ''); missingAttachments.clear(); attachments.commit?.(); ownedAttachment = null; renderChips(); }
        // Reset only after native dispatch; reset failures must not roll back or resend.
        try { await request({ type: 'SIDER_TAB_TEMPLATES_CLEAR', expectedContext: sentContext }); }
        catch (error) { report('消息已交给原站发送，但取消预设勾选失败：' + error.message, true); }
      } catch (error) {
        if (adapter.sessionKey() === transaction.session) await restoreQuestion(transaction.written || draft, templateOptions ? draft : question, current);
        if (transaction.staged) await removeAttachmentId(transaction.adopted ? templateOptions.template.id : transaction.staged.id).catch(() => {});
        if (ownedAttachment || transaction.abort.signal.aborted || transaction.stamp && transaction.stamp !== contextStamp() || !unchanged(question)) {
          try { if (attachments.retain) await attachments.retain(filled.snapshots().filter(item => item.attachment).map(item => item.id)); else await clearAttachment(); }
          catch (cleanup) { throw new Error(error.message + '\n' + cleanup.message); }
        }
        for (const snapshot of filled.snapshots()) if (snapshot.attachment && !attachments.isReady(snapshot.attachment)) missingAttachments.add(snapshot.id);
        renderChips();
        throw error;
      }
    }, transaction).finally(() => { if (delivery === transaction) delivery = null; delivering = false; if (clearingAttachment?.settled) clearingAttachment = null; });
  }

  // Native editing/selecting must retain its default behavior, but these UI
  // events must not reach ChatGPT's composer focus and submit handlers.
  const uiEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'focusin', 'focusout', 'touchstart', 'touchend', 'wheel'];
  const containUIEvent = event => event.stopPropagation();
  for (const type of uiEvents) root.addEventListener(type, containUIEvent);
  for (const item of root.querySelectorAll('[data-pane]')) {
    if (item.dataset.pane === 'templates') {
      item.addEventListener('pointerdown', rememberInsertion);
      item.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) rememberInsertion(); });
    }
    item.addEventListener('click', () => {
      if (item.dataset.pane === 'templates' && !insertion) rememberInsertion();
      showPane(pane === item.dataset.pane ? null : item.dataset.pane);
    });
  }
  $('#close-pane').addEventListener('click', () => showPane(null));
  $('#source-access').addEventListener('click', () => run($('#source-access'), () => requestSitePermission('SIDER_SOURCE_ACCESS_REQUEST')));
  $('#page-retry').addEventListener('click', () => run($('#page-retry'), async () => {
    report('正在提取当前网页正文…');
    await request({ type: 'SIDER_TAB_ATTACHMENT_SET', kind: 'page', enabled: true });
    report(context?.pageError || '正文引用已就绪。', Boolean(context?.pageError));
  }));
  const outside = event => { if (pane && !event.composedPath().includes(host)) showPane(null, { restoreFocus: false }); };
  const keyboard = event => { if (event.key === 'Escape') { if (sorting?.active) { event.preventDefault(); sorting.cancel(); } else showPane(null); } };
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keyboard, true);
  document.addEventListener('keydown', nativeSend, true); document.addEventListener('click', nativeSend, true);
  const nativeAttachmentRemoved = event => {
    if (replaying || !event.isTrusted) return;
    const node = event.composedPath().find(node => attachments.isOwnedRemoveButton?.(node)); if (!node) return;
    const id = attachments.ownedId?.(node) || PRESET_IDS.page;
    delivery?.abort.abort(); missingAttachments.add(id);
    report('预设附件已移除，请在预设标签中重试上传或移除该项。', true); renderChips();
  };

  document.addEventListener('click', nativeAttachmentRemoved, true);
  const inputChanged = event => {
    const current = composer?.isConnected && composer.contains(event.target) ? composer : findComposer(document);
    if (!current?.contains(event.target) || writing) return;
    if (replaying || delivery?.replayed) {
      if (!getComposerText(current).trim()) { filled.reset(current, adapter.sessionKey(), ''); attachments.commit?.(); ownedAttachment = null; missingAttachments.clear(); renderChips(); }
      prepared = null; return;
    }
    filled.reconcile(getComposerText(current), current, adapter.sessionKey());
    if (!getComposerText(current).trim()) { missingAttachments.clear(); void clearAttachment().catch(error => report(error.message, true)); }
    renderChips();
    delivery?.abort.abort();
    if (delivering) reportProgress('正在取消本次发送…');
    else hideStatus();
    schedulePosition();
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
  const disposeTextDrop = adapter.site.adapter === 'generic' ? installTextDrop({ document, adapter,
    isBusy: () => writing,
    beforeWrite() { delivery?.abort.abort(); prepared = null; writing = true; },
    afterWrite() { writing = false; scheduleMount(); },
    onError: detail => report(detail, true),
  }) : () => {};
  const refresh = () => {
    if (refreshPending) { refreshAgain = true; return refreshPending; }
    refreshPending = (async () => {
      let result;
      do {
        refreshAgain = false;
        result = await request({ type: 'SIDER_TAB_CONTEXT_GET', ...(context ? { knownContext: { tabId: context.tabId, revision: context.revision } } : {}) });
      } while (refreshAgain && !disposed);
      return result;
    })().finally(() => { refreshPending = null; });
    return refreshPending;
  };
  const storageChanged = (changes, area) => {
    if (area === 'local' && changes[UNIFIED_TEMPLATES_KEY]) {
      const draggingConflict = sorting?.dragging && JSON.stringify(templates) !== JSON.stringify(changes[UNIFIED_TEMPLATES_KEY].newValue);
      settingsEpoch++; templates = validateTemplates(changes[UNIFIED_TEMPLATES_KEY].newValue); templatesIdentity = JSON.stringify(templates);
      delivery?.abort.abort(); renderChips();
      if (draggingConflict) { sorting.cancel(); report('预设已在另一侧栏修改，排序已取消，请核对后重试。', true); }
      if (pane === 'templates' && !$('#template-name')) syncTemplateList();
    }

    if (area === 'session' && context && changes[`${TAB_CONTEXT_PREFIX}${context.tabId}`]) void refresh().catch(() => {});
  };
  chrome.storage.onChanged.addListener(storageChanged);
  // Streaming text elsewhere in the conversation cannot replace an editor or
  // sender. Still scan added controls, ancestor visibility and explicit targets.
  const controlSelector = ['textarea', '[contenteditable]', 'button', 'input', '[tabindex]', '[data-action]', '[role="button"]', '[role="textbox"]', '[role="alert"]', '[role="status"]', 'form', ...Object.values(adapter.site.selectors || {}).filter(Boolean)].join(',');
  const relevant = record => {
    if (record.target === host) return false;
    if (!composer?.isConnected || !host.isConnected) return true;
    const target = record.target;
    if (target === document.documentElement || target === document.body || target.contains(composer) || host.previousElementSibling?.contains(target) || target.matches?.(controlSelector)) return true;
    if (record.type === 'attributes') return target.matches?.(controlSelector) || Boolean(target.querySelector?.(controlSelector));
    return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches(controlSelector) || node.querySelector(controlSelector)));
  };
  const observer = new view.MutationObserver(records => { if (records.some(relevant)) scheduleMount(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'contenteditable', 'style', 'id', 'role', 'aria-label', 'aria-disabled', 'disabled', 'data-testid', 'data-test-id', 'title'] });
  const resized = () => { scheduleMount(); schedulePosition(); };
  const resizeObserver = view.ResizeObserver ? new view.ResizeObserver(schedulePosition) : null;
  resizeObserver?.observe(host); resizeObserver?.observe(popup);
  view.addEventListener('resize', resized); view.addEventListener('scroll', schedulePosition, true);
  const interval = view.setInterval(() => {
    scheduleMount();
    attachments.reconcile();
    if (!delivering && !templateApplying) for (const id of attachments.missingIds?.() || []) {
      if (filled.records.has(id) || context?.templateSelections?.[id]) missingAttachments.add(id);
    }
    if (polling || disposed) return;
    polling = true; void refresh().catch(() => {}).finally(() => { polling = false; });
  }, 1000);
  mount(); void refresh().catch(error => report(error.message, true, error.code === 'SOURCE_ACCESS_REQUIRED'));
  void request({ type: 'SIDER_PROMPT_TEMPLATES_GET' }).catch(error => report(error.message, true));
  return { host, root, refresh, dispose() {
    if (disposed) return;
    delivery?.abort.abort(); void Promise.resolve(attachments.dispose()).catch(() => {}); disposeTextDrop();
    disposed = true; sorting?.dispose(); clearSendGap(); observer.disconnect(); resizeObserver?.disconnect(); view.clearInterval(interval); view.clearTimeout(statusTimer);
    if (mountFrame !== null) view.cancelAnimationFrame(mountFrame);
    showPane(null, { immediate: true, restoreFocus: false }); motion.dispose();
    for (const type of uiEvents) root.removeEventListener(type, containUIEvent);
    chrome.storage.onChanged.removeListener(storageChanged); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true);
    document.removeEventListener('keydown', nativeSend, true); document.removeEventListener('click', nativeSend, true); document.removeEventListener('input', inputChanged, true);
    document.removeEventListener('click', nativeAttachmentRemoved, true);
    view.removeEventListener('resize', resized); view.removeEventListener('scroll', schedulePosition, true); host.remove();
  } };
}
