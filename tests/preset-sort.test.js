import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installPresetSort } from '../src/content/preset-sort.js';

function fixture(t, save = async () => {}) {
 const dom = new JSDOM('<section><div id="list"></div></section>', { pretendToBeVisual:true }); t.after(()=>dom.window.close());
 const {document}=dom.window, list=document.querySelector('#list'), scroller=document.querySelector('section');
 scroller.getBoundingClientRect=()=>({top:0,bottom:160});
 const items=['one','two','three','four'].map(id=>({id})); let changes=[], failures=[], executions=0;
 for(const item of items){const row=document.createElement('div');row.dataset.sortId=item.id;
  const handle=document.createElement('button');handle.dataset.sortHandle='';row.append(handle);
  const use=document.createElement('button');use.addEventListener('click',()=>executions++);row.append(use);
  const toggle=document.createElement('input');toggle.type='checkbox';row.append(toggle);list.append(row);
  row.getBoundingClientRect=()=>({top:[...list.children].indexOf(row)*40,height:40});
 }
 const sort=installPresetSort(list,{scroller,items,save,changed:active=>changes.push(active),error:cause=>failures.push(cause.message)});t.after(()=>sort.dispose());
 const event=(handle,type,y)=>{const e=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientY:y});Object.defineProperty(e,'pointerId',{value:1});handle.dispatchEvent(e);};
 return{list,scroller,items,sort,changes,failures,event,handle:list.firstChild.firstChild,get executions(){return executions;},order:()=>[...list.children].map(row=>row.dataset.sortId)};
}
const pause=()=>new Promise(resolve=>setTimeout(resolve,30));

test('drag reorders only on release, locks other controls and performs one compare-and-save',async t=>{
 let writes=[];const f=fixture(t,async(next,expected)=>writes.push({next,expected}));
 f.event(f.handle,'pointerdown',10);f.event(f.handle,'pointermove',135);
 await pause();
 assert.equal(writes.length,0);assert.deepEqual(f.order(),['two','three','one','four']);
 assert.ok([...f.list.querySelectorAll('input')].every(input=>input.disabled));
 f.event(f.handle,'pointerup',135);await pause();assert.equal(writes.length,1);assert.deepEqual(writes[0].next.map(item=>item.id),f.order());assert.deepEqual(writes[0].expected,f.items);
 assert.equal(f.executions,0);assert.ok([...f.list.querySelectorAll('input')].every(input=>!input.checked&&!input.disabled));assert.equal(f.sort.active,false);
});
test('release flushes the latest move even before its animation frame and saves once',async t=>{
 let writes=[];const f=fixture(t,async next=>writes.push(next));
 f.event(f.handle,'pointerdown',10);f.event(f.handle,'pointermove',70);f.event(f.handle,'pointermove',150);f.event(f.handle,'pointerup',150);
 await pause();assert.deepEqual(f.order(),['two','three','four','one']);assert.equal(writes.length,1);assert.deepEqual(writes[0].map(item=>item.id),f.order());
});
test('ordinary movement in the same slot does not reinsert rows and disposal cancels the pending frame',async t=>{
 const f=fixture(t);let moves=0;const insert=f.list.insertBefore.bind(f.list);f.list.insertBefore=(...args)=>{moves++;return insert(...args)};
 f.event(f.handle,'pointerdown',10);f.event(f.handle,'pointermove',17);await pause();f.event(f.handle,'pointermove',18);await pause();assert.equal(moves,0);
 f.event(f.handle,'pointermove',150);f.sort.dispose();await pause();assert.equal(moves,0);assert.deepEqual(f.order(),f.items.map(item=>item.id));
});
test('pointer cancellation and explicit Escape cancellation restore order without saving',async t=>{
 let writes=0;const f=fixture(t,async()=>writes++);
 for(const type of ['pointercancel','escape']){f.event(f.handle,'pointerdown',10);f.event(f.handle,'pointermove',150);if(type==='escape')f.sort.cancel();else f.event(f.handle,type,150);assert.deepEqual(f.order(),f.items.map(item=>item.id));}
 assert.equal(writes,0);assert.equal(f.executions,0);assert.equal(f.sort.active,false);
});
test('a click on the handle and a short movement never execute a preset or save its order',async t=>{
 let writes=0;const f=fixture(t,async()=>writes++);f.event(f.handle,'pointerdown',10);f.event(f.handle,'pointermove',12);f.event(f.handle,'pointerup',12);f.handle.click();await pause();
 assert.equal(writes,0);assert.equal(f.executions,0);assert.deepEqual(f.order(),f.items.map(item=>item.id));
});
test('save conflict restores the visible order and reports the reason',async t=>{
 const f=fixture(t,async()=>{throw new Error('配置已在另一侧栏修改');});f.event(f.handle,'pointerdown',10);f.event(f.handle,'pointermove',150);f.event(f.handle,'pointerup',150);await pause();
 assert.deepEqual(f.order(),f.items.map(item=>item.id));assert.deepEqual(f.failures,['配置已在另一侧栏修改']);assert.equal(f.sort.active,false);
});
test('edge dragging scrolls the list and cancelling stops the animation',async t=>{
 const f=fixture(t);f.event(f.handle,'pointerdown',10);f.event(f.handle,'pointermove',159);await pause();assert.ok(f.scroller.scrollTop>0);f.sort.cancel();const before=f.scroller.scrollTop;await pause();assert.equal(f.scroller.scrollTop,before);
});
