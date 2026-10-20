const MARKERS = { 'oai-client-session-epoch': 'epoch', _account: 'account' };

/** Network SameSite exemptions do not apply to document.cookie in an extension
 * iframe. Reuse only markers already disclosed in this document's bootstrap;
 * leave actual cookies, credentials, writes and visible mismatches untouched. */
export function installChatGPTSessionCookieCompat(document, onApplied = () => {}) {
  if (document.location?.origin !== 'https://chatgpt.com') return () => {};
  const own = Object.getOwnPropertyDescriptor(document, 'cookie');
  let descriptor = own;
  for (let proto = Object.getPrototypeOf(document); !descriptor && proto; proto = Object.getPrototypeOf(proto)) descriptor = Object.getOwnPropertyDescriptor(proto, 'cookie');
  if (!descriptor?.get || !descriptor?.set || own && !own.configurable) return () => {};
  let snapshot, reported = false;
  const invalidated = new Set();
  function markers() {
    if (snapshot !== undefined) return snapshot;
    const node = document.getElementById('client-bootstrap');
    if (!node) return null;
    const text = node.textContent;
    if (text.length > 4 * 1024 * 1024) return null;
    try {
      const context = JSON.parse(text)?.sessionCookieContext;
      snapshot = {};
      for (const field of Object.values(MARKERS)) if (typeof context?.[field] === 'string' && context[field].length > 0 && context[field].length <= 512) snapshot[field] = context[field];
      return snapshot;
    } catch { return null; }
  }
  function get() {
    const cookies = Reflect.apply(descriptor.get, this, []);
    if (this !== document) return cookies;
    const context = markers();
    if (!context) return cookies;
    const names = new Set(cookies.split(';').map(value => value.trim().split('=', 1)[0]));
    const added = [];
    for (const [name, field] of Object.entries(MARKERS)) if (!names.has(name) && !invalidated.has(name) && context[field]) added.push(`${name}=${encodeURIComponent(context[field])}`);
    if (added.length && !reported) {
      reported = true;
      try { onApplied({ epochFallback: added.some(value => value.startsWith('oai-client-session-epoch=')), accountFallback: added.some(value => value.startsWith('_account=')) }); } catch {}
    }
    return [cookies, ...added].filter(Boolean).join('; ');
  }
  function set(value) {
    if (this === document && typeof value === 'string') {
      const name = value.split('=', 1)[0].trim();
      if (Object.hasOwn(MARKERS, name)) invalidated.add(name);
    }
    return Reflect.apply(descriptor.set, this, [value]);
  }
  try { Object.defineProperty(document, 'cookie', { configurable: true, enumerable: descriptor.enumerable, get, set }); }
  catch { return () => {}; }
  return () => {
    if (Object.getOwnPropertyDescriptor(document, 'cookie')?.get !== get) return;
    if (own) Object.defineProperty(document, 'cookie', own);
    else delete document.cookie;
  };
}
