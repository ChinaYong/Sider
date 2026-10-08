import { chromium as engine } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Every suite uses a fresh profile. No connection to the user's browser.
export const chromium = {
  async launchPersistentContext(profile, options) {
    const browser = await engine.launchPersistentContext(profile, { channel: 'chromium', ...options });
    const name = path.basename(process.argv[1], '.mjs');
    const messages = [];
    const attach = page => {
      page.on('pageerror', error => messages.push({ url: page.url(), error: error.message }));
      page.on('console', event => { if (event.type() === 'error') messages.push({ url: page.url(), error: event.text() }); });
    };
    browser.pages().forEach(attach); browser.on('page', attach);
    const close = browser.close.bind(browser);
    browser.close = async () => {
      try {
        for (const [index, page] of browser.pages().entries()) {
          await page.screenshot({ path: `tmp/browser/${name}-page-${index}.png`, timeout: 2500 }).catch(() => {});
        }
        await writeFile(`tmp/browser/${name}-diagnostics.json`, JSON.stringify({ browser: browser.browser().version(), fixtureOnly: true, profile, messages }, null, 2));
      } finally { await close(); }
    };
    return browser;
  },
};
