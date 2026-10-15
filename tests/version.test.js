import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkVersion, setVersion } from '../scripts/version.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sider-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = {
    'package.json': { name: 'sider-context', version: '0.6.0', dependencies: { example: '^1.0.0' } },
    'package-lock.json': { version: '0.6.0', lockfileVersion: 3, packages: { '': { version: '0.6.0' }, 'node_modules/example': { version: '1.2.3' } } },
    'manifest.json': { manifest_version: 3, version: '0.6.0', permissions: ['storage'] },
  };
  await Promise.all(Object.entries(files).map(([name, data]) => writeFile(path.join(directory, name), `${JSON.stringify(data, null, 2)}\n`)));
  return directory;
}

test('version update keeps all release versions in sync without changing dependencies or permissions', async t => {
  const directory = await fixture(t);
  const manifestSource = '{\r\n  "version": "0.6.0",\r\n  "permissions": ["storage"]\r\n}\r\n';
  await writeFile(path.join(directory, 'manifest.json'), manifestSource);
  await setVersion('0.7.0', directory);
  assert.equal(await checkVersion(directory, 'v0.7.0'), '0.7.0');
  const read = async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
  assert.deepEqual((await read('package.json')).dependencies, { example: '^1.0.0' });
  assert.equal((await read('package-lock.json')).packages['node_modules/example'].version, '1.2.3');
  assert.deepEqual((await read('manifest.json')).permissions, ['storage']);
  assert.equal(await readFile(path.join(directory, 'manifest.json'), 'utf8'), manifestSource.replace('0.6.0', '0.7.0'));
});

test('release check rejects every version location drifting from package.json', async t => {
  const directory = await fixture(t);
  for (const [name, mutate] of [
    ['manifest.json', data => { data.version = '0.7.0'; }],
    ['package-lock.json', data => { data.version = '0.7.0'; }],
    ['package-lock.json', data => { data.packages[''].version = '0.7.0'; }],
  ]) {
    const filename = path.join(directory, name);
    const original = await readFile(filename, 'utf8');
    const data = JSON.parse(original);
    mutate(data);
    await writeFile(filename, JSON.stringify(data));
    await assert.rejects(checkVersion(directory), /Version mismatch/);
    await writeFile(filename, original);
  }
});

test('release tag must exactly match the version in the extension', async t => {
  const directory = await fixture(t);
  for (const tag of ['v0.7.0', '0.6.0', 'v0.6.0-beta', 'v0.6.0/other', '']) {
    await assert.rejects(checkVersion(directory, tag), /Release tag/);
  }
  assert.equal(await checkVersion(directory, 'v0.6.0'), '0.6.0');
});

test('invalid Chrome versions fail without modifying any file', async t => {
  const directory = await fixture(t);
  const names = ['package.json', 'package-lock.json', 'manifest.json'];
  const readAll = () => Promise.all(names.map(name => readFile(path.join(directory, name), 'utf8')));
  const original = await readAll();
  for (const version of ['0.0.0', '01.2.3', '1.2', '1.2.3.4', '1.2.3-beta.1', '1.2.65536', 'v1.2.3', undefined]) {
    await assert.rejects(setVersion(version, directory), /stable version/);
    assert.deepEqual(await readAll(), original);
  }
});

test('malformed lockfile is rejected before updating other version files', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '0.6.0', packages: {} }));
  await assert.rejects(setVersion('0.7.0', directory), /missing the root package/);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).version, '0.6.0');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')).version, '0.6.0');
});
