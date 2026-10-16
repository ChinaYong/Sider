import test from 'node:test';
import assert from 'node:assert/strict';
import { planRelease, githubRequest } from '../scripts/release.mjs';

function fixture(entries = {}) {
  const calls = [];
  return {
    calls,
    options: { repository: 'example/sider', tag: 'v0.7.2', sha: 'current-commit', request: async endpoint => {
      calls.push(endpoint);
      const value = entries[endpoint.replace('/repos/example/sider', '')];
      if (value instanceof Error) throw value;
      return value ?? null;
    } },
  };
}

test('an unpublished version plans a new tag and release', async () => {
  const f = fixture();
  assert.deepEqual(await planRelease(f.options), { publish: true, tagExists: false });
  assert.equal(f.calls.length, 2);
});

test('an existing published release is skipped without touching its tag', async () => {
  const f = fixture({ '/releases/tags/v0.7.2': { draft: false, prerelease: false } });
  assert.deepEqual(await planRelease(f.options), { publish: false, tagExists: true });
  assert.equal(f.calls.length, 1);
});

test('drafts and prereleases require inspection instead of being silently replaced', async () => {
  for (const release of [{ draft: true }, { prerelease: true }]) {
    await assert.rejects(planRelease(fixture({ '/releases/tags/v0.7.2': release }).options), /draft or prerelease/);
  }
});

test('an existing lightweight tag can resume publishing only for the same commit', async () => {
  for (const sha of ['current-commit', 'other-commit']) {
    const f = fixture({ '/git/ref/tags/v0.7.2': { object: { type: 'commit', sha } } });
    if (sha === 'current-commit') assert.deepEqual(await planRelease(f.options), { publish: true, tagExists: true });
    else await assert.rejects(planRelease(f.options), /does not point to this commit/);
  }
});

test('annotated tags are resolved and mismatches or missing targets stop publication', async () => {
  for (const target of [{ type: 'commit', sha: 'current-commit' }, { type: 'commit', sha: 'other-commit' }, null]) {
    const f = fixture({ '/git/ref/tags/v0.7.2': { object: { type: 'tag', sha: 'annotation' } }, '/git/tags/annotation': target && { object: target } });
    if (target?.sha === 'current-commit') assert.deepEqual(await planRelease(f.options), { publish: true, tagExists: true });
    else await assert.rejects(planRelease(f.options), /Cannot resolve|does not point/);
  }
});

test('GitHub network failures stop the release plan', async () => {
  await assert.rejects(planRelease(fixture({ '/releases/tags/v0.7.2': new Error('Network unavailable') }).options), /Network unavailable/);
});

test('only HTTP 404 means absence; authorization and server errors are surfaced without secrets', async () => {
  for (const status of [200, 404, 401, 403, 500]) {
    let seen;
    const request = githubRequest({ apiURL: 'https://api.github.test', token: 'fixture-only-token', fetchImpl: async (url, options) => {
      seen = { url, options };
      return { status, ok: status === 200, json: async () => ({ id: 1 }) };
    } });
    if (status === 200) assert.deepEqual(await request('/release'), { id: 1 });
    else if (status === 404) assert.equal(await request('/release'), null);
    else await assert.rejects(request('/release'), error => error.message.includes(String(status)) && !error.message.includes('fixture-only-token'));
    assert.equal(seen.url, 'https://api.github.test/release');
    assert.ok(seen.options.signal instanceof AbortSignal);
  }
});
