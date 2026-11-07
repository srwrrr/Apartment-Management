import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';

export type Who = { id: string; pw: string };
export const ADMIN: Who = { id: 'admin@demo.local', pw: 'Admin1234' };
export const CASHIER: Who = { id: 'billing@demo.local', pw: 'Billing1234' }; // billing.manage + payments.record + billing.view
export const VIEWER: Who = { id: 'viewer@demo.local', pw: 'Viewer1234' }; // billing.view only

const run = Date.now().toString(36);
let counter = 0;
/** A short, unique, upper-case token for names and unit numbers (stays under the 10-character unit limit). */
export const unique = () => `${run}${counter++}`.slice(-5).toUpperCase();

export async function login(page: Page, who: Who, expectSuccess = true) {
  await page.goto('/login');
  await page.getByLabel('Email or mobile number').fill(who.id);
  await page.getByLabel('Password', { exact: true }).fill(who.pw);
  await page.getByRole('button', { name: 'Log in' }).click();
  if (expectSuccess) await expect(page).not.toHaveURL(/\/login/);
}

/** On a phone the navigation is behind a Menu button. */
export async function openMenu(page: Page) {
  const menu = page.getByRole('button', { name: /^(Menu|মেনু)$/ });
  if (await menu.isVisible()) await menu.click();
}

export async function logout(page: Page) {
  await openMenu(page);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

export async function noSidewaysScroll(page: Page) {
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(ok, 'page must not scroll sideways (NFR-10)').toBe(true);
}

export const csvFile = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });

/** A resident's first login with the temporary password: choose a new one and land on the home page. */
export async function firstLogin(page: Page, loginId: string, temp: string, newPassword = 'ResidentNew1') {
  await login(page, { id: loginId, pw: temp });
  await expect(page).toHaveURL(/\/change-password/);
  await page.getByLabel('Current password').fill(temp);
  await page.getByLabel('New password').fill(newPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
}

/** A throwaway administrator, for tests that change account-level settings. */
export async function createAdmin(name = 'Lang Admin') {
  const id = `adm${unique().toLowerCase()}@demo.local`;
  const pw = 'Admin1234';
  const db = new Client({ connectionString: 'postgresql://apt:apt@localhost:5432/apartment_e2e' });
  await db.connect();
  await db.query(
    `INSERT INTO users (id, "loginId", "passwordHash", role, "fullName", phone, "mustChangePassword", "updatedAt")
     VALUES ($1, $2, $3, 'ADMIN', $4, '+8801700000001', false, now())`,
    [randomUUID(), id, await bcrypt.hash(pw, 4), name],
  );
  await db.end();
  return { id, pw };
}

export interface Tenant {
  unit: string;
  name: string;
  email: string;
  temp: string;
}

/**
 * Sets up units and residents through the Import page (as an administrator, already logged in):
 * one resident per unit, each living there since 2025. `openingBalances` are in taka, one per unit (or empty).
 */
export async function importTenants(page: Page, openingBalances: string[]): Promise<Tenant[]> {
  const n = unique();
  const tenants = openingBalances.map((_, i) => {
    const letter = String.fromCharCode(65 + i);
    return { unit: `B${n}${letter}`, name: `Payer ${n}${letter}`, email: `payer${n.toLowerCase()}${letter.toLowerCase()}@example.com`, phone: `0171234${String(1000 + i * 7).slice(-4)}` };
  });
  await page.goto('/import');
  const unitsCsv = 'unit_number,floor,opening_balance\r\n' + tenants.map((t, i) => `${t.unit},4,${openingBalances[i] ?? ''}`).join('\r\n') + '\r\n';
  await page.getByTestId('file-units').setInputFiles(csvFile('units.csv', unitsCsv));
  await expect(page.getByText(/The file is ready: \d+ rows/).first()).toBeVisible();
  await page.getByRole('button', { name: `Import ${tenants.length} rows` }).click();
  await expect(page.getByText(`${tenants.length} units were imported.`)).toBeVisible();

  const resCsv =
    'full_name,login_id,phone,unit_number,type,start_date,billing_contact\r\n' +
    tenants.map((t) => `${t.name},${t.email},${t.phone},${t.unit},tenant,2025-01-01,yes`).join('\r\n') +
    '\r\n';
  await page.getByTestId('file-residents').setInputFiles(csvFile('residents.csv', resCsv));
  await expect(page.getByText(`The file is ready: ${tenants.length} rows, no problems found.`)).toBeVisible();
  await page.getByRole('button', { name: `Import ${tenants.length} rows` }).click();
  await expect(page.getByText(`${tenants.length} residents were imported.`)).toBeVisible();

  const result: Tenant[] = [];
  for (const t of tenants) {
    const row = page.getByTestId('credentials').locator('tbody tr').filter({ hasText: t.email });
    result.push({ unit: t.unit, name: t.name, email: t.email, temp: (await row.locator('td').nth(3).innerText()).trim() });
  }
  return result;
}
