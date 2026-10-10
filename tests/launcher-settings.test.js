import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLauncherSettings, normalizeLauncherSite, launcherVisible, setLauncherSite, validateLauncherSettings } from '../src/launcher-settings.js';
import { exportConfiguration, validateConfiguration, configurationSummary } from '../src/configuration.js';

test('legacy launcher settings default to an empty blacklist without losing position', () => {
  const legacy = { floating: false, side: 'left', y: 0.2 };
  assert.deepEqual(validateLauncherSettings(legacy), { ...legacy, mode: 'blacklist', blacklist: [], whitelist: [] });
  assert.equal(launcherVisible(undefined, 'https://example.test/path'), true);
});

test('site rules normalize URLs and match only exact hostnames across ports and protocols', () => {
  const value = { blacklist: ['Example.test', 'https://example.test:8443/path', 'https://例子.测试/'] };
  assert.deepEqual(normalizeLauncherSettings(value).blacklist, ['example.test', 'xn--fsqu00a.xn--0zwm56d']);
  for (const url of ['http://example.test/another', 'https://example.test:8443/page', 'https://example.test./']) assert.equal(launcherVisible(value, url), false);
  assert.equal(launcherVisible(value, 'https://sub.example.test/'), true);
  assert.equal(launcherVisible(value, 'https://example.test.evil.test/'), true);
  assert.equal(normalizeLauncherSite('http://[::1]:8080/page'), '[::1]');
  for (const input of ['', '*.example.test', 'chrome://settings', 'https://user:pass@example.test/', 'bad address']) assert.equal(normalizeLauncherSite(input), '');
  for (const url of ['chrome://settings/', 'file:///tmp/page', 'invalid']) assert.equal(launcherVisible(undefined, url), false);
});

test('whitelist is opt-in and edits retain the inactive list and disabled global choice', () => {
  const settings = { mode: 'whitelist', whitelist: ['example.test'], blacklist: ['blocked.test'] };
  assert.equal(launcherVisible(settings, 'http://example.test:8080/path'), true);
  assert.equal(launcherVisible(settings, 'https://other.test/'), false);
  assert.equal(launcherVisible({ ...settings, floating: false }, 'https://example.test/'), false);
  const next = setLauncherSite(settings, 'https://other.test/page');
  assert.deepEqual(next.whitelist, ['example.test', 'other.test']); assert.deepEqual(next.blacklist, ['blocked.test']);
  assert.deepEqual(setLauncherSite(next, 'other.test', false).whitelist, ['example.test']);
  assert.deepEqual(settings.whitelist, ['example.test']);
});

test('configuration roundtrip and preview include both lists and reject malformed rules', () => {
  const backup = exportConfiguration({ 'sider.launcher.v1': { mode: 'whitelist', whitelist: ['example.test'], blacklist: ['blocked.test'] } });
  assert.deepEqual(validateConfiguration(backup).configuration.launcher, backup.configuration.launcher);
  assert.match(configurationSummary(exportConfiguration({}), backup), /白名单模式/);
  assert.match(configurationSummary(exportConfiguration({}), backup), /悬浮球黑名单：blocked.test/);
  for (const patch of [{ mode: 'all' }, { blacklist: 'example.test' }, { whitelist: ['chrome://settings'] }, { whitelist: [null] }]) {
    assert.throws(() => validateLauncherSettings({ ...normalizeLauncherSettings(), ...patch }), /悬浮球设置/);
  }
});
