export const MOTION = Object.freeze({ feedback: 120, enter: 180, exit: 120, reorder: 150, easing: 'cubic-bezier(.2,.8,.2,1)' });

/** One animation per element; late completions cannot hide a reopened surface. */
export function createMotion(view) {
  const preference = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const active = new Map(), visibility = new WeakMap();
  let disposed = false;
  const reduced = () => Boolean(preference?.matches);
  function cancel(node) {
    const record = active.get(node);
    if (!record) return;
    active.delete(node); record.animation.cancel();
  }
  function animate(node, frames, duration = MOTION.enter, complete = () => {}) {
    cancel(node);
    if (disposed || reduced() || !node.isConnected || !node.animate) { complete(); return; }
    const animation = node.animate(frames, { duration, easing: MOTION.easing });
    const record = { animation, complete }; active.set(node, record);
    animation.finished.then(() => {
      if (active.get(node) !== record) return;
      active.delete(node); complete();
    }, () => {});
  }
  function enter(node, { fadeOnly = false, duration = MOTION.enter } = {}) {
    animate(node, fadeOnly ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], duration);
  }
  function setVisible(node, visible, { open = () => { node.hidden = false; }, close = () => { node.hidden = true; }, immediate = false, fadeOnly = false } = {}) {
    let state = visibility.get(node);
    if (!state) { state = { visible: node.tagName === 'DIALOG' ? node.open : !node.hidden, inert: node.inert }; visibility.set(node, state); }
    if (state.visible === visible) {
      if (!visible && immediate && active.has(node)) { const record = active.get(node); cancel(node); record.complete(); }
      return;
    }
    state.visible = visible; cancel(node);
    if (visible) {
      node.inert = state.inert; node.removeAttribute('data-motion-closing'); open();
      if (!immediate) enter(node, { fadeOnly });
    } else {
      state.inert = node.inert; node.inert = true; node.setAttribute('data-motion-closing', '');
      const finish = () => { close(); node.inert = state.inert; node.removeAttribute('data-motion-closing'); };
      if (immediate) finish();
      else animate(node, fadeOnly ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px)' }], MOTION.exit, finish);
    }
  }
  // Preserve the current visual position when interrupting an earlier move;
  // cancel transforms before the caller mutates/reads the new layout.
  function capture(nodes) {
    if (disposed || reduced()) return new Map();
    const result = new Map();
    for (const node of nodes) if (node.isConnected) result.set(node, node.getBoundingClientRect());
    for (const node of result.keys()) cancel(node);
    return result;
  }
  function rearrange(before, nodes) {
    if (disposed || reduced()) return;
    const after = [...nodes].map(node => [node, node.getBoundingClientRect()]);
    for (const [node, rect] of after) {
      const previous = before.get(node); if (!previous) continue;
      const x = previous.left - rect.left, y = previous.top - rect.top;
      if (Math.abs(x) + Math.abs(y) > .5) animate(node, [{ transform: `translate(${x}px,${y}px)` }, { transform: 'none' }], MOTION.reorder);
    }
  }
  const changed = () => {
    if (!reduced()) return;
    for (const [node, record] of [...active]) { cancel(node); record.complete(); }
  };
  preference?.addEventListener?.('change', changed);
  return { enter, animate, cancel, setVisible, capture, rearrange, reduced, isVisible(node) { return visibility.get(node)?.visible ?? (node.tagName === 'DIALOG' ? node.open : !node.hidden); }, dispose() {
    disposed = true; preference?.removeEventListener?.('change', changed);
    for (const [node, record] of [...active]) { cancel(node); record.complete(); }
  } };
}

/** Keep native modal focus/stacking and the caller's existing cancel guards. */
export function installDialogMotion(document, motion) {
  const registrations = [];
  for (const dialog of document.querySelectorAll('dialog')) {
    const showModal = dialog.showModal.bind(dialog), close = dialog.close.bind(dialog);
    dialog.showModal = () => motion.setVisible(dialog, true, { open: () => { if (!dialog.open) showModal(); } });
    dialog.close = value => motion.setVisible(dialog, false, { close: () => close(value) });
    dialog.closeImmediately = value => motion.setVisible(dialog, false, { close: () => close(value), immediate: true });
    // Installed after feature listeners so e.g. a busy import can veto Escape.
    const cancel = event => { if (!event.defaultPrevented) { event.preventDefault(); dialog.close(); } };
    dialog.addEventListener('cancel', cancel); registrations.push([dialog, cancel, showModal, close]);
  }
  return () => { for (const [dialog, listener, showModal, close] of registrations) { dialog.removeEventListener('cancel', listener); dialog.showModal = showModal; dialog.close = close; delete dialog.closeImmediately; } };
}
