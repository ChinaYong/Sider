import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FILE_DROP_MARKER, entryDropAvailable, installFileDropCompat } from '../src/content/file-drop-compat.js';
import { dropFileAtEditor } from '../src/content/file-drop.js';

function fixture(t) {
  const { window } = new JSDOM('<form><textarea></textarea></form>', { pretendToBeVisual: true });
  window.DragEvent = class extends window.MouseEvent {
    constructor(type, options) { super(type, options); this.dataTransfer = options.dataTransfer; }
  };
  const document = window.document, editor = document.querySelector('textarea'), scope = editor.parentElement;
  const file = new window.File(['正文\nCOMPLETE-END'], '正文-sider-0123456789abcdef.txt', { type: 'text/plain' });
  const item = { kind: 'file', type: file.type, getAsFile() { assert.equal(this, item); return file; }, webkitGetAsEntry() { assert.equal(this, item); return null; } };
  const items = [item];
  const transfer = { files: [file], types: ['Files'], get items() { return items; } };
  t.after(() => window.close());
  return { window, document, editor, scope, file, item, items, transfer, drop: () => dropFileAtEditor(document, { editor, scope, transfer }) };
}

test('a compatible receiver is probed without dragging or changing the draft', t => {
  const f = fixture(t); f.editor.value = '原问题'; let drops = 0;
  f.editor.addEventListener('drop', () => drops++);
  assert.equal(entryDropAvailable(f.document, f.editor), false);
  installFileDropCompat(f.document);
  assert.equal(entryDropAvailable(f.document, f.editor), true);
  assert.equal(drops, 0); assert.equal(f.editor.value, '原问题');
});

test('entry consumers and FileList consumers receive the same complete file in one drop', async t => {
  const f = fixture(t), events = [], reads = [];
  installFileDropCompat(f.document); installFileDropCompat(f.document);
  f.editor.addEventListener('drop', event => {
    events.push(event);
    const transfer = event.dataTransfer;
    assert.equal(transfer.files[0], f.file);
    assert.equal(transfer.items[0].getAsFile(), f.file);
    assert.equal(Array.from(transfer.items)[0], transfer.items[0]);
    assert.equal([...transfer.items][0], transfer.items[0]);
    assert.equal(transfer.items.length, 1);
    assert.equal(transfer.items[0].type, 'text/plain');
    const entry = transfer.items[0].webkitGetAsEntry();
    assert.equal(entry.isFile, true); assert.equal(entry.isDirectory, false);
    assert.equal(entry.name, f.file.name); assert.equal(entry.fullPath, `/${f.file.name}`);
    entry.file(file => reads.push(file));
    assert.equal(reads.length, 0, 'file callback is asynchronous');
  });
  f.drop(); await Promise.resolve();
  assert.equal(events.length, 1); assert.equal(events[0].isTrusted, false);
  assert.deepEqual(reads, [f.file]);
  assert.equal(f.editor.hasAttribute(FILE_DROP_MARKER), false);
  assert.equal(f.item.webkitGetAsEntry(), null, 'native item is not modified');
});

test('native entries and non-file items retain their existing interfaces', t => {
  const f = fixture(t), entry = { isFile: true, name: f.file.name };
  f.item.webkitGetAsEntry = function() { assert.equal(this, f.item); return entry; };
  const text = { kind: 'string', type: 'text/plain', getAsString(callback) { callback('user data'); } };
  f.items.push(text); installFileDropCompat(f.document); f.drop();
  assert.equal(f.transfer.items[0].webkitGetAsEntry(), entry);
  assert.equal(f.transfer.items[1], text);
});

test('unmarked drops and files without an attachment ownership nonce are untouched', t => {
  const f = fixture(t); installFileDropCompat(f.document);
  const event = new f.window.DragEvent('drop', { bubbles: true, dataTransfer: f.transfer });
  f.editor.dispatchEvent(event);
  assert.equal(f.transfer.items, f.items); assert.equal(f.transfer.items[0].webkitGetAsEntry(), null);
  f.transfer.files[0] = new f.window.File(['user data'], 'user.txt', { type: 'text/plain' });
  f.drop(); assert.equal(f.transfer.items, f.items);
});

test('drop ownership markers are restored even when the editor disappears mid-sequence', t => {
  const f = fixture(t); f.editor.setAttribute(FILE_DROP_MARKER, 'previous');
  let dropped = 0;
  f.editor.addEventListener('dragenter', () => f.editor.remove());
  f.editor.addEventListener('drop', () => dropped++);
  assert.throws(f.drop, /输入框/); assert.equal(dropped, 0);
  assert.equal(f.editor.getAttribute(FILE_DROP_MARKER), 'previous');
});
