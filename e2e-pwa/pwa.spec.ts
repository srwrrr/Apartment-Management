import { expect, test, type Page } from '@playwright/test';

const ADMIN = { id: 'admin@demo.local', pw: 'Admin1234' };

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email or mobile number').fill(ADMIN.id);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.pw);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Waits until the service worker has taken control of this page. */
const controlled = (page: Page) =>
  page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });

test('FR-48 the app can be installed: full-screen, with a name and icons', async ({ page }) => {
  await page.goto('/login');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await page.request.get(href!)).json();
  expect(manifest).toMatchObject({ name: 'Apartment Management', short_name: 'Apartment', display: 'standalone', start_url: '/' });
  for (const icon of manifest.icons) {
    const res = await page.request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  }
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  // iPhones read their own tags, not the manifest.
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect((await page.request.get(apple!)).status()).toBe(200);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
});

test('FR-48 without internet a friendly page appears, in both languages, instead of a browser error', async ({ page, context }) => {
  await page.goto('/login');
  await controlled(page);
  await context.setOffline(true);
  await page.goto('/bills');
  await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'আপনি অফলাইনে আছেন' })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: /Try again/ }).click();
  await expect(page.getByLabel('Email or mobile number')).toBeVisible(); // back in the app
});

test('FR-48 nothing private is stored on the device', async ({ page, context }) => {
  await page.goto('/login');
  await controlled(page);
  await login(page);
  for (const path of ['/', '/bills', '/residents', '/reports', '/notifications']) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
  }
  await page.waitForLoadState('networkidle');
  const stored = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) urls.push(r.url);
    return urls;
  });
  expect(stored.length).toBeGreaterThan(0); // the app's own files are there
  expect(stored.filter((u) => u.includes('/api/'))).toEqual([]);

  // Offline, a data request fails rather than being answered from the device.
  await context.setOffline(true);
  const fromDevice = await page.evaluate(() => fetch('/api/auth/me').then((r) => r.status, () => 'failed'));
  expect(fromDevice).toBe('failed');
});
