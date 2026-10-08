import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await mkdir('tmp/browser', { recursive: true });
const suites = ['permissions', 'context', 'fresh-send', 'entry-drop', 'gemini-upload', 'send-picker', 'ai-web', 'unified-templates', 'motion'];
const chosen = process.argv.slice(2);
for (const suite of chosen.length ? chosen : suites) {
  if (!suites.includes(suite)) throw new Error(`Unknown browser suite: ${suite}`);
  console.log(`\nBrowser regression: ${suite}`);
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, `tests/browser/${suite}.mjs`)], { stdio: 'inherit', env: process.env });
    child.on('error', error => { console.error(error); resolve(1); });
    child.on('exit', resolve);
  });
  if (code !== 0) { console.error(`Failed stage: ${suite}. Evidence: tmp/browser/. Install Chromium using: npx playwright install chromium`); process.exit(code || 1); }
}
