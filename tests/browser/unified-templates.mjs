import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from './browser.js';
import { newTemplate } from '../../src/prompt-templates.js';

const nativeFixture = rich => String.raw`<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:14px system-ui}main{padding:14px;min-height:680px;display:flex;flex-direction:column;justify-content:center}.shell{border:1px solid #ddd;border-radius:16px;padding:12px}textarea,[contenteditable]{box-sizing:border-box;width:100%;min-height:90px;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}[data-composer-attachments]{display:flex;flex-wrap:wrap;gap:5px}.card{border:1px solid #ddd;padding:4px;overflow-wrap:anywhere;max-width:100%}button{font:inherit}</style>
<main><div class="shell"><form><div data-composer-body>${rich ? '<div id="prompt-textarea" class="ProseMirror" role="textbox" aria-label="Ask ChatGPT" contenteditable="true"><p><br></p></div>' : '<textarea id="prompt-textarea" aria-label="Ask ChatGPT"></textarea>'}</div><div data-composer-attachments></div><input type="file" aria-label="Attach files" accept="text/plain,.txt" hidden><button data-testid="send-button" type="submit" aria-label="Send prompt">发送</button></form></div></main>
<script>
window.sent=[];window.uploads=[];window.hold=false;window.release=[];window.failNext=false;
const editor=document.querySelector('#prompt-textarea'),area=document.querySelector('[data-composer-attachments]');
const text=()=>editor.tagName==='TEXTAREA'?editor.value:editor.innerText;
document.querySelector('input[type=file]').addEventListener('change',event=>{for(const file of event.target.files){
const item={name:file.name,content:null,ready:false};uploads.push(item);
const card=document.createElement('div');card.className='group/composer-attachment card';card.item=item;
const progress=document.createElement('span');progress.setAttribute('role','progressbar');progress.setAttribute('aria-label','Uploading '+file.name);
const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove '+file.name);remove.textContent='×';remove.onclick=()=>card.remove();card.append(progress,remove);area.append(card);
const failure=failNext;failNext=false;
void(async()=>{item.content=await file.text();if(hold)await new Promise(resolve=>release.push(resolve));else await new Promise(resolve=>setTimeout(resolve,100));if(!card.isConnected)return;progress.remove();if(failure){const alert=document.createElement('span');alert.setAttribute('role','alert');alert.textContent='fixture upload failed';card.append(alert)}else{item.ready=true;const label=document.createElement('button');label.type='button';label.setAttribute('aria-label',file.name);label.textContent=file.name;card.prepend(label)}})();
}event.target.value='';});
document.querySelector('form').onsubmit=event=>{event.preventDefault();sent.push({text:text(),files:[...area.children].map(card=>card.item),pending:area.querySelectorAll('[role=progressbar]').length})};
editor.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();document.querySelector('form').requestSubmit()}});
</script>`;
await mkdir('tmp/browser', { recursive: true });
const tls = httpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, (req,res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(nativeFixture(req.url.startsWith('/c/rich'))); });
const article = httpServer((_req,res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>预设合并来源</title><main><article><h1>预设合并来源</h1><p id="selection">选中的示例文字</p><p id="dynamic">' + '正文资料与关键事实。'.repeat(2200) + ' FULL-END-MARKER</p></article></main>'); });
await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve)); await new Promise(resolve=>article.listen(0,'127.0.0.1',resolve));
let context, panel;
const checks=[], results={ fixtureOnly:true, trustedInteraction:true }, errors=[];
const checked = message => { checks.push(message); console.log('PASS '+message); };
async function eventually(check) { const until=Date.now()+10000; for(;;){try{return await check()}catch(error){if(Date.now()>until)throw error;await new Promise(resolve=>setTimeout(resolve,50))}} }
try {
 const extension=path.resolve('dist'); context=await chromium.launchPersistentContext(path.resolve('tmp/browser/unified-profile-'+Date.now()),{ ...(process.env.SIDER_CHROMIUM?{executablePath:process.env.SIDER_CHROMIUM}:{}),headless:true,ignoreHTTPSErrors:true,viewport:{width:420,height:840},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--enable-unsafe-extension-debugging',`--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${tls.address().port}`,'--no-proxy-server','--ignore-certificate-errors'] });
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),extensionId=new URL(worker.url()).hostname;
 await worker.evaluate(()=>chrome.storage.local.clear());await worker.evaluate(()=>chrome.storage.session.clear());
 // Start from old settings to verify the real worker migration, including backups.
 await worker.evaluate(()=>chrome.storage.local.set({'sider.contextSettings.v1':{defaultSelection:false,defaultUrl:true,pageTemplate:'原正文 {{content}}',pagePosition:'prepend',pageMode:'auto',pageThreshold:12000,pageAttachmentTemplate:'旧附件 {{filename}}'},'sider.promptTemplates.v1':[{id:'legacy-fixture-001',name:'旧预设',text:'旧提示 {{title}}',directSend:false}]}));
 const source=await context.newPage(),sourceURL=`http://127.0.0.1:${article.address().port}/article`;await source.goto(sourceURL);await source.bringToFront();
 const cdp=await context.browser().newBrowserCDPSession(),targets=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false}]});
 await cdp.send('Extensions.triggerAction',{id:extensionId,targetId:targets.targetInfos.find(item=>item.url===sourceURL).targetId});
 const tab=await worker.evaluate(async()=> (await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0]);
 panel=await context.newPage();panel.on('pageerror',error=>errors.push(error.message));await panel.goto(`chrome-extension://${extensionId}/panel.html?sourceTab=${tab.id}`);
 let chat=panel.frameLocator('iframe');await chat.locator('#sider-enhancement').waitFor();
 const message=value=>panel.evaluate(async value=>chrome.runtime.sendMessage(value),value);
 const exported=()=>message({type:'SIDER_CONFIGURATION_EXPORT'});
 let backup=(await exported()).backup,templates=backup.configuration.templates;
 assert.equal(templates.length,4);assert.equal(templates[2].position,'prepend');assert.equal(templates[2].threshold,12000);assert.equal(templates[2].attachmentText,'旧附件 {{filename}}');assert.equal(templates[3].action,'append');
 const archive=await worker.evaluate(()=>chrome.storage.local.get(['sider.contextSettings.v1','sider.promptTemplates.v1']));assert.equal(archive['sider.promptTemplates.v1'].length,1);checked('real worker migrates old formats, positions, defaults and attachment notes once; v3 backup preserves legacy archives');
 templates=templates.map(item=>({...item,defaultIncluded:false}));
 const first=newTemplate({id:'fixture-file-first',name:'正文一',text:'总结第一份网页材料。\n<attachment>{{content}}</attachment>',position:'prepend',delivery:'file',action:'append'});
 const second=newTemplate({id:'fixture-file-second',name:'正文二',text:'核对第二份网页材料。\n<attachment>{{content}}</attachment>\n按事实回答。',delivery:'file',action:'append',attachmentText:'第二份文件：{{filename}}'});
 const fill=newTemplate({id:'fixture-fill-item',name:'追加快照',text:'快照 <attachment>{{content}}</attachment>',delivery:'file',action:'append'});
 const direct=newTemplate({id:'fixture-direct-item',name:'立即提问',text:'直接提问 {{title}}',action:'send',position:'prepend'});
 const replacement=newTemplate({id:'fixture-replace-item',name:'替换预设',text:'替换后总结。\n<attachment>{{content}}</attachment>\n中文回答。',delivery:'file',action:'replace'});
 templates.push(first,second,fill,direct,replacement);
 const saved=await message({type:'SIDER_CONFIGURATION_IMPORT',backup:{...backup,configuration:{...backup.configuration,templates}},expected:backup.configuration});assert.equal(saved.ok,true,saved.error);
 await message({type:'SIDER_TAB_ATTACHMENT_SET',tabId:tab.id,kind:'url',enabled:false});
 await worker.evaluate(()=>{const send=chrome.tabs.sendMessage.bind(chrome.tabs);globalThis.captureCount=0;chrome.tabs.sendMessage=async(...args)=>{if(args[1]?.type==='SIDER_PAGE_CAPTURE')captureCount++;return send(...args)}});
 const editor=chat.locator('#prompt-textarea'),body=chat.locator('body');
 const fixture=()=>body.evaluate(()=>({sent:window.sent,uploads:window.uploads}));
 async function menu(){if(await chat.locator('.popover').evaluate(node=>node.hidden||node.inert))await chat.locator('[data-pane="templates"]').click();}
 async function invoke(id){await menu();await chat.locator(`#pane-body [data-template-id="${id}"]`).click();}
 async function select(id,enabled=true){await menu();await chat.locator(`#pane-body [data-template-id="${id}"]`).locator('..').locator('input[type=checkbox]').setChecked(enabled);}
 assert.equal(await chat.locator('[data-pane="references"]').count(),0);assert.equal(await chat.locator('[data-pane="settings"]').count(),0);
 await menu();await chat.getByRole('button',{name:'编辑预设 旧预设',exact:true}).click();await chat.locator('#template-name').fill('修改后的旧预设');await chat.locator('#template-position').selectOption('prepend');await chat.getByRole('button',{name:'保存预设',exact:true}).click();
 await eventually(async()=>assert.equal((await exported()).backup.configuration.templates.find(item=>item.id==='legacy-fixture-001').name,'修改后的旧预设'));checked('one entrance edits each template and its position without touching the native draft');
 assert.equal((await exported()).backup.version,3);
  // Actual pointer events save the order, and Escape cancels a pending change.
 const order=async()=>(await exported()).backup.configuration.templates.map(item=>item.id);
 const originalOrder=await order();
 const firstHandle=chat.locator('[data-sort-id="'+originalOrder[0]+'"] [data-sort-handle]');
 const from=await firstHandle.boundingBox(),target=await chat.locator('[data-sort-id="'+originalOrder[2]+'"]').boundingBox();
  assert.equal(await chat.getByRole('button',{name:/^(上移|下移)预设 /}).count(),0);
  await panel.mouse.move(from.x+from.width/2,from.y+from.height/2);await panel.mouse.down();await panel.mouse.move(target.x+20,target.y+target.height-2,{steps:10});
  assert.equal(await chat.getByRole('button',{name:'编辑预设 划词',exact:true}).evaluate(node=>getComputedStyle(node).cursor),'default');await panel.mouse.up();
 const moved=[originalOrder[1],originalOrder[2],originalOrder[0],...originalOrder.slice(3)];await eventually(async()=>assert.deepEqual(await order(),moved));
  const movedFrom=await firstHandle.boundingBox(),restoreTarget=await chat.locator('[data-sort-id="'+originalOrder[1]+'"]').boundingBox();
  await panel.mouse.move(movedFrom.x+movedFrom.width/2,movedFrom.y+movedFrom.height/2);await panel.mouse.down();await panel.mouse.move(restoreTarget.x+20,restoreTarget.y+2,{steps:10});await panel.mouse.up();await eventually(async()=>assert.deepEqual(await order(),originalOrder));
 const handleAgain=await firstHandle.boundingBox();await panel.mouse.move(handleAgain.x+3,handleAgain.y+3);await panel.mouse.down();await panel.mouse.move(target.x+20,target.y+target.height-2,{steps:8});await panel.keyboard.press('Escape');await panel.mouse.up();
  assert.deepEqual(await order(),originalOrder);assert.equal(await editor.inputValue(),'');assert.equal((await fixture()).sent.length,0);checked('trusted pointer sorting and Escape cancellation preserve the draft; locked controls use ordinary disabled cursors and arrow buttons are absent');
 const conflictFrom=await firstHandle.boundingBox();await panel.mouse.move(conflictFrom.x+3,conflictFrom.y+3);await panel.mouse.down();await panel.mouse.move(target.x+20,target.y+target.height-2,{steps:8});
 const external=(await exported()).backup;external.configuration.templates.find(item=>item.preset==='url').name='外部更新的网页链接';
 const externalSaved=await message({type:'SIDER_CONFIGURATION_IMPORT',backup:external,expected:(await exported()).backup.configuration});assert.equal(externalSaved.ok,true,externalSaved.error);
 await eventually(async()=>assert.match(await chat.locator('.status.error').innerText(),/排序已取消/));await panel.mouse.up();assert.deepEqual(await order(),originalOrder);assert.equal(await editor.inputValue(),'');checked('external configuration changes cancel an active drag without overwriting the new settings');
 // A manual reference can wait without executing or resetting at the next selection.
 await select('preset-selection');await eventually(async()=>assert.match(await chat.locator('[data-chip="selection"] .excerpt').innerText(),/等待划词/));
 await source.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('#selection'));getSelection().removeAllRanges();getSelection().addRange(range)});
 await eventually(async()=>assert.match(await chat.locator('[data-chip="selection"] .excerpt').innerText(),/选中的示例/));
 await source.evaluate(()=>getSelection().removeAllRanges());await eventually(async()=>assert.match(await chat.locator('[data-chip="selection"] .excerpt').innerText(),/等待划词/));
 await select('preset-selection',false);
 await source.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('#selection'));getSelection().addRange(range)});
 await eventually(async()=>assert.equal(await chat.locator('#pane-body [data-template-id="preset-selection"]').locator('..').locator('input').isChecked(),false));
 await source.evaluate(()=>getSelection().removeAllRanges());assert.equal((await fixture()).sent.length,0);checked('manual selection reference waits without a source selection and new selections preserve both checked and cancelled choices');
 for(const width of [420,320]){
  await panel.setViewportSize({width,height:840});await menu();
  assert.equal(await chat.locator('.popover').evaluate(node=>node.scrollWidth>node.clientWidth),false);
  await chat.getByRole('button',{name:'编辑预设 网页正文',exact:true}).click();await chat.locator('summary').filter({hasText:'高级'}).click();
  const oldText=await chat.locator('#template-text').inputValue();await chat.locator('#template-text').evaluate(node=>{const start=node.value.indexOf('{{content}}');node.focus();node.setSelectionRange(start,start+11)});
  await chat.getByRole('button',{name:'设为附件区域',exact:true}).click();assert.equal(await chat.locator('#template-text').inputValue(),oldText.replace('{{content}}','<attachment>{{content}}</attachment>'));
  assert.equal(await chat.locator('.popover').evaluate(node=>node.scrollWidth>node.clientWidth),false);
  await panel.screenshot({path:`tmp/browser/unified-editor-${width}.png`});await chat.getByRole('button',{name:'取消编辑',exact:true}).click();
 }
 checked('template list and advanced editor have no horizontal overflow at 320 and 420 pixels');
 await select(first.id);await select(second.id);await chat.getByRole('button',{name:'关闭',exact:true}).click();
 await chat.locator('input[type=file]').setInputFiles({name:'user-note.txt',mimeType:'text/plain',buffer:Buffer.from('user file')});await chat.getByRole('button',{name:'user-note.txt',exact:true}).waitFor();
 await worker.evaluate(()=>{captureCount=0});await editor.fill('请使用两份资料');await editor.press('Enter');
 await eventually(async()=>assert.equal((await fixture()).sent.length,1));let data=await fixture();
 assert.equal(await worker.evaluate(()=>captureCount),1);assert.equal(data.sent[0].files.length,3);assert.equal(data.sent[0].pending,0);
 const files=data.sent[0].files.filter(file=>file.name!=='user-note.txt');for(const file of files){assert.ok(file.ready);assert.ok(file.content.includes('FULL-END-MARKER'));assert.ok(data.sent[0].text.includes(file.name));assert.ok(!file.content.includes('总结第一份网页材料。'));assert.ok(!file.content.includes('核对第二份网页材料。'))}assert.ok(data.sent[0].text.startsWith('总结第一份网页材料。'));assert.ok(data.sent[0].text.endsWith('按事实回答。'));assert.equal(data.sent[0].text.includes('FULL-END-MARKER'),false);
 checked('trusted Enter uploads two independent full files from one capture, preserves the user file, and sends once');
 await menu();await eventually(async()=>assert.deepEqual(await chat.locator('#pane-body input[type=checkbox]').evaluateAll(inputs=>inputs.map(input=>input.checked)),templates.map(()=>false)));
 await chat.getByRole('button',{name:'关闭',exact:true}).click();checked('trusted send automatically unchecks every built-in and custom preset in the real worker and UI');
 await editor.fill('保留问题');await invoke(fill.id);await eventually(async()=>assert.match(await chat.locator('.status').innerText(),/已追加/));
 const filledText=await editor.inputValue(),oldFile=(await fixture()).uploads.at(-1);assert.ok(filledText.includes(oldFile.name));assert.equal((await fixture()).sent.length,1);
 await source.evaluate(()=>document.querySelector('#dynamic').append(' SOURCE-UPDATED'));
 await select(first.id);await chat.getByRole('button',{name:'关闭',exact:true}).click();await editor.press('Enter');await eventually(async()=>assert.equal((await fixture()).sent.length,2));data=await fixture();
 assert.equal(data.sent[1].text.split(oldFile.name).length-1,1);assert.ok(data.sent[1].files.some(file=>file.name===oldFile.name));assert.equal(oldFile.content.includes('SOURCE-UPDATED'),false);assert.ok(data.sent[1].files.some(file=>file.name!==oldFile.name&&file.content.includes('SOURCE-UPDATED')));
 checked('fill uploads without sending; later send preserves its original file while another template gets fresh source content');
 await editor.fill('');await select(first.id,false);await invoke(direct.id);await eventually(async()=>assert.equal((await fixture()).sent.length,3));assert.ok((await fixture()).sent[2].text.startsWith('直接提问'));
 checked('an explicit direct template sends from an empty native draft');
 // Replacement stages its new material before removing the previous own file.
 await editor.fill('需要保留的旧问题');await invoke(fill.id);await eventually(async()=>assert.match(await chat.locator('.status').innerText(),/已追加/));
 const previousDraft=await editor.inputValue(),previousFile=(await fixture()).uploads.at(-1).name;
 await body.evaluate(()=>window.failNext=true);await invoke(replacement.id);await eventually(async()=>assert.match(await chat.locator('.status.error').innerText(),/fixture upload failed/));
 assert.equal(await editor.inputValue(),previousDraft);assert.equal(await chat.getByRole('button',{name:previousFile,exact:true}).count(),1);assert.equal((await fixture()).sent.length,3);
 await invoke(replacement.id);await eventually(async()=>assert.match(await chat.locator('.status').innerText(),/已替换/));
 const replaced=await editor.inputValue(),latestFile=(await fixture()).uploads.at(-1);
 assert.ok(replaced.startsWith('替换后总结。'));assert.ok(replaced.endsWith('中文回答。'));assert.ok(replaced.includes(latestFile.name));assert.ok(!replaced.includes('需要保留的旧问题'));
 assert.ok(!latestFile.content.includes('替换后总结。'));assert.equal(await chat.getByRole('button',{name:previousFile,exact:true}).count(),0);assert.equal(await chat.getByRole('button',{name:'user-note.txt',exact:true}).count(),1);assert.equal((await fixture()).sent.length,3);
 checked('replacement upload failure retains the old file and draft; success replaces only own files and keeps instructions outside the attachment');
 // Switch the same real iframe to a contenteditable fixture and exercise native editing.
 await panel.evaluate(()=>{document.querySelector('iframe').src='https://chatgpt.com/c/rich'});chat=panel.frameLocator('iframe');await chat.locator('#sider-enhancement').waitFor();
 const rich=chat.locator('#prompt-textarea');await menu();await eventually(async()=>assert.equal(await chat.locator('#pane-body .source').innerText(),'预设合并来源'));await chat.getByRole('button',{name:'关闭',exact:true}).click();
 await rich.fill('富文本原问题');await menu();await chat.locator('#pane-body [data-template-id="legacy-fixture-001"]').click();
 await eventually(async()=>assert.match(await chat.locator('.status').innerText(),/已追加/));assert.match(await rich.innerText(),/旧提示/);assert.ok((await rich.innerText()).includes('富文本原问题'));assert.equal((await chat.locator('body').evaluate(()=>window.sent)).length,0);
 await panel.screenshot({path:'tmp/browser/unified-rich-320.png'});checked('rich editor fills at the configured position, preserves the original draft, and does not send');
 await menu();
 const waitingReference=chat.getByRole('checkbox',{name:'发送时引用 划词',exact:true});await waitingReference.focus();await waitingReference.press('Space');assert.equal(await waitingReference.isChecked(),true);
 await chat.getByRole('button',{name:'关闭',exact:true}).click();await worker.evaluate(()=>captureCount=0);
 await rich.fill('只发普通问题');await rich.press('Enter');await eventually(async()=>assert.equal((await chat.locator('body').evaluate(()=>window.sent)).length,1));
 const ordinary=(await chat.locator('body').evaluate(()=>window.sent))[0];assert.equal(ordinary.text,'只发普通问题');assert.equal(ordinary.files.length,0);assert.equal(await worker.evaluate(()=>captureCount),0);
 await menu();await eventually(async()=>assert.equal(await chat.getByRole('checkbox',{name:'发送时引用 划词',exact:true}).isChecked(),false));
 assert.equal(await chat.locator('[data-chip="selection"]').count(),0);checked('a waiting selection preset skips ordinary sending, collects no page body, and is automatically unchecked after send');
 assert.deepEqual(errors,[]);Object.assign(results,{browser:context.browser().version(),checks,errors});await writeFile('tmp/browser/unified-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}catch(error){Object.assign(results,{checks,errors,error:error.stack});if(panel){await panel.screenshot({path:'tmp/browser/unified-failure.png'}).catch(()=>{});try{results.fixture=await panel.frameLocator('iframe').locator('body').evaluate(()=>({sent:window.sent,uploads:window.uploads,status:document.querySelector('#sider-enhancement')?.shadowRoot.querySelector('.status')?.textContent}))}catch{}}
await writeFile('tmp/browser/unified-results.json',JSON.stringify(results,null,2));throw error;
}finally{await context?.close();await new Promise(resolve=>tls.close(resolve));await new Promise(resolve=>article.close(resolve));}
