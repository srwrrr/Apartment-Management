import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';

const ADMIN = { id: 'admin@demo.local', pw: 'Admin1234' };
const STAFF_NONE = { id: 'staff@demo.local', pw: 'Staff1234' };
const STAFF_OFFICE = { id: 'office@demo.local', pw: 'Office1234' };

const run = Date.now().toString(36);
let counter = 0;
const unique = () => `${run}${counter++}`;

/** A throwaway administrator, for tests that change account-level settings. */
async function createAdmin() {
  const id = `adm${unique()}@demo.local`;
  const pw = 'Admin1234';
  const db = new Client({ connectionString: 'postgresql://apt:apt@localhost:5432/apartment_e2e' });
  await db.connect();
  await db.query(
    `INSERT INTO users (id, "loginId", "passwordHash", role, "fullName", phone, "mustChangePassword", "updatedAt")
     VALUES ($1, $2, $3, 'ADMIN', 'Lang Admin', '+8801700000001', false, now())`,
    [randomUUID(), id, await bcrypt.hash(pw, 4)],
  );
  await db.end();
  return { id, pw };
}

async function login(page: Page, who: { id: string; pw: string }, expectSuccess = true) {
  await page.goto('/login');
  await page.getByLabel('Email or mobile number').fill(who.id);
  await page.getByLabel('Password', { exact: true }).fill(who.pw);
  await page.getByRole('button', { name: 'Log in' }).click();
  // Wait until the login has really finished; navigating away earlier would cancel it.
  if (expectSuccess) await expect(page).not.toHaveURL(/\/login/);
}

/** YYYY-MM-DD for a day offset from today in Dhaka. */
function dhakaDay(offsetDays: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

async function logout(page: Page) {
  await openMenu(page);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** On a phone the navigation is behind a Menu button. */
async function openMenu(page: Page) {
  const menu = page.getByRole('button', { name: /^(Menu|মেনু)$/ });
  if (await menu.isVisible()) await menu.click();
}

async function noSidewaysScroll(page: Page) {
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(ok, 'page must not scroll sideways (NFR-10)').toBe(true);
}

test.describe('FR-01 log in', () => {
  test('a wrong password shows a clear error; the right one opens the home page', async ({ page }) => {
    await login(page, { id: ADMIN.id, pw: 'WrongPass1' }, false);
    await expect(page.getByRole('alert')).toHaveText('Incorrect login ID or password.');
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel('Password', { exact: true }).fill(ADMIN.pw);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome, Demo Admin' })).toBeVisible();
    await noSidewaysScroll(page);
  });

  test('pages need a login, and logging out ends the session', async ({ page }) => {
    await page.goto('/units');
    await expect(page).toHaveURL(/\/login/);
    await login(page, ADMIN);
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
    await logout(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/login/); // Back does not reveal private pages
  });
});

test.describe('FR-04 units', () => {
  test('admin adds a unit and sees it in the list; a duplicate number is rejected', async ({ page }) => {
    const num = `E${unique().slice(-5)}`.toUpperCase();
    await login(page, ADMIN);
    await page.goto('/units');
    await page.getByRole('button', { name: 'Add unit' }).click();
    await page.getByLabel('Unit number').fill(num);
    await page.getByLabel('Floor').fill('3');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('link', { name: new RegExp(num) })).toBeVisible();
    await noSidewaysScroll(page);

    await page.getByRole('button', { name: 'Add unit' }).click();
    await page.getByLabel('Unit number').fill(num.toLowerCase()); // different letter case, same unit
    await page.getByLabel('Floor').fill('3');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toHaveText('A unit with this number already exists.');
  });
});

test.describe('FR-03 / FR-31 / FR-07 resident account lifecycle', () => {
  test('admin creates a resident; they log in with the temporary password, must change it, then see only their own pages', async ({ page }) => {
    const id = `res${unique()}@example.com`;
    await login(page, ADMIN);
    await page.goto('/residents');
    await page.getByRole('button', { name: 'Add resident' }).click();
    await page.getByLabel('Full name').fill('Rahim Uddin');
    await page.getByLabel('Email or mobile number').fill(id);
    await page.getByLabel('Phone', { exact: true }).fill('01712345678');
    await page.getByRole('button', { name: 'Save' }).click();

    const temp = (await page.getByTestId('temp-password').innerText()).trim();
    expect(temp).toMatch(/^(?=.*[A-Za-z])(?=.*\d).{8,}$/);
    await page.getByRole('button', { name: 'I have noted it' }).click();
    await logout(page);

    // Temporary password: forced to choose a new one before anything else.
    await login(page, { id, pw: temp });
    await expect(page).toHaveURL(/\/change-password/);
    await page.goto('/'); // trying to skip it
    await expect(page).toHaveURL(/\/change-password/);

    await page.getByLabel('Current password').fill(temp);
    await page.getByLabel('New password').fill('weak');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toHaveText('Use at least 8 characters, with a letter and a number.');
    await page.getByLabel('New password').fill('MyNewPass1');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome, Rahim Uddin' })).toBeVisible();
    await expect(page.getByText('You are not linked to an apartment yet')).toBeVisible();

    // FR-02: a resident sees no admin links and is refused admin pages even by typing the address.
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Units' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Staff' })).toHaveCount(0);
    for (const path of ['/units', '/residents', '/staff']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    }
    await page.goto('/profile');
    await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible();
    await noSidewaysScroll(page);
  });
});

test.describe('FR-05 occupancy', () => {
  test('assigning a resident makes a unit Occupied; ending the stay makes it Vacant again', async ({ page }) => {
    const n = unique();
    const unitNo = `O${n.slice(-5)}`.toUpperCase();
    const name = `Karim ${n}`;
    await login(page, ADMIN);

    await page.goto('/units');
    await page.getByRole('button', { name: 'Add unit' }).click();
    await page.getByLabel('Unit number').fill(unitNo);
    await page.getByLabel('Floor').fill('5');
    await page.getByRole('button', { name: 'Save' }).click();

    await page.goto('/residents');
    await page.getByRole('button', { name: 'Add resident' }).click();
    await page.getByLabel('Full name').fill(name);
    await page.getByLabel('Email or mobile number').fill(`k${n}@example.com`);
    await page.getByLabel('Phone', { exact: true }).fill('01812345678');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'I have noted it' }).click();

    await page.goto('/units');
    await page.getByRole('link', { name: new RegExp(unitNo) }).click();
    await expect(page.getByText('Vacant')).toBeVisible();

    await page.getByPlaceholder('Search residents by name or phone').fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByLabel('Start date').fill(dhakaDay(-30));
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Occupied')).toBeVisible();
    await expect(page.locator('li').getByText('Billing contact')).toBeVisible(); // first occupant (BR-06)

    await page.getByRole('button', { name: 'End stay' }).click();
    await page.getByRole('dialog').getByLabel('End date').fill(dhakaDay(-1));
    await page.getByRole('dialog').getByRole('button', { name: 'End stay' }).click();
    await expect(page.getByText('Vacant')).toBeVisible();
    await noSidewaysScroll(page);
  });

  test('deactivating a resident who still lives in a unit asks for the move-out date', async ({ page }) => {
    const n = unique();
    const unitNo = `D${n.slice(-5)}`.toUpperCase();
    const name = `Selim ${n}`;
    await login(page, ADMIN);
    await page.goto('/units');
    await page.getByRole('button', { name: 'Add unit' }).click();
    await page.getByLabel('Unit number').fill(unitNo);
    await page.getByLabel('Floor').fill('6');
    await page.getByRole('button', { name: 'Save' }).click();

    await page.goto('/residents');
    await page.getByRole('button', { name: 'Add resident' }).click();
    await page.getByLabel('Full name').fill(name);
    await page.getByLabel('Email or mobile number').fill(`s${n}@example.com`);
    await page.getByLabel('Phone', { exact: true }).fill('01912345678');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'I have noted it' }).click();

    await page.goto('/units');
    await page.getByRole('link', { name: new RegExp(unitNo) }).click();
    await page.getByPlaceholder('Search residents by name or phone').fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByLabel('Start date').fill(dhakaDay(-30));
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Occupied')).toBeVisible();

    await page.getByRole('link', { name }).click();
    await page.getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByLabel('Move-out date')).toBeVisible();
    await page.getByLabel('Move-out date').fill(dhakaDay(-1));
    await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByText('Inactive')).toBeVisible();

    await page.goto('/units');
    await page.getByRole('link', { name: new RegExp(unitNo) }).click();
    await expect(page.getByText('Vacant')).toBeVisible();
  });
});

test.describe('FR-02 / FR-06 staff permissions', () => {
  test('staff with no permissions see no admin links and are refused by URL', async ({ page }) => {
    await login(page, STAFF_NONE);
    await expect(page.getByRole('heading', { name: 'Welcome, Demo Caretaker' })).toBeVisible();
    await openMenu(page);
    for (const name of ['Units', 'Residents', 'Staff']) await expect(page.getByRole('link', { name })).toHaveCount(0);
    for (const path of ['/units', '/residents', '/staff']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    }
  });

  test('staff with units and residents permissions can use those pages but not Staff', async ({ page }) => {
    await login(page, STAFF_OFFICE);
    await page.goto('/units');
    await expect(page.getByRole('heading', { name: 'Apartment units' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add unit' })).toBeVisible();
    await page.goto('/residents');
    await expect(page.getByRole('heading', { name: 'Residents' })).toBeVisible();
    await page.goto('/staff');
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  });

  test('admin creates a staff member with a permission, and it takes effect for them', async ({ page, browser }) => {
    const n = unique();
    const id = `st${n}@example.com`;
    await login(page, ADMIN);
    await page.goto('/staff');
    await page.getByRole('button', { name: 'Add staff member' }).click();
    await page.getByLabel('Full name').fill(`Staff ${n}`);
    await page.getByLabel('Email or mobile number').fill(id);
    await page.getByLabel('Phone', { exact: true }).fill('01612345678');
    await page.getByLabel('Manage units', { exact: true }).check();
    await page.getByRole('button', { name: 'Save' }).click();
    const temp = (await page.getByTestId('temp-password').innerText()).trim();
    await page.getByRole('button', { name: 'I have noted it' }).click();
    await expect(page.getByText(`Staff ${n}`)).toBeVisible();

    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await login(other, { id, pw: temp });
    await other.getByLabel('Current password').fill(temp);
    await other.getByLabel('New password').fill('StaffNew123');
    await other.getByRole('button', { name: 'Save' }).click();
    await expect(other.getByRole('heading', { name: /^Welcome/ })).toBeVisible(); // password change finished
    await other.goto('/units');
    await expect(other.getByRole('heading', { name: 'Apartment units' })).toBeVisible();
    await other.goto('/residents');
    await expect(other.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await ctx.close();
  });
});

test.describe('FR-47 / FR-55 language and text size', () => {
  test('Bangla translates the page and is remembered; Large text enlarges without sideways scrolling', async ({ page, browser }) => {
    // Own admin account, so this test cannot leave the shared demo admin in Bangla / Large text.
    const me = await createAdmin();

    await page.goto('/login');
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await expect(page.getByRole('heading', { name: 'লগ ইন' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'bn');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'লগ ইন' })).toBeVisible(); // remembered

    await page.getByLabel('ইমেইল বা মোবাইল নম্বর').fill(me.id);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill('WrongPass1');
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();
    await expect(page.getByRole('alert')).toHaveText('লগইন আইডি বা পাসওয়ার্ড ভুল।');

    // The language picked on the login page is kept after logging in (and saved to the account).
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill(me.pw);
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();
    await expect(page.getByRole('heading', { name: 'স্বাগতম, Lang Admin' })).toBeVisible();

    const sizeBefore = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    await openMenu(page);
    await page.getByRole('button', { name: /\(A\+\)/ }).click();
    await expect(page.locator('html')).toHaveClass(/text-large/);
    const sizeAfter = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(sizeAfter).toBeCloseTo(sizeBefore * 1.25, 1);
    for (const path of ['/', '/units', '/residents', '/staff']) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await noSidewaysScroll(page);
    }

    // Both choices are saved to the account: they follow the user to a fresh browser.
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    await login(fresh, me);
    await expect(fresh.getByRole('heading', { name: 'স্বাগতম, Lang Admin' })).toBeVisible();
    await expect(fresh.locator('html')).toHaveClass(/text-large/);
    await ctx.close();
  });
});
