import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from './browser.js';
const marker = 'AI-WEB-FULL-BODY-END';
const body = '完整正文段落，必须保留。'.repeat(1400) + marker;
const fixture = kind => `<!doctype html><html><head><title>${kind} fixture</title><style>body{font:14px system-ui;margin:14px;background:white;color:#222}main{margin-top:120px}.input-area,form{border:1px solid #ddd;border-radius:12px;padding:12px}textarea,[contenteditable=true]{display:block;width:100%;box-sizing:border-box;min-height:70px;padding:8px;border:1px solid #ddd}.ql-clipboard{position:absolute;left:-10000px;height:1px!important;min-height:0!important}button{padding:8px}#files{display:flex;gap:6px;flex-wrap:wrap}#files>div{border:1px solid #ddd;padding:6px}.file-name{display:block}#other{min-height:40px}</style></head><body><main>
${kind === 'gemini' ? '<div class="input-area"><rich-textarea><div class="ql-editor" role="textbox" contenteditable="true" aria-label="Prompt"><p><br></p></div><div class="ql-clipboard" contenteditable="true"></div></rich-textarea>' : '<form id="custom-form">' + (kind === 'claude' ? '<div class="ProseMirror" role="textbox" contenteditable="true" aria-label="Prompt"><p><br></p></div>' : '<textarea id="' + (kind === 'custom' ? 'question' : 'prompt-textarea') + '" aria-label="Prompt"></textarea>')}
${kind === 'custom' ? '<textarea id="other" aria-label="Prompt"></textarea>' : ''}
${kind !== 'gemini' && kind !== 'custom' ? '<input type="file" aria-label="Upload files">' : ''}
<div id="files" data-composer-attachments></div><button id="send" type="submit" class="send-button" data-testid="send-button" aria-label="Send message">Send</button>${kind === 'gemini' ? '</div>' : '</form>'}</main>
<script>const kind=${JSON.stringify(kind)}; window.sent=[];window.uploaded=[];window.removed=[];window.failUpload=false;
const editor=document.querySelector('textarea,.ql-editor,.ProseMirror'), area=document.querySelector('#files'), button=document.querySelector('#send');
const text=()=>editor.tagName==='TEXTAREA'?editor.value:editor.innerText;
function send(event){event.preventDefault();sent.push(text());if(editor.tagName==='TEXTAREA')editor.value='';else editor.innerHTML='<p><br></p>';editor.dispatchEvent(new InputEvent('input',{bubbles:true}));}
if(kind==='gemini')button.addEventListener('click',send);else document.querySelector('form').addEventListener('submit',send);
editor.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&(kind==='custom'?event.ctrlKey:!event.ctrlKey)){event.preventDefault();button.click();}});
function addCard(name,pending=false){const card=document.createElement('div');card.className=kind==='chatgpt'?'group/composer-attachment':kind==='gemini'?'file-preview':'file-thumbnail';card.dataset.testid='file-attachment';
const label=document.createElement('span');label.textContent=name;card.append(label);const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove '+name);remove.onclick=()=>{removed.push(name);card.remove()};card.append(remove);area.append(card);
const ready=()=>{card.querySelector('[role=progressbar]')?.remove();const preview=document.createElement('button');preview.type='button';preview.setAttribute('aria-label',name);card.append(preview)};
if(pending){const progress=document.createElement('span');progress.setAttribute('role','progressbar');card.append(progress);setTimeout(()=>{if(failUpload){const error=document.createElement('span');error.setAttribute('role','alert');card.append(error)}else ready()},100)}else ready();return card;}
window.userFile=()=>addCard('user.txt');
async function upload(file){uploaded.push({name:file.name,text:await file.text()});addCard(file.name,true)}
document.querySelector('input[type=file]')?.addEventListener('change',event=>{upload(event.target.files[0]);event.target.value=''});
document.querySelector('.input-area')?.addEventListener('drop',event=>{event.preventDefault();upload(event.dataTransfer.files[0])});
for(const type of ['dragenter','dragover'])document.querySelector('.input-area')?.addEventListener(type,event=>event.preventDefault());
</script></body></html>`;
const tls = httpsServer({ key: await readFile('tests/browser/fixtures/test-key.pem'), cert: await readFile('tests/browser/fixtures/test-cert.pem') }, (req,res) => {
  const host = req.headers.host || ''; const kind = host.includes('gemini') ? 'gemini' : host.includes('claude') ? 'claude' : host.includes('custom-ai') ? 'custom' : 'chatgpt';
  res.writeHead(200, { 'content-type':'text/html; charset=utf-8','content-security-policy':"frame-ancestors 'none'; script-src 'unsafe-inline'",'x-frame-options':'DENY' }); res.end(fixture(kind));
});
const article = httpServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<html><title>AI source fixture</title><main><article><h1>正文标题</h1><p>${body}</p></article></main></html>`)});
await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve)); await new Promise(resolve=>article.listen(0,'127.0.0.1',resolve));
const extension = path.resolve('tmp/browser/ai-web-extension');
assert.ok(extension.startsWith(path.resolve('tmp/browser') + path.sep));
await cp('dist',extension,{recursive:true});
const manifest = JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
// Only this isolated fixture checkout pregrants the test destinations. Permission
// denial and transactional saves are covered separately; production stays unchanged.
manifest.host_permissions.push('https://gemini.google.com/*','https://claude.ai/*','https://custom-ai.test/*','http://127.0.0.1/*');
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
let context;
const checks=[], errors=[];
const passed=message=>{checks.push(message);console.log('PASS '+message)};
try {
  const rules = ['chatgpt.com','gemini.google.com','claude.ai','custom-ai.test'].map(host=>`MAP ${host}:443 127.0.0.1:${tls.address().port}`).join(',');
  context = await chromium.launchPersistentContext(path.resolve(`tmp/browser/ai-web-profile-${Date.now()}`),{...(process.env.SIDER_CHROMIUM ? { executablePath: process.env.SIDER_CHROMIUM } : {}),headless:true,ignoreHTTPSErrors:true,viewport:{width:420,height:840},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--enable-unsafe-extension-debugging',`--host-resolver-rules=${rules}`,'--no-proxy-server','--ignore-certificate-errors']});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).hostname;
  const source=await context.newPage(); const sourceURL=`http://127.0.0.1:${article.address().port}/article`; await source.goto(sourceURL);
  const sourceTab=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url),sourceURL);assert.ok(sourceTab);
  const panel=await context.newPage();panel.on('pageerror',error=>errors.push(error.message));
  await panel.goto(`chrome-extension://${id}/panel.html?sourceTab=${sourceTab.id}`);
  const chat=panel.frameLocator('iframe');
  const send=async message=>panel.evaluate(message=>chrome.runtime.sendMessage(message),message);
  await chat.locator('#sider-enhancement').waitFor();
  await send({type:'SIDER_TAB_ATTACHMENT_SET',tabId:sourceTab.id,kind:'url',enabled:true});
  await send({type:'SIDER_TAB_ATTACHMENT_SET',tabId:sourceTab.id,kind:'page',enabled:true});
  const choose=async siteId=>{await panel.getByRole('button',{name:'AI 网站设置',exact:true}).click();await panel.locator('#ai-active-site').selectOption(siteId);await panel.getByRole('button',{name:'保存全局设置',exact:true}).click();await panel.locator('#ai-settings-dialog').waitFor({state:'hidden'});};
  const reload=async()=>{await panel.locator('#reload-chatgpt').click();await chat.locator('#sider-enhancement').waitFor();};
  const editor=()=>chat.getByRole('textbox',{name:'Prompt',exact:true});
  const waitSent=async()=>chat.locator('body').evaluate(()=>window.sent);
  const reselect=async()=>{await send({type:'SIDER_TAB_ATTACHMENT_SET',tabId:sourceTab.id,kind:'url',enabled:true});await send({type:'SIDER_TAB_ATTACHMENT_SET',tabId:sourceTab.id,kind:'page',enabled:true});await chat.locator('[data-chip="page"]').waitFor();};
  await editor().fill('ChatGPT question');await editor().press('Enter');
  await chat.locator('body').evaluate(()=>new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(sent.length){clearInterval(timer);resolve()}else if(Date.now()-started>5000){clearInterval(timer);reject(new Error('No send'))}},20)}));
  assert.ok((await waitSent())[0].includes(sourceURL)); assert.ok((await chat.locator('body').evaluate(()=>uploaded[0].text)).includes(marker));passed('ChatGPT native Enter and complete body attachment');
  await editor().fill('Draft stays here'); const oldURL=await panel.locator('iframe').getAttribute('src');await choose('gemini');
  assert.equal(await panel.locator('iframe').getAttribute('src'),oldURL);assert.equal(await editor().inputValue(),'Draft stays here');passed('global switch preserves current frame and draft');
  await reload();assert.equal(new URL(await panel.locator('iframe').getAttribute('src')).origin,'https://gemini.google.com');
  await reselect();await editor().fill('Gemini question');await editor().press('Enter');
  await chat.locator('body').evaluate(()=>new Promise(resolve=>{const timer=setInterval(()=>{if(sent.length){clearInterval(timer);resolve()}},20)}));
  assert.ok((await waitSent())[0].includes(sourceURL));assert.ok((await chat.locator('body').evaluate(()=>uploaded[0].text)).includes(marker));passed('Gemini Quill native editing, drop upload and positive preview');
  await choose('claude');await reload();await reselect();await chat.locator('body').evaluate(()=>userFile());await editor().fill('Claude question');await chat.locator('#send').click();
  await chat.locator('body').evaluate(()=>new Promise(resolve=>{const timer=setInterval(()=>{if(sent.length){clearInterval(timer);resolve()}},20)}));
  assert.ok((await waitSent())[0].includes(sourceURL));assert.ok((await chat.locator('body').evaluate(()=>uploaded[0].text)).includes(marker));passed('Claude ProseMirror native editing and file-input upload');
  await chat.locator('[data-chip="page"]').waitFor({state:'hidden'});assert.ok(await chat.getByRole('button',{name:'user.txt',exact:true}).count());passed('automatic preset deselection preserves the user attachment');
  await chat.getByRole('button',{name:'预设',exact:true}).click(); await chat.getByRole('button',{name:'新增预设',exact:true}).click();
  await chat.locator('#template-name').fill('富文本预设'); await chat.locator('#template-text').fill('读 {{url.host}}');
  assert.equal(await chat.locator('#template-action').inputValue(),'append');
  await chat.getByRole('button',{name:'保存预设',exact:true}).click(); await chat.getByRole('button',{name:'关闭',exact:true}).click();
  await editor().fill('前缀旧词后缀'); await editor().focus();
  await editor().evaluate(node=>{const text=document.createTreeWalker(node,NodeFilter.SHOW_TEXT).nextNode(),range=document.createRange();range.setStart(text,2);range.setEnd(text,4);getSelection().removeAllRanges();getSelection().addRange(range);});
  await chat.getByRole('button',{name:'预设',exact:true}).click(); await chat.getByRole('button',{name:'富文本预设 · 追加',exact:true}).click();
  await assertEventually(async()=>assert.match(await editor().innerText(),/^前缀旧词后缀\n+读 127.0.0.1$/)); assert.equal((await waitSent()).length,1);
  await chat.locator('.popover').waitFor({state:'hidden'});
  await chat.getByRole('button',{name:'预设',exact:true}).click(); await chat.getByRole('button',{name:'编辑预设 富文本预设',exact:true}).click();
  await chat.locator('#template-text').fill('总结\n{{content}}'); await chat.locator('#template-action').selectOption('send');
  await chat.locator('.variables summary').filter({hasText:'查看全部变量'}).click(); assert.equal(await chat.locator('.variable').count(),16);
  await panel.screenshot({path:'tmp/browser/templates-rich-420.png'}); assert.equal(await chat.locator('.popover').evaluate(node=>node.scrollWidth>node.clientWidth+1),false);
  await chat.getByRole('button',{name:'保存预设',exact:true}).click(); await chat.getByRole('button',{name:'关闭',exact:true}).click();
  await editor().fill(''); await editor().fill('已有草稿\n'); await editor().focus();
  await editor().evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);});
  await chat.getByRole('button',{name:'预设',exact:true}).click(); await chat.getByRole('button',{name:'富文本预设 · 直接发送',exact:true}).click();
  await assertEventually(async()=>assert.equal((await waitSent()).length,2)); const richSent=(await waitSent()).at(-1);
  assert.ok(richSent.startsWith('已有草稿')); assert.match(richSent,/总结\n+/); assert.equal(richSent.split(marker).length-1,1); assert.equal(await chat.locator('[data-chip="page"]').count(),0);
  await chat.getByRole('button',{name:'预设',exact:true}).click(); await chat.getByRole('button',{name:'删除预设 富文本预设',exact:true}).click();
  await assertEventually(async()=>assert.equal(await chat.locator('#pane-body [data-template-id]').count(),3)); await chat.getByRole('button',{name:'关闭',exact:true}).click();
  passed('real rich editor template creation, draft preservation, editing, variable directory, direct body send without enabling references, deletion and 420px layout');
  await panel.getByRole('button',{name:'AI 网站设置',exact:true}).click();await panel.getByRole('button',{name:'添加网站',exact:true}).click();
  await panel.locator('#ai-site-name').fill('Custom fixture');await panel.locator('#ai-site-url').fill('https://custom-ai.test/chat');await panel.getByRole('button',{name:'保存网站',exact:true}).click();
  const customId=await panel.locator('#ai-active-site').inputValue();await panel.getByRole('button',{name:'保存全局设置',exact:true}).click();await panel.locator('#ai-settings-dialog').waitFor({state:'hidden'});
  await panel.locator('#reload-chatgpt').click();await panel.locator('#connection-status').filter({hasText:'网页引用未就绪'}).waitFor();assert.match(await panel.locator('#connection-status').getAttribute('title'),/多个匹配/);passed('ambiguous custom site pauses enhancement and reports configuration');
  await panel.getByRole('button',{name:'AI 网站设置',exact:true}).click();
  assert.equal(await panel.locator('#ai-gemini-spark').isVisible(),false);
  await panel.locator('#ai-site-settings > summary').click();
  assert.equal(await panel.locator('#ai-site-groups > details').count(),4);
  await panel.locator('[data-site-id="gemini"] > summary').click();
  assert.equal(await panel.locator('#ai-gemini-spark').isVisible(),true);
  await panel.locator('#ai-gemini-model').selectOption('pro');
  await panel.locator('[data-site-id="gemini"] > summary').click();
  assert.equal(await panel.locator('#ai-gemini-spark').isVisible(),false);
  await panel.getByRole('button',{name:'编辑网站',exact:true}).click();await panel.locator('#ai-custom-fields summary').click();
  await panel.locator('#ai-selector-composer').fill('#question');await panel.locator('#ai-selector-send').fill('#send');await panel.locator('#ai-selector-mount').fill('#custom-form');await panel.locator('#ai-send-shortcut').selectOption('ctrl-enter');
  await panel.setViewportSize({width:320,height:840});await panel.screenshot({path:'tmp/browser/ai-web-settings-320.png'});
  const overflow=await panel.locator('#ai-settings-dialog').evaluate(el=>el.scrollWidth>el.clientWidth+1);assert.equal(overflow,false);passed('320px website settings layout has no horizontal overflow');
  await panel.getByRole('button',{name:'保存网站',exact:true}).click();await panel.getByRole('button',{name:'保存全局设置',exact:true}).click();await panel.locator('#ai-settings-dialog').waitFor({state:'hidden'});await reload();
  await send({type:'SIDER_TAB_ATTACHMENT_SET',tabId:sourceTab.id,kind:'page',enabled:true});await chat.locator('#question').fill('Custom question');await chat.locator('#question').press('Control+Enter');
  await chat.locator('body').evaluate(()=>new Promise(resolve=>{const timer=setInterval(()=>{if(sent.length){clearInterval(timer);resolve()}},20)}));
  assert.ok((await waitSent())[0].includes(marker));assert.equal(await chat.locator('body').evaluate(()=>uploaded.length),0);assert.match(await chat.locator('.status').innerText(),/完整文本/);passed('custom configured shortcut and complete-text fallback');
  const saved=(await send({type:'SIDER_AI_WEB_SETTINGS_GET'})).settings;assert.equal(saved.activeSiteId,customId);assert.equal(saved.customSites[0].selectors.composer,'#question');assert.equal(saved.geminiModel,'pro');
  passed('per-site settings stay hidden until expanded and preserve changes after collapsing');
  await worker.evaluate(()=>{globalThis.originalTabsSend=chrome.tabs.sendMessage.bind(chrome.tabs);});
  assert.deepEqual(errors,[]);passed('no panel page errors');
  await writeFile('tmp/browser/ai-web-integration-results.json',JSON.stringify({checks,errors,browser:await context.browser().version(),testHostPermissions:true},null,2));
  console.log(JSON.stringify({passed:checks.length,errors}));
} finally {await context?.close();await new Promise(resolve=>tls.close(resolve));await new Promise(resolve=>article.close(resolve));}

async function assertEventually(check,timeout=6000){const until=Date.now()+timeout;for(;;){try{await check();return;}catch(error){if(Date.now()>=until)throw error;}await new Promise(resolve=>setTimeout(resolve,50));}}
