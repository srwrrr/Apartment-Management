import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { ADMIN, createAdmin, firstLogin, importTenants, login, logout, noSidewaysScroll, openMenu, unique, type Tenant } from './helpers';

test.describe.configure({ mode: 'serial' });

async function sql<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  const db = new Client({ connectionString: 'postgresql://apt:apt@localhost:5432/apartment_e2e' });
  await db.connect();
  const res = await db.query(text, values);
  await db.end();
  return res.rows as T[];
}

async function noViolations(page: Page) {
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${page.url()}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date()).slice(0, 7);

test.describe('Sprint 7: the Could items and demo mode', () => {
  let tenant: Tenant;
  let other: Tenant;
  const groupName = `Committee ${unique()}`;

  test('setup', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    [tenant, other] = (await importTenants(page, ['', ''])) as [Tenant, Tenant];
    await logout(page);
    await firstLogin(page, tenant.email, tenant.temp);
    await logout(page);
    await firstLogin(page, other.email, other.temp);
    await logout(page);
  });

  test('demo mode: one button logs in', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Administrator' }).click();
    await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  });

  test('FR-54 a household member gets a login, sees the household, and is stopped when removed', async ({ page, browser }) => {
    const [unit] = await sql<{ id: string }>('SELECT id FROM units WHERE "unitNumber" = $1', [tenant.unit]);
    const email = `family${unique().toLowerCase()}@example.com`;
    await login(page, ADMIN);
    await page.goto(`/units/${unit!.id}`);
    await page.getByRole('button', { name: 'Add a household member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill('Rina Begum');
    await dialog.getByLabel('Relation').fill('Wife');
    await dialog.getByLabel('Login ID (email or mobile)').fill(email);
    await dialog.getByRole('button', { name: 'Add' }).click();
    const temp = (await page.getByTestId('temp-password').innerText()).trim();
    await page.getByRole('button', { name: 'I have noted it' }).click();
    await expect(page.getByTestId('household-member')).toContainText('Rina Begum');
    await noViolations(page);

    const phone = await browser.newContext();
    const member = await phone.newPage();
    await firstLogin(member, email, temp);
    await member.goto('/announcements');
    await expect(member.getByRole('heading', { name: 'Announcements' })).toBeVisible();

    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Remove: Rina Begum' }).click();
    await expect(page.getByTestId('household-member')).toContainText('Removed');
    await member.reload();
    await expect(member.getByLabel('Password', { exact: true })).toBeVisible(); // back at the login page
    await login(member, { id: email, pw: 'ResidentNew1' }, false);
    await expect(member).toHaveURL(/\/login/);
    await phone.close();
  });

  test('FR-50 a resident confirms the fix and rates it once; the administrator sees it', async ({ page }) => {
    await login(page, { id: tenant.email, pw: 'ResidentNew1' });
    await page.goto('/requests/new');
    await page.getByLabel('Category').selectOption('PLUMBING');
    await page.getByLabel('Short title').fill('Bathroom tap is dripping');
    await page.getByLabel('Describe the problem').fill('The bathroom tap drips all night long.');
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}/);
    const id = page.url().split('/').pop()!;
    await sql(`UPDATE maintenance_requests SET status = 'RESOLVED', "resolvedAt" = now() WHERE id = $1`, [id]);

    await page.reload();
    await page.getByRole('button', { name: 'Yes, it is fixed' }).click();
    await expect(page.getByRole('heading', { name: 'How did we do?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send rating' })).toBeDisabled();
    await noViolations(page);
    await page.getByText('4 ★').click();
    await page.getByLabel('Comment (optional)').fill('Quick work');
    await page.getByRole('button', { name: 'Send rating' }).click();
    await expect(page.getByTestId('rating')).toHaveText('4 out of 5');
    await expect(page.getByRole('heading', { name: 'How did we do?' })).toHaveCount(0);
    await logout(page);

    await login(page, ADMIN);
    await page.goto(`/requests/${id}`);
    await expect(page.getByTestId('rating')).toHaveText('4 out of 5');
    await page.goto('/reports');
    await expect(page.getByTestId('mr-rating')).toContainText('/ 5');
    await expect(page.getByTestId('mr-categories')).toContainText('/ 5');
  });

  test('FR-49 scheduled jobs: add one, see it coming up, edit, pause and resume', async ({ page }) => {
    const title = `Service the lift ${unique()}`;
    await login(page, ADMIN);
    await page.goto('/scheduled-tasks');
    await page.getByRole('button', { name: 'New scheduled job' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Job').fill(title);
    await dialog.getByLabel('What needs doing').fill('Monthly service by the lift company.');
    await dialog.getByLabel('Category').selectOption('LIFT');
    await dialog.getByLabel('Next due date').fill(addDays(30));
    await dialog.getByRole('button', { name: 'Save' }).click();
    const row = page.getByTestId('scheduled-task').filter({ hasText: title });
    await expect(row).toContainText('Every month');
    await expect(page.getByTestId('upcoming')).toContainText(title);
    await noViolations(page);

    await row.getByRole('button', { name: 'Pause' }).click();
    await expect(row).toContainText('Paused');
    await expect(page.getByTestId('upcoming').filter({ hasText: title })).toHaveCount(0);
    await row.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByTestId('upcoming')).toContainText(title);

    await row.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('dialog').getByLabel('Repeat every (months)').fill('6');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(row).toContainText('Every 6 months');
  });

  test('FR-36 a resident group receives an announcement, and others do not', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/groups');
    await page.getByLabel('Group name').fill(groupName);
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(page.getByRole('heading', { name: groupName })).toBeVisible();
    await page.getByLabel('Search residents to add').fill(tenant.name);
    await page.getByRole('button', { name: `Add ${tenant.name}` }).click();
    await expect(page.getByTestId('group-member')).toContainText(tenant.name);
    await noViolations(page);

    const title = `For the group ${unique()}`;
    await page.goto('/announcements/new');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Message').fill('Meeting on Sunday.');
    await page.getByLabel('Who should receive it?').selectOption('GROUP');
    await page.getByLabel('Group', { exact: true }).selectOption({ label: `${groupName} (1 member)` });
    await expect(page.getByTestId('reach')).toHaveText('This will reach 1 residents.');
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(`Group: ${groupName}`)).toBeVisible();
    await logout(page);

    await login(page, { id: other.email, pw: 'ResidentNew1' });
    await page.goto('/announcements');
    await expect(page.getByText(title)).toHaveCount(0);
    await logout(page);
    await login(page, { id: tenant.email, pw: 'ResidentNew1' });
    await page.goto('/announcements');
    await expect(page.getByText(title)).toBeVisible();
  });

  test('FR-51 and FR-53 an announcement can wait, and can be printed', async ({ page }) => {
    const title = `Gas off later ${unique()}`;
    await login(page, ADMIN);
    await page.goto('/announcements/new');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Message').fill('Gas will be off on Tuesday.');
    await page.getByLabel('Publish at (optional)').fill(`${addDays(3)}T09:00`);
    await page.getByRole('button', { name: 'Schedule' }).click();
    await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Goes out/)).toBeVisible();
    await expect(page.getByTestId('read-summary')).toHaveCount(0);

    const href = await page.getByRole('link', { name: 'Print notice' }).getAttribute('href');
    const pdf = await page.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    await logout(page);

    await login(page, { id: tenant.email, pw: 'ResidentNew1' });
    await page.goto('/announcements');
    await expect(page.getByText(title)).toHaveCount(0);
    await page.getByLabel('Past announcements').check();
    await expect(page.getByText('No past announcements.').or(page.getByTestId('announcement').first())).toBeVisible();
  });

  test('FR-52 the administrator edits the emergency numbers, and a resident can tap them', async ({ page }) => {
    const name = `Guard desk ${unique()}`;
    await login(page, ADMIN);
    await page.goto('/emergency');
    await expect(page.getByRole('heading', { name: 'Emergency contacts' })).toBeVisible();
    await page.getByRole('button', { name: 'Add a contact' }).click();
    const row = page.getByTestId('emergency-row').last();
    await row.getByLabel('Name').fill(name);
    await row.getByLabel('Role').fill('Security');
    await row.getByLabel('Phone').fill('not a number');
    await row.getByLabel('Available').fill('24 hours');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Enter a phone number, like 999 or 01712345678.')).toBeVisible();
    await row.getByLabel('Phone').fill('999');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await noViolations(page);
    await logout(page);

    await login(page, { id: tenant.email, pw: 'ResidentNew1' });
    await openMenu(page);
    await page.getByRole('link', { name: 'Emergency contacts' }).click();
    const contact = page.getByTestId('emergency-contact').filter({ hasText: name });
    await expect(contact.getByRole('link')).toHaveAttribute('href', 'tel:999');
    await expect(page.getByRole('button', { name: 'Add a contact' })).toHaveCount(0);
    await noViolations(page);
  });

  test('FR-57, FR-38, FR-58 the committee PDF, CSV exports and the collection chart', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/reports');
    const pdf = await page.request.get(`/api/reports/committee.pdf?month=${thisMonth()}`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', `/api/reports/committee.pdf?month=${thisMonth()}`);

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export to CSV' }).first().click()]);
    expect(download.suggestedFilename()).toMatch(/^collection-.*\.csv$/);

    await page.goto('/requests');
    const href = await page.getByRole('link', { name: 'Export to CSV' }).getAttribute('href');
    const csv = await page.request.get(href!);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain('Bathroom tap is dripping');

    await page.goto('/');
    await expect(page.getByTestId('trend').locator('li').first()).toHaveAttribute('title', /billed .*collected .*rate/);
    await noViolations(page);
    await noSidewaysScroll(page);
  });

  test('staff without the permissions are refused the new pages, and do not see them in the menu', async ({ page }) => {
    await login(page, { id: 'staff@demo.local', pw: 'Staff1234' });
    for (const path of ['/groups', '/scheduled-tasks']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: /permission|Access|denied/i })).toBeVisible();
    }
    await page.goto('/');
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Resident groups' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Scheduled jobs' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Emergency contacts' })).toBeVisible();
  });

  test('the new pages work in Bangla with Large text, without sideways scrolling', async ({ page }) => {
    const me = await createAdmin('তৃতীয় প্রশাসক');
    await page.goto('/login');
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.getByRole('button', { name: /^A\+/ }).click();
    await noSidewaysScroll(page);
    await page.getByLabel('ইমেইল বা মোবাইল নম্বর').fill(me.id);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill(me.pw);
    await page.getByRole('button', { name: 'লগ ইন করুন', exact: true }).click();
    await expect(page.getByRole('heading', { name: /স্বাগতম/ })).toBeVisible();
    await noSidewaysScroll(page);
    for (const [path, title] of [['/emergency', 'জরুরি যোগাযোগ'], ['/groups', 'বাসিন্দা গ্রুপ'], ['/scheduled-tasks', 'নির্ধারিত কাজ']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await noSidewaysScroll(page);
    }
  });
});
