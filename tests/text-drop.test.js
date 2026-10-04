import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { normalizeCustomAISite } from '../src/ai-web.js';
import { createWebAdapter } from '../src/content/adapters.js';
import { installTextDrop } from '../src/content/text-drop.js';

function fixture(t, html = '<main><form><textarea></textarea><button type="submit">Send</button></form></main>') {
  const { window } = new JSDOM(html, { url: 'https://drop-ai.test/', pretendToBeVisual: true });
  window.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{}] : []; };
  const document = window.document;
  const adapter = createWebAdapter(document, normalizeCustomAISite({ id: 'custom-drop-fixture', name: 'Drop AI', url: window.location.href }));
  const listeners = new Map(), errors = [], writes = [];
  const add = document.addEventListener.bind(document);
  document.addEventListener = (type, listener, options) => { listeners.set(type, listener); add(type, listener, options); };
  let busy = false;
  const dispose = installTextDrop({ document, adapter, beforeWrite: () => writes.push('start'), afterWrite: () => writes.push('end'), onError: detail => errors.push(detail), isBusy: () => busy });
  t.after(() => { dispose(); window.close(); });
  const editor = document.querySelector('textarea,[contenteditable]');
  return { window, document, adapter, editor, errors, writes, dispose, setBusy: value => { busy = value; },
    fire(type = 'drop', options = {}) {
      const event = { type, target: editor, isTrusted: true, dataTransfer: { types: ['text/plain'], items: [], files: [], getData: type => type === 'text/plain' ? '拖入文字\r\n完整尾部' : '', ...options.transfer }, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...options };
      if (options.transfer) event.dataTransfer = { types: ['text/plain'], items: [], files: [], getData: type => type === 'text/plain' ? 'Text' : '', ...options.transfer };
      // jsdom cannot manufacture trusted drag input; call its registered handler.
      listeners.get(type)?.(event);
      return event;
    },
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 80));

test('custom text drops cancel the native file handler, insert full text once and never click Send', async t => {
  const f = fixture(t); let sends = 0;
  f.document.querySelector('button').onclick = () => { sends++; };
  f.editor.value = '草稿';
  const over = f.fire('dragover'); assert.equal(over.prevented, true); assert.equal(over.dataTransfer.dropEffect, 'copy');
  const drop = f.fire(); assert.equal(drop.prevented, true); assert.equal(drop.stopped, true);
  f.fire(); await settle();
  assert.equal(f.editor.value, '草稿拖入文字\n完整尾部'); assert.equal(sends, 0);
  assert.deepEqual(f.writes, ['start', 'end']); assert.match(f.errors[0], /正在写入/);
});

test('a focused textarea drop inserts at its selected range and places the caret after the text', async t => {
  const f = fixture(t); f.editor.value = 'left old right'; f.editor.focus(); f.editor.setSelectionRange(5, 8);
  f.fire('drop', { transfer: { getData: type => type === 'text/plain' ? 'NEW' : '' } }); await settle();
  assert.equal(f.editor.value, 'left NEW right'); assert.equal(f.editor.selectionStart, 8); assert.equal(f.editor.selectionEnd, 8);
  assert.deepEqual(f.errors, []);
});

for (const [name, transfer] of [
  ['file', { types: ['Files', 'text/plain'], files: [{}] }],
  ['file item', { types: ['text/plain'], items: [{ kind: 'file' }] }],
  ['web image URL', { types: ['text/plain', 'text/html', 'text/uri-list'] }],
  ['web image HTML', { types: ['text/plain', 'text/html'], getData: type => type === 'text/html' ? '<img src="https://example.com/image.png">' : 'Image' }],
  ['empty text', { getData: () => '' }],
  ['unreadable data', { getData: () => { throw new Error('protected'); } }],
]) test(`native ${name} drops remain with the website`, async t => {
  const f = fixture(t); const event = f.fire('drop', { transfer }); await settle();
  assert.equal(event.prevented, false); assert.equal(f.editor.value, ''); assert.deepEqual(f.writes, []);
});

test('untrusted, internal editor, and outside drops keep their native behavior', async t => {
  const f = fixture(t);
  assert.equal(f.fire('drop', { isTrusted: false }).prevented, false);
  assert.equal(f.fire('drop', { target: f.document.querySelector('main') }).prevented, false);
  f.fire('dragstart'); assert.equal(f.fire('drop').prevented, false);
  f.fire('dragend'); assert.equal(f.fire('drop').prevented, true); await settle();
});

test('ambiguous editors, excessive text and an active write never corrupt the original draft', async t => {
  const f = fixture(t); f.editor.value = '保留';
  const other = f.document.createElement('textarea'); f.document.querySelector('form').append(other);
  assert.equal(f.fire().prevented, false); other.remove();
  assert.equal(f.fire('drop', { transfer: { getData: type => type === 'text/plain' ? 'x'.repeat(1_000_000) : '' } }).prevented, true);
  assert.equal(f.editor.value, '保留'); assert.match(f.errors.at(-1), /过长/);
  f.setBusy(true); f.fire(); await settle(); assert.equal(f.editor.value, '保留'); assert.deepEqual(f.writes, []);
});

test('native editing refusal and incomplete reconciliation report failures without another write', async t => {
  const f = fixture(t); f.editor.value = '原草稿';
  const reject = event => event.preventDefault(); f.editor.addEventListener('beforeinput', reject);
  f.fire(); await settle(); assert.equal(f.editor.value, '原草稿'); assert.match(f.errors.at(-1), /不接受自动编辑/);
  f.editor.removeEventListener('beforeinput', reject);
  f.editor.addEventListener('input', () => { f.editor.value = '网站保留的文字'; });
  f.fire(); await settle(); assert.equal(f.editor.value, '网站保留的文字'); assert.match(f.errors.at(-1), /未完整保留/);
  assert.deepEqual(f.writes, ['start', 'end', 'start', 'end']);
});

test('editor replacement before the write prevents filling a different conversation', async t => {
  const f = fixture(t); f.editor.value = 'Same draft';
  const write = f.adapter.writeDraft;
  f.adapter.writeDraft = (text, options) => {
    const replacement = f.editor.cloneNode(); replacement.value = f.editor.value; f.editor.replaceWith(replacement);
    return write(text, options);
  };
  f.fire(); await settle(); assert.equal(f.document.querySelector('textarea').value, 'Same draft'); assert.match(f.errors[0], /输入框.*变化/);
});

test('rich editors use the adapter editing API and never insert dragged HTML', async t => {
  const f = fixture(t, '<form><div contenteditable="true" role="textbox">Draft</div><button type="submit">Send</button></form>');
  let inserted;
  f.document.execCommand = (command, _ui, text) => { assert.equal(command, 'insertText'); inserted = text; f.editor.textContent = text; return true; };
  f.fire('drop', { transfer: { types: ['text/plain', 'text/html'], getData: type => type === 'text/html' ? '<b>Text</b><script>evil()</script>' : 'Text' } });
  await settle(); assert.equal(inserted, 'DraftText'); assert.equal(f.editor.querySelector('script,b'), null); assert.deepEqual(f.errors, []);
});

test('a reused editor changing conversations before the write keeps its new draft', async t => {
  const f = fixture(t); f.editor.value = 'Same draft';
  const write = f.adapter.writeDraft;
  f.adapter.writeDraft = (text, options) => {
    f.window.history.replaceState({}, '', '/new-conversation');
    return write(text, options);
  };
  f.fire(); await settle(); assert.equal(f.editor.value, 'Same draft'); assert.match(f.errors[0], /会话.*变化/);
});

test('disposing the text fallback removes its listeners', t => {
  const f = fixture(t); f.dispose();
  const event = new f.window.Event('drop', { bubbles: true, cancelable: true }); f.editor.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false); assert.deepEqual(f.writes, []);
});
