import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pickSendButton, sendButtonSelector } from '../src/content/send-picker.js';

function fixture(t, html) {
  const { window } = new JSDOM(html, { pretendToBeVisual: true });
  window.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{}] : []; };
  t.after(() => window.close());
  return { window, document: window.document };
}

test('button selection escapes attribute values and prefers stable test identifiers over transient IDs', t => {
  const { document } = fixture(t, '<button id=":r1:" data-testid="send"><svg><path></path></svg></button><button data-testid="other"></button>');
  const button = document.querySelector('button');
  button.setAttribute('data-testid', 'send"\\\n消息');
  const selector = sendButtonSelector(document, button);
  assert.equal(document.querySelector(selector), button);
  assert.match(selector, /data-testid/);
  button.outerHTML = button.outerHTML.replace(':r1:', ':r2:');
  assert.equal(document.querySelector(selector).id, ':r2:');
});

test('ambiguous button labels produce a unique selector within a stable parent', t => {
  const { document } = fixture(t, '<form data-testid="active-composer"><button aria-label="Send"></button></form><form><button aria-label="Send"></button></form>');
  const button = document.querySelector('button');
  const selector = sendButtonSelector(document, button);
  assert.equal(document.querySelectorAll(selector).length, 1);
  assert.equal(document.querySelector(selector), button);
  assert.throws(() => sendButtonSelector(document, document.querySelector('form')), /发送按钮/);
  button.remove();
  assert.throws(() => sendButtonSelector(document, button), /发送按钮/);
});

test('clicking through the picker selects a disabled button without sending or modifying the draft', async t => {
  const { document, window } = fixture(t, '<textarea>Keep question</textarea><button disabled data-testid="native-send"><span>Send</span></button>');
  const editor = document.querySelector('textarea');
  editor.focus();
  let clicks = 0;
  const button = document.querySelector('button'); button.onclick = () => clicks++;
  const pending = pickSendButton(document);
  const host = document.querySelector('[data-sider-send-picker]');
  document.elementsFromPoint = () => [host, button.querySelector('span'), button, document.body];
  host.shadowRoot.querySelector('.surface').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, clientX: 50, clientY: 80 }));
  assert.deepEqual(await pending, { ok: true, selector: 'button[data-testid="native-send"]' });
  assert.equal(clicks, 0); assert.equal(editor.value, 'Keep question');
  assert.equal(document.activeElement, editor);
  assert.equal(document.querySelector('[data-sider-send-picker]'), null);
});

test('manual selection supports native submit and keyboard-focusable custom controls without selecting editable fields', async t => {
  for (const html of ['<input type="submit" id="custom-action" value="Go">', '<div tabindex="0" id="custom-action"><span>Go</span></div>']) {
    const { document, window } = fixture(t, '<textarea tabindex="0">Keep draft</textarea><input tabindex="0" value="Send"><div tabindex="0" contenteditable="plaintext-only"></div>' + html);
    for (const editable of document.querySelectorAll('textarea,input:not([type=submit]),[contenteditable]')) assert.throws(() => sendButtonSelector(document, editable), /发送按钮/);
    const button = document.querySelector('#custom-action'); let clicks = 0; button.addEventListener('click', () => clicks++);
    const pending = pickSendButton(document), host = document.querySelector('[data-sider-send-picker]');
    document.elementsFromPoint = () => [host, button.querySelector('span') || button, button, document.body];
    host.shadowRoot.querySelector('.surface').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
    const result = await pending; assert.equal(result.ok, true); assert.equal(document.querySelector(result.selector), button);
    assert.equal(clicks, 0); assert.equal(document.querySelector('textarea').value, 'Keep draft');
  }
});

test('non-button selection remains open, Escape cancels, and a later click cannot change the result', async t => {
  const { document, window } = fixture(t, '<textarea>Draft</textarea><button data-testid="send"></button>');
  const pending = pickSendButton(document);
  const host = document.querySelector('[data-sider-send-picker]');
  document.elementsFromPoint = () => [host, document.querySelector('textarea'), document.body];
  host.shadowRoot.querySelector('.surface').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
  assert.match(host.shadowRoot.querySelector('.hint').textContent, /没有可选择的按钮/);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  document.querySelector('button').click();
  assert.equal(document.querySelector('[data-sider-send-picker]'), null);
});

test('picker cancellation, navigation and timeout remove the surface and return no selector', async t => {
  for (const cause of ['cancel', 'abort', 'pagehide', 'timeout']) {
    const { document, window } = fixture(t, '<button>Send</button>');
    const controller = new AbortController();
    const pending = pickSendButton(document, { signal: controller.signal, timeoutMs: cause === 'timeout' ? 5 : 60000 });
    if (cause === 'cancel') document.querySelector('[data-sider-send-picker]').shadowRoot.querySelector('button').click();
    if (cause === 'abort') controller.abort();
    if (cause === 'pagehide') window.dispatchEvent(new window.Event('pagehide'));
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.selector, undefined);
    if (cause === 'timeout') assert.match(result.error, /超时/); else assert.equal(result.cancelled, true);
    assert.equal(document.querySelector('[data-sider-send-picker]'), null);
  }
});

test('picker controls work on a page that rejects HTML-string assignments', async t => {
  const { document, window } = fixture(t, '<button data-testid="send"></button>');
  Object.defineProperty(window.ShadowRoot.prototype, 'innerHTML', { set() { throw new Error('TrustedHTML required'); } });
  const controller = new AbortController();
  const pending = pickSendButton(document, { signal: controller.signal });
  assert.ok(document.querySelector('[data-sider-send-picker]').shadowRoot.querySelector('button'));
  controller.abort(); assert.equal((await pending).cancelled, true);
});
