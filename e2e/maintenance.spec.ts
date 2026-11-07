import { expect, test, type Page } from '@playwright/test';
import { ADMIN, VIEWER, createAdmin, firstLogin, importTenants, login, logout, noSidewaysScroll, openMenu, unique, type Tenant } from './helpers';

const MANAGER = { id: 'manager@demo.local', pw: 'Manager1234' }; // view all, review, assign
const CARETAKER = { id: 'staff@demo.local', pw: 'Staff1234' }; // no maintenance permissions: works on what is assigned
const CARETAKER_NAME = 'Demo Caretaker';

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const photo = (name = 'leak.png') => ({ name, mimeType: 'image/png', buffer: PNG });
const path = (url: string) => new URL(url).pathname;

/** The resident reports a problem. Returns the address of the new request. */
async function report(page: Page, o: { title: string; description?: string; category?: string; photos?: boolean }) {
  await page.goto('/requests/new');
  await page.getByLabel('Short title').fill(o.title);
  await page.getByLabel('Describe the problem').fill(o.description ?? 'The problem started yesterday evening and is getting worse.');
  if (o.category) await page.getByLabel('Category').selectOption({ label: o.category });
  if (o.photos) await page.getByTestId('photo-input').setInputFiles([photo('leak.png')]);
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  return page.url();
}

/** The manager sets a priority and assigns the request to the caretaker. */
async function reviewAndAssign(page: Page, url: string, priority = 'High') {
  await page.goto(path(url));
  await page.getByLabel('Priority').selectOption({ label: priority });
  await page.getByRole('button', { name: 'Save priority' }).click();
  await expect(page.getByText('Under review').first()).toBeVisible();
  await page.getByLabel('Assign to').selectOption({ label: CARETAKER_NAME });
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByTestId('assignee')).toHaveText(CARETAKER_NAME);
}

test.describe.configure({ mode: 'serial' });

test.describe('Sprint 3: maintenance requests', () => {
  let a: Tenant;
  let b: Tenant;
  let urlA = ''; // the request that goes through the whole journey

  test('a resident reports a problem with a photo and can follow it; a neighbour cannot see it', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    [a, b] = await importTenants(page, ['', '']);
    await logout(page);

    await firstLogin(page, a.email, a.temp);
    await page.getByRole('link', { name: 'Report a problem' }).click();
    await expect(page).toHaveURL(/\/requests\/new/);
    await expect(page.getByText(a.unit)).toBeVisible(); // the apartment is filled in for them (FR-17)

    // mistakes are explained next to the field, and nothing is sent
    await page.getByLabel('Short title').fill('Hi');
    await page.getByLabel('Describe the problem').fill('short');
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page).toHaveURL(/\/requests\/new/);

    // a file that is not a picture is turned away before it is even sent (BR-19)
    await page.getByTestId('photo-input').setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }]);
    await expect(page.getByText('Only real JPG, PNG or WEBP photos are allowed.')).toBeVisible();

    urlA = await report(page, { title: `Bathroom light flickers ${a.unit}`, category: 'Electrical', photos: true });
    await expect(page.getByRole('heading', { name: new RegExp('Bathroom light flickers') })).toBeVisible();
    await expect(page.getByText('Submitted').first()).toBeVisible();
    await expect(page.getByText('Electrical')).toBeVisible();
    await expect(page.getByText('Request submitted')).toBeVisible(); // the first line of the timeline
    const img = page.getByTestId('photos').getByRole('img');
    await expect(img).toBeVisible();
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true); // the photo really loaded
    const photoSrc = await img.getAttribute('src');
    for (const name of ['Priority', 'Assign to']) await expect(page.getByLabel(name)).toHaveCount(0); // staff controls are not there
    await noSidewaysScroll(page);

    await page.goto('/requests');
    await expect(page.getByRole('link', { name: /Bathroom light flickers/ })).toBeVisible();

    // the neighbour sees none of this
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await firstLogin(other, b.email, b.temp);
    await other.goto('/requests');
    await expect(other.getByText('No requests found.')).toBeVisible();
    await other.goto(path(urlA));
    await expect(other.getByText('We could not find what you asked for.')).toBeVisible();
    expect((await other.request.get(photoSrc!)).status()).toBe(404); // nor the photo itself
    await ctx.close();
  });

  test('the manager reviews it, sets a priority, assigns it, and leaves an internal note', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page, MANAGER);
    await page.goto('/requests');
    await page.getByRole('button', { name: 'New requests' }).click();
    const row = page.getByRole('link', { name: /Bathroom light flickers/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Submitted');
    await row.click();
    await expect(page.getByTestId('description')).toContainText('getting worse');

    await reviewAndAssign(page, urlA);
    await expect(page.getByText('High').first()).toBeVisible();
    await expect(page.getByTestId('update').filter({ hasText: 'Priority: Not set → High' })).toBeVisible();
    await expect(page.getByTestId('update').filter({ hasText: `Assigned to ${CARETAKER_NAME}` })).toBeVisible();

    // an internal note and a shared one
    await page.getByLabel('Note', { exact: true }).fill('Tenant works nights, call after 10am');
    await page.getByLabel('Internal note (staff only)').check();
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('Note added.')).toBeVisible();
    await page.getByLabel('Note', { exact: true }).fill('We will visit tomorrow morning');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByTestId('update').filter({ hasText: 'Tenant works nights' }).getByText('Internal')).toBeVisible();
    await noSidewaysScroll(page);
  });

  test('the caretaker sees it as a task, does the work, and cannot do the manager’s jobs', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page, CARETAKER);
    await openMenu(page);
    await expect(page.getByRole('navigation', { name: 'main' }).getByRole('link', { name: 'My tasks' })).toBeVisible();
    await page.goto('/requests');
    await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();
    await page.getByRole('link', { name: /Bathroom light flickers/ }).click();

    // not their job to prioritise, assign or reject
    for (const name of ['Priority', 'Assign to']) await expect(page.getByLabel(name)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reject this request' })).toHaveCount(0);
    await expect(page.getByText('Tenant works nights')).toBeVisible(); // staff do see internal notes

    await page.getByRole('button', { name: 'Start work' }).click();
    await expect(page.getByText('In progress').first()).toBeVisible();

    // resolving needs an explanation
    await page.getByRole('button', { name: 'Mark as resolved' }).click();
    await expect(page.getByRole('button', { name: 'Mark as resolved' })).toBeDisabled();
    await page.getByLabel('What was done?').fill('Replaced the faulty switch and tested the light');
    await page.getByRole('button', { name: 'Mark as resolved' }).click();
    await expect(page.getByText('Resolved').first()).toBeVisible();
    await expect(page.getByTestId('update').filter({ hasText: 'Replaced the faulty switch' })).toBeVisible();
    await expect(page.getByText('Mark as resolved')).toHaveCount(0);
  });

  test('the resident sees the progress and the shared notes but not the internal note, and confirms the fix', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page, { id: a.email, pw: 'ResidentNew1' });
    await page.goto(path(urlA));
    await expect(page.getByText('Resolved').first()).toBeVisible();
    await expect(page.getByTestId('assignee')).toHaveText(CARETAKER_NAME);
    await expect(page.getByText('We will visit tomorrow morning')).toBeVisible();
    await expect(page.getByText('Replaced the faulty switch and tested the light')).toBeVisible();
    await expect(page.getByText('Tenant works nights')).toHaveCount(0); // internal
    await expect(page.getByTestId('update').filter({ hasText: CARETAKER_NAME }).first()).toBeVisible(); // who did what

    await expect(page.getByText(/closes by itself after 7 days/)).toBeVisible();
    await page.getByRole('button', { name: 'Yes, it is fixed' }).click();
    await expect(page.getByText('Closed').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Yes, it is fixed' })).toHaveCount(0);
    await expect(page.getByText('This request is finished.')).toBeVisible();
    await noSidewaysScroll(page);
  });

  test('a rejection explains why; the resident can cancel a request that has not been looked at', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await login(page, { id: a.email, pw: 'ResidentNew1' });
    const rejected = await report(page, { title: `Neighbour’s noisy dog ${a.unit}`, category: 'Other' });
    const cancelled = await report(page, { title: `Changed my mind ${a.unit}`, category: 'Cleaning' });

    // cancel (after a "are you sure")
    await page.goto(path(cancelled));
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Cancel this request' }).click();
    await expect(page.getByText('Cancelled').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel this request' })).toHaveCount(0);

    // the manager rejects the other one, with a reason
    const ctx = await browser.newContext();
    const m = await ctx.newPage();
    await login(m, MANAGER);
    await m.goto(path(rejected));
    await m.getByRole('button', { name: 'Reject this request' }).click();
    await expect(m.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled(); // a reason is needed
    await m.getByLabel('Reason (the resident will see this)').fill('This is a matter between neighbours, not the building');
    await m.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(m.getByText('Rejected').first()).toBeVisible();
    await ctx.close();

    await page.goto(path(rejected));
    await expect(page.getByText('Rejected').first()).toBeVisible();
    await expect(page.getByText('This is a matter between neighbours, not the building')).toBeVisible();
    // once the manager has acted, the resident can no longer cancel
    await expect(page.getByRole('button', { name: 'Cancel this request' })).toHaveCount(0);
  });

  test('a resident can say it is not fixed, and it goes back to being worked on', async ({ page, browser }) => {
    test.setTimeout(150_000);
    await login(page, { id: a.email, pw: 'ResidentNew1' });
    const url = await report(page, { title: `Kitchen tap drips ${a.unit}`, category: 'Plumbing', photos: true });

    const mctx = await browser.newContext();
    const m = await mctx.newPage();
    await login(m, MANAGER);
    await reviewAndAssign(m, url, 'Medium');
    await mctx.close();

    const cctx = await browser.newContext();
    const c = await cctx.newPage();
    await login(c, CARETAKER);
    await c.goto(path(url));
    await c.getByRole('button', { name: 'Start work' }).click();
    await c.getByRole('button', { name: 'Mark as resolved' }).click();
    await c.getByLabel('What was done?').fill('Tightened the tap');
    await c.getByRole('button', { name: 'Mark as resolved' }).click();
    await expect(c.getByText('Resolved').first()).toBeVisible();
    await cctx.close();

    await page.goto(path(url));
    await page.getByRole('button', { name: 'It is not fixed' }).click();
    await expect(page.getByRole('button', { name: 'Reopen request' })).toBeDisabled(); // an explanation is needed
    await page.getByLabel('What is still wrong?').fill('It started dripping again this morning');
    await page.getByRole('button', { name: 'Reopen request' }).click();
    await expect(page.getByText('In progress').first()).toBeVisible();
    await expect(page.getByText('It started dripping again this morning')).toBeVisible();
    await expect(page.getByTestId('assignee')).toHaveText(CARETAKER_NAME); // the same person picks it up
  });

  test('staff without maintenance permissions cannot open someone else’s request', async ({ page }) => {
    await login(page, VIEWER);
    await page.goto(path(urlA));
    await expect(page.getByText('You do not have permission to do this.')).toBeVisible();
    await page.goto('/requests');
    await expect(page.getByText('Nothing is assigned to you right now.')).toBeVisible();
  });

  test('the manager can filter all requests; the administrator sees them too', async ({ page }) => {
    await login(page, MANAGER);
    await page.goto('/requests');
    await page.getByLabel('Status', { exact: true }).selectOption({ label: 'Rejected' });
    // each run of this suite uses its own apartment, so look for this run's requests by the unit number in the title
    const dog = page.getByRole('link', { name: new RegExp(`noisy dog ${a.unit}`) });
    const light = page.getByRole('link', { name: new RegExp(`Bathroom light flickers ${a.unit}`) });
    await expect(dog).toBeVisible();
    await expect(light).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Electrical' });
    await expect(light).toBeVisible();
    await page.getByLabel('Category', { exact: true }).selectOption({ label: 'All' });
    await page.getByPlaceholder('Search by number, title or unit').fill(a.unit);
    await expect(light).toBeVisible();
    await expect(page.getByRole('link').filter({ hasText: /Closed/ }).first()).toBeVisible();
    await noSidewaysScroll(page);

    await logout(page);
    await login(page, ADMIN);
    await page.goto('/requests');
    await expect(page.getByRole('heading', { name: 'Maintenance requests' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Bathroom light flickers/ }).first()).toBeVisible();
  });

  test('the request pages work in Bangla with Large text, without sideways scrolling', async ({ page }) => {
    const me = await createAdmin('অনুরোধ প্রশাসক');
    await page.goto('/login');
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.getByRole('button', { name: /^A\+/ }).click();
    await page.getByLabel('ইমেইল বা মোবাইল নম্বর').fill(me.id);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill(me.pw);
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();
    await expect(page.getByRole('heading', { name: /স্বাগতম/ })).toBeVisible();

    await page.goto('/requests');
    await expect(page.getByRole('heading', { name: 'রক্ষণাবেক্ষণ অনুরোধ' })).toBeVisible();
    await noSidewaysScroll(page);
    await page.getByRole('link', { name: /Bathroom light flickers/ }).first().click();
    await expect(page.getByRole('heading', { name: 'যা যা ঘটেছে' })).toBeVisible();
    await expect(page.getByText('বন্ধ').first()).toBeVisible(); // the status, in Bangla
    await noSidewaysScroll(page);
  });

  test('the resident’s own pages work in Bangla too', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.getByLabel('ইমেইল বা মোবাইল নম্বর').fill(a.email);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill('ResidentNew1');
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();
    await expect(page.getByRole('heading', { name: /স্বাগতম/ })).toBeVisible();
    await page.goto('/requests');
    await expect(page.getByRole('heading', { name: 'আমার অনুরোধ' })).toBeVisible();
    await page.getByRole('link', { name: 'সমস্যা জানান' }).click();
    await expect(page.getByLabel('সংক্ষিপ্ত শিরোনাম')).toBeVisible();
    await noSidewaysScroll(page);
    void unique;
  });
});
