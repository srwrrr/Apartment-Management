import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN, importTenants, login, logout, firstLogin, type Tenant } from './helpers';

test.describe.configure({ mode: 'serial' });

/** NFR-12: WCAG 2.1 A and AA rules, including contrast, labels, names and landmarks. */
async function scan(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('main').or(page.getByRole('heading').first()).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  // axe skips contrast over a background image, so the decorative light is taken away and every text colour is
  // really measured against the glass. 'text over the brightest background' below covers what the light adds.
  await page.addStyleTag({ content: '.ambient { display: none !important; }' });
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const found = violations.map((v) => `${path}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  return found;
}

test.describe('NFR-12 accessibility', () => {
  let tenant: Tenant;

  test('text over the brightest background', async ({ page }) => {
    await page.goto('/login');
    await page.addStyleTag({ content: '#root { visibility: hidden; }' });
    const shot = (await page.screenshot()).toString('base64');
    const { brightest, tokens } = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const c = canvas.getContext('2d')!;
      c.drawImage(img, 0, 0);
      const d = c.getImageData(0, 0, img.width, img.height).data;
      let best = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > best[0]! + best[1]! + best[2]!) best = [d[i]!, d[i + 1]!, d[i + 2]!];
      const css = getComputedStyle(document.documentElement);
      const read = (n: string) => css.getPropertyValue(`--color-${n}`).trim();
      return { brightest: best, tokens: { ink: read('ink'), muted: read('muted'), accent: read('accent'), danger: read('danger'), surface: read('surface') } };
    }, shot);

    const hex = (v: string) => [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const [sr, sg, sb, alpha] = tokens.surface.match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
    const glass = brightest.map((v, i) => [sr, sg, sb][i]! * alpha + v * (1 - alpha));
    for (const name of ['ink', 'muted', 'accent', 'danger'] as const) {
      expect(contrast(hex(tokens[name]), brightest), `${name} straight on the background`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(tokens[name]), glass), `${name} on glass`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the login page', async ({ page }) => {
    expect(await scan(page, '/login')).toEqual([]);
  });

  test('every administrator page', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, ADMIN);
    [tenant] = (await importTenants(page, [''])) as [Tenant];
    const found: string[] = [];
    for (const path of ['/', '/units', '/residents', '/bills', '/bills/generate', '/fees', '/requests', '/announcements', '/announcements/new', '/groups', '/scheduled-tasks', '/emergency', '/payment-reports', '/expenses', '/reports', '/search?q=demo', '/activity', '/notifications', '/directory', '/staff', '/import', '/settings']) {
      found.push(...(await scan(page, path)));
    }
    expect(found).toEqual([]);
    await logout(page);
  });

  test('every resident page', async ({ page }) => {
    test.setTimeout(120_000);
    await firstLogin(page, tenant.email, tenant.temp);
    const found: string[] = [];
    for (const path of ['/', '/bills', '/statement', '/requests', '/requests/new', '/announcements', '/emergency', '/notifications', '/profile']) {
      found.push(...(await scan(page, path)));
    }
    expect(found).toEqual([]);
  });

  test('the main actions can be reached with the keyboard alone', async ({ page }) => {
    await page.goto('/login');
    await page.keyboard.press('Tab'); // the first stop is the skip link
    await expect(page.locator(':focus')).toBeVisible();
    await page.getByLabel('Email or mobile number').focus();
    await page.keyboard.type(ADMIN.id);
    await page.keyboard.press('Tab');
    await page.keyboard.type(ADMIN.pw);
    await page.keyboard.press('Enter');
    await expect(page).not.toHaveURL(/\/login/);
  });
});
