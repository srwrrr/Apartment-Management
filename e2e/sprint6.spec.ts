import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN, CASHIER, createAdmin, importTenants, login, logout, noSidewaysScroll, openMenu, unique, type Tenant } from './helpers';

test.describe.configure({ mode: 'serial' });

async function noViolations(page: Page) {
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${page.url()}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

test.describe('Sprint 6: activity log, search, maintenance report', () => {
  let tenant: Tenant;
  let unitUrl = '';

  test('what the administrator does appears on the dashboard and in the log, with who and when', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    [tenant] = (await importTenants(page, [''])) as [Tenant];
    const title = `Lift inspection ${unique()}`;
    await page.goto('/announcements/new');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Message').fill('On Sunday morning.');
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();

    await page.goto('/');
    const latest = page.getByTestId('activity').first();
    await expect(latest).toContainText('Demo Admin');
    await expect(latest).toContainText('Published an announcement');
    await expect(latest).toContainText(title);
    await noSidewaysScroll(page);

    await page.getByRole('link', { name: 'See the full log' }).click();
    await page.getByLabel('Action').selectOption('announcement.publish');
    await expect(page.getByTestId('activity').first()).toContainText(title);
    await expect(page.getByTestId('activity').filter({ hasNotText: 'Published an announcement' })).toHaveCount(0);
    await page.getByLabel('Action').selectOption('import.run');
    await expect(page.getByTestId('activity').first()).toContainText('Ran a bulk import');
    await noSidewaysScroll(page);
    await noViolations(page);
    // Nothing on this page can change an entry.
    await expect(page.getByRole('main').getByRole('button', { name: /Edit|Delete|Remove/ })).toHaveCount(0);
  });

  test('a failed login is recorded without a person', async ({ page }) => {
    await login(page, { id: tenant.email, pw: 'Definitely-wrong-1' }, false);
    await expect(page.getByRole('alert')).toBeVisible();
    await login(page, ADMIN);
    await page.goto('/activity');
    await page.getByLabel('Action').selectOption('login.failed');
    await expect(page.getByTestId('activity').first()).toContainText('Not logged in');
    await expect(page.getByTestId('activity').first()).toContainText('WRONG_PASSWORD');
  });

  test('one search box finds a resident and a unit, and opens them', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/');
    await page.getByLabel('Search residents, units, bills and requests').fill(tenant.unit);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=/);
    await page.getByTestId('search-units').getByRole('link', { name: new RegExp(tenant.unit) }).click();
    await expect(page.getByRole('heading', { name: new RegExp(tenant.unit) })).toBeVisible();
    unitUrl = new URL(page.url()).pathname;

    await page.goto('/search');
    await page.getByLabel('Search residents, units, bills and requests').fill(tenant.name);
    await expect(page.getByTestId('search-residents')).toContainText(tenant.name);
    await noSidewaysScroll(page);
    await noViolations(page);
    await page.getByLabel('Search residents, units, bills and requests').fill('zzzz-nothing');
    await expect(page.getByText('Nothing found.')).toBeVisible();
  });

  test('a cashier’s search shows bills but not residents, and the log is closed to them', async ({ page }) => {
    await login(page, CASHIER);
    await page.goto(`/search?q=${encodeURIComponent(tenant.name)}`);
    await expect(page.getByText('Nothing found.')).toBeVisible();
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Activity log' })).toHaveCount(0);
    await page.goto('/activity');
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  });

  test('residents have no search or activity log', async ({ page }) => {
    await login(page, ADMIN);
    await logout(page);
    await page.goto('/login');
    await page.getByLabel('Email or mobile number').fill(tenant.email);
    await page.getByLabel('Password', { exact: true }).fill(tenant.temp);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/change-password/);
    await page.getByLabel('Current password').fill(tenant.temp);
    await page.getByLabel('New password').fill('ResidentNew1');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Search', exact: true })).toHaveCount(0);
    await page.goto('/search');
    await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
    await page.goto('/activity');
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  });

  test('the maintenance report shows requests by status and category, and the unit page passes the accessibility scan', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Maintenance report' })).toBeVisible();
    await expect(page.getByTestId('mr-total')).toHaveText(/^\d+$/);
    await expect(page.getByTestId('mr-categories')).toBeVisible();
    await noSidewaysScroll(page);
    await noViolations(page);
    await page.goto(unitUrl);
    await expect(page.getByRole('heading', { name: new RegExp(tenant.unit) })).toBeVisible();
    await noViolations(page);
  });

  test('the new pages work in Bangla with Large text', async ({ page }) => {
    const me = await createAdmin('লগ প্রশাসক');
    await page.goto('/login');
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.getByRole('button', { name: /^A\+/ }).click();
    await page.getByLabel('ইমেইল বা মোবাইল নম্বর').fill(me.id);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill(me.pw);
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();
    await expect(page.getByRole('heading', { name: /স্বাগতম/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'সাম্প্রতিক কার্যকলাপ' })).toBeVisible();
    await noSidewaysScroll(page);

    await page.goto('/activity');
    await expect(page.getByRole('heading', { name: 'কার্যকলাপের লগ' })).toBeVisible();
    await expect(page.getByTestId('activity').first()).toContainText('লগ ইন করেছেন');
    await noSidewaysScroll(page);
    await page.goto(`/search?q=${encodeURIComponent(tenant.unit)}`);
    await expect(page.getByRole('heading', { name: 'ইউনিট', exact: true })).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'রক্ষণাবেক্ষণ রিপোর্ট' })).toBeVisible();
    await noSidewaysScroll(page);
  });
});
