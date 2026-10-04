import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createWebAdapter } from '../src/content/adapters.js';
import { createGenericAttachmentDriver } from '../src/content/generic-attachments.js';
import { normalizeCustomAISite } from '../src/ai-web.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const spec = { name: '网页正文.txt', content: '完整正文\nUTF-8中文尾部。', mimeType: 'text/plain' };
const x = '<svg viewBox="0 0 10 10"><path d="M0 0L10 10M0 10L10 0"></path></svg>';
function mockClose(svg) {
  const shape = svg.querySelector('path');
  shape.getTotalLength = () => 2;
  shape.getPointAtLength = length => length <= 1 ? {x: length * 10, y: length * 10} : {x: (length - 1) * 10, y: (2 - length) * 10};
}

function fixture(t, { onDrop, timeoutMs = 1500, input = true, dropzone = false, selectors, url = 'https://arbitrary-ai.test/chat' } = {}) {
  const { window } = new JSDOM(`<main><section id="dock"><div id="files"></div><div id="shell"><textarea placeholder="Message">原问题</textarea>${input ? '<input type="file" accept=".txt,.pdf,.png">' : ''}<button type="button" aria-label="Send">↑</button></div></section><div id="bar-out"></div></main>`, {url, pretendToBeVisual:true});
  window.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{width:300,height:60}] : []; };
  window.DataTransfer = class { constructor() { this.files=[]; this.items={add:file=>this.files.push(file)}; } };
  window.DragEvent = class extends window.MouseEvent { constructor(type, options) { super(type, options); this.dataTransfer=options.dataTransfer; } };
  const document = window.document, editor = document.querySelector('textarea'), area = document.querySelector('#files');
  editor.getBoundingClientRect = () => ({left:20,top:40,width:200,height:80});
  if (dropzone) document.querySelector('#shell').setAttribute('data-dropzone','');
  const site = normalizeCustomAISite({id:'custom-file-fixture-01',name:'Arbitrary AI',url,selectors});
  const adapter=createWebAdapter(document,site), driver=createGenericAttachmentDriver(document,adapter);
  const uploads=[], removes=[], events=[]; let inputChanges=0;
  document.querySelector('input')?.addEventListener('change',()=>inputChanges++);
  function addCard(name,{ready=false,close='label',removeWorks=true,state='',status='Uploading...'}={}) {
    const card=document.createElement('div'); card.className='opaque-card';
    if(state)card.dataset.state=state;
    const filename=document.createElement('div');filename.textContent=name;card.append(filename);
    const detail=document.createElement('div');detail.textContent=ready?'TXT 44B':status;card.append(detail);
    const remove=document.createElement(close==='icon'?'div':'button');
    if(close==='icon'){remove.tabIndex=0;remove.insertAdjacentHTML('beforeend',x);mockClose(remove.querySelector('svg'));}
    else{remove.type='button';remove.setAttribute('aria-label',`Remove ${name}`);}
    remove.addEventListener('click',()=>{removes.push(name);if(removeWorks)card.remove();});card.append(remove);area.append(card);
    const markReady=()=>{detail.textContent='TXT 44B';card.removeAttribute('data-state');};
    return {card,filename,detail,remove,markReady};
  }
  for(const node of [editor,document.querySelector('#shell'),document])for(const type of ['dragenter','dragover','drop'])node.addEventListener(type,event=>{
    events.push({node:node===editor?'editor':node===document?'document':'shell',type,target:event.target,x:event.clientX,y:event.clientY});
    event.preventDefault();
    if(node===document&&type==='drop'){const file=event.dataTransfer.files[0];uploads.push(file);if(onDrop)onDrop(file,addCard,window);else addCard(file.name,{ready:true});}
  });
  const manager=adapter.createAttachmentManager({timeoutMs});
  t.after(async()=>{await manager.dispose();window.close();});
  return {window,document,editor,area,adapter,driver,manager,uploads,removes,events,addCard,get inputChanges(){return inputChanges;}};
}

test('custom native attachment capability is detected without a hostname adapter, including explicit drop zones',t=>{
  const first=fixture(t), second=fixture(t,{input:false,dropzone:true,url:'https://another-ai.test/'}), third=fixture(t,{input:false});
  assert.equal(first.adapter.supportsAttachments(),true);assert.equal(second.adapter.supportsAttachments(),true);assert.equal(third.adapter.supportsAttachments(),false);
  second.document.querySelector('#shell').removeAttribute('data-dropzone');
  second.document.querySelector('#dock').setAttribute('data-drop-zone','');assert.equal(second.adapter.supportsAttachments(),true);
  first.document.querySelector('input').accept='image/*';assert.equal(first.adapter.supportsAttachments(),false);
  second.window.DragEvent=undefined;assert.equal(second.adapter.supportsAttachments(),false);
});

test('generic TXT upload drops once at the editor center and reaches nearby and fullscreen handlers without using change',async t=>{
  const f=fixture(t);const result=await f.manager.prepare(spec);
  assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].name,result.name);assert.match(result.name,/-sider-[a-f0-9]{16}\.txt$/);
  assert.equal(f.uploads[0].type,'text/plain');assert.equal(f.uploads[0].size,Buffer.byteLength(spec.content));assert.equal(f.inputChanges,0);
  assert.equal(f.events.length,9);for(const event of f.events){assert.equal(event.target,f.editor);assert.equal(event.x,120);assert.equal(event.y,80);}
  assert.equal(f.manager.isReady(spec),true);assert.equal(f.editor.value,'原问题');
});

test('manual reference-bar placement outside the composer does not disable native TXT uploads',async t=>{
  const f=fixture(t,{selectors:{composer:'textarea',send:'button[aria-label=Send]',mount:'#bar-out'}});
  assert.equal(f.adapter.findMountAnchor().id,'bar-out');assert.equal(f.adapter.supportsAttachments(),true);
  const user=f.addCard('user.png',{ready:true});await f.manager.prepare(spec);await f.manager.clear();
  assert.equal(f.uploads.length,1);assert.equal(f.removes.length,1);assert.equal(user.card.isConnected,true);
});

test('generic upload waits for positive file metadata even if the progress label disappears',async t=>{
  let card;const f=fixture(t,{onDrop(file,add){card=add(file.name);}});let finished=false;
  const pending=f.manager.prepare(spec).then(result=>{finished=true;return result;});await pause(20);
  assert.equal(finished,false);card.detail.textContent='';await pause(20);assert.equal(finished,false);
  card.markReady();await pending;assert.equal(finished,true);assert.equal(f.manager.isReady(spec),true);
});

test('metadata still waits for parsing and an enabled native Send control',async t=>{
  let card;const f=fixture(t,{onDrop(file,add){card=add(file.name,{ready:true,state:'processing'});}});
  const pending=f.manager.prepare(spec);await pause(20);assert.equal(f.manager.isReady(spec),false);
  const send=f.document.querySelector('[aria-label=Send]');send.classList.add('is-disabled');card.card.removeAttribute('data-state');await pause(20);
  assert.equal(f.manager.isReady(spec),false);send.classList.remove('is-disabled');await pending;
  assert.equal(f.manager.isReady(spec),true);
});

test('an unlabeled SVG close glyph is used only within its single filename-bearing card',async t=>{
  const f=fixture(t,{onDrop(file,add){add(file.name,{ready:true,close:'icon'});}});const user=f.addCard('user.png',{ready:true,close:'icon'});
  const result=await f.manager.prepare(spec);await f.manager.clear();assert.deepEqual(f.removes,[result.name]);assert.equal(user.card.isConnected,true);
});

test('explicit ready state and separated native type/size fields are positive completion evidence',async t=>{
  for(const mode of ['state','split']){
    const f=fixture(t,{onDrop(file,add){const c=add(file.name,{status:''});if(mode==='state')c.card.dataset.status='complete';else{c.detail.textContent='TXT';const size=f.document.createElement('span');size.textContent='1.2 KB';c.card.append(size);}}});
    await f.manager.prepare(spec);assert.equal(f.manager.isReady(spec),true);
  }
});

test('decimal native file sizes are completion metadata rather than extra filenames',async t=>{
  for(const status of ['TXT 25.75KB','TXT 1.25 MB','TXT 25,75KB','text/plain · 0.5 KiB']){
    const f=fixture(t,{onDrop(file,add){add(file.name,{status});}});const user=f.addCard('user.png',{ready:true});
    const uploaded=await f.manager.prepare(spec);assert.equal(f.manager.isReady(spec),true);assert.equal(f.driver.cards(f.area).length,2);
    await f.manager.clear();assert.deepEqual(f.removes,[uploaded.name]);assert.equal(user.card.isConnected,true);
  }
});

test('clickable native preview ancestors retain upload status and completion metadata',async t=>{
  let card;const f=fixture(t,{onDrop(file,add){card=add(file.name,{close:'icon'});const preview=f.document.createElement('div');preview.tabIndex=0;card.card.replaceWith(preview);preview.append(card.card);}});
  let completed=false;const pending=f.manager.prepare(spec).then(result=>{completed=true;return result;});await pause(20);assert.equal(completed,false);
  card.detail.textContent='TXT 25.75KB';const uploaded=await pending;assert.equal(f.manager.isReady(spec),true);
  await f.manager.clear();assert.deepEqual(f.removes,[uploaded.name]);assert.equal(f.editor.value,'原问题');
});

test('generic failures report native reasons, clean only the owned file and never switch upload routes',async t=>{
  for(const state of ['', 'failed']){
    const f=fixture(t,{onDrop(file,add){add(file.name,{state,status:'Upload failed: unsupported file.'});}});const user=f.addCard('user.txt',{ready:true});
    await assert.rejects(f.manager.prepare(spec),/unsupported file/);assert.equal(f.uploads.length,1);assert.equal(f.inputChanges,0);
    assert.equal(f.removes.length,1);assert.equal(user.card.isConnected,true);assert.equal(f.editor.value,'原问题');
  }
});

test('filenames containing failure words or action verbs are data rather than status',async t=>{
  const f=fixture(t);const result=await f.manager.prepare({...spec,name:'Remove Upload failed 文档.txt'});
  assert.equal(f.manager.isReady({...spec,name:'Remove Upload failed 文档.txt'}),true);await f.manager.clear();assert.deepEqual(f.removes,[result.name]);
});

test('same pending and ready custom attachment is reused without a second drop',async t=>{
  let card;const f=fixture(t,{onDrop(file,add){card=add(file.name);}});
  const first=f.manager.prepare(spec), second=f.manager.prepare(spec);await pause(10);card.markReady();
  const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);await f.manager.prepare(spec);assert.equal(f.uploads.length,1);
});

test('cancelling a pending generic upload removes only the owned card and preserves the draft',async t=>{
  const f=fixture(t,{onDrop(file,add){add(file.name);}});const user=f.addCard('user.txt',{ready:true}),abort=new AbortController();
  const pending=f.manager.prepare(spec,{signal:abort.signal});await pause(15);abort.abort();
  await assert.rejects(pending,/取消/);assert.equal(f.removes.length,1);assert.equal(user.card.isConnected,true);assert.equal(f.editor.value,'原问题');
});

test('generic cleanup failures retain the ownership record and prohibit a second upload until the card is gone',async t=>{
  let card;const f=fixture(t,{timeoutMs:65,onDrop(file,add){card=add(file.name,{removeWorks:false});}});
  await assert.rejects(f.manager.prepare(spec),/取消正文附件超时/);
  await assert.rejects(f.manager.prepare({...spec,content:'Changed'}),/取消正文附件超时/);assert.equal(f.uploads.length,1);assert.equal(f.removes.length,1);
  card.card.remove();await f.manager.clear();assert.equal(f.editor.value,'原问题');
});

test('a late generic owned card is cleaned in the original composer without claiming a user file',async t=>{
  const f=fixture(t,{timeoutMs:65,onDrop(){}});const user=f.addCard('网页正文.txt',{ready:true});
  // Use a different logical name so the unrelated user file is a baseline card.
  const request={...spec,name:'late.txt'};await assert.rejects(f.manager.prepare(request),/取消正文附件超时/);
  const owned=f.addCard(f.uploads[0].name,{ready:true});await pause(50);
  assert.equal(owned.card.isConnected,false);assert.equal(user.card.isConnected,true);await f.manager.clear();
});

test('card discovery refuses ambiguous delete controls and a shared multi-file remove container',t=>{
  const f=fixture(t);const card=f.addCard('one.txt',{ready:true});card.card.append(card.remove.cloneNode(true));
  assert.equal(f.driver.cards(f.area).length,0);
  card.card.querySelector('button:last-child').remove();const other=f.document.createElement('span');other.textContent='user.png';card.card.append(other);
  assert.equal(f.driver.cards(f.area).length,0);
});

test('a form submit control is never clicked as an attachment remove action',t=>{
  const f=fixture(t);const c=f.addCard('one.txt',{ready:true});const form=f.document.createElement('form');f.area.append(form);form.append(c.card);c.remove.type='submit';
  assert.equal(f.driver.cards(f.area).length,0);assert.equal(f.driver.removeButton(c.card),null);
});

test('changing conversations during a pending generic upload preserves attachments in the new conversation',async t=>{
  let old;const f=fixture(t,{onDrop(file,add){old=add(file.name);}});const pending=f.manager.prepare(spec);
  await pause(15);f.editor.dataset.conversationId='new';old.card.remove();const replacement=f.addCard(f.uploads[0].name,{ready:true});
  await assert.rejects(pending,/会话已切换/);assert.equal(replacement.card.isConnected,true);assert.deepEqual(f.removes,[]);
});

function nativeUploadMenu(f, { delay = 0, direct = false, disabled = false, duplicate = false, fail = false, onAction, compact = false } = {}) {
  const trigger=f.document.createElement('button');trigger.type='button';trigger.setAttribute('aria-label',direct?'Upload file':'Attachments');
  if(!direct){trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls','native-upload-menu');}
  f.editor.parentElement.append(trigger);
  let calls=0,changes=0,pickerCancelled=false,target,retained,menu;
  const action=()=>{
    calls++;target=f.document.createElement('input');target.type='file';target.hidden=true;target.accept='.txt';
    let files=[];Object.defineProperty(target,'files',{get:()=>files,set:value=>{files=value;}});
    target.onclick=event=>{pickerCancelled=event.defaultPrevented;};
    target.onchange=()=>{changes++;f.addCard(files[0].name,fail?{status:'Upload failed: test rejection'}:{ready:true});};
    (direct?f.editor.parentElement:menu).append(target);target.click();onAction?.();
  };
  if(direct)trigger.onclick=action;
  else trigger.onclick=()=>{
    if(trigger.getAttribute('aria-expanded')==='true'){trigger.setAttribute('aria-expanded','false');menu?.remove();return;}
    trigger.setAttribute('aria-expanded','true');menu=f.document.createElement('div');menu.id='native-upload-menu';menu.setAttribute('role','menu');
    menu.innerHTML='<input type="file" accept=".txt" hidden><input type="file" accept="text/plain" hidden>';
    retained=[...menu.querySelectorAll('input')];f.document.body.append(menu);
    f.window.setTimeout(()=>{
      const button=f.document.createElement('div');button.setAttribute('role','menuitem');
      if(compact)button.innerHTML='<span aria-hidden="true">attach_file</span><span> Files </span>';
      else button.setAttribute('aria-label','Upload file: Documents');button.onclick=action;
      if(disabled)button.setAttribute('aria-disabled','true');menu.append(button);
      if(duplicate){const other=button.cloneNode(true);other.onclick=action;menu.append(other);}
    },delay);
  };
  return {trigger,get menu(){return menu;},get calls(){return calls;},get changes(){return changes;},get target(){return target;},get retained(){return retained;},get pickerCancelled(){return pickerCancelled;}};
}

test('custom sites use the same lazy semantic upload route with multiple hidden inputs and no drag support',async t=>{
  const f=fixture(t,{input:false}),native=nativeUploadMenu(f,{delay:30});f.window.DragEvent=undefined;
  const user=f.addCard('user.txt',{ready:true});assert.equal(f.adapter.supportsAttachments(),true);
  const [a,b]=await Promise.all([f.manager.prepare(spec),f.manager.prepare(spec)]);assert.deepEqual(a,b);
  assert.equal(native.calls,1);assert.equal(native.changes,1);assert.equal(native.pickerCancelled,true);assert.equal(f.events.length,0);
  assert.equal(native.target.files[0].name,a.name);assert.equal(native.target.files[0].size,Buffer.byteLength(spec.content));
  assert.ok(native.retained.every(input=>input.files.length===0));assert.equal(f.manager.isReady(spec),true);
  await f.manager.clear();assert.deepEqual(f.removes,[a.name]);assert.equal(user.card.isConnected,true);assert.equal(f.editor.value,'原问题');
});

test('a generic direct file action resolves its dynamically created input without a menu',async t=>{
  const f=fixture(t,{input:false}),native=nativeUploadMenu(f,{direct:true});
  const result=await f.manager.prepare(spec);assert.equal(native.target.files[0].name,result.name);assert.equal(native.changes,1);assert.equal(f.events.length,0);
});

test('custom sites share compact file actions only inside their bound upload menu',async t=>{
  const f=fixture(t,{input:false}),native=nativeUploadMenu(f,{compact:true});let unrelated=0;
  const outside=f.document.createElement('button');outside.type='button';outside.textContent='Files';outside.onclick=()=>unrelated++;f.editor.parentElement.append(outside);
  const other=f.document.createElement('div');other.setAttribute('role','menu');const copy=outside.cloneNode(true);copy.onclick=()=>unrelated++;other.append(copy);f.document.body.append(other);
  const uploaded=await f.manager.prepare(spec);assert.equal(native.target.files[0].name,uploaded.name);
  assert.equal(native.calls,1);assert.equal(unrelated,0);assert.equal(f.events.length,0);assert.equal(f.manager.isReady(spec),true);
});

test('a bare Files button outside an upload menu does not claim native upload capability',t=>{
  const f=fixture(t,{input:false});const button=f.document.createElement('button');button.type='button';button.textContent='Files';f.editor.parentElement.append(button);
  assert.equal(f.adapter.supportsAttachments(),false);
});

for(const mode of ['disabled','duplicate','cancel'])test(`generic native upload ${mode} preserves the question without dropping or choosing an input`,async t=>{
  const f=fixture(t,{input:false,timeoutMs:140}),native=nativeUploadMenu(f,{disabled:mode==='disabled',duplicate:mode==='duplicate',delay:mode==='cancel'?80:0});
  const controller=new AbortController();const pending=f.manager.prepare(spec,{signal:controller.signal});
  if(mode==='cancel'){await pause(20);controller.abort();}
  await assert.rejects(pending,/没有提供可用|多个匹配|取消/);
  assert.equal(native.calls,0);assert.equal(native.changes,0);assert.equal(f.events.length,0);assert.equal(f.editor.value,'原问题');assert.equal(native.trigger.getAttribute('aria-expanded'),'false');
});

test('a failed generic input upload never retries through drag and cleans only its own card',async t=>{
  const f=fixture(t,{input:false}),native=nativeUploadMenu(f,{fail:true}),user=f.addCard('user.txt',{ready:true});
  await assert.rejects(f.manager.prepare(spec),/test rejection/);assert.equal(native.calls,1);assert.equal(native.changes,1);assert.equal(f.events.length,0);
  assert.equal(f.removes.length,1);assert.equal(user.card.isConnected,true);assert.equal(f.editor.value,'原问题');
});
