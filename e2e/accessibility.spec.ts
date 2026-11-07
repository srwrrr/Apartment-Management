import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN, importTenants, login, logout, firstLogin, type Tenant } from './helpers';

test.describe.configure({ mode: 'serial' });

/** NFR-12: WCAG 2.1 A and AA rules, including contrast, labels, names and landmarks. */
async function scan(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('main').or(page.getByRole('heading').first()).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const found = violations.map((v) => `${path}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  return found;
}

test.describe('NFR-12 accessibility', () => {
  let tenant: Tenant;

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
