import { chromium, type Browser } from 'playwright-core';
import { ApiError } from '../lib/errors';

// One shared headless Chromium, started on first use. Browsers shape Bangla text correctly,
// which common PDF libraries do not (NFR-28).
let browser: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = chromium.launch({ args: ['--disable-dev-shm-usage'] }).then((b) => {
      b.on('disconnected', () => {
        browser = null; // restart on the next request if it ever crashes
      });
      return b;
    });
    browser.catch(() => {
      browser = null;
    });
  }
  return browser;
}

// At most two pages render at once, so a burst of downloads cannot exhaust memory.
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** HTML in, A4 PDF out. Scripts are disabled and every request except embedded data is blocked. */
export function renderPdf(html: string): Promise<Buffer> {
  return slot(async () => {
    let context;
    try {
      const b = await getBrowser();
      context = await b.newContext({ javaScriptEnabled: false, offline: true });
      await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
      return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
    } catch (e) {
      console.error('PDF rendering failed', e);
      throw new ApiError(503, 'PDF_UNAVAILABLE');
    } finally {
      await context?.close().catch(() => undefined);
    }
  });
}

export async function closePdfBrowser() {
  if (browser) await (await browser).close().catch(() => undefined);
  browser = null;
}
