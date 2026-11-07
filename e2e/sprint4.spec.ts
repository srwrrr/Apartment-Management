import { expect, test } from '@playwright/test';
import { ADMIN, firstLogin, importTenants, login, logout, noSidewaysScroll, unique, type Tenant } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('Sprint 4: announcements, notifications, dashboard, reports', () => {
  let tenants: Tenant[];
  const title = `Water tank cleaning ${unique()}`;

  test('admin publishes an announcement to one chosen unit and sees who will receive it', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    tenants = await importTenants(page, ['', '']);

    await page.goto('/announcements/new');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Message').fill('The water will be off from 9 to 11 on Friday.');
    await page.getByLabel('Who should receive it?').selectOption('UNITS');
    await page.getByLabel('Search a unit to add').fill(tenants[0]!.unit);
    await page.getByRole('button', { name: `+ ${tenants[0]!.unit}` }).click();
    await expect(page.getByTestId('reach')).toHaveText('This will reach 1 residents.');
    await noSidewaysScroll(page);
    await page.getByRole('button', { name: 'Publish' }).click();

    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByTestId('read-summary')).toHaveText('0 of 1 have read it');
    await expect(page.getByText('Not read yet')).toBeVisible();
    await expect(page.getByText(tenants[0]!.name)).toBeVisible();
  });

  test('the chosen resident gets a notification and an unread badge; opening it marks it read', async ({ page }) => {
    await firstLogin(page, tenants[0]!.email, tenants[0]!.temp);
    await expect(page.getByTestId('unread-badge')).toHaveText('1');

    await page.goto('/notifications');
    const note = page.getByTestId('notification').first();
    await expect(note).toContainText(`New announcement: ${title}`);
    await expect(note).toContainText('Unread');

    await page.goto('/announcements');
    await expect(page.getByTestId('announcement').filter({ hasText: title })).toContainText('New');
    await page.getByRole('link', { name: new RegExp(title) }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText('The water will be off from 9 to 11 on Friday.')).toBeVisible();
    await noSidewaysScroll(page);

    await page.goto('/notifications');
    await expect(page.getByTestId('notification').first()).not.toContainText('Unread');
    await expect(page.getByTestId('unread-badge')).toHaveCount(0);
    await logout(page);
  });

  test('another resident is not notified and does not see it', async ({ page }) => {
    await firstLogin(page, tenants[1]!.email, tenants[1]!.temp);
    await expect(page.getByTestId('unread-badge')).toHaveCount(0);
    await page.goto('/announcements');
    await expect(page.getByText(title)).toHaveCount(0);
    await expect(page.getByText('No announcements.')).toBeVisible();
    await logout(page);
  });

  test('the administrator now sees it was read', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/announcements');
    await page.getByRole('link', { name: new RegExp(title) }).click();
    await expect(page.getByTestId('read-summary')).toHaveText('1 of 1 have read it');
    await expect(page.getByText('Everyone has read it.')).toBeVisible();
  });

  test('the administrator can edit and then archive it', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/announcements');
    await page.getByRole('link', { name: new RegExp(title) }).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Message').fill('Moved to Saturday, 9 to 11.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Moved to Saturday, 9 to 11.')).toBeVisible();
    await expect(page.getByText(/Edited /)).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('Archived').first()).toBeVisible();
    await page.goto('/announcements');
    await expect(page.getByText(title)).toHaveCount(0);
  });

  test('the dashboard and both reports load for the administrator, and a resident cannot open them', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome, Demo Admin' })).toBeVisible();
    await expect(page.getByTestId('dash-billed')).toBeVisible();
    await expect(page.getByTestId('dash-units')).toBeVisible();
    await expect(page.getByTestId('trend').locator('li')).toHaveCount(6);
    await page.getByRole('button', { name: 'Show as table' }).click();
    await expect(page.getByTestId('trend-table').locator('tbody tr')).toHaveCount(6);
    await page.getByRole('button', { name: 'Show as chart' }).click();
    await noSidewaysScroll(page);

    await page.goto('/reports');
    await expect(page.getByTestId('finance-table')).toBeVisible();
    await expect(page.getByTestId('fin-billed')).toBeVisible();
    // The period is in the address and can be changed; a backwards period is explained, not shown as a crash.
    await page.goto('/reports?from=2026-05&to=2026-01');
    await expect(page.getByText('The end month must not be before the start month.')).toBeVisible();
    await noSidewaysScroll(page);
    await logout(page);

    await login(page, { id: tenants[0]!.email, pw: 'ResidentNew1' });
    await page.goto('/reports');
    await expect(page.getByTestId('finance-table')).toHaveCount(0);
    await page.goto('/announcements/new');
    await expect(page.getByLabel('Title')).toHaveCount(0);
  });
});
