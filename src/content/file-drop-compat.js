export const FILE_DROP_MARKER = 'data-sider-file-drop';
const PROBE = 'sider-file-drop-capability';
const INSTALLED = 'sider.file-drop.compat.v1';

/** Probe through a native DOM event: JS expandos are not shared across worlds. */
export function entryDropAvailable(document, editor) {
  const view = document.defaultView;
  if (!editor?.isConnected || typeof view.DragEvent !== 'function') return false;
  const probe = new view.Event(PROBE, { bubbles: true, composed: true, cancelable: true });
  editor.dispatchEvent(probe);
  return probe.defaultPrevented;
}

/** Keep native files and entries; supply an entry only for a memory-backed file. */
function withFileEntries(transfer) {
  const items = transfer.items;
  const wrapped = Array.from(items, item => {
    if (item.kind !== 'file') return item;
    const nativeEntry = item.webkitGetAsEntry?.();
    if (nativeEntry) return item;
    const file = item.getAsFile();
    if (!file) return item;
    const entry = {
      isFile: true, isDirectory: false, name: file.name, fullPath: `/${file.name}`,
      file(success) { queueMicrotask(() => success(file)); },
    };
    return new Proxy(item, {
      get(target, key) {
        if (key === 'webkitGetAsEntry') return () => entry;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  if (wrapped.every((item, index) => item === items[index])) return;
  // Preserve the native list's interface and method receivers, including for
  // consumers using indices, Array.from(), or for..of instead of FileList.
  const list = new Proxy(items, {
    get(target, key) {
      if (key === Symbol.iterator) return wrapped[Symbol.iterator].bind(wrapped);
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return wrapped[Number(key)];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.defineProperty(transfer, 'items', { configurable: true, get: () => list });
}

/** Run in MAIN so page handlers see the compatible wrappers on our transfer. */
export function installFileDropCompat(document) {
  const view = document.defaultView, key = Symbol.for(INSTALLED);
  if (view[key]) return;
  Object.defineProperty(view, key, { value: true });
  document.addEventListener(PROBE, event => {
    if (!event.isTrusted && event.target?.isConnected) event.preventDefault();
  }, true);
  const prepared = new WeakSet();
  const prepare = event => {
    if (event.isTrusted || !event.dataTransfer || prepared.has(event.dataTransfer)) return;
    const files = event.dataTransfer.files;
    if (files.length !== 1 || !/-sider-[a-f0-9]{16}(?:-|\.|$)/.test(files[0].name)) return;
    const owner = event.composedPath().find(node => node?.getAttribute?.(FILE_DROP_MARKER) === files[0].name);
    if (!owner) return;
    withFileEntries(event.dataTransfer);
    prepared.add(event.dataTransfer);
  };
  for (const type of ['dragenter', 'dragover', 'drop']) document.addEventListener(type, prepare, true);
}
