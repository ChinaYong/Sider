import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createWebAdapter } from '../src/content/adapters.js';
import { createNativeAttachmentDriver } from '../src/content/attachment-drivers.js';
import { BUILTIN_AI_SITES } from '../src/ai-web.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const spec = { name: '正文.txt', content: '完整 UTF-8 正文。\n'.repeat(2100) + '结束标记', mimeType: 'text/plain' };
function fixture(t, { delay = 15, duplicate = false, onUpload, onMenu, timeoutMs = 400 } = {}) {
  const { window } = new JSDOM('<main><input-area-v2><div id="files"></div><div class="input-area"><rich-textarea><div class="ql-editor" role="textbox" contenteditable="true">原问题</div></rich-textarea><button type="button" aria-label="上传和工具" aria-expanded="false"></button><button class="send-button" aria-label="发送"></button></div></input-area-v2></main>', {url: BUILTIN_AI_SITES[1].url, pretendToBeVisual:true});
  window.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{}] : []; };
  window.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  const document = window.document, editor = document.querySelector('.ql-editor'), area = document.querySelector('#files'), trigger = document.querySelector('[aria-label="上传和工具"]');
  const adapter = createWebAdapter(document, BUILTIN_AI_SITES[1]), driver = createNativeAttachmentDriver(document, adapter), manager = adapter.createAttachmentManager({timeoutMs});
  let clicks = 0, drops = 0, openMenu = null; const uploads = [], removes = [];
  document.addEventListener('drop', () => drops++);
  function card(name, { pending = false, type = 'TXT', removeWorks = true } = {}) {
    const outer = document.createElement('div'); outer.className = 'file-preview-container';
    const tile = document.createElement('gem-attachment'); tile.tabIndex = 0; outer.append(tile);
    const label = document.createElement('span'); label.className = 'gem-attachment-text'; label.textContent = name.slice(0,-4);
    const ext = document.createElement('span'); ext.className = 'gem-attachment-extension-label'; ext.textContent = type;
    const close = document.createElement('button'); close.type = 'button'; close.setAttribute('aria-label', `close ${label.textContent}`);
    close.onclick = () => { removes.push(name); if (removeWorks) outer.remove(); };
    tile.append(ext,label,close); area.append(outer);
    if(pending) { const spinner = document.createElement('mat-progress-spinner'); tile.append(spinner); }
    return {tile,outer,label,ext,close,ready(){ tile.querySelector('mat-progress-spinner')?.remove(); }};
  }
  function fileInput(container, accept) {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.hidden = true;
    let files = []; Object.defineProperty(input,'files',{get:()=>files,set:value=>{files=value;}});
    input.onchange = () => { const file = input.files[0]; uploads.push(file); if(onUpload)onUpload(file,card); else card(file.name); };
    container.append(input); return input;
  }
  trigger.onclick = () => {
    if(trigger.getAttribute('aria-expanded') === 'true') { trigger.setAttribute('aria-expanded','false'); openMenu?.remove(); openMenu=null; return; }
    clicks++; trigger.setAttribute('aria-expanded','true');
    window.setTimeout(() => {
      if(trigger.getAttribute('aria-expanded') !== 'true')return;
      const menu = document.createElement('div');menu.setAttribute('role','menu'); const local = document.createElement('images-files-uploader'); menu.append(local);
      fileInput(local,'.txt,.pdf'); if(duplicate)fileInput(local,'text/plain');
      fileInput(menu,'.txt,.doc'); fileInput(menu,'image/*'); onMenu?.(menu,local,fileInput); document.body.append(menu); openMenu=menu;
    },delay);
  };
  t.after(async()=>{await manager.dispose();window.close();});
  return {window,document,editor,area,trigger,adapter,driver,manager,card,fileInput,uploads,removes,get clicks(){return clicks;},get drops(){return drops;}};
}

test('Gemini lazily initializes its unique local uploader once and recognizes basename plus TXT outside the editor row',async t=>{
  const f = fixture(t,{onUpload(file,add){const owned=add(file.name);owned.close.style.visibility='hidden';}}), user = f.card('user.txt'); const first = f.manager.prepare(spec), second = f.manager.prepare(spec);
  const [uploaded, repeated] = await Promise.all([first,second]);assert.deepEqual(repeated,uploaded);
  assert.equal(f.clicks,1);assert.equal(f.uploads.length,1);assert.equal(f.drops,0);assert.equal(f.uploads[0].size,Buffer.byteLength(spec.content));
  assert.equal(f.manager.isReady(spec),true);assert.equal(f.editor.textContent,'原问题');
  assert.match(uploaded.name,/-sider-[a-f0-9]{16}\.txt$/);assert.equal(f.driver.cards(f.area).length,2);
  await f.manager.prepare(spec);assert.equal(f.uploads.length,1);await f.manager.clear();assert.deepEqual(f.removes,[uploaded.name]);assert.equal(user.outer.isConnected,true);
});

test('Gemini current tiles wait for visible native progress and the actual enabled sender',async t=>{
  let owned;const f = fixture(t,{onUpload(file,add){owned=add(file.name,{pending:true});}});let done=false;
  const pending=f.manager.prepare(spec).then(value=>{done=true;return value;});await pause(50);assert.equal(done,false);
  const send=f.document.querySelector('.send-button');send.disabled=true;owned.ready();await pause(35);assert.equal(done,false);
  send.disabled=false;await pending;assert.equal(f.manager.isReady(spec),true);assert.equal(f.uploads.length,1);
});

test('Gemini native error icons report tooltip reasons and clean only the owned close control',async t=>{
  const f=fixture(t,{onUpload(file,add){const owned=add(file.name);const error=f.document.createElement('mat-icon');error.setAttribute('fonticon','error');error.setAttribute('aria-hidden','true');owned.tile.append(error);owned.outer.setAttribute('aria-describedby','reason');const tooltip=f.document.createElement('div');tooltip.id='reason';tooltip.textContent='文件上传失败：不支持此文件';f.document.body.append(tooltip);}}),user=f.card('user.txt');
  await assert.rejects(f.manager.prepare(spec),/不支持此文件/);assert.equal(f.uploads.length,1);assert.equal(f.drops,0);assert.equal(f.removes.length,1);assert.equal(user.outer.isConnected,true);assert.equal(f.editor.textContent,'原问题');
});

test('Gemini identity requires the exact nonce-bearing basename and TXT type',t=>{
  const f=fixture(t),name='body-sider-1234567890123456.txt',owned=f.card(name),other=f.card('body-sider-6543210987654321.txt'),wrong=f.card(name,{type:'PDF'});
  assert.equal(f.driver.namesCard(owned.tile,name),true);assert.equal(f.driver.namesCard(other.tile,name),false);assert.equal(f.driver.namesCard(wrong.tile,name),false);
  assert.equal(f.driver.ready(wrong.tile,name),false);owned.close.setAttribute('aria-label','close all');assert.equal(f.driver.removeButton(owned.tile),null);
});

test('Gemini truncated labels use the full native tooltip and never claim a matching abbreviated user label',async t=>{
  const f=fixture(t,{onUpload(file,add){const owned=add(file.name);owned.label.textContent='正文-si...abcd';owned.close.setAttribute('aria-label','close 正文-si...abcd');owned.close.style.visibility='hidden';owned.outer.setAttribute('aria-describedby','owned-filename');const tooltip=f.document.createElement('div');tooltip.id='owned-filename';tooltip.textContent=file.name;f.document.body.append(tooltip);}});
  const user=f.card('user.txt');user.label.textContent='正文-si...abcd';user.close.setAttribute('aria-label','close 正文-si...abcd');
  const uploaded=await f.manager.prepare(spec);assert.equal(f.driver.namesCard(user.tile,uploaded.name),false);assert.equal(f.manager.isReady(spec),true);
  await f.manager.clear();assert.deepEqual(f.removes,[uploaded.name]);assert.equal(user.outer.isConnected,true);
});

test('Gemini failed tiles without a TXT label remain identifiable for failure reporting and owned cleanup',async t=>{
  const f=fixture(t,{onUpload(file,add){const owned=add(file.name);owned.ext.remove();owned.label.textContent='正文-si...abcd';owned.close.setAttribute('aria-label','close 正文-si...abcd');owned.outer.setAttribute('aria-describedby','failed-filename');const tooltip=f.document.createElement('div');tooltip.id='failed-filename';tooltip.textContent=file.name;f.document.body.append(tooltip);const error=f.document.createElement('mat-icon');error.setAttribute('data-mat-icon-name','error_outline');error.setAttribute('title','原站拒绝此文件');owned.tile.append(error);}});
  await assert.rejects(f.manager.prepare(spec),/原站拒绝此文件/);assert.equal(f.uploads.length,1);assert.equal(f.removes.length,1);assert.equal(f.editor.textContent,'原问题');
});

for (const change of ['abort','clear','draft','session','editor']) test(`Gemini delayed upload-menu initialization cancels before file dispatch on ${change}`,async t=>{
  const f=fixture(t,{delay:100}),controller=new AbortController();let current=true;
  const pending=f.manager.prepare(spec,{signal:controller.signal,isCurrent:()=>current}),rejection=assert.rejects(pending,/取消|修改|切换/);
  await pause(10);
  if(change==='abort')controller.abort();
  if(change==='clear')await f.manager.clear();
  if(change==='draft'){f.editor.textContent='修改后的问题';current=false;}
  if(change==='session')f.editor.setAttribute('data-conversation-id','new');
  if(change==='editor')f.editor.replaceWith(f.editor.cloneNode(true));
  await rejection;await pause(115);assert.equal(f.uploads.length,0);assert.equal(f.drops,0);assert.equal(f.trigger.getAttribute('aria-expanded'),'false');assert.equal(f.document.querySelector('[role="menu"]'),null);
  assert.equal(f.adapter.readDraft(f.adapter.findComposer()),change==='draft'?'修改后的问题':'原问题');
});

test('Gemini ambiguous local upload controls stop without dropping or dispatching any file',async t=>{
  const f=fixture(t,{duplicate:true});await assert.rejects(f.manager.prepare(spec),/多个匹配/);
  assert.equal(f.uploads.length,0);assert.equal(f.drops,0);assert.equal(f.editor.textContent,'原问题');assert.equal(f.trigger.getAttribute('aria-expanded'),'false');
});

test('Gemini selects its newly opened menu rather than other retained uploaders or a previously open menu',async t=>{
  const f=fixture(t),inputs=[];
  for(const mode of ['outside','hidden-menu','old-open-menu']){
    const root=f.document.createElement('div');if(mode!=='outside')root.setAttribute('role','menu');if(mode==='hidden-menu')root.hidden=true;
    const local=f.document.createElement('images-files-uploader');root.append(local);inputs.push(f.fileInput(local,'.txt'));f.document.body.append(root);
  }
  const uploaded=await f.manager.prepare(spec);assert.equal(f.uploads.length,1);assert.equal(f.clicks,1);assert.equal(f.drops,0);
  for(const input of inputs)assert.equal(input.files.length,0);
  assert.equal(f.manager.isReady(spec),true);await f.manager.clear();assert.deepEqual(f.removes,[uploaded.name]);assert.equal(f.editor.textContent,'原问题');
});

test('Gemini ignores hidden, inert, aria-hidden and offscreen uploader copies inside the current menu',async t=>{
  const inputs=[];const f=fixture(t,{onMenu(menu,_local,add){for(const mode of ['hidden','display','visibility','aria','inert','offscreen']){const clone=menu.ownerDocument.createElement('images-files-uploader');if(mode==='hidden')clone.hidden=true;if(mode==='display')clone.style.display='none';if(mode==='visibility')clone.style.visibility='hidden';if(mode==='aria')clone.setAttribute('aria-hidden','true');if(mode==='inert')clone.setAttribute('inert','');if(mode==='offscreen')clone.getBoundingClientRect=()=>({left:-10000,right:-9900,top:0,bottom:40,width:100,height:40});inputs.push(add(clone,'.txt'));menu.append(clone);}}});
  await f.manager.prepare(spec);assert.equal(f.uploads.length,1);for(const input of inputs)assert.equal(input.files.length,0);assert.equal(f.manager.isReady(spec),true);assert.equal(f.drops,0);
});

for(const attribute of ['aria-controls','aria-owns'])test(`Gemini ${attribute} binds the upload menu while leaving another visible native file menu alone`,async t=>{
  const f=fixture(t,{onMenu(menu){menu.id='current-upload-menu';}});f.trigger.setAttribute(attribute,'current-upload-menu');
  const other=f.document.createElement('div');other.setAttribute('role','menu');const local=f.document.createElement('images-files-uploader');other.append(local);const input=f.fileInput(local,'.txt');f.document.body.append(other);
  await f.manager.prepare(spec);assert.equal(f.uploads.length,1);assert.equal(input.files.length,0);assert.equal(other.isConnected,true);assert.equal(f.manager.isReady(spec),true);
});

test('Gemini nested native menu lists count as one menu and do not duplicate the local input',async t=>{
  const f=fixture(t,{onMenu(menu,local){const inner=menu.ownerDocument.createElement('div');inner.setAttribute('role','menu');inner.append(local);menu.append(inner);}});
  await f.manager.prepare(spec);assert.equal(f.uploads.length,1);assert.equal(f.clicks,1);assert.equal(f.manager.isReady(spec),true);
});

test('Gemini uploader portals without a menu role remain bound to the newly opened native portal',async t=>{
  const f=fixture(t,{onMenu(menu){menu.removeAttribute('role');menu.className='cdk-overlay-pane';}});
  await f.manager.prepare(spec);assert.equal(f.uploads.length,1);assert.equal(f.manager.isReady(spec),true);assert.equal(f.drops,0);
});

test('Gemini reuses an already open native file menu without counting an unrelated navigation menu',async t=>{
  const f=fixture(t),menu=f.document.createElement('div');menu.setAttribute('role','menu');const local=f.document.createElement('images-files-uploader');menu.append(local);f.fileInput(local,'.txt');f.document.body.append(menu);f.trigger.setAttribute('aria-expanded','true');
  const navigation=f.document.createElement('div');navigation.setAttribute('role','menu');navigation.textContent='Navigation';f.document.body.append(navigation);
  await f.manager.prepare(spec);assert.equal(f.clicks,0);assert.equal(f.uploads.length,1);assert.equal(f.manager.isReady(spec),true);assert.equal(navigation.isConnected,true);
});

test('Gemini unavailable controlled menu never falls back to an unrelated native uploader',async t=>{
  const f=fixture(t,{timeoutMs:70});f.trigger.setAttribute('aria-controls','missing-upload-menu');
  const other=f.document.createElement('div');other.setAttribute('role','menu');const local=f.document.createElement('images-files-uploader');other.append(local);const input=f.fileInput(local,'.txt');f.document.body.append(other);
  await assert.rejects(f.manager.prepare(spec),/没有提供可用的 TXT 文件入口/);assert.equal(f.uploads.length,0);assert.equal(input.files.length,0);assert.equal(other.isConnected,true);assert.equal(f.editor.textContent,'原问题');
});

test('Gemini two newly opened independent upload menus remain ambiguous and dispatch no file',async t=>{
  const f=fixture(t,{onMenu(menu,_local,add){const other=menu.ownerDocument.createElement('div');other.setAttribute('role','menu');const local=menu.ownerDocument.createElement('images-files-uploader');other.append(local);add(local,'.txt');menu.ownerDocument.body.append(other);}});
  await assert.rejects(f.manager.prepare(spec),/当前上传菜单存在多个匹配/);assert.equal(f.uploads.length,0);assert.equal(f.drops,0);assert.equal(f.editor.textContent,'原问题');
});

test('Gemini inactive local upload capability cannot redirect to the other document input',async t=>{
  const f=fixture(t,{timeoutMs:70,onMenu(_menu,local){local.querySelector('input').disabled=true;}});
  await assert.rejects(f.manager.prepare(spec),/没有提供可用的 TXT 文件入口/);assert.equal(f.uploads.length,0);assert.equal(f.drops,0);assert.equal(f.editor.textContent,'原问题');
});

test('Gemini uses the explicitly labelled file-upload action when another active uploader also accepts TXT',async t=>{
  let imageInput;const f=fixture(t,{onMenu(menu,local,add){const fileAction=menu.ownerDocument.createElement('button');fileAction.setAttribute('role','menuitem');fileAction.setAttribute('aria-label','上传文件. 文档、数据、代码文件');fileAction.onclick=()=>local.querySelector('input').click();local.append(fileAction);
    const images=menu.ownerDocument.createElement('images-files-uploader'),imageAction=menu.ownerDocument.createElement('button');imageAction.setAttribute('role','menuitem');imageAction.setAttribute('aria-label','上传图片');images.append(imageAction);imageInput=add(images,'.txt,.png');menu.prepend(images);}});
  await f.manager.prepare(spec);assert.equal(f.uploads.length,1);assert.equal(imageInput.files.length,0);assert.equal(f.manager.isReady(spec),true);assert.equal(f.drops,0);
});

test('Gemini disabled native file-upload actions block dispatch even when their hidden input is enabled',async t=>{
  const f=fixture(t,{timeoutMs:70,onMenu(menu,local){const action=menu.ownerDocument.createElement('button');action.setAttribute('role','menuitem');action.setAttribute('aria-label','Upload files. Documents, data, code files');action.setAttribute('aria-disabled','true');local.append(action);}});
  await assert.rejects(f.manager.prepare(spec),/没有提供可用的 TXT 文件入口/);assert.equal(f.uploads.length,0);assert.equal(f.drops,0);assert.equal(f.editor.textContent,'原问题');
});

test('Gemini upload-menu initialization uses the existing total upload deadline',async t=>{
  const f=fixture(t,{delay:500,timeoutMs:60});await assert.rejects(f.manager.prepare(spec),/没有提供可用的 TXT 文件入口/);
  assert.equal(f.uploads.length,0);assert.equal(f.drops,0);assert.equal(f.trigger.getAttribute('aria-expanded'),'false');assert.equal(f.editor.textContent,'原问题');
});

function fileAction(local, select) {
  const action=local.ownerDocument.createElement('button');action.type='button';action.setAttribute('role','menuitem');action.setAttribute('aria-label','上传文件. 文档、数据、代码文件');action.onclick=select;local.append(action);return action;
}

test('Gemini waits for the file action when duplicate template inputs render first',async t=>{
  const f=fixture(t,{duplicate:true,timeoutMs:1000,onMenu(_menu,local){
    setTimeout(()=>fileAction(local,()=>local.querySelectorAll('input')[1].click()),50);
  }});
  await f.manager.prepare(spec);assert.equal(f.uploads.length,1);assert.equal(f.drops,0);assert.equal(f.manager.isReady(spec),true);
});

for(const label of ['文件','Files','File','本地文件'])test(`Gemini compact upload menu resolves the bare ${label} button beside cloud and photo actions`,async t=>{
  let target,calls=0;
  const f=fixture(t,{duplicate:true,onMenu(menu,local){
    target=local.querySelectorAll('input')[1];
    const action=fileAction(local,()=>{calls++;target.click();});
    action.removeAttribute('aria-label');action.removeAttribute('role');action.removeAttribute('type');
    action.innerHTML='<span><span role="img" aria-hidden="true">attach_file</span><span> '+label+' </span></span>';
    for(const name of ['云端硬盘','Google 相册','Notebooks']){
      const other=menu.ownerDocument.createElement('button');other.textContent=name;other.onclick=()=>{throw new Error('wrong upload action');};menu.append(other);
    }
  }});
  const user=f.card('user.txt'),uploaded=await f.manager.prepare(spec);
  assert.equal(calls,1);assert.equal(target.files[0].name,uploaded.name);assert.equal(f.uploads.length,1);assert.equal(f.drops,0);
  assert.equal(f.manager.isReady(spec),true);await f.manager.clear();assert.deepEqual(f.removes,[uploaded.name]);assert.equal(user.outer.isConnected,true);assert.equal(f.editor.textContent,'原问题');
});

test('two compact file actions remain ambiguous instead of choosing the first',async t=>{
  let calls=0;
  const f=fixture(t,{timeoutMs:100,duplicate:true,onMenu(menu,local){
    for(let i=0;i<2;i++){const action=fileAction(local,()=>calls++);action.setAttribute('aria-label','文件');}
  }});
  await assert.rejects(f.manager.prepare(spec),/上传操作存在多个匹配/);assert.equal(calls,0);assert.equal(f.uploads.length,0);
});

test('a disabled compact file action cannot fall back to an enabled template input',async t=>{
  const f=fixture(t,{timeoutMs:100,onMenu(_menu,local){const action=fileAction(local,()=>local.querySelector('input').click());action.setAttribute('aria-label','文件');action.disabled=true;}});
  await assert.rejects(f.manager.prepare(spec),/没有提供可用的 TXT 文件入口/);assert.equal(f.uploads.length,0);
});

for(const mode of ['labelledby','text-with-icon','punctuation','outside-component'])test(`Gemini shares semantic action resolution for ${mode}`,async t=>{
  let target;
  const f=fixture(t,{duplicate:true,onMenu(menu,local){
    target=local.querySelectorAll('input')[1];const action=fileAction(local,()=>target.click());
    if(mode==='labelledby'){
      action.removeAttribute('aria-label');action.setAttribute('aria-labelledby','file-action-name');
      const label=menu.ownerDocument.createElement('span');label.id='file-action-name';label.textContent='选择文件';menu.append(label);
    }
    if(mode==='text-with-icon'){
      action.removeAttribute('aria-label');action.innerHTML='<span role="img" aria-hidden="true">attach_file</span><span>上传文件</span>';
    }
    if(mode==='punctuation')action.setAttribute('aria-label','  上传文件：文档、数据、代码文件  ');
    if(mode==='outside-component'){menu.append(action);const wrapper=menu.ownerDocument.createElement('section');wrapper.append(...local.childNodes);local.replaceWith(wrapper);}
  }});
  const uploaded=await f.manager.prepare(spec);assert.equal(target.files[0].name,uploaded.name);assert.equal(f.uploads.length,1);assert.equal(f.drops,0);
  assert.equal(f.manager.isReady(spec),true);await f.manager.clear();assert.deepEqual(f.removes,[uploaded.name]);assert.equal(f.editor.textContent,'原问题');
});

test('Gemini follows the native action-created input despite template and retained picker inputs, and coalesces preparation',async t=>{
  let calls=0;const retained=[],selected=[],cancelled=[];
  const f=fixture(t,{duplicate:true,onMenu(_menu,local,add){retained.push(...local.querySelectorAll('input'));fileAction(local,()=>{calls++;const input=add(local,'');input.setAttribute('aria-hidden','true');input.style.display='none';input.onclick=event=>cancelled.push(event.defaultPrevented);selected.push(input);input.click();});}});
  const [first,repeated]=await Promise.all([f.manager.prepare(spec),f.manager.prepare(spec)]);
  assert.deepEqual(repeated,first);assert.equal(calls,1);assert.equal(f.clicks,1);assert.equal(f.uploads.length,1);assert.equal(selected[0].files[0].name,first.name);assert.equal(selected[0].files[0].size,Buffer.byteLength(spec.content));assert.deepEqual(cancelled,[true]);
  assert.ok(retained.every(input=>input.files.length===0));assert.equal(f.drops,0);assert.equal(f.manager.isReady(spec),true);assert.equal(f.editor.textContent,'原问题');
  await f.manager.prepare(spec);assert.equal(calls,1);await f.manager.clear();assert.deepEqual(f.removes,[first.name]);
  const retry=await f.manager.prepare(spec);assert.notEqual(retry.name,first.name);assert.equal(calls,2);assert.equal(f.uploads.length,2);assert.equal(selected[1].files[0].name,retry.name);assert.equal(selected[0].files[0].name,first.name);assert.ok(retained.every(input=>!input.files.length));
});

test('Gemini uses the input actually clicked by the native file action and leaves a preselected user input untouched',async t=>{
  let userInput,target,calls=0;const f=fixture(t,{duplicate:true,onMenu(_menu,local){[userInput,target]=local.querySelectorAll('input');userInput.files=[new local.ownerDocument.defaultView.File(['User file'],'user.txt')];fileAction(local,()=>{calls++;target.click();});}}),user=f.card('user.txt');
  const uploaded=await f.manager.prepare(spec);assert.equal(calls,1);assert.equal(target.files[0].name,uploaded.name);assert.equal(userInput.files[0].name,'user.txt');assert.equal(f.uploads.length,1);
  await f.manager.clear();assert.equal(user.outer.isConnected,true);assert.deepEqual(f.removes,[uploaded.name]);assert.equal(userInput.files[0].name,'user.txt');
});

test('Gemini file actions can initialize their only native input on demand',async t=>{
  const f=fixture(t,{onMenu(_menu,local,add){local.replaceChildren();fileAction(local,()=>add(local,'.txt').click());}});
  await f.manager.prepare(spec);assert.equal(f.uploads.length,1);assert.equal(f.manager.isReady(spec),true);assert.equal(f.drops,0);
});

test('Gemini nested uploader components do not duplicate the same native file action',async t=>{
  const f=fixture(t,{duplicate:true,onMenu(menu,local){const parent=menu.ownerDocument.createElement('images-files-uploader');parent.append(local);menu.append(parent);fileAction(local,()=>local.querySelectorAll('input')[1].click());}});
  await f.manager.prepare(spec);assert.equal(f.uploads.length,1);assert.equal(f.manager.isReady(spec),true);
});

test('Gemini two enabled document actions remain ambiguous without activating either action',async t=>{
  let calls=0;const f=fixture(t,{onMenu(menu,local,add){fileAction(local,()=>{calls++;local.querySelector('input').click();});const other=menu.ownerDocument.createElement('images-files-uploader');const input=add(other,'.txt');fileAction(other,()=>{calls++;input.click();});menu.append(other);}});
  await assert.rejects(f.manager.prepare(spec),/上传操作存在多个匹配（2 个）/);assert.equal(calls,0);assert.equal(f.uploads.length,0);assert.equal(f.drops,0);assert.equal(f.editor.textContent,'原问题');
});

for(const mode of ['none','multiple','image','outside','detached'])test(`Gemini an unconfirmed native file action (${mode}) stops before dispatch and releases the picker listener`,async t=>{
  let blocked=[];const f=fixture(t,{onMenu(_menu,local,add){fileAction(local,()=>{
    if(mode==='none')return;
    const container=mode==='outside'?local.ownerDocument.body:local,input=add(container,mode==='image'?'image/*':'.txt');input.onclick=event=>blocked.push(event.defaultPrevented);input.click();
    if(mode==='multiple')add(local,'.txt').click();if(mode==='detached')input.remove();
  });}});
  await assert.rejects(f.manager.prepare(spec),/调用了多个文件入口|没有提供可确认的 TXT 文件入口/);assert.equal(f.uploads.length,0);assert.equal(f.drops,0);assert.equal(f.editor.textContent,'原问题');assert.equal(f.trigger.getAttribute('aria-expanded'),'false');
  if(mode!=='none')assert.deepEqual(blocked,[true]);
  const after=f.document.createElement('input');after.type='file';f.document.body.append(after);let prevented=true;after.onclick=event=>{prevented=event.defaultPrevented;};after.click();assert.equal(prevented,false);
});

for(const change of ['abort','draft','session','editor'])test(`Gemini native file-action resolution cancels ${change} before assigning any file`,async t=>{
  const controller=new AbortController();let current=true;
  const f=fixture(t,{onMenu(_menu,local,add){fileAction(local,()=>{const input=add(local,'.txt');input.click();
    if(change==='abort')controller.abort();if(change==='draft'){f.editor.textContent='修改后的问题';current=false;}if(change==='session')f.editor.setAttribute('data-conversation-id','new');if(change==='editor')f.editor.replaceWith(f.editor.cloneNode(true));
  });}});
  await assert.rejects(f.manager.prepare(spec,{signal:controller.signal,isCurrent:()=>current}),/修改|取消/);assert.equal(f.uploads.length,0);assert.equal(f.drops,0);assert.equal(f.adapter.readDraft(f.adapter.findComposer()),change==='draft'?'修改后的问题':'原问题');assert.equal(f.trigger.getAttribute('aria-expanded'),'false');
});
