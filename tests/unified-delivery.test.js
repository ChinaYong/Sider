import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installEnhancement } from '../src/content/enhancement.js';
import { createAttachmentManager } from '../src/content/attachments.js';
import { presetTemplates, newTemplate } from '../src/prompt-templates.js';
import { createTabContext } from '../src/context.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function wait(predicate) { const deadline = Date.now() + 3000; while (!predicate()) { assert.ok(Date.now() < deadline, 'delivery did not finish'); await pause(); } }
const custom = patch => newTemplate({ id: 'custom-delivery-001', name: '自建项', text: '{{content}}', ...patch });

function fixture(t, items = [], { failureAt = 0, pendingAt = 0, clearOnSend = false } = {}) {
 const { window } = new JSDOM('<main><form><div data-composer-body><textarea id="prompt-textarea"></textarea></div><input type="file" aria-label="Attach files"><div data-composer-attachments></div><button type="submit" data-testid="send-button">Send</button></form></main>', { url: 'https://chatgpt.com/', pretendToBeVisual: true });
 const document = window.document, editor = document.querySelector('textarea');
 window.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{ width: 300, height: 60 }] : []; };
 window.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
 let nativeFiles = [];
 Object.defineProperty(document.querySelector('input[type="file"]'), 'files', { get: () => nativeFiles, set: value => { nativeFiles = value; } });
 let templates = [...presetTemplates().map(item => ({ ...item, defaultIncluded: false })), ...items];
 let body = '# 原始正文\n正文的尾标记'; let captures = 0, uploads = 0, release, requests = [], sent = [], files = new Map();
 const context = { ...createTabContext(1), url: 'https://source.test/', title: '来源', templateSelections: Object.fromEntries(templates.map(item => [item.id, item.defaultIncluded])) };
 const page = () => ({ url: context.url, title: context.title, content: body, capturedAt: new Date().toISOString(), metadata: { author: '作者' } });
 const response = () => ({ ok: true, context: structuredClone(context), templates: structuredClone(templates), needsAccess: false });
 const listeners = new Map();
 const addListener = document.addEventListener.bind(document);
 document.addEventListener = (type, fn, options) => { if (['nativeSend', 'nativeAttachmentRemoved'].includes(fn.name)) listeners.set(fn.name + ':' + type, fn); addListener(type, fn, options); };
 const chrome = { runtime: { async sendMessage(message) {
  const request = message.request; requests.push(structuredClone(request));
  if (request.type === 'SIDER_TAB_TEMPLATE_SET') { context.templateSelections[request.id] = request.enabled; context.explicitTemplates = context.explicitTemplates.filter(id => id !== request.id); if (request.enabled) context.explicitTemplates.push(request.id); context.revision++; return response(); }
  if (request.type === 'SIDER_TAB_TEMPLATES_CLEAR') {
   if (request.expectedContext.tabId === context.tabId && request.expectedContext.url === context.url && request.expectedContext.revision === context.revision) {
    for (const id of Object.keys(context.templateSelections)) context.templateSelections[id] = false;
    context.explicitTemplates = []; context.selectionIncluded = false; context.attachments = { url: false, page: null }; context.pageRequested = false; context.pageError = ''; context.revision++;
   }
   return response();
  }
  if (request.type === 'SIDER_TEMPLATE_CONTEXT_GET') {
   if (request.needPage) { captures++; const snapshot = page(); return { ...response(), variablePage: snapshot }; }
   return response();
  }
  if (request.type === 'SIDER_PROMPT_TEMPLATES_SAVE') { templates = structuredClone(request.templates); return response(); }
  return response();
 } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
 document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); sent.push(editor.value); if (clearOnSend) { editor.value = ''; document.querySelector('[data-composer-attachments]').replaceChildren(); editor.dispatchEvent(new window.Event('input', { bubbles: true })); } });
 document.querySelector('input[type="file"]').addEventListener('change', event => {
  const file = event.target.files[0]; uploads++;
  const reader = new window.FileReader(); reader.onload = () => files.set(file.name, reader.result); reader.readAsText(file);
  const card = document.createElement('div'); card.className = 'group/composer-attachment'; card.dataset.name = file.name;
  const name = document.createElement('button'); name.type = 'button'; name.setAttribute('aria-label', file.name); name.textContent = file.name;
  const remove = document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove ' + file.name); remove.textContent = '×'; remove.addEventListener('click', () => card.remove()); card.append(name, remove);
  if (failureAt === uploads) { const error = document.createElement('span'); error.setAttribute('role', 'alert'); error.textContent = '第二项上传失败'; card.append(error); }
  if (pendingAt === uploads) { const progress = document.createElement('span'); progress.setAttribute('role', 'progressbar'); card.append(progress); release = () => progress.remove(); }
  document.querySelector('[data-composer-attachments]').append(card);
 });
 const manager = createAttachmentManager(document, { timeoutMs: 1000 });
 const api = installEnhancement({ document, chrome, bridgeId: 'unified-fixture-001', attachmentManager: manager });
 t.after(() => { api.dispose(); window.close(); });
 const root = api.root;
 function clickText(text) { [...root.querySelectorAll('button')].find(button => button.textContent === text).click(); }
 async function invoke(id) {
  editor.focus(); root.querySelector('[data-pane="templates"]').dispatchEvent(new window.Event('pointerdown'));
  if (root.querySelector('.popover').hidden) root.querySelector('[data-pane="templates"]').click();
  root.querySelector('#pane-body [data-template-id="' + id + '"]').click(); await pause();
 }
 return { api, root, editor, document, manager, files, sent, requests, get context() { return structuredClone(context); }, get uploads() { return uploads; }, get captures() { return captures; }, get templates() { return templates; },
  release: () => release?.(), body(value) { body = value; },
  async select(id, value = true) { context.templateSelections[id] = value; context.revision++; await api.refresh(); },
  async invoke(id) { await api.refresh(); await invoke(id); if (templates.find(item => item.id === id)?.action === 'append') await wait(() => api.root.querySelector('.status').textContent.includes('已追加') || api.root.querySelector('.status').classList.contains('error')); },
  edit(value) { editor.value = value; editor.dispatchEvent(new window.Event('input', { bubbles: true })); },
  send() { listeners.get('nativeSend:click')({ type: 'click', isTrusted: true, target: document.querySelector('[data-testid="send-button"]'), preventDefault() {}, stopImmediatePropagation() {} }); },
  removeNative(name) { const button = [...document.querySelectorAll('[data-composer-attachments] button')].find(button => button.getAttribute('aria-label') === 'Remove ' + name); listeners.get('nativeAttachmentRemoved:click')({ isTrusted: true, composedPath: () => [button] }); button.click(); },
  clickText,
 };
}

test('two independently named attachments share one capture, preserve a user file, and send once', async t => {
 const a = custom({ delivery: 'file', position: 'prepend' }), b = custom({ id: 'custom-delivery-002', name: '第二项', delivery: 'file', attachmentText: '{{template.name}}：{{filename}}' });
 const f = fixture(t, [a,b]); await f.api.refresh();
 const user = f.document.createElement('div'); user.className = 'group/composer-attachment'; user.textContent = '用户文件'; f.document.querySelector('[data-composer-attachments]').append(user);
 await f.select(a.id); await f.select(b.id); f.editor.value = '我的问题'; f.send(); await wait(() => f.sent.length === 1 && f.files.size === 2);
 assert.equal(f.captures, 1); assert.equal(f.uploads, 2); assert.ok(user.isConnected);
 for (const [name, content] of f.files) { assert.ok(f.sent[0].includes(name)); assert.ok(content.includes('正文的尾标记')); assert.match(name, /sider-[0-9a-f]{16}/); }
 assert.ok(f.sent[0].startsWith('预设“自建项”')); assert.ok(f.sent[0].includes('第二项：')); assert.equal(f.sent[0].includes('正文的尾标记'), false);
});
test('fill uploads its own snapshot and subsequent send keeps that file plus a fresh distinct template', async t => {
 const a = custom({ action: 'append', delivery: 'file' }), b = custom({ id: 'custom-delivery-002', name: '第二项', delivery: 'file' });
 const f = fixture(t, [a,b]); f.editor.value = '问题'; await f.invoke(a.id); await wait(() => f.uploads === 1 && f.root.querySelector('.status').textContent.includes('已追加'));
 const originalName = [...f.files.keys()][0]; assert.ok(f.editor.value.includes(originalName)); assert.equal(f.sent.length, 0);
 f.body('新正文尾标记'); await f.select(a.id); await f.select(b.id); f.send(); await wait(() => f.sent.length === 1 && f.files.size === 2);
 assert.equal(f.uploads, 2); assert.equal(f.captures, 2); assert.equal(f.sent[0].split(originalName).length - 1, 1);
 assert.ok(f.files.get(originalName).includes('正文的尾标记')); assert.ok([...f.files.values()].some(value => value.includes('新正文尾标记')));
});
test('fill appends without replacing the native selection and repeated fill updates only its original block', async t => {
 const a = custom({ text: '填入 {{title}}' }); const f = fixture(t, [a]); f.editor.value = '前缀旧词后缀'; f.editor.setSelectionRange(2,4);
 await f.invoke(a.id); await wait(() => f.editor.value.includes('填入 来源'));
 assert.equal(f.editor.value, '前缀旧词后缀\n\n填入 来源'); await f.invoke(a.id); await pause(); assert.equal(f.editor.value, '前缀旧词后缀\n\n填入 来源'); assert.equal(f.sent.length, 0);
 f.edit(f.editor.value.replace('填入 来源', '用户修改')); const edited = f.editor.value; await f.invoke(a.id);
 assert.equal(f.editor.value, edited); assert.match(f.root.querySelector('.status').textContent, /已被编辑/);
});

test('filled body preview and copying retain the original raw snapshot independently of the current source', async t => {
 const a = custom({ delivery: 'file' }), f = fixture(t, [a]); f.editor.value = '问题'; await f.invoke(a.id);
 let copied; Object.defineProperty(f.document.defaultView.navigator, 'clipboard', { value: { async writeText(text) { copied = text; } } });
 f.body('网页后来更新的内容'); f.root.querySelector('.chip .excerpt').click(); f.clickText('查看正文快照');
 assert.equal(f.root.querySelector('.page-body').textContent, '# 原始正文\n正文的尾标记'); f.clickText('复制正文'); await pause();
 assert.equal(copied, '# 原始正文\n正文的尾标记'); assert.equal(f.root.querySelector('#refresh-page').disabled, true); assert.equal(f.sent.length, 0);
});
test('direct send permits an empty draft, applies position, and consumes the same active item once', async t => {
 const a = custom({ text: '立即提问', action: 'send', position: 'prepend' }); const f = fixture(t, [a]); await f.select(a.id); await f.invoke(a.id); await wait(() => f.sent.length === 1);
 assert.equal(f.sent[0], '立即提问'); assert.equal(f.uploads, 0);
 await wait(() => !f.context.templateSelections[a.id]);
 f.root.querySelector('[data-pane="templates"]').click(); assert.equal(f.root.querySelector('[aria-label="发送时引用 自建项"]').checked, false);
 assert.equal(f.requests.filter(request => request.type === 'SIDER_TAB_TEMPLATES_CLEAR').length, 1);
});

test('a default template waiting for selection does not collect its body when sending an ordinary question', async t => {
 const a = custom({ text: '{{selection}} {{content}}', defaultIncluded: true }); const f = fixture(t, [a]);
 f.editor.value = '普通问题'; await f.api.refresh(); f.send(); await wait(() => f.sent.length === 1);
 assert.equal(f.captures, 0); assert.equal(f.sent[0], '普通问题'); await wait(() => !f.root.querySelector('.chip'));
});

test('repeating one filled item preserves the independent range and attachment of another item', async t => {
 const a = custom({ text: '第一项 {{content}}', delivery: 'file' }), b = custom({ id: 'custom-delivery-002', name: '第二项', text: '第二项 {{content}}', delivery: 'file' });
 const f = fixture(t, [a,b]); f.editor.value = '问题'; await f.invoke(a.id); await f.invoke(b.id);
 const secondName = [...f.files.keys()][1]; f.body('新的正文'); await f.invoke(a.id); assert.ok(f.editor.value.includes(secondName));
 await f.invoke(b.id); assert.match(f.root.querySelector('.status').textContent, /已追加/); assert.equal(f.uploads, 4);
 assert.equal(f.editor.value.split('预设“自建项”').length - 1, 1); assert.equal(f.editor.value.split('预设“第二项”').length - 1, 1);
 assert.equal(f.sent.length, 0);
});
test('second attachment failure stops sending and preserves the question and user attachment', async t => {
 const a = custom({ delivery: 'file' }), b = custom({ id: 'custom-delivery-002', name: '第二项', delivery: 'file' }); const f = fixture(t, [a,b], { failureAt: 2 });
 await f.select(a.id); await f.select(b.id); f.editor.value = '保留问题'; f.send(); await wait(() => f.root.querySelector('.status').classList.contains('error'));
 assert.equal(f.sent.length, 0); assert.equal(f.editor.value, '保留问题'); assert.match(f.root.querySelector('.status').textContent, /上传失败/);
});
test('editing a draft during the second upload cancels every new attachment without overwriting the draft', async t => {
 const a = custom({ delivery: 'file' }), b = custom({ id: 'custom-delivery-002', name: '第二项', delivery: 'file' }); const f = fixture(t, [a,b], { pendingAt: 2 });
 await f.select(a.id); await f.select(b.id); f.editor.value = '旧问题'; f.send(); await wait(() => f.uploads === 2); f.edit('用户新问题'); f.release(); await pause(); await pause();
 assert.equal(f.sent.length, 0); assert.equal(f.editor.value, '用户新问题'); await wait(() => f.document.querySelectorAll('.group\\/composer-attachment').length === 0);
});
test('native removal of a filled attachment blocks sending and the tag can retry with its original snapshot', async t => {
 const a = custom({ delivery: 'file' }); const f = fixture(t, [a]); f.editor.value = '问题'; await f.invoke(a.id); await wait(() => f.files.size === 1 && f.editor.value.includes('sider-'));
 const oldName = [...f.files.keys()][0]; f.removeNative(oldName); f.send(); await wait(() => f.root.querySelector('.status').textContent.includes('对应标签')); assert.equal(f.sent.length, 0);
 f.root.querySelector('.chip .excerpt').click(); f.clickText('重试附件');
 try { await wait(() => f.uploads === 2 && f.files.size === 2 && !f.editor.value.includes(oldName) && f.root.querySelector('.status').textContent.includes('附件已恢复')); }
 catch (error) { assert.fail(JSON.stringify({ uploads: f.uploads, status: f.root.querySelector('.status').textContent, draft: f.editor.value, files: [...f.files.keys()] })); }
 f.send(); await wait(() => f.sent.length === 1); assert.ok(f.sent[0].includes([...f.files.keys()][1]));
});
test('native success clears filled records so the same template can fill the next question again', async t => {
 const a = custom({ text: '固定提示词' }); const f = fixture(t, [a], { clearOnSend: true }); f.editor.value = '问题'; await f.invoke(a.id); await wait(() => f.editor.value.includes('固定提示词'));
 f.send(); await wait(() => f.sent.length === 1); f.editor.value = '第二问'; await f.invoke(a.id); await wait(() => f.editor.value.includes('固定提示词'));
 assert.equal(f.editor.value, '第二问\n\n固定提示词');
});

test('marked attachments preserve instructions and replace only the note when retrying an original snapshot', async t => {
 const a = custom({ text: '总结网页。\n<attachment>{{content}}</attachment>\n按三点回答。', delivery: 'file' });
 const f = fixture(t, [a]); f.editor.value = '问题'; await f.invoke(a.id); await wait(() => f.files.size === 1);
 const oldName = [...f.files.keys()][0]; assert.ok(f.editor.value.startsWith('问题\n\n总结网页。')); assert.ok(f.editor.value.endsWith('按三点回答。'));
 assert.ok(!f.files.get(oldName).includes('总结网页。')); assert.ok(!f.files.get(oldName).includes('按三点回答。'));
 f.body('后来网页内容'); f.removeNative(oldName); f.root.querySelector('.chip .excerpt').click(); f.clickText('重试附件');
 await wait(() => f.root.querySelector('.status').textContent.includes('附件已恢复'));
 assert.equal(f.editor.value.split('总结网页。').length - 1,1); assert.equal(f.editor.value.split('按三点回答。').length - 1,1);
 assert.ok(!f.editor.value.includes(oldName)); assert.ok([...f.files.values()].every(text => !text.includes('后来网页内容')));
});

test('replacement removes every previous preset file and edited snapshot while keeping user files and checkbox choices', async t => {
 const a = custom({ delivery: 'file' }), b = custom({ id:'custom-delivery-002', name:'第二项', text:'第二份材料', delivery:'file' }), r = custom({ id:'replacement-item-001', text:'替换后 {{title}}', action:'replace' });
 const f = fixture(t,[a,b,r]); f.editor.value='旧问题'; await f.invoke(a.id); await f.invoke(b.id); await f.select(a.id);
 const user = f.document.createElement('div'); user.className='group/composer-attachment'; user.textContent='用户文件'; f.document.querySelector('[data-composer-attachments]').append(user);
 f.edit(f.editor.value.replace('旧问题','用户已修改的问题')); await f.invoke(r.id);
 await wait(() => f.root.querySelector('.status').textContent.includes('已替换'));
 assert.equal(f.editor.value,'替换后 来源'); assert.equal(f.sent.length,0); assert.ok(user.isConnected);
 assert.equal(f.document.querySelectorAll('[data-composer-attachments] button').length,0);
 assert.equal(f.root.querySelector('.chips [data-template-id="'+b.id+'"]'),null);
 assert.ok(f.root.querySelector('.chips [data-template-id="'+a.id+'"]')); // selected reference remains selected
 f.editor.value=''; f.edit('新问题'); await f.invoke(b.id); await wait(() => f.editor.value.includes('预设“第二项”'));
 assert.ok(!f.editor.value.includes('替换后'));
});

test('a failed same-ID replacement stages a new file without removing the old snapshot or draft', async t => {
 const a = custom({ delivery:'file' }); const f=fixture(t,[a],{failureAt:2}); f.editor.value='保留问题'; await f.invoke(a.id); await wait(()=>f.files.size===1);
 const oldName=[...f.files.keys()][0], original=f.editor.value;
 f.templates.find(item=>item.id===a.id).action='replace'; f.body('新的材料'); await f.invoke(a.id);
 await wait(()=>f.root.querySelector('.status').classList.contains('error'));
 assert.equal(f.editor.value,original); assert.equal(f.sent.length,0); assert.ok(f.document.querySelector('[data-name="'+oldName+'"]'));
 assert.equal(f.document.querySelectorAll('.group\\/composer-attachment').length,1);
});

test('partial old-file cleanup stops replacement, preserves the draft and marks removed snapshot files missing', async t => {
 const a=custom({delivery:'file'}), b=custom({id:'custom-delivery-002',name:'第二项',delivery:'file'}), r=custom({id:'replacement-item-001',text:'替换材料',action:'replace',delivery:'file'});
 const f=fixture(t,[a,b,r]); f.editor.value='旧问题'; await f.invoke(a.id); await f.invoke(b.id); await wait(()=>f.files.size===2);
 const names=[...f.files.keys()], original=f.editor.value;
 const second=f.document.querySelector('[data-name="'+names[1]+'"]'); second.querySelectorAll('button')[1].disabled=true;
 await f.invoke(r.id); await wait(()=>f.root.querySelector('.status').classList.contains('error'));
 assert.equal(f.editor.value,original); assert.equal(f.sent.length,0); assert.equal(f.document.querySelector('[data-name="'+names[0]+'"]'),null); assert.ok(second.isConnected);
 assert.match(f.root.querySelector('[data-template-id="'+a.id+'"] .excerpt').textContent,/附件缺失/);
 assert.equal(f.document.querySelectorAll('.group\\/composer-attachment').length,1);
});

test('direct send updates an intact previous block once and stops when the user has edited it', async t => {
 const a=custom({text:'旧提示 {{title}}'}), f=fixture(t,[a]); f.editor.value='问题'; await f.invoke(a.id);
 const item=f.templates.find(item=>item.id===a.id); item.action='send'; item.text='新提示 {{title}}'; await f.invoke(a.id); await wait(()=>f.sent.length===1);
 assert.equal(f.sent[0],'问题\n\n新提示 来源'); assert.ok(!f.sent[0].includes('旧提示'));
});

test('direct send respects an edited existing preset block and dispatches no message', async t => {
 const a=custom({text:'初始提示'}), f=fixture(t,[a]); f.editor.value='问题'; await f.invoke(a.id); f.edit(f.editor.value.replace('初始提示','我改过的提示'));
 f.templates.find(item=>item.id===a.id).action='send'; const before=f.editor.value; await f.invoke(a.id); await wait(()=>f.root.querySelector('.status').classList.contains('error'));
 assert.equal(f.editor.value,before); assert.equal(f.sent.length,0); assert.match(f.root.querySelector('.status').textContent,/已被编辑/);
});

test('direct send stages the updated same-ID attachment, removes the old one and sends its note only once',async t=>{
 const a=custom({text:'总结。<attachment>{{content}}</attachment>用中文。',delivery:'file'}), f=fixture(t,[a]); f.editor.value='原问题'; await f.invoke(a.id); await wait(()=>f.files.size===1);
 const oldName=[...f.files.keys()][0]; f.body('新资料最后一行'); f.templates.find(item=>item.id===a.id).action='send'; await f.invoke(a.id);await wait(()=>f.sent.length===1&&f.files.size===2);
 const name=[...f.files.keys()][1];assert.equal(f.sent[0].split(name).length-1,1);assert.ok(!f.sent[0].includes(oldName));assert.equal(f.sent[0].split('总结。').length-1,1);
 assert.ok(f.files.get(name).includes('新资料最后一行')); assert.ok(!f.files.get(name).includes('总结。'));assert.equal(f.document.querySelector('[data-name="'+oldName+'"]'),null);
 await f.invoke(a.id);await wait(()=>f.sent.length===2);assert.equal(f.sent[1].split('总结。').length-1,1);assert.equal(f.document.querySelectorAll('.group\\/composer-attachment').length,1);
});

test('failed direct-send update keeps the original same-ID file and editable draft',async t=>{
 const a=custom({delivery:'file'}), f=fixture(t,[a],{failureAt:2});f.editor.value='原问题';await f.invoke(a.id);await wait(()=>f.files.size===1);
 const oldName=[...f.files.keys()][0], draft=f.editor.value;f.templates.find(item=>item.id===a.id).action='send'; f.body('后来的资料');await f.invoke(a.id);await wait(()=>f.root.querySelector('.status').classList.contains('error'));
 assert.equal(f.sent.length,0);assert.equal(f.editor.value,draft);assert.ok(f.document.querySelector('[data-name="'+oldName+'"]'));assert.equal(f.document.querySelectorAll('.group\\/composer-attachment').length,1);
});
