import { expect, test, type Page } from '@playwright/test';
import { ADMIN, CASHIER, VIEWER, createAdmin, firstLogin, importTenants, login, noSidewaysScroll, openMenu, unique, type Tenant } from './helpers';

const unitFilter = (page: Page, unit: string) => page.getByLabel('Unit', { exact: true }).fill(unit);
const regularBill = (page: Page, unit: string) =>
  page.getByRole('link').filter({ hasText: unit }).filter({ hasNotText: 'Opening balance' });
const openingBill = (page: Page, unit: string) => page.getByRole('link').filter({ hasText: unit }).filter({ hasText: 'Opening balance' });

async function openBillOf(page: Page, unit: string, opening = false) {
  await page.goto('/bills');
  await unitFilter(page, unit);
  await (opening ? openingBill(page, unit) : regularBill(page, unit)).first().click();
  await expect(page.getByTestId('bill-total')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('Sprint 2: fees, bills, payments, receipts', () => {
  let tenants: Tenant[];
  let billUrlB = '';

  test('admin sets fees, generates the month’s bills, and sees the preview before confirming', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    // Two units; the first also owed ৳1,500 from before the system was used (FR-41).
    tenants = await importTenants(page, ['1500', '']);

    await page.goto('/fees');
    await page.getByTestId('fee-SERVICE').fill('3000');
    await page.getByTestId('fee-WATER').fill('500');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Fees saved.')).toBeVisible();
    await noSidewaysScroll(page);

    await page.goto('/bills/generate');
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText(/This will create \d+ bills, totalling/)).toBeVisible();
    await page.getByText(/Units that will be billed/).click();
    await expect(page.getByText(tenants[0]!.unit)).toBeVisible();
    await expect(page.getByText(tenants[1]!.unit)).toBeVisible();
    await noSidewaysScroll(page);
    await page.getByRole('button', { name: /^Generate \d+ bills$/ }).click();
    await expect(page.getByText(/\d+ bills were generated\./)).toBeVisible();

    // Running it again creates nothing: those units are already billed (BR-07).
    await page.goto('/bills/generate');
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('Already has a bill for this month').first()).toBeVisible();

    // The new bills are in the list, with a total of ৳3,500.
    await page.goto('/bills');
    await unitFilter(page, tenants[0]!.unit);
    await expect(regularBill(page, tenants[0]!.unit)).toContainText('৳ 3,500.00');
    await expect(openingBill(page, tenants[0]!.unit)).toContainText('৳ 1,500.00');
    await noSidewaysScroll(page);
  });

  test('the cashier records payments; mistakes are caught with clear messages', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, CASHIER);
    const a = tenants[0]!;
    const ref = `TXN-${unique()}`;

    await openBillOf(page, a.unit);
    await expect(page.getByTestId('bill-total')).toHaveText('৳ 3,500.00');
    await expect(page.getByText('Unpaid').or(page.getByText('Overdue')).first()).toBeVisible();

    // a partial payment by bKash
    await page.getByLabel('Amount (৳)', { exact: true }).fill('1000');
    await page.getByLabel('Payment method').selectOption({ label: 'bKash' });
    await page.getByLabel('Transaction ID or reference').fill(ref);
    await page.getByRole('button', { name: 'Record a payment' }).click();
    await expect(page.getByText('Payment recorded.')).toBeVisible();
    await expect(page.getByTestId('bill-balance')).toHaveText('৳ 2,500.00');
    await expect(page.getByTestId('bill-paid')).toHaveText('৳ 1,000.00');
    await expect(page.getByText('Partly paid').or(page.getByText('Overdue')).first()).toBeVisible();
    await expect(page.getByTestId('payment')).toHaveCount(1);
    await expect(page.getByTestId('payment')).toContainText(/RCPT-\d{4}-\d{5}/);

    // the same transaction ID again: a warning, and nothing is saved until confirmed
    await page.getByLabel('Amount (৳)', { exact: true }).fill('100');
    await page.getByLabel('Payment method').selectOption({ label: 'bKash' });
    await page.getByLabel('Transaction ID or reference').fill(ref);
    await page.getByRole('button', { name: 'Record a payment' }).click();
    await expect(page.getByText(/This transaction ID was already used/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save anyway' })).toBeVisible();
    await expect(page.getByTestId('payment')).toHaveCount(1);
    await page.getByLabel('Transaction ID or reference').fill(`${ref}-2`); // editing clears the warning
    await expect(page.getByRole('button', { name: 'Save anyway' })).toHaveCount(0);

    // more than the balance: refused, and the message says what the balance is
    await page.getByLabel('Amount (৳)', { exact: true }).fill('9999');
    await page.getByRole('button', { name: 'Record a payment' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'more than the balance due (৳ 2,500.00)' })).toBeVisible();
    await expect(page.getByTestId('payment')).toHaveCount(1);

    // not a number
    await page.getByLabel('Amount (৳)', { exact: true }).fill('abc');
    await page.getByRole('button', { name: 'Record a payment' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'not valid' })).toBeVisible();

    // pay the rest with one click, and the bill is closed
    await page.getByRole('button', { name: 'Fill the full balance' }).click();
    await page.getByLabel('Transaction ID or reference').fill('');
    await page.getByRole('button', { name: 'Record a payment' }).click();
    await expect(page.getByTestId('bill-balance')).toHaveText('৳ 0.00');
    await expect(page.getByText('This bill is fully paid.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record a payment' })).toHaveCount(0);
    await expect(page.getByTestId('payment')).toHaveCount(2);
    await noSidewaysScroll(page);

    // the cashier can edit charges (billing.manage) but cannot void (administrators only)
    await expect(page.getByRole('button', { name: 'Add a charge' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Void payment' })).toHaveCount(0);

    // remember the neighbour's bill address for the privacy check below
    await openBillOf(page, tenants[1]!.unit);
    billUrlB = page.url();
  });

  test('a resident sees their own bills and balance, downloads a receipt, and cannot open a neighbour’s bill', async ({ page }) => {
    test.setTimeout(120_000);
    const a = tenants[0]!;
    await firstLogin(page, a.email, a.temp);
    // regular bill is paid; only the ৳1,500 opening balance is still owed
    await expect(page.getByTestId('home-outstanding')).toHaveText('৳ 1,500.00');
    await page.getByRole('link', { name: 'View my bills' }).click();
    await expect(page.getByTestId('outstanding')).toHaveText('৳ 1,500.00');
    await expect(page.getByRole('link').filter({ hasText: 'Opening balance' })).toBeVisible();
    await expect(page.getByRole('link').filter({ hasText: /Paid/ })).toBeVisible();
    await noSidewaysScroll(page);

    await page.getByRole('link').filter({ hasText: /Paid/ }).first().click();
    await expect(page.getByTestId('bill-total')).toHaveText('৳ 3,500.00');
    await expect(page.getByTestId('payment')).toHaveCount(2);
    // staff-only controls are not there
    for (const name of ['Add a charge', 'Record a payment', 'Void payment']) await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(page.getByTestId('payment').first()).not.toContainText('Recorded by');

    // the receipt is a real PDF
    const href = await page.getByRole('link', { name: 'Receipt (PDF)' }).first().getAttribute('href');
    expect(href).toMatch(/^\/api\/payments\/[0-9a-f-]+\/receipt\.pdf$/);
    const pdf = await page.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

    // a neighbour's bill: just "not found"
    await page.goto(billUrlB.replace(/^https?:\/\/[^/]+/, ''));
    await expect(page.getByText('We could not find what you asked for.')).toBeVisible();
    for (const path of ['/fees', '/bills/generate', '/settings']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    }
  });

  test('the administrator voids a payment; it stays in the history and the balance comes back', async ({ page }) => {
    await login(page, ADMIN);
    await openBillOf(page, tenants[0]!.unit);
    await expect(page.getByTestId('bill-balance')).toHaveText('৳ 0.00');
    await page.getByRole('button', { name: 'Void payment' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Void payment' })).toBeDisabled(); // a reason is needed
    await dialog.getByLabel('Reason').fill('Entered against the wrong unit');
    await dialog.getByRole('button', { name: 'Void payment' }).click();

    await expect(page.getByTestId('payment')).toHaveCount(2); // never deleted
    await expect(page.getByText('Entered against the wrong unit')).toBeVisible();
    await expect(page.getByText('Void', { exact: true })).toBeVisible();
    await expect(page.getByTestId('bill-paid')).not.toHaveText('৳ 3,500.00');
    await expect(page.getByTestId('bill-balance')).not.toHaveText('৳ 0.00');
    // its receipt still opens, marked void
    const href = await page.getByRole('link', { name: 'Receipt (PDF)' }).first().getAttribute('href');
    expect((await page.request.get(href!)).status()).toBe(200);
  });

  test('charges can be added and changed, but never below what is paid', async ({ page }) => {
    await login(page, CASHIER);
    await openBillOf(page, tenants[1]!.unit);
    const before = await page.getByTestId('bill-total').innerText();
    expect(before).toBe('৳ 3,500.00');

    await page.getByRole('button', { name: 'Add a charge' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type').selectOption({ label: 'Other' });
    await dialog.getByLabel('Amount (৳)').fill('250.50');
    await dialog.getByLabel('Description').fill('Lift repair share');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('bill-total')).toHaveText('৳ 3,750.50');
    await expect(page.getByText('Lift repair share')).toBeVisible();

    // pay ৳3,000, then try to lower a charge so the total would drop below that
    await page.getByLabel('Amount (৳)', { exact: true }).fill('3000');
    await page.getByRole('button', { name: 'Record a payment' }).click();
    await expect(page.getByTestId('bill-paid')).toHaveText('৳ 3,000.00');
    await page.getByRole('listitem').filter({ hasText: 'Service charge' }).getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog');
    await edit.getByLabel('Amount (৳)').fill('1000');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit.getByRole('alert').first()).toContainText('cannot go below what has already been paid');
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('bill-total')).toHaveText('৳ 3,750.50'); // unchanged

    // removing the extra charge is fine (3,500 > 3,000 paid)
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('listitem').filter({ hasText: 'Lift repair share' }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByTestId('bill-total')).toHaveText('৳ 3,500.00');
  });

  test('view-only billing staff can look but not change anything', async ({ page }) => {
    await login(page, VIEWER);
    await openBillOf(page, tenants[1]!.unit);
    await expect(page.getByTestId('bill-total')).toBeVisible();
    for (const name of ['Add a charge', 'Record a payment', 'Void payment', 'Edit', 'Remove']) await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Receipt (PDF)' }).first()).toBeVisible();
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Fees' })).toHaveCount(0);
    for (const path of ['/fees', '/bills/generate']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    }
  });

  test('staff with no billing permission see no money screens', async ({ page }) => {
    await login(page, { id: 'staff@demo.local', pw: 'Staff1234' });
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Bills' })).toHaveCount(0);
    for (const path of ['/bills', `/bills/00000000-0000-0000-0000-000000000000`, '/fees']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    }
  });

  test('a one-off bill can be created for a unit', async ({ page }) => {
    await login(page, CASHIER);
    const t = tenants[1]!;
    await page.goto('/bills');
    await page.getByRole('button', { name: 'New bill' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Search by unit number').fill(t.unit);
    await dialog.getByRole('button', { name: new RegExp(t.unit) }).click();
    await dialog.getByLabel('Month').fill('2026-01'); // a month this unit has no bill for
    await dialog.getByLabel('Amount (৳)').fill('700');
    await dialog.getByLabel('Description').fill('Cleaning');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: /January 2026/ })).toBeVisible();
    await expect(page.getByTestId('bill-total')).toHaveText('৳ 700.00');

    // a second bill for the same unit and month is refused
    await page.goto('/bills');
    await page.getByRole('button', { name: 'New bill' }).click();
    const again = page.getByRole('dialog');
    await again.getByPlaceholder('Search by unit number').fill(t.unit);
    await again.getByRole('button', { name: new RegExp(t.unit) }).click();
    await again.getByLabel('Month').fill('2026-01');
    await again.getByLabel('Amount (৳)').fill('100');
    await again.getByRole('button', { name: 'Save' }).click();
    await expect(again.getByRole('alert')).toContainText('already has a bill for that month');
  });

  test('an opening balance can be recorded from the unit page, once', async ({ page }) => {
    await login(page, ADMIN);
    // a fresh unit with a resident, so there is something to attach it to
    const [t] = await importTenants(page, ['']);
    await page.goto('/units');
    await page.getByPlaceholder('Search by unit number').fill(t!.unit);
    await page.getByRole('link', { name: new RegExp(t!.unit) }).click();
    await page.getByTestId('opening-amount').fill('2500');
    await page.getByRole('button', { name: 'Record opening balance' }).click();
    await expect(page.getByText('Opening balance recorded')).toBeVisible();
    await page.getByRole('link', { name: 'View the bill' }).click();
    await expect(page.getByTestId('bill-total')).toHaveText('৳ 2,500.00');
    await expect(page.getByText('balance from before the system was used')).toBeVisible();
    // no charges can be added to it
    await expect(page.getByRole('button', { name: 'Add a charge' })).toHaveCount(0);
    // a mistaken one can be removed while nothing has been paid
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Remove opening balance' }).click();
    await expect(page).toHaveURL(/\/bills$/);
  });
});

test.describe('settings and Bangla', () => {
  test('the building name set in Settings appears in the page header', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/settings');
    await page.getByLabel('Building name').fill('Sunrise Tower');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('banner').getByText('Sunrise Tower')).toBeVisible();

    await page.goto('/settings');
    await page.getByLabel('Usual due day of the month').fill('29');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toBeVisible(); // 1 to 28 only (BR-10)

    await page.getByLabel('Usual due day of the month').fill('10');
    await page.getByLabel('Building name').fill('Demo Tower');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
  });

  test('bills, a bill and the payment form work in Bangla and Large text without sideways scrolling', async ({ page }) => {
    const me = await createAdmin('বিল প্রশাসক');
    await page.goto('/login');
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.getByRole('button', { name: /\(A\+\)/ }).click();
    await page.getByLabel('ইমেইল বা মোবাইল নম্বর').fill(me.id);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill(me.pw);
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();
    await expect(page.getByRole('heading', { name: /স্বাগতম/ })).toBeVisible();

    await page.goto('/bills');
    await expect(page.getByRole('heading', { name: 'বিল', exact: true })).toBeVisible();
    await expect(page.getByText(/মোট .*পরিশোধিত .*বাকি/).first()).toBeVisible();
    await noSidewaysScroll(page);
    await page.getByRole('link').filter({ hasText: /৳/ }).first().click();
    await expect(page.getByTestId('bill-total')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'চার্জ' })).toBeVisible();
    await noSidewaysScroll(page);

    for (const path of ['/fees', '/bills/generate', '/settings']) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await noSidewaysScroll(page);
    }
  });
});
