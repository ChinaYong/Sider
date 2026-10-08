import { createMotion } from '../motion.js';

/** Pointer sorting stays local until one compare-and-save operation on release. */
export function installPresetSort(list, { scroller, items, save, changed = () => {}, error = () => {} }) {
  const view = list.ownerDocument.defaultView, original = [...list.children];
  const motion = createMotion(view);
  let drag = null, saving = false, frame = null, disposed = false;
  let marker = null;
  const render = rows => {
    const before = motion.capture(list.children);
    rows.forEach((row, index) => { if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null); });
    motion.rearrange(before, list.children);
  };
  const locked = new Map();
  const unlock = () => { for (const [button, disabled] of locked) button.disabled = disabled; locked.clear(); };
  function cleanup() {
    if (frame !== null) view.cancelAnimationFrame(frame); frame = null;
    drag?.row.classList.remove('dragging');
    if (marker) { marker.node.classList.remove(marker.className); marker = null; }
    list.classList.remove('sorting'); unlock();
    const old = drag; drag = null;
    if (old && list.hasPointerCapture?.(old.pointerId)) list.releasePointerCapture(old.pointerId);
  }
  function cancel() {
    if (!drag) return;
    render(original); cleanup(); if (!disposed) changed(false);
  }
  function position(y) {
    if (!drag?.moved) return;
    const others = [...list.children].filter(row => row !== drag.row);
    const listTop = list.getBoundingClientRect().top;
    const next = others.find(row => {
      // offset geometry ignores transforms applied to the neighboring rows.
      const rect = row.offsetHeight ? { top: listTop + row.offsetTop - list.offsetTop, height: row.offsetHeight } : row.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    if (drag.row.nextElementSibling !== (next || null)) {
      const before = motion.capture(others);
      list.insertBefore(drag.row, next || null);
      motion.rearrange(before, others);
    }
    const nextMarker = { node: next || others.at(-1), className: next ? 'drop-before' : 'drop-after' };
    if (marker?.node !== nextMarker.node || marker?.className !== nextMarker.className) {
      marker?.node.classList.remove(marker.className); marker = nextMarker;
      marker.node?.classList.add(marker.className);
    }
  }
  function update() {
    frame = null; if (!drag?.moved) return;
    const rect = scroller.getBoundingClientRect();
    const delta = drag.y < rect.top + 28 ? -10 : drag.y > rect.bottom - 28 ? 10 : 0;
    if (delta) scroller.scrollTop += delta;
    position(drag.y);
    if (delta) frame = view.requestAnimationFrame(update);
  }
  const schedule = () => { if (frame === null) frame = view.requestAnimationFrame(update); };
  const registrations = [];
  // Capture on the stable list: moving a captured row releases native capture.
  const onMove = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); drag.y = event.clientY;
    if (!drag.moved && Math.abs(drag.y - drag.start) >= 5) {
      drag.moved = true; drag.row.classList.add('dragging'); list.classList.add('sorting');
      for (const button of list.querySelectorAll('button,input')) if (button !== drag.handle) { locked.set(button, button.disabled); button.disabled = true; }
    }
    if (drag.moved) schedule();
  };
  const onUp = async event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    if (frame !== null) { view.cancelAnimationFrame(frame); frame = null; }
    // The last move may not have painted yet; save its actual final position.
    if (drag.moved) position(event.clientY);
    const rows = [...list.children];
    const reordered = drag.moved && rows.some((row, index) => row !== original[index]);
    cleanup();
    if (!reordered) { changed(false); return; }
    saving = true;
    try { await save(rows.map(row => items.find(item => item.id === row.dataset.sortId)), items); }
    catch (cause) { render(original); error(cause); }
    finally { saving = false; if (!disposed) changed(false); }
  };
  const onCancel = event => { if (drag && event.pointerId === drag.pointerId) cancel(); };
  for (const [type, listener] of [['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onCancel], ['lostpointercapture', onCancel]]) {
    list.addEventListener(type, listener); registrations.push([list, type, listener]);
  }
  for (const row of original) {
    const handle = row.querySelector('[data-sort-handle]');
    const onDown = event => {
      if (disposed || saving || drag || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      drag = { handle, row, pointerId: event.pointerId, start: event.clientY, y: event.clientY, moved: false };
      list.setPointerCapture?.(event.pointerId); changed(true);
    };
    const suppressClick = event => { event.preventDefault(); event.stopPropagation(); };
    for (const [type, listener] of [['pointerdown', onDown], ['click', suppressClick]]) {
      handle.addEventListener(type, listener); registrations.push([handle, type, listener]);
    }
  }
  return { get active() { return Boolean(drag || saving); }, get dragging() { return Boolean(drag); }, cancel, dispose() { disposed = true; motion.dispose(); cancel(); for (const [handle, type, listener] of registrations) handle.removeEventListener(type, listener); } };
}
