import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installChatGPTSessionCookieCompat } from '../src/chatgpt-session.js';

function fixture(t, url = 'https://chatgpt.com/') {
  const dom = new JSDOM('<main></main>', { url });
  t.after(() => dom.window.close());
  const document = dom.window.document, reports = [];
  const native = Object.getOwnPropertyDescriptor(dom.window.Document.prototype, 'cookie');
  const bootstrap = value => {
    const script = document.createElement('script'); script.id = 'client-bootstrap'; script.type = 'application/json';
    script.textContent = JSON.stringify(value); document.head.append(script); return script;
  };
  return { dom, document, native, reports, bootstrap, install: () => installChatGPTSessionCookieCompat(document, report => reports.push(report)) };
}

test('hidden consistency markers reuse only the current bootstrap, without copying credentials or changing actual cookies', t => {
  const f = fixture(t);
  f.document.cookie = 'ordinary=keep';
  f.dom.cookieJar.setCookieSync('session=fixture-http-only; HttpOnly; Secure; Path=/', 'https://chatgpt.com/');
  const restore = f.install();
  assert.equal(f.document.cookie, 'ordinary=keep', 'bootstrap may arrive after document_start');
  const bootstrap = f.bootstrap({ sessionCookieContext: { epoch: 'epoch; unsafe=value', account: 'workspace/fixture', session: 'private-extra' }, accessToken: 'private-token' });
  assert.equal(f.document.cookie, 'ordinary=keep; oai-client-session-epoch=epoch%3B%20unsafe%3Dvalue; _account=workspace%2Ffixture');
  assert.equal(f.native.get.call(f.document), 'ordinary=keep', 'browser cookie storage is unchanged');
  assert.deepEqual(f.reports, [{ epochFallback: true, accountFallback: true }]);
  bootstrap.remove();
  assert.match(f.document.cookie, /oai-client-session-epoch=epoch%3B%20unsafe%3Dvalue/, 'hydration removes bootstrap scripts but the document auth snapshot remains the same');
  assert.doesNotMatch(JSON.stringify(f.reports) + f.document.cookie, /private|fixture-http-only/);
  restore(); assert.equal(f.document.cookie, 'ordinary=keep');
  assert.equal(Object.hasOwn(f.document, 'cookie'), false);
});

test('visible cookie differences still reach the native ChatGPT consistency check', t => {
  const f = fixture(t);
  f.document.cookie = 'oai-client-session-epoch=actual-epoch'; f.document.cookie = '_account=actual-account';
  f.bootstrap({ sessionCookieContext: { epoch: 'old-epoch', account: 'old-account' } }); f.install();
  assert.equal(f.document.cookie, 'oai-client-session-epoch=actual-epoch; _account=actual-account');
  assert.deepEqual(f.reports, []);
});

test('all writes use the original setter and marker writes invalidate the old document fallback', t => {
  const f = fixture(t); f.bootstrap({ sessionCookieContext: { epoch: 'old-epoch', account: 'old-account' } }); f.install();
  assert.match(f.document.cookie, /old-epoch/);
  f.document.cookie = 'ordinary=new'; assert.match(f.native.get.call(f.document), /ordinary=new/);
  f.document.cookie = 'oai-client-session-epoch=; Max-Age=0; Path=/';
  f.document.cookie = '_account=new-account; Path=/';
  assert.equal(f.document.cookie, 'ordinary=new; _account=new-account');
  f.document.cookie = '_account=; Max-Age=0; Path=/'; assert.equal(f.document.cookie, 'ordinary=new');
});

test('absent or malformed bootstrap data and other origins preserve native cookies', t => {
  for (const value of ['not-json', JSON.stringify({ sessionCookieContext: { epoch: 1, account: null } }), JSON.stringify({ unrelated: 'value' })]) {
    const f = fixture(t), script = f.bootstrap({}); script.textContent = value; f.install();
    assert.equal(f.document.cookie, ''); assert.deepEqual(f.reports, []);
  }
  const other = fixture(t, 'https://other.example/'); other.bootstrap({ sessionCookieContext: { epoch: 'private' } }); other.install();
  assert.equal(Object.hasOwn(other.document, 'cookie'), false);
});

test('a borrowed getter does not supply markers to another document, and disposal respects later replacements', t => {
  const f = fixture(t), other = fixture(t, 'https://other.example/');
  f.bootstrap({ sessionCookieContext: { epoch: 'only-this-document' } }); const restore = f.install();
  const get = Object.getOwnPropertyDescriptor(f.document, 'cookie').get;
  assert.equal(get.call(other.document), '');
  const replacement = () => 'new-owner'; Object.defineProperty(f.document, 'cookie', { configurable: true, get: replacement });
  restore(); assert.equal(f.document.cookie, 'new-owner');
});
