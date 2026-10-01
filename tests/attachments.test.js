import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAttachmentManager } from '../src/content/attachments.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pageSpec = (content = '网页完整正文', name = '网页正文.txt') => ({ name, content, mimeType: 'text/plain' });

function fixture(t, { timeoutMs = 200, onUpload } = {}) {
  const dom = new JSDOM('<main><form><div data-composer-body><textarea id="prompt-textarea">原问题</textarea><input type="file" aria-label="Attach files"><div data-composer-attachments></div></div></form></main>', { url: 'https://chatgpt.com/c/conversation-one', pretendToBeVisual: true });
  const { document } = dom.window;
  const editor = document.querySelector('textarea');
  editor.getClientRects = () => [{ width: 300, height: 60 }];
  const input = document.querySelector('input');
  let files = [];
  Object.defineProperty(input, 'files', { get: () => files, set: value => { files = value; }, configurable: true });
  dom.window.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  };
  const uploads = [];
  const removes = [];
  const area = document.querySelector('[data-composer-attachments]');
  const addCard = (name, { ready = false, error = false, removeWorks = true } = {}) => {
    const card = document.createElement('div'); card.className = 'group/composer-attachment';
    const label = document.createElement('span'); label.textContent = name; card.append(label);
    const remove = document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${name}`);
    remove.addEventListener('click', () => { removes.push(name); if (removeWorks) card.remove(); }); card.append(remove);
    const markReady = () => {
      card.querySelector('[role="progressbar"]')?.remove();
      if (!card.querySelector('button[data-preview]')) { const preview = document.createElement('button'); preview.type = 'button'; preview.dataset.preview = ''; preview.setAttribute('aria-label', name); card.append(preview); }
    };
    if (ready) markReady(); else { const progress = document.createElement('span'); progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-label', `Uploading ${name}`); card.append(progress); }
    if (error) { const failure = document.createElement('span'); failure.setAttribute('role', 'alert'); failure.textContent = 'Upload failed'; card.append(failure); }
    area.append(card);
    return { card, remove, markReady };
  };
  input.addEventListener('change', () => {
    const file = input.files[0]; uploads.push(file); input.files = [];
    if (onUpload) onUpload(file, addCard, dom.window);
    else addCard(file.name, { ready: true });
  });
  const manager = createAttachmentManager(document, { timeoutMs });
  t.after(async () => { await manager.dispose(); dom.window.close(); });
  return { dom, document, editor, input, area, manager, uploads, removes, addCard };
}

test('waits for an explicit native attachment preview after upload progress ends', async t => {
  let attachment;
  const f = fixture(t, { onUpload(file, addCard) { attachment = addCard(file.name); } });
  let finished = false;
  const preparation = f.manager.prepare(pageSpec()).then(() => { finished = true; });
  await pause(15);
  assert.equal(finished, false);
  assert.equal(f.manager.isReady(pageSpec()), false);
  attachment.card.querySelector('[role="progressbar"]').remove();
  await pause(15);
  assert.equal(finished, false, 'absence of progress alone is not upload success');
  attachment.markReady(); await preparation;
  assert.equal(f.manager.isReady(pageSpec()), true);
  assert.equal(f.editor.value, '原问题');
});

test('reuses the same ready or pending file without duplicate uploads', async t => {
  let attachment;
  const f = fixture(t, { onUpload(file, addCard) { attachment = addCard(file.name); } });
  const first = f.manager.prepare(pageSpec());
  const second = f.manager.prepare(pageSpec());
  attachment.markReady();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  const reused = await f.manager.prepare(pageSpec());
  assert.deepEqual(secondResult, firstResult);
  assert.deepEqual(reused, firstResult);
  assert.equal(firstResult.name, f.uploads[0].name);
  assert.match(firstResult.name, /^网页正文-sider-[0-9a-f]{16}\.txt$/);
  assert.equal(f.uploads.length, 1);
});

test('each fresh upload uses a unique secure filename and preserves the page-body suffix', async t => {
  const f = fixture(t);
  const spec = pageSpec('content', '文章标题-网页正文.txt');
  const first = await f.manager.prepare(spec);
  assert.match(first.name, /^文章标题-sider-[0-9a-f]{16}-网页正文\.txt$/);
  await f.manager.clear();
  const second = await f.manager.prepare(spec);
  assert.notEqual(second.name, first.name);
  assert.deepEqual(f.removes, [first.name]);
  assert.equal(f.manager.isReady(spec), true);
});

test('a concurrent user file with the logical name cannot be mistaken for the delayed extension upload', async t => {
  const f = fixture(t, { timeoutMs: 1000, onUpload() {} });
  const spec = pageSpec();
  let finished = false;
  const preparation = f.manager.prepare(spec).then(result => { finished = true; return result; });
  const user = f.addCard(spec.name, { ready: true });
  await pause(30);
  assert.equal(finished, false);
  assert.equal(f.manager.isReady(spec), false);
  assert.equal(f.manager.isOwnedRemoveButton(user.remove), false);
  assert.deepEqual(f.removes, []);
  const extension = f.addCard(f.uploads[0].name);
  await pause(15);
  assert.equal(finished, false);
  extension.markReady();
  const result = await preparation;
  assert.equal(result.name, f.uploads[0].name);
  assert.equal(f.manager.isReady(spec), true);
  await f.manager.clear();
  assert.equal(user.card.isConnected, true);
  assert.equal(extension.card.isConnected, false);
  assert.deepEqual(f.removes, [result.name]);
});

test('cancelling before the extension card appears leaves a concurrent logical-name user card alone', async t => {
  const f = fixture(t, { timeoutMs: 1000, onUpload() {} });
  const preparation = f.manager.prepare(pageSpec());
  const rejected = assert.rejects(preparation, /取消/);
  const user = f.addCard(pageSpec().name, { ready: true });
  const clearing = f.manager.clear();
  await pause(15);
  assert.equal(user.card.isConnected, true);
  assert.deepEqual(f.removes, []);
  const extension = f.addCard(f.uploads[0].name);
  await clearing; await rejected;
  assert.equal(user.card.isConnected, true);
  assert.equal(extension.card.isConnected, false);
  assert.deepEqual(f.removes, [f.uploads[0].name]);
});

test('refuses attachment preparation without a secure random source', async t => {
  const f = fixture(t);
  Object.defineProperty(f.dom.window, 'crypto', { value: {}, configurable: true });
  await assert.rejects(f.manager.prepare(pageSpec()), /安全随机数/);
  assert.equal(f.uploads.length, 0);
});

test('uses randomUUID when secure random byte generation is unavailable', async t => {
  const f = fixture(t);
  Object.defineProperty(f.dom.window, 'crypto', { value: { randomUUID: () => '12345678-1234-4321-8234-123456789abc' }, configurable: true });
  const result = await f.manager.prepare(pageSpec());
  assert.equal(result.name, '网页正文-sider-1234567812349abc.txt');
  assert.equal(f.manager.isReady(pageSpec()), true);
});

test('changing content removes only the extension file before preparing a replacement', async t => {
  const f = fixture(t);
  const user = f.addCard('user-notes.txt', { ready: true });
  await f.manager.prepare(pageSpec('first'));
  await f.manager.prepare(pageSpec('second'));
  assert.deepEqual(f.removes, [f.uploads[0].name]);
  assert.equal(f.uploads.length, 2);
  assert.notEqual(f.uploads[1].name, f.uploads[0].name);
  assert.equal(user.card.isConnected, true);
  assert.equal(f.manager.isReady(pageSpec('second')), true);
  await f.manager.clear();
  assert.equal(user.card.isConnected, true);
  assert.deepEqual(f.removes, f.uploads.map(file => file.name));
});

test('refuses a same-name user attachment before uploading or removing it', async t => {
  const f = fixture(t);
  const user = f.addCard('网页正文.txt', { ready: true });
  await assert.rejects(f.manager.prepare(pageSpec()), /已有同名附件/);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.removes.length, 0);
  assert.equal(user.card.isConnected, true);
});

test('handles filenames as literal names rather than CSS selector fragments', async t => {
  const f = fixture(t);
  const spec = pageSpec('content', '正文" ] #unsafe.txt');
  const result = await f.manager.prepare(spec);
  assert.equal(f.manager.isReady(spec), true);
  await f.manager.clear();
  assert.deepEqual(f.removes, [result.name]);
  assert.match(result.name, /^正文" \] #unsafe-sider-[0-9a-f]{16}\.txt$/);
});

test('error words in a filename do not turn a successful upload into a failure', async t => {
  const f = fixture(t);
  const spec = pageSpec('content', 'Upload failed troubleshooting-网页正文.txt');
  await f.manager.prepare(spec);
  assert.equal(f.manager.isReady(spec), true);
});

test('upload failures preserve the question and remove only the failed extension file', async t => {
  const f = fixture(t, { onUpload(file, addCard) { addCard(file.name, { error: true }); } });
  const user = f.addCard('mine.txt', { ready: true });
  await assert.rejects(f.manager.prepare(pageSpec()), /未能上传正文附件/);
  assert.equal(f.editor.value, '原问题');
  assert.equal(user.card.isConnected, true);
  assert.deepEqual(f.removes, [f.uploads[0].name]);
});

test('an upload timeout is not treated as attachment readiness', async t => {
  const f = fixture(t, { timeoutMs: 40, onUpload(file, addCard) { addCard(file.name); } });
  await assert.rejects(f.manager.prepare(pageSpec()), /上传超时/);
  assert.equal(f.manager.isReady(pageSpec()), false);
  assert.equal(f.area.children.length, 0);
});

test('aborting an upload cancels the owned native card and preserves other attachments', async t => {
  const f = fixture(t, { onUpload(file, addCard) { addCard(file.name); } });
  const user = f.addCard('mine.txt', { ready: true });
  const controller = new AbortController();
  const preparation = f.manager.prepare(pageSpec(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(preparation, /取消/);
  assert.equal(user.card.isConnected, true);
  assert.equal(f.editor.value, '原问题');
});

test('clear cancels an upload even when its native card appears later', async t => {
  const f = fixture(t, { onUpload(file, addCard, view) { view.setTimeout(() => addCard(file.name), 35); } });
  const preparation = f.manager.prepare(pageSpec());
  const rejected = assert.rejects(preparation, /取消/);
  await f.manager.clear();
  await rejected;
  assert.equal(f.area.children.length, 0);
  assert.deepEqual(f.removes, [f.uploads[0].name]);
});

test('a card appearing after timeout is still removed only in the original composer', async t => {
  const f = fixture(t, { timeoutMs: 40, onUpload(file, addCard, view) { view.setTimeout(() => addCard(file.name), 130); } });
  const user = f.addCard('mine.txt', { ready: true });
  await assert.rejects(f.manager.prepare(pageSpec()), /上传超时/);
  await pause(100);
  assert.equal(f.area.children.length, 1);
  assert.equal(user.card.isConnected, true);
  assert.deepEqual(f.removes, [f.uploads[0].name]);
});

test('cancellation without a native card reports promptly and cleans a subsequent late card', async t => {
  const f = fixture(t, { timeoutMs: 90000, onUpload() {} });
  const controller = new AbortController();
  const started = Date.now();
  const preparation = f.manager.prepare(pageSpec(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(preparation, /取消.*无法确认/s);
  assert.ok(Date.now() - started < 3000, 'cleanup must not wait the entire 90 second upload timeout');
  assert.equal(f.manager.isReady(pageSpec()), false);
  f.addCard(f.uploads[0].name);
  await pause(20);
  assert.equal(f.area.children.length, 0);
  assert.deepEqual(f.removes, [f.uploads[0].name]);
});

test('user removing an uploading card rejects preparation instead of silently sending', async t => {
  let attachment;
  const f = fixture(t, { onUpload(file, addCard) { attachment = addCard(file.name); } });
  const preparation = f.manager.prepare(pageSpec());
  const rejected = assert.rejects(preparation, /已被移除/);
  await pause(10); attachment.remove.click();
  await rejected;
  assert.equal(f.manager.isReady(pageSpec()), false);
});

test('recognizes only its owned native remove button and invalidates after native clearing', async t => {
  const f = fixture(t);
  const user = f.addCard('mine.txt', { ready: true });
  const result = await f.manager.prepare(pageSpec());
  const ownRemove = [...f.area.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === `Remove ${result.name}`);
  assert.equal(f.manager.isOwnedRemoveButton(ownRemove), true);
  assert.equal(f.manager.isOwnedRemoveButton(user.remove), false);
  f.area.querySelector('.group\\/composer-attachment:last-child').remove();
  assert.deepEqual(f.manager.reconcile(), { ready: false, name: result.name, invalidated: true, removed: true });
  assert.equal(f.manager.isReady(pageSpec()), false);
});

test('changing the draft while uploading cancels preparation', async t => {
  let current = true;
  const f = fixture(t, { onUpload(file, addCard) { addCard(file.name); } });
  const preparation = f.manager.prepare(pageSpec(), { isCurrent: () => current });
  const rejected = assert.rejects(preparation, /问题或引用已修改/);
  current = false; await rejected;
  assert.equal(f.area.children.length, 0);
});

test('conversation changes invalidate readiness and do not claim a new same-name user card', async t => {
  const f = fixture(t);
  const result = await f.manager.prepare(pageSpec());
  f.area.replaceChildren();
  f.dom.window.history.pushState({}, '', '/c/conversation-two');
  const user = f.addCard(result.name, { ready: true });
  assert.equal(f.manager.isReady(pageSpec()), false);
  await f.manager.clear();
  assert.equal(user.card.isConnected, true);
  assert.equal(f.removes.length, 0);
});

test('a same-name user replacement in the same conversation does not inherit ownership', async t => {
  const f = fixture(t);
  const result = await f.manager.prepare(pageSpec());
  f.area.replaceChildren();
  const user = f.addCard(result.name, { ready: true });
  assert.equal(f.manager.isReady(pageSpec()), false);
  assert.equal(f.manager.isOwnedRemoveButton(user.remove), false);
  await f.manager.clear();
  assert.equal(user.card.isConnected, true);
  assert.equal(f.removes.length, 0);
});

test('a navigation before any card appears does not block a later new conversation preparation', async t => {
  let shouldUpload = false;
  const f = fixture(t, { onUpload(file, addCard) { if (shouldUpload) addCard(file.name, { ready: true }); } });
  const preparation = f.manager.prepare(pageSpec());
  const rejected = assert.rejects(preparation, /会话已切换/);
  f.dom.window.history.pushState({}, '', '/c/conversation-two');
  await rejected;
  shouldUpload = true;
  await f.manager.prepare(pageSpec());
  assert.equal(f.manager.isReady(pageSpec()), true);
});

test('conversation switching while uploading aborts and removes only a recorded old card', async t => {
  const f = fixture(t, { onUpload(file, addCard) { addCard(file.name); } });
  const preparation = f.manager.prepare(pageSpec());
  const rejected = assert.rejects(preparation, /会话已切换/);
  f.dom.window.history.pushState({}, '', '/c/conversation-two');
  await rejected;
  assert.equal(f.area.children.length, 0);
});

test('does not choose an image-only native upload input', async t => {
  const f = fixture(t);
  f.input.setAttribute('accept', 'image/*,video/*');
  await assert.rejects(f.manager.prepare(pageSpec()), /没有找到可用/);
  assert.equal(f.uploads.length, 0);
});

test('clear verifies native removal and rejects when the original card remains', async t => {
  const f = fixture(t, { timeoutMs: 40, onUpload(file, addCard) { addCard(file.name, { ready: true, removeWorks: false }); } });
  await f.manager.prepare(pageSpec());
  await assert.rejects(f.manager.clear(), /超时/);
  assert.equal(f.area.children.length, 1);
});
