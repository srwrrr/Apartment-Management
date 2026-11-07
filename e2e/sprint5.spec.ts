import { expect, test, type Page } from '@playwright/test';
import { ADMIN, CASHIER, createAdmin, firstLogin, importTenants, login, logout, noSidewaysScroll, openMenu, unique, type Tenant } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const NEW_PASSWORD = 'ResidentNew1';

/** "৳ 12,500.00" -> 12500. Desktop and phone runs share a database, so totals are compared, not fixed. */
const taka = (text: string) => {
  const n = Number(text.replace(/[^\d.]/g, ''));
  expect(n, `an amount in "${text}"`).not.toBeNaN();
  return n;
};

const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date()).slice(0, 7);

/** Test setup through the API, as the logged-in user: one bill of ৳3,000 for this unit. */
async function billUnit(page: Page, unitNumber: string) {
  const { csrfToken } = await (await page.request.get('/api/auth/csrf')).json();
  const units = await (await page.request.get(`/api/units?q=${unitNumber}`)).json();
  const res = await page.request.post('/api/bills', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: { unitId: units.items[0].id, month: thisMonth(), charges: [{ type: 'SERVICE', amount: 300000, description: 'Service charge' }] },
  });
  expect(res.status()).toBe(201);
  return { unitId: units.items[0].id as string, billId: (await res.json()).id as string };
}

async function reportPayment(page: Page, billId: string, reference: string) {
  await page.goto(`/bills/${billId}`);
  await page.getByRole('button', { name: "I've paid" }).click();
  await page.getByLabel('Transaction ID or reference').fill(reference);
  await page.getByLabel(/^Screenshot/).setInputFiles({ name: 'bkash.png', mimeType: 'image/png', buffer: PNG });
  await noSidewaysScroll(page);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByText('Your report was sent.')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('Sprint 5: payment reports, statements, certificates, move-out, expenses', () => {
  let tenants: Tenant[];
  let a: { unitId: string; billId: string };
  let b: { unitId: string; billId: string };
  const refA = `TRX${unique()}`;
  const refB = `TRX${unique()}`;
  const payee = `Lift Service ${unique()}`;
  let certificate = '';

  test('a resident reports a payment; the balance does not change until it is checked', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    tenants = await importTenants(page, ['', '']);
    a = await billUnit(page, tenants[0]!.unit);
    b = await billUnit(page, tenants[1]!.unit);
    await logout(page);

    await firstLogin(page, tenants[0]!.email, tenants[0]!.temp, NEW_PASSWORD);
    await reportPayment(page, a.billId, refA);
    await expect(page.getByTestId('bill-report')).toContainText('Waiting for verification');
    await expect(page.getByTestId('bill-balance')).toContainText('3,000');
    // Everything due has been reported, so there is nothing more to report.
    await expect(page.getByRole('button', { name: "I've paid" })).toHaveCount(0);
    await logout(page);
  });

  test('the cashier sees the screenshot and verifies it; a receipt is created', async ({ page }) => {
    await login(page, CASHIER);
    await page.goto('/payment-reports');
    const card = page.getByTestId('queue-report').filter({ hasText: refA });
    await expect(card).toContainText(tenants[0]!.unit);
    const shot = await card.getByRole('link', { name: 'View screenshot' }).getAttribute('href');
    expect((await page.request.get(shot!)).headers()['content-type']).toContain('image/png');
    await noSidewaysScroll(page);
    await card.getByRole('button', { name: 'Verify' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('queue-report').filter({ hasText: refA })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Verified' }).click();
    await expect(page.getByTestId('queue-report').filter({ hasText: refA })).toBeVisible();
    await logout(page);
  });

  test('the resident is told, and the statement closes at zero and downloads as a PDF', async ({ page }) => {
    await login(page, { id: tenants[0]!.email, pw: NEW_PASSWORD });
    await page.goto('/notifications');
    await expect(page.getByTestId('notification').first()).toContainText('was verified');

    await page.goto(`/bills/${a.billId}`);
    await expect(page.getByTestId('bill-report')).toContainText('Verified');
    await expect(page.getByTestId('payment')).toContainText(refA);

    await page.goto('/statement');
    await expect(page.getByTestId('statement-row')).toHaveCount(2);
    await expect(page.getByTestId('statement-closing')).toHaveText(/^৳ 0(\.00)?$/);
    await noSidewaysScroll(page);
    const href = await page.getByRole('link', { name: 'Download PDF' }).getAttribute('href');
    expect((await page.request.get(href!)).headers()['content-type']).toContain('application/pdf');
    await logout(page);
  });

  test('a rejected report shows the resident the reason, and the bill stays unpaid', async ({ page }) => {
    await firstLogin(page, tenants[1]!.email, tenants[1]!.temp, NEW_PASSWORD);
    await reportPayment(page, b.billId, refB);
    await logout(page);

    await login(page, CASHIER);
    await page.goto('/payment-reports');
    await page.getByTestId('queue-report').filter({ hasText: refB }).getByRole('button', { name: 'Reject' }).click();
    await page.getByLabel('Reason (the resident will see this)').fill('No such transaction in our bKash statement');
    await page.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByTestId('queue-report').filter({ hasText: refB })).toHaveCount(0);
    await logout(page);

    await login(page, { id: tenants[1]!.email, pw: NEW_PASSWORD });
    await page.goto(`/bills/${b.billId}`);
    await expect(page.getByTestId('bill-report')).toContainText('Not accepted');
    await expect(page.getByTestId('bill-report')).toContainText('No such transaction in our bKash statement');
    await expect(page.getByTestId('bill-balance')).toContainText('3,000');
    await expect(page.getByRole('button', { name: "I've paid" })).toBeVisible(); // they can try again
    await logout(page);
  });

  test('a certificate needs a zero balance; once issued, its number can be checked', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto(`/units/${b.unitId}`);
    await expect(page.getByTestId('certificate-blocked')).toContainText('3,000');
    await expect(page.getByRole('button', { name: 'Issue certificate' })).toHaveCount(0);

    await page.goto(`/units/${a.unitId}`);
    await page.getByRole('button', { name: 'Issue certificate' }).click();
    await expect(page.getByTestId('certificate')).toContainText(/NDC-\d{4}-\d{5}/);
    certificate = /NDC-\d{4}-\d{5}/.exec(await page.getByTestId('certificate').innerText())![0];
    await noSidewaysScroll(page);

    await page.goto('/reports');
    await page.getByLabel('Certificate number').fill(certificate);
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByTestId('certificate-result')).toContainText(`Genuine: ${certificate}, unit ${tenants[0]!.unit}`);
    await page.getByLabel('Certificate number').fill('NDC-1999-00001');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('No certificate has this number.')).toBeVisible();
    await logout(page);

    await login(page, { id: tenants[0]!.email, pw: NEW_PASSWORD });
    await page.goto('/statement');
    await expect(page.getByTestId('certificate')).toContainText(certificate);
    await logout(page);
  });

  test('expenses are recorded and voided, and appear in the income and expense report', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/reports');
    const before = taka(await page.getByTestId('ie-expenses').innerText());
    await page.goto('/expenses');
    await page.getByRole('button', { name: 'Add expense' }).click();
    await page.getByLabel('Category').last().selectOption('LIFT');
    await page.getByLabel('Amount (৳)').fill('12500');
    await page.getByLabel('Paid to').fill(payee);
    await page.getByLabel(/^Receipt photo/).setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    const row = page.getByTestId('expense').filter({ hasText: payee });
    await expect(row).toContainText('12,500');
    await expect(row.getByRole('link', { name: 'View receipt' })).toBeVisible();
    await noSidewaysScroll(page);

    await page.getByRole('button', { name: 'Add expense' }).click();
    await page.getByLabel('Amount (৳)').fill('99');
    await page.getByLabel('Paid to').fill(`${payee} duplicate`);
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    const wrong = page.getByTestId('expense').filter({ hasText: `${payee} duplicate` });
    await wrong.getByRole('button', { name: 'Void' }).click();
    await page.getByLabel('Reason').fill('Entered by mistake');
    await page.getByRole('dialog').getByRole('button', { name: 'Void' }).click();
    await expect(wrong).toContainText('Voided');
    await expect(wrong).toContainText('Entered by mistake');

    await page.goto('/reports');
    await expect(page.getByTestId('income-expense')).toBeVisible();
    await expect(page.getByTestId('ie-expenses')).toBeVisible();
    expect(taka(await page.getByTestId('ie-expenses').innerText())).toBe(before + 12500); // the voided ৳99 is not counted
    await noSidewaysScroll(page);
  });

  test('residents see spending by category only once it is shared, and never who was paid', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/settings');
    await page.getByLabel('Share a spending summary with residents').check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await logout(page);

    await login(page, { id: tenants[1]!.email, pw: NEW_PASSWORD });
    await openMenu(page);
    await page.getByRole('link', { name: 'Building spending' }).click();
    await expect(page.getByTestId('summary')).toContainText('Lift');
    expect(taka(await page.getByTestId('summary-total').innerText())).toBeGreaterThanOrEqual(12500);
    await expect(page.getByText(payee)).toHaveCount(0);
    await noSidewaysScroll(page);
    await logout(page);

    await login(page, ADMIN);
    await page.goto('/settings');
    await page.getByLabel('Share a spending summary with residents').uncheck();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
  });

  test('moving out with nothing owed: certificate, deactivation, and the unit is Vacant at once', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto(`/units/${a.unitId}`);
    await page.getByRole('link', { name: 'Move out' }).click();
    await expect(page.getByTestId('moveout-balance')).toHaveText('Nothing is owed on this unit.');
    await expect(page.getByLabel('Deactivate this account')).toBeChecked(); // BR-03: their only home
    await page.getByLabel('Issue a no-dues certificate').check();
    await expect(page.getByTestId('moveout-summary')).toContainText('The unit shows as Vacant.');
    await expect(page.getByTestId('moveout-summary')).toContainText('A no-dues certificate is issued.');
    await expect(page.getByTestId('moveout-summary')).toContainText('The account is deactivated');
    await noSidewaysScroll(page);
    await page.getByRole('button', { name: 'Confirm move-out' }).click();
    await expect(page.getByRole('heading', { name: 'Move-out recorded.' })).toBeVisible();
    await expect(page.getByTestId('moveout-certificate')).toContainText(/NDC-/);

    await page.goto(`/units/${a.unitId}`);
    await expect(page.getByText('Vacant', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Move out' })).toHaveCount(0);
    await logout(page);

    await login(page, { id: tenants[0]!.email, pw: NEW_PASSWORD }, false);
    await expect(page).toHaveURL(/\/login/); // the account no longer works
  });

  test('moving out with dues needs a note first, and the dues stay in the report', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto(`/units/${b.unitId}`);
    await page.getByRole('link', { name: 'Move out' }).click();
    await expect(page.getByTestId('moveout-balance')).toContainText('3,000');
    await expect(page.getByLabel('Issue a no-dues certificate')).toHaveCount(0);
    const confirm = page.getByRole('button', { name: 'Confirm move-out' });
    await expect(confirm).toBeDisabled();
    await page.getByLabel('Why is this resident leaving with dues unpaid?').fill('Will pay by cheque next week');
    await expect(page.getByTestId('moveout-summary')).toContainText('stays owed on the unit');
    await page.getByLabel('Deactivate this account').uncheck(); // they will still need to pay, and see their bills
    await confirm.click();
    await expect(page.getByRole('heading', { name: 'Move-out recorded.' })).toBeVisible();

    await page.goto(`/units/${b.unitId}`);
    await expect(page.getByText('Left with dues: Will pay by cheque next week')).toBeVisible();
    await page.goto('/reports');
    await expect(page.getByTestId('dues-table')).toContainText(tenants[1]!.unit);
  });

  test('staff without the permissions are refused by address', async ({ page }) => {
    await login(page, { id: 'staff@demo.local', pw: 'Staff1234' });
    for (const path of ['/payment-reports', '/expenses', `/units/${a.unitId}/statement`, `/occupancies/${a.billId}/move-out`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: /permission|Access|denied/i })).toBeVisible();
    }
  });

  test('every Sprint 4 and 5 page for managers works in Bangla with Large text, without sideways scrolling', async ({ page }) => {
    const me = await createAdmin('অর্থ প্রশাসক');
    await page.goto('/login');
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.getByRole('button', { name: /\(A\+\)/ }).click();
    await page.getByLabel('ইমেইল বা মোবাইল নম্বর').fill(me.id);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill(me.pw);
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();
    await expect(page.getByRole('heading', { name: /স্বাগতম/ })).toBeVisible();
    await expect(page.getByText('আদায়ের হার').first()).toBeVisible(); // the dashboard
    await noSidewaysScroll(page);

    const pages: [string, RegExp | string][] = [
      ['/payment-reports', 'পেমেন্ট রিপোর্ট'],
      ['/expenses', 'খরচ'],
      ['/reports', 'রিপোর্ট'],
      ['/announcements', 'ঘোষণা'],
      ['/announcements/new', 'নতুন ঘোষণা'],
      ['/notifications', 'বিজ্ঞপ্তি'],
    ];
    for (const [path, title] of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await noSidewaysScroll(page);
    }
    await page.goto(`/units/${b.unitId}`);
    await expect(page.getByRole('heading', { name: 'বকেয়া-মুক্ত সনদ' })).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto(`/units/${b.unitId}/statement`);
    await expect(page.getByTestId('statement')).toBeVisible();
    await expect(page.getByText('সমাপনী ব্যালেন্স')).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto(`/bills/${b.billId}`);
    await expect(page.getByText('গৃহীত হয়নি')).toBeVisible();
    await noSidewaysScroll(page);
  });

  test('the resident’s Sprint 4 and 5 pages work in Bangla with Large text', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.getByRole('button', { name: /\(A\+\)/ }).click();
    await page.getByLabel('ইমেইল বা মোবাইল নম্বর').fill(tenants[1]!.email);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();
    await expect(page.getByRole('heading', { name: /স্বাগতম/ })).toBeVisible();

    await page.goto('/statement');
    await expect(page.getByRole('heading', { name: 'হিসাব বিবরণী' })).toBeVisible();
    await expect(page.getByText('সমাপনী ব্যালেন্স')).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto('/notifications');
    await expect(page.getByTestId('notification').filter({ hasText: 'গৃহীত হয়নি' })).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto('/announcements');
    await expect(page.getByRole('heading', { name: 'ঘোষণা', exact: true })).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto(`/bills/${b.billId}`);
    await page.getByRole('button', { name: 'আমি পরিশোধ করেছি' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await noSidewaysScroll(page);
  });
});
