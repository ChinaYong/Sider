import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMotion, installDialogMotion } from '../src/motion.js';

function fixture(t) {
  const dom = new JSDOM('<button id="opener">打开</button><section hidden></section><dialog></dialog>', { pretendToBeVisual: true });
  const { window } = dom, { document } = window;
  let reduced = false, listener;
  window.matchMedia = () => ({ get matches() { return reduced; }, addEventListener(_type, fn) { listener = fn; }, removeEventListener() { listener = null; } });
  const animations = [];
  window.HTMLElement.prototype.animate = function(frames, options) {
    let finish, reject;
    const animation = { node: this, frames, options, finished: new Promise((resolve, fail) => { finish = resolve; reject = fail; }), finish: () => finish(), cancel() { this.cancelled = true; reject(new Error('cancelled')); } };
    animations.push(animation); return animation;
  };
  const motion = createMotion(window);
  t.after(() => { motion.dispose(); dom.window.close(); });
  return { window, document, node: document.querySelector('section'), animations, motion, reduce() { reduced = true; listener?.(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('late exit completion never hides a reopened surface and closing blocks interaction immediately', async t => {
  const f = fixture(t); f.motion.setVisible(f.node, true); f.motion.setVisible(f.node, false);
  const exit = f.animations.at(-1); assert.equal(f.node.hidden, false); assert.equal(f.node.inert, true);
  f.motion.setVisible(f.node, true); exit.finish(); await settle();
  assert.equal(exit.cancelled, true); assert.equal(f.node.hidden, false); assert.equal(f.node.inert, undefined); assert.equal(f.node.hasAttribute('data-motion-closing'), false);
});
test('unchanged visibility does not replay animation; completed exit hides once', async t => {
  const f = fixture(t); f.motion.setVisible(f.node, true); f.motion.setVisible(f.node, true); assert.equal(f.animations.length, 1);
  f.motion.setVisible(f.node, false); f.motion.setVisible(f.node, false); assert.equal(f.animations.length, 2);
  f.animations.at(-1).finish(); await settle(); assert.equal(f.node.hidden, true);
});
test('changing reduced motion finishes a pending close and future visibility changes are immediate', async t => {
  const f = fixture(t); f.motion.setVisible(f.node, true); f.motion.setVisible(f.node, false); f.reduce();
  assert.equal(f.node.hidden, true); assert.ok(f.animations.every(animation => animation.cancelled));
  f.motion.setVisible(f.node, true); f.motion.setVisible(f.node, false); assert.equal(f.animations.length, 2); assert.equal(f.node.hidden, true);
});
test('dispose settles pending visibility and cancels all animations', async t => {
  const f = fixture(t); f.motion.setVisible(f.node, true); f.motion.setVisible(f.node, false); f.motion.dispose(); await settle();
  assert.equal(f.node.hidden, true); assert.ok(f.animations.every(animation => animation.cancelled));
});
test('an urgent hide settles an already closing surface immediately', t => {
  const f = fixture(t); f.motion.setVisible(f.node, true); f.motion.setVisible(f.node, false);
  assert.equal(f.motion.isVisible(f.node), false); assert.equal(f.node.hidden, false);
  f.motion.setVisible(f.node, false, { immediate: true }); assert.equal(f.node.hidden, true); assert.equal(f.node.inert, undefined);
});
test('dialog Escape guards retain their veto and an allowed close preserves native completion', async t => {
  const f = fixture(t), dialog = f.document.querySelector('dialog'); let closes = 0, busy = true;
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { closes++; dialog.open = false; };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  const dispose = installDialogMotion(f.document, f.motion); t.after(dispose);
  dialog.showModal(); dialog.dispatchEvent(new f.window.Event('cancel', { cancelable: true })); assert.equal(dialog.open, true); assert.equal(closes, 0);
  busy = false; dialog.dispatchEvent(new f.window.Event('cancel', { cancelable: true })); assert.equal(dialog.inert, true); assert.equal(closes, 0);
  f.animations.at(-1).finish(); await settle(); assert.equal(dialog.open, false); assert.equal(closes, 1);
});
test('dialog immediate close hands control to a native picker without waiting for animation', t => {
  const f = fixture(t), dialog = f.document.querySelector('dialog');
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  const dispose = installDialogMotion(f.document, f.motion); t.after(dispose);
  dialog.showModal(); dialog.closeImmediately(); assert.equal(dialog.open, false); assert.equal(dialog.inert, undefined);
});
