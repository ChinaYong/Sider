import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = path.join(root, 'dist');
await mkdir(outdir, { recursive: true });
const common = { bundle: true, target: ['chrome116'], sourcemap: false, legalComments: 'eof', outdir, logLevel: 'info' };
await build({ ...common, entryPoints: { background: path.join(root, 'src/background.js'), panel: path.join(root, 'src/panel.js') }, format: 'esm' });
await build({ ...common, entryPoints: { 'launcher-content': path.join(root, 'src/content/launcher.js'), 'page-content': path.join(root, 'src/content/page.js'), 'ai-content': path.join(root, 'src/content/chatgpt.js'), 'chatgpt-content': path.join(root, 'src/content/chatgpt.js'), 'file-drop-main': path.join(root, 'src/content/file-drop-main.js') }, format: 'iife' });
for (const [source, dest] of [['manifest.json', 'manifest.json'], ['src/panel.html', 'panel.html'], ['src/styles.css', 'styles.css']]) {
  await copyFile(path.join(root, source), path.join(outdir, dest));
}
const iconDir = path.join(outdir, 'icons');
await mkdir(iconDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const filename = `icon-${size}.png`;
  await copyFile(path.join(root, 'assets', 'icons', filename), path.join(iconDir, filename));
}
const packages = ['@mozilla/readability', 'turndown', 'turndown-plugin-gfm', 'css-tree', 'mdn-data', 'source-map-js'];
let notices = 'Sider third-party notices\n\n';
for (const name of packages) {
  const packageDir = path.join(root, 'node_modules', name);
  const metadata = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  notices += `${name} ${metadata.version} (${metadata.license})\n`;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT']) {
    try { notices += `${await readFile(path.join(packageDir, filename), 'utf8')}\n\n`; break; } catch {}
  }
}
await writeFile(path.join(outdir, 'THIRD_PARTY_NOTICES.txt'), notices);
console.log('Extension ready: dist/');
