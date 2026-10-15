import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function validateVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || version.split('.').some(part => Number(part) > 65535) || version === '0.0.0') {
    throw new Error('Use a stable version such as 0.7.1 (three integers from 0 to 65535, not all zero).');
  }
}

async function readFiles(directory) {
  return Promise.all(['package.json', 'package-lock.json', 'manifest.json'].map(async name => {
    const filename = path.join(directory, name);
    const source = await readFile(filename, 'utf8');
    return { name, filename, source, data: JSON.parse(source) };
  }));
}

export async function checkVersion(directory = root, tag) {
  const [pkg, lock, manifest] = await readFiles(directory);
  const version = pkg.data.version;
  validateVersion(version);
  if (lock.data.version !== version || lock.data.packages?.['']?.version !== version || manifest.data.version !== version) {
    throw new Error('Version mismatch: package.json, package-lock.json and manifest.json must agree. Run npm run version:set -- <version>.');
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match v${version}.`);
  }
  return version;
}

export async function setVersion(version, directory = root) {
  validateVersion(version);
  const files = await readFiles(directory);
  const lock = files.find(file => file.name === 'package-lock.json');
  if (!lock.data.packages?.['']) throw new Error('package-lock.json is missing the root package. Run npm install first.');
  for (const file of files) file.data.version = version;
  lock.data.packages[''].version = version;
  for (const { filename, source, data } of files) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const edited = source.replace(/^([ \t]*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
    const output = JSON.stringify(JSON.parse(edited)) === JSON.stringify(data)
      ? edited
      : `${JSON.stringify(data, null, 2)}\n`.replaceAll('\n', eol);
    await writeFile(filename, output);
  }
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, value, ...extra] = process.argv.slice(2);
    if (extra.length || !['check', 'set'].includes(command) || (command === 'set' && !value)) {
      throw new Error('Usage: node scripts/version.mjs check [vX.Y.Z] | set X.Y.Z');
    }
    const version = command === 'set' ? await setVersion(value) : await checkVersion(root, value);
    console.log(`${command === 'set' ? 'Version updated' : 'Version verified'}: ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
