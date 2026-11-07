import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { addMonths, client, currentMonthDhaka, d, loginAs, makeBill, makeLoginUser, occupy, resetDb, todayDhaka } from './helpers';
import { EXE, PNG, admin, asResident, clearUploads, filesOnDisk, makeRequest, residentIn, type Upload } from './maintenance.helpers';

const app = createApp();
beforeEach(async () => {
  await resetDb();
  clearUploads();
});
afterAll(async () => {
  await resetDb();
  clearUploads();
  await prisma.$disconnect();
  await pool.end();
});

type C = Awaited<ReturnType<typeof client>>;
const MONTH = currentMonthDhaka();
const TODAY = todayDhaka();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

function addDays(ymd: string, n: number): string {
  const t = new Date(ymd + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const FUTURE_DUE = addDays(TODAY, 20);

function report(c: C, billId: string, fields: Record<string, string> = {}, file?: Upload) {
  let req = c.form(`/api/bills/${billId}/payment-reports`);
  for (const [k, v] of Object.entries({ amount: '100000', paidOn: TODAY, method: 'BKASH', reference: 'TRX1', ...fields })) req = req.field(k, v);
  if (file) req = req.attach('screenshot', file.data, { filename: file.name, contentType: file.type ?? 'application/octet-stream' });
  return req;
}

const cashier = (a = app) => loginAs(a, 'STAFF', ['payments.record']);
const balanceOf = async (c: C, id: string) => (await c.get(`/api/bills/${id}`)).body.balance as number;
const notes = (userId: string, type: string) => prisma.notification.findMany({ where: { userId, type: type as 'BILL_NEW' } });

/** A resident with one unpaid bill of ৳3,000. */
async function billed(unit = '1A') {
  const r = await residentIn(app, unit);
  const bill = await makeBill(r.unit.id, MONTH, [['SERVICE', 300000]], { contactId: r.resident.id, dueDate: FUTURE_DUE });
  return { ...r, bill };
}
const pay = async (c: C, billId: string, amount: number, reference?: string, paidOn = TODAY) =>
  c.post(`/api/bills/${billId}/payments`, { amount, method: 'CASH', paidOn, ...(reference && { reference }) });

describe('FR-39 report a payment (BR-21)', () => {
  it('saves as pending, changes no balance, and tells the people who check payments', async () => {
    const { c, bill } = await billed();
    const staff = await cashier();
    const a = await admin(app);
    const plain = await loginAs(app, 'STAFF', ['billing.view']);
    const res = await report(c, bill.id);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(await balanceOf(c, bill.id)).toBe(300000);
    expect(await prisma.payment.count()).toBe(0);
    expect(await notes(staff.user.id, 'PAYMENT_REPORT_NEW')).toHaveLength(1);
    expect(await notes(a.user.id, 'PAYMENT_REPORT_NEW')).toHaveLength(1);
    expect(await notes(plain.user.id, 'PAYMENT_REPORT_NEW')).toHaveLength(0);
  });

  it('only residents who can see the bill may report; a neighbour gets not found', async () => {
    const { bill } = await billed();
    const other = await residentIn(app, '2A');
    expect((await report(other.c, bill.id)).status).toBe(404);
    expect((await report((await cashier()).c, bill.id)).status).toBe(403);
    expect((await report(await client(app), bill.id)).status).toBe(401);
    expect(await prisma.paymentReport.count()).toBe(0);
  });

  it('a household member can report too (BR-27)', async () => {
    const { occupancy, bill } = await billed();
    const member = await makeLoginUser('RESIDENT', [], { fullName: 'Spouse' });
    await prisma.householdMember.create({ data: { occupancyId: occupancy.id, userId: member.id, relation: 'Spouse', addedAt: d('2020-06-01') } });
    expect((await report(await asResident(app, member), bill.id)).status).toBe(201);
  });

  it('cannot report more than the balance less other pending reports', async () => {
    const { c, bill } = await billed();
    expect((await report(c, bill.id, { amount: '300001' })).body.error.fields.amount.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    expect((await report(c, bill.id, { amount: '200000' })).status).toBe(201);
    const over = await report(c, bill.id, { amount: '100001', reference: 'TRX2' });
    expect(over.status).toBe(400);
    expect(over.body.error.fields.amount).toEqual({ code: 'AMOUNT_EXCEEDS_BALANCE', params: { balance: 100000 } });
    expect((await report(c, bill.id, { amount: '100000', reference: 'TRX2' })).status).toBe(201);
    expect((await c.get(`/api/bills/${bill.id}/payment-reports`)).body.available).toBe(0);
  });

  it('two reports at the same moment cannot together exceed the balance', async () => {
    const { c, bill } = await billed();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => report(c, bill.id, { amount: '100000', reference: `R${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3); // ৳3,000 due, ৳1,000 each
    expect(results.filter((r) => r.status === 400)).toHaveLength(7);
    expect(await prisma.paymentReport.count()).toBe(3);
  });

  it('needs a transaction ID, a real amount and a date that is not in the future', async () => {
    const { c, bill } = await billed();
    expect((await report(c, bill.id, { reference: '   ' })).status).toBe(400);
    expect((await report(c, bill.id, { amount: '0' })).status).toBe(400);
    expect((await report(c, bill.id, { amount: 'abc' })).status).toBe(400);
    expect((await report(c, bill.id, { paidOn: addDays(TODAY, 1) })).body.error.fields.paidOn.code).toBe('PAID_ON_FUTURE');
  });

  it('accepts an image or a PDF by its real content, and refuses anything else', async () => {
    const { c, bill } = await billed();
    expect((await report(c, bill.id, { amount: '1000' }, { name: 'a.png', data: PNG })).status).toBe(201);
    expect((await report(c, bill.id, { amount: '1000', reference: 'T2' }, { name: 'a.pdf', data: PDF })).status).toBe(201);
    const bad = await report(c, bill.id, { amount: '1000', reference: 'T3' }, { name: 'photo.png', data: EXE, type: 'image/png' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.screenshot.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(filesOnDisk()).toHaveLength(2);
  });

  it('a refused report leaves no file behind', async () => {
    const { c, bill } = await billed();
    expect((await report(c, bill.id, { amount: '999999' }, { name: 'a.png', data: PNG })).status).toBe(400);
    expect(filesOnDisk()).toHaveLength(0);
  });

  it('the screenshot is shown to those who may see the bill, and nobody else', async () => {
    const { c, bill } = await billed();
    const other = await residentIn(app, '2A');
    await report(c, bill.id, {}, { name: 'a.png', data: PNG });
    const staff = await cashier();
    const id = (await staff.c.get('/api/payment-reports')).body.items[0].screenshotId as string;
    expect((await c.get(`/api/attachments/${id}`)).status).toBe(200);
    expect((await staff.c.get(`/api/attachments/${id}`)).status).toBe(200);
    expect((await other.c.get(`/api/attachments/${id}`)).status).toBe(404);
  });

  it('a neighbour cannot list the reports on a bill', async () => {
    const { c, bill } = await billed();
    const other = await residentIn(app, '2A');
    await report(c, bill.id);
    expect((await c.get(`/api/bills/${bill.id}/payment-reports`)).body.items).toHaveLength(1);
    expect((await other.c.get(`/api/bills/${bill.id}/payment-reports`)).status).toBe(404);
  });

  it('an opening balance with a report on it cannot be deleted', async () => {
    const r = await residentIn(app, '1A');
    const a = await admin(app);
    const bill = await prisma.bill.create({
      data: { unitId: r.unit.id, billingMonth: d(`${addMonths(MONTH, -1)}-01`), dueDate: d(`${addMonths(MONTH, -1)}-01`), kind: 'OPENING_BALANCE', createdById: a.user.id, billingContactId: r.resident.id, charges: { create: [{ type: 'OPENING_BALANCE', amount: 5000, description: 'Before' }] } },
    });
    expect((await report(r.c, bill.id, { amount: '1000' })).status).toBe(201);
    const res = await a.c.delete(`/api/bills/${bill.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BILL_HAS_PAYMENTS');
  });
});

describe('FR-40 verify reported payments', () => {
  it('only payments.record and administrators see the queue or decide', async () => {
    const { c, bill } = await billed();
    const id = (await report(c, bill.id)).body.id;
    const viewer = await loginAs(app, 'STAFF', ['billing.view']);
    for (const who of [c, viewer.c]) {
      expect((await who.get('/api/payment-reports')).status).toBe(403);
      expect((await who.post(`/api/payment-reports/${id}/verify`)).status).toBe(403);
      expect((await who.post(`/api/payment-reports/${id}/reject`, { reason: 'No such payment' })).status).toBe(403);
    }
    expect((await (await client(app)).get('/api/payment-reports')).status).toBe(401);
    expect((await (await cashier()).c.get('/api/payment-reports')).status).toBe(200);
  });

  it('shows pending reports oldest first, with the unit, bill and amount', async () => {
    const one = await billed('1A');
    const two = await billed('2A');
    const first = (await report(two.c, two.bill.id, { reference: 'OLD' })).body.id;
    await prisma.paymentReport.update({ where: { id: first }, data: { createdAt: new Date(Date.now() - 86_400_000) } });
    await report(one.c, one.bill.id, { reference: 'NEW' });
    const res = await (await cashier()).c.get('/api/payment-reports');
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: { reference: string }) => i.reference)).toEqual(['OLD', 'NEW']);
    expect(res.body.items[0]).toMatchObject({ unitNumber: '2A', billingMonth: MONTH, amount: 100000, method: 'BKASH', balance: 300000, duplicate: false });
  });

  it('verifying creates the payment and receipt, lowers the balance, and tells the household once each', async () => {
    const { c, occupancy, resident, bill } = await billed();
    const member = await makeLoginUser('RESIDENT', [], { fullName: 'Spouse' });
    await prisma.householdMember.create({ data: { occupancyId: occupancy.id, userId: member.id, relation: 'Spouse', addedAt: d('2020-06-01') } });
    const id = (await report(c, bill.id)).body.id;
    const staff = await cashier();
    const res = await staff.c.post(`/api/payment-reports/${id}/verify`);
    expect(res.status).toBe(200);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: res.body.paymentId } });
    expect(payment).toMatchObject({ amount: 100000, method: 'BKASH', reference: 'TRX1', recordedById: staff.user.id });
    expect(payment.receiptNo).toMatch(/^RCPT-\d{4}-\d{5}$/);
    expect(await balanceOf(c, bill.id)).toBe(200000);
    expect(await prisma.paymentReport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'VERIFIED', reviewedById: staff.user.id, paymentId: payment.id });
    // The reporter hears it once, as the answer to their report; the rest of the household hears a payment was recorded.
    expect(await notes(resident.id, 'PAYMENT_REPORT_VERIFIED')).toHaveLength(1);
    expect(await notes(resident.id, 'PAYMENT_RECORDED')).toHaveLength(0);
    expect(await notes(member.id, 'PAYMENT_RECORDED')).toHaveLength(1);
  });

  it('the date or amount can be corrected while verifying', async () => {
    const { c, bill } = await billed();
    const id = (await report(c, bill.id)).body.id;
    const yesterday = addDays(TODAY, -1);
    const res = await (await cashier()).c.post(`/api/payment-reports/${id}/verify`, { amount: 90000, paidOn: yesterday });
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: res.body.paymentId } });
    expect(p.amount).toBe(90000);
    expect(p.paidOn.toISOString().slice(0, 10)).toBe(yesterday);
  });

  it('every FR-11 rule still applies, and a refusal changes nothing', async () => {
    const { c, bill } = await billed();
    const id = (await report(c, bill.id)).body.id;
    const staff = await cashier();
    const over = await staff.c.post(`/api/payment-reports/${id}/verify`, { amount: 300001 });
    expect(over.body.error.fields.amount.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    expect((await staff.c.post(`/api/payment-reports/${id}/verify`, { paidOn: addDays(TODAY, 1) })).status).toBe(400);
    expect(await prisma.payment.count()).toBe(0);
    expect((await prisma.paymentReport.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    expect(await prisma.counter.count({ where: { kind: 'RCPT' } })).toBe(0); // no receipt number was used up
  });

  it('a report cannot be decided twice, even at the same moment', async () => {
    const { c, bill } = await billed();
    const id = (await report(c, bill.id)).body.id;
    const staff = await cashier();
    const results = await Promise.all([staff.c.post(`/api/payment-reports/${id}/verify`), staff.c.post(`/api/payment-reports/${id}/verify`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.payment.count()).toBe(1);
    const reject = await staff.c.post(`/api/payment-reports/${id}/reject`, { reason: 'Changed my mind' });
    expect(reject.body.error.code).toBe('REPORT_ALREADY_REVIEWED');
  });

  it('warns when the transaction ID was used on a payment, and asks before verifying', async () => {
    const one = await billed('1A');
    const two = await billed('2A');
    const staff = await cashier();
    await staff.c.post(`/api/bills/${one.bill.id}/payments`, { amount: 1000, method: 'BKASH', paidOn: TODAY, reference: 'used1' });
    const id = (await report(two.c, two.bill.id, { reference: 'USED1' })).body.id;
    expect((await staff.c.get('/api/payment-reports')).body.items[0].duplicate).toBe(true);
    const first = await staff.c.post(`/api/payment-reports/${id}/verify`);
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect((await staff.c.post(`/api/payment-reports/${id}/verify`, { confirm: true })).status).toBe(200);
  });

  it('warns about two reports with the same ID, but a report is never a duplicate of itself', async () => {
    const one = await billed('1A');
    const two = await billed('2A');
    const staff = await cashier();
    const a = (await report(one.c, one.bill.id, { reference: 'SAME' })).body.id;
    expect((await staff.c.get('/api/payment-reports')).body.items[0].duplicate).toBe(false);
    await report(two.c, two.bill.id, { reference: 'SAME' });
    expect((await staff.c.get('/api/payment-reports')).body.items.map((i: { duplicate: boolean }) => i.duplicate)).toEqual([true, true]);
    expect((await staff.c.post(`/api/payment-reports/${a}/verify`)).status).toBe(409);
  });

  it('a verified report does not warn about its own payment', async () => {
    const { c, bill } = await billed();
    const id = (await report(c, bill.id)).body.id;
    const staff = await cashier();
    await staff.c.post(`/api/payment-reports/${id}/verify`);
    expect((await staff.c.get('/api/payment-reports?status=VERIFIED')).body.items[0].duplicate).toBe(false);
  });

  it('entering a payment by hand with the ID of a waiting report asks first', async () => {
    const { c, bill } = await billed();
    await report(c, bill.id, { reference: 'WAIT1' });
    const staff = await cashier();
    const res = await staff.c.post(`/api/bills/${bill.id}/payments`, { amount: 1000, method: 'BKASH', paidOn: TODAY, reference: 'WAIT1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_REFERENCE');
  });

  it('rejecting needs a reason, which the resident sees; the same ID can then be reported again', async () => {
    const { c, resident, bill } = await billed();
    const id = (await report(c, bill.id, { reference: 'TYPO' })).body.id;
    const staff = await cashier();
    expect((await staff.c.post(`/api/payment-reports/${id}/reject`, { reason: '' })).status).toBe(400);
    expect((await staff.c.post(`/api/payment-reports/${id}/reject`, { reason: 'Amount does not match' })).status).toBe(200);
    expect(await balanceOf(c, bill.id)).toBe(300000);
    const mine = (await c.get(`/api/bills/${bill.id}/payment-reports`)).body;
    expect(mine.items[0]).toMatchObject({ status: 'REJECTED', rejectReason: 'Amount does not match' });
    expect(mine.available).toBe(300000);
    expect((await notes(resident.id, 'PAYMENT_REPORT_REJECTED'))[0]!.params).toMatchObject({ reason: 'Amount does not match' });
    const again = (await report(c, bill.id, { reference: 'TYPO' })).body.id;
    expect((await staff.c.get('/api/payment-reports')).body.items[0].duplicate).toBe(false);
    expect((await staff.c.post(`/api/payment-reports/${again}/verify`)).status).toBe(200);
  });

  it('a pending report is not counted in reports or the dashboard’s money, only as a number waiting', async () => {
    const { c, bill } = await billed();
    await report(c, bill.id);
    const a = await admin(app);
    const dash = (await a.c.get('/api/dashboard')).body;
    expect(dash.billing).toMatchObject({ collected: 0, pendingReports: 1 });
  });
});

describe('FR-45 statement of account', () => {
  const FIRST = `${addMonths(MONTH, -3)}-01`;
  async function scene() {
    const r = await residentIn(app, '1A');
    const a = await admin(app);
    const b1 = await makeBill(r.unit.id, addMonths(MONTH, -2), [['SERVICE', 300000]], { contactId: r.resident.id, createdById: a.user.id });
    const b2 = await makeBill(r.unit.id, addMonths(MONTH, -1), [['SERVICE', 300000], ['WATER', 50000]], { contactId: r.resident.id, createdById: a.user.id });
    await pay(a.c, b1.id, 300000, undefined, `${addMonths(MONTH, -2)}-15`);
    await pay(a.c, b2.id, 100000, undefined, `${addMonths(MONTH, -1)}-20`);
    return { ...r, a, b1, b2 };
  }
  const mine = (c: C, unitId: string, from: string, to: string) => c.get(`/api/me/billing/statement?unitId=${unitId}&from=${from}&to=${to}`);

  it('lists bills and payments in date order with a running balance', async () => {
    const { c, unit } = await scene();
    const res = await mine(c, unit.id, FIRST, TODAY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ opening: 0, totalCharged: 650000, totalPaid: 400000, closing: 250000 });
    expect(res.body.rows.map((r: { kind: string; balance: number }) => [r.kind, r.balance])).toEqual([
      ['BILL', 300000],
      ['PAYMENT', 0],
      ['BILL', 350000],
      ['PAYMENT', 250000],
    ]);
  });

  it('carries what came before the period into the opening balance', async () => {
    const { c, unit } = await scene();
    const from = `${addMonths(MONTH, -1)}-01`;
    const res = await mine(c, unit.id, from, TODAY);
    expect(res.body).toMatchObject({ opening: 0, closing: 250000 }); // the first bill was fully paid before this period
    expect(res.body.rows).toHaveLength(2);
    const mid = await mine(c, unit.id, `${addMonths(MONTH, -2)}-10`, TODAY);
    expect(mid.body.opening).toBe(300000); // billed on the 1st, not paid until the 15th
  });

  it('a period can end early; the closing balance is the balance on that day', async () => {
    const { c, unit } = await scene();
    const res = await mine(c, unit.id, FIRST, `${addMonths(MONTH, -2)}-20`);
    expect(res.body).toMatchObject({ closing: 0, totalCharged: 300000, totalPaid: 300000 });
  });

  it('up to today it ends on the outstanding balance, even with next month already billed', async () => {
    const { c, unit, resident, a } = await scene();
    await makeBill(unit.id, addMonths(MONTH, 1), [['SERVICE', 300000]], { contactId: resident.id, createdById: a.user.id });
    const closing = (await mine(c, unit.id, FIRST, TODAY)).body.closing;
    expect(closing).toBe(550000);
    expect(closing).toBe((await c.get('/api/me/billing/balance')).body.outstanding);
  });

  it('voided payments do not count', async () => {
    const { c, unit, a, b2 } = await scene();
    const p = await prisma.payment.findFirstOrThrow({ where: { billId: b2.id } });
    await a.c.post(`/api/payments/${p.id}/void`, { reason: 'Entered by mistake' });
    const res = await mine(c, unit.id, FIRST, TODAY);
    expect(res.body).toMatchObject({ totalPaid: 300000, closing: 350000 });
    expect(res.body.rows.filter((r: { kind: string }) => r.kind === 'PAYMENT')).toHaveLength(1);
  });

  it('a resident gets only the bills from their own stay (BR-08)', async () => {
    const earlier = await occupy('5C', { start: '2020-01-01', end: `${addMonths(MONTH, -2)}-28`, contact: false });
    const a = await admin(app);
    await makeBill(earlier.unit.id, addMonths(MONTH, -3), [['SERVICE', 100000]], { createdById: a.user.id });
    const now = await occupy('5C', { start: `${addMonths(MONTH, -1)}-01` });
    await makeBill(earlier.unit.id, MONTH, [['SERVICE', 200000]], { createdById: a.user.id });
    const c = await asResident(app, now.resident);
    const res = await mine(c, earlier.unit.id, FIRST, TODAY);
    expect(res.body).toMatchObject({ opening: 0, totalCharged: 200000, closing: 200000 });
    expect((await a.c.get(`/api/units/${earlier.unit.id}/statement?from=${FIRST}&to=${TODAY}`)).body.totalCharged).toBe(300000);
  });

  it('a neighbour gets not found, for the data and the PDF, and only sees their own units', async () => {
    const { c, unit } = await scene();
    const other = await residentIn(app, '2A');
    expect((await mine(other.c, unit.id, FIRST, TODAY)).status).toBe(404);
    expect((await other.c.get(`/api/me/billing/statement.pdf?unitId=${unit.id}&from=${FIRST}&to=${TODAY}`)).status).toBe(404);
    expect((await other.c.get('/api/me/billing/statement/units')).body.items).toEqual([]);
    expect((await c.get('/api/me/billing/statement/units')).body.items.map((u: { unitNumber: string }) => u.unitNumber)).toEqual(['1A']);
  });

  it('staff who work with bills can open any unit; others cannot', async () => {
    const { unit } = await scene();
    const url = `/api/units/${unit.id}/statement?from=${FIRST}&to=${TODAY}`;
    expect((await (await loginAs(app, 'STAFF', ['billing.view'])).c.get(url)).status).toBe(200);
    expect((await (await loginAs(app, 'STAFF')).c.get(url)).status).toBe(403);
    expect((await (await residentIn(app, '9Z')).c.get(url)).status).toBe(403);
    expect((await (await client(app)).get(url)).status).toBe(401);
  });

  it('refuses a backwards period', async () => {
    const { c, unit } = await scene();
    const res = await mine(c, unit.id, TODAY, FIRST);
    expect(res.status).toBe(400);
    expect(res.body.error.fields.to.code).toBe('RANGE_REVERSED');
  });

  it('downloads as a PDF', async () => {
    const { c, unit } = await scene();
    const res = await c.agent.get(`/api/me/billing/statement.pdf?unitId=${unit.id}&from=${FIRST}&to=${TODAY}`).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on('data', (x: Buffer) => parts.push(x));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  }, 30_000);
});

describe('FR-46 no-dues certificate (BR-24)', () => {
  it('is refused while anything is owed, and when nothing was ever billed', async () => {
    const { unit } = await billed();
    const a = await admin(app);
    const res = await a.c.post(`/api/units/${unit.id}/certificates`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUES_OUTSTANDING');
    expect((await a.c.get(`/api/units/${unit.id}/certificates`)).body).toMatchObject({ canIssue: false, balance: 300000 });

    const empty = await occupy('2A');
    const none = await a.c.post(`/api/units/${empty.unit.id}/certificates`);
    expect(none.body.error.code).toBe('NOTHING_BILLED');
    expect(await prisma.noDuesCertificate.count()).toBe(0);
    expect(await prisma.counter.count({ where: { kind: 'NDC' } })).toBe(0);
  });

  async function settled() {
    const b = await billed();
    const a = await admin(app);
    await pay(a.c, b.bill.id, 300000);
    return { ...b, a };
  }

  it('numbers run in order, goes to the billing contact, and covers the latest billed month', async () => {
    const { a, unit, resident } = await settled();
    const year = TODAY.slice(0, 4);
    const res = await a.c.post(`/api/units/${unit.id}/certificates`);
    expect(res.status).toBe(201);
    expect(res.body.number).toBe(`NDC-${year}-00001`);
    expect((await a.c.post(`/api/units/${unit.id}/certificates`)).body.number).toBe(`NDC-${year}-00002`);
    const list = (await a.c.get(`/api/units/${unit.id}/certificates`)).body;
    expect(list.canIssue).toBe(true);
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ coversThroughMonth: MONTH, issuedTo: { id: resident.id } });
    expect(await notes(resident.id, 'CERTIFICATE_ISSUED')).toHaveLength(2);
  });

  it('a voided payment brings the dues back and blocks the certificate', async () => {
    const { a, unit, bill } = await settled();
    const p = await prisma.payment.findFirstOrThrow({ where: { billId: bill.id } });
    await a.c.post(`/api/payments/${p.id}/void`, { reason: 'Cheque bounced' });
    expect((await a.c.post(`/api/units/${unit.id}/certificates`)).body.error.code).toBe('DUES_OUTSTANDING');
  });

  it('can be issued to someone who lived there, but not to a stranger', async () => {
    const { a, unit } = await settled();
    const past = await occupy('1A', { start: '2019-01-01', end: '2019-12-31', contact: false, name: 'Past Owner' });
    const stranger = await occupy('7Z');
    expect((await a.c.post(`/api/units/${unit.id}/certificates`, { residentId: past.resident.id })).status).toBe(201);
    const res = await a.c.post(`/api/units/${unit.id}/certificates`, { residentId: stranger.resident.id });
    expect(res.body.error.fields.residentId.code).toBe('INVALID_RESIDENT');
  });

  it('needs a resident when the unit has no billing contact', async () => {
    const o = await occupy('3A', { start: '2019-01-01', end: '2019-12-31', contact: false });
    const a = await admin(app);
    await makeBill(o.unit.id, '2019-05', [['SERVICE', 100]], { createdById: a.user.id }).then((b) => pay(a.c, b.id, 100));
    expect((await a.c.post(`/api/units/${o.unit.id}/certificates`)).body.error.fields.residentId.code).toBe('RESIDENT_REQUIRED');
  });

  it('only administrators issue; billing.view may look', async () => {
    const { c, unit } = await settled();
    const viewer = await loginAs(app, 'STAFF', ['billing.view', 'billing.manage', 'payments.record']);
    expect((await viewer.c.post(`/api/units/${unit.id}/certificates`)).status).toBe(403);
    expect((await c.post(`/api/units/${unit.id}/certificates`)).status).toBe(403);
    expect((await viewer.c.get(`/api/units/${unit.id}/certificates`)).status).toBe(200);
    expect((await c.get(`/api/units/${unit.id}/certificates`)).status).toBe(403);
  });

  it('the resident can download theirs; a neighbour gets not found', async () => {
    const { a, c, unit } = await settled();
    const other = await residentIn(app, '2A');
    const id = (await a.c.post(`/api/units/${unit.id}/certificates`)).body.id;
    expect((await c.get('/api/me/billing/certificates')).body.items).toHaveLength(1);
    expect((await other.c.get('/api/me/billing/certificates')).body.items).toEqual([]);
    expect((await other.c.get(`/api/certificates/${id}/pdf`)).status).toBe(404);
    expect((await (await loginAs(app, 'STAFF')).c.get(`/api/certificates/${id}/pdf`)).status).toBe(403);
    expect((await c.get(`/api/certificates/${id}/pdf`)).status).toBe(200);
  }, 30_000);

  it('an administrator can check a number; anyone else cannot', async () => {
    const { a, c, unit } = await settled();
    const { number } = (await a.c.post(`/api/units/${unit.id}/certificates`)).body;
    const res = await a.c.get(`/api/certificates?number=${number.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ number, unit: { unitNumber: '1A' } });
    expect((await a.c.get('/api/certificates?number=NDC-1999-00001')).status).toBe(404);
    expect((await c.get(`/api/certificates?number=${number}`)).status).toBe(403);
  });
});

describe('FR-56 move-out wizard', () => {
  const body = (over: object = {}) => ({ endDate: TODAY, expectedBalance: 0, ...over });
  const go = (c: C, id: string, over: object = {}) => c.post(`/api/occupancies/${id}/move-out`, body(over));

  it('is for administrators only, even with residents.manage', async () => {
    const { occupancy } = await billed();
    const office = await loginAs(app, 'STAFF', ['residents.manage']);
    expect((await office.c.get(`/api/occupancies/${occupancy.id}/move-out-preview`)).status).toBe(403);
    expect((await go(office.c, occupancy.id)).status).toBe(403);
    expect((await (await client(app)).get(`/api/occupancies/${occupancy.id}/move-out-preview`)).status).toBe(401);
  });

  it('the preview shows the dues, pending reports, open requests, occupants and household, and changes nothing', async () => {
    const { c, occupancy, unit, resident, bill } = await billed();
    await report(c, bill.id);
    await makeRequest(resident.id, unit.id, { status: 'IN_PROGRESS', title: 'Broken lift button' });
    await makeRequest(resident.id, unit.id, { status: 'CLOSED', title: 'Old one' });
    const other = await occupy('1A', { contact: false, name: 'Flatmate' });
    const member = await makeLoginUser('RESIDENT', [], { fullName: 'Spouse' });
    await prisma.householdMember.create({ data: { occupancyId: occupancy.id, userId: member.id, relation: 'Spouse', addedAt: d('2020-06-01') } });
    const a = await admin(app);
    const res = await a.c.get(`/api/occupancies/${occupancy.id}/move-out-preview`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ balance: 300000, canIssueCertificate: false, hasOtherActiveOccupancy: false });
    expect(res.body.unpaidBills).toHaveLength(1);
    expect(res.body.pendingReports).toHaveLength(1);
    expect(res.body.openRequests.map((r: { title: string }) => r.title)).toEqual(['Broken lift button']);
    expect(res.body.otherOccupants).toEqual([{ occupancyId: other.occupancy.id, type: 'TENANT', fullName: 'Flatmate' }]);
    expect(res.body.householdMembers).toEqual([{ id: member.id, fullName: 'Spouse' }]);
    expect((await prisma.occupancy.findUniqueOrThrow({ where: { id: occupancy.id } })).endDate).toBeNull();
  });

  it('does everything together: ends the stay, removes the household, issues the certificate, deactivates and logs out', async () => {
    const r = await billed();
    const a = await admin(app);
    await pay(a.c, r.bill.id, 300000);
    const member = await makeLoginUser('RESIDENT', [], { fullName: 'Spouse' });
    await prisma.householdMember.create({ data: { occupancyId: r.occupancy.id, userId: member.id, relation: 'Spouse', addedAt: d('2020-06-01') } });
    const memberC = await asResident(app, member);

    const res = await go(a.c, r.occupancy.id, { issueCertificate: true, deactivateAccount: true });
    expect(res.status).toBe(200);
    expect(res.body.certificate.number).toMatch(/^NDC-/);
    expect((await prisma.occupancy.findUniqueOrThrow({ where: { id: r.occupancy.id } })).endDate?.toISOString().slice(0, 10)).toBe(TODAY);
    expect((await prisma.householdMember.findFirstOrThrow({ where: { userId: member.id } })).removedAt).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.resident.id } })).isActive).toBe(false);
    // Checked before any request from them, because a request from an inactive user also clears its own session.
    expect(await prisma.$queryRaw`SELECT 1 FROM "session" WHERE "userId" = ${r.resident.id}::uuid`).toEqual([]);
    expect((await r.c.get('/api/auth/me')).status).toBe(401); // logged out everywhere
    expect((await r.c.login(r.resident.loginId)).status).not.toBe(200);
    expect((await a.c.get(`/api/units/${r.unit.id}`)).body.status).toBe('VACANT');
    // The household member stops seeing bills from months after they left, but keeps those from their time there (BR-08).
    const later = await makeBill(r.unit.id, addMonths(MONTH, 1), [['SERVICE', 100]], { createdById: a.user.id });
    expect((await memberC.get(`/api/bills/${later.id}`)).status).toBe(404);
  });

  it('with dues unpaid it needs a note, keeps it, and the dues stay on the unit', async () => {
    const { occupancy, unit } = await billed();
    const a = await admin(app);
    const refused = await go(a.c, occupancy.id, { expectedBalance: 300000 });
    expect(refused.body.error.fields.duesNote.code).toBe('NOTE_REQUIRED');
    expect((await go(a.c, occupancy.id, { expectedBalance: 300000, duesNote: 'Will pay by cheque next week' })).status).toBe(200);
    expect((await prisma.occupancy.findUniqueOrThrow({ where: { id: occupancy.id } })).moveOutNote).toBe('Will pay by cheque next week');
    const dues = (await a.c.get('/api/reports/dues')).body;
    expect(dues.units[0]).toMatchObject({ owed: 300000, unit: { id: unit.id } });
  });

  it('notices if the balance changed since the preview', async () => {
    const { occupancy, bill } = await billed();
    const a = await admin(app);
    await pay(a.c, bill.id, 100000);
    const res = await go(a.c, occupancy.id, { expectedBalance: 300000, duesNote: 'Out of date' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STALE_PREVIEW');
    expect((await prisma.occupancy.findUniqueOrThrow({ where: { id: occupancy.id } })).endDate).toBeNull();
  });

  it('the billing contact must be handed over when others stay, and the unit stays Occupied', async () => {
    const r = await occupy('1A');
    const stay = await occupy('1A', { contact: false, name: 'Flatmate' });
    const a = await admin(app);
    const refused = await go(a.c, r.occupancy.id);
    expect(refused.body.error.fields.newBillingContactOccupancyId.code).toBe('NEW_BILLING_CONTACT_REQUIRED');
    expect((await go(a.c, r.occupancy.id, { newBillingContactOccupancyId: stay.occupancy.id })).status).toBe(200);
    expect((await prisma.occupancy.findUniqueOrThrow({ where: { id: stay.occupancy.id } })).isBillingContact).toBe(true);
    expect((await a.c.get(`/api/units/${r.unit.id}`)).body.status).toBe('OCCUPIED');
  });

  it('is all or nothing: a certificate that cannot be issued undoes the whole move-out', async () => {
    const r = await billed();
    const a = await admin(app);
    const res = await go(a.c, r.occupancy.id, { expectedBalance: 300000, duesNote: 'Paying later', issueCertificate: true, deactivateAccount: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUES_OUTSTANDING');
    expect((await prisma.occupancy.findUniqueOrThrow({ where: { id: r.occupancy.id } }))).toMatchObject({ endDate: null, moveOutNote: null });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.resident.id } })).isActive).toBe(true);
  });

  it('will not deactivate someone who still lives elsewhere', async () => {
    const r = await occupy('1A');
    await prisma.occupancy.create({ data: { unitId: (await prisma.unit.create({ data: { unitNumber: '8B', floor: 8 } })).id, residentId: r.resident.id, type: 'OWNER', startDate: d('2021-01-01'), isBillingContact: true } });
    const a = await admin(app);
    expect((await a.c.get(`/api/occupancies/${r.occupancy.id}/move-out-preview`)).body.hasOtherActiveOccupancy).toBe(true);
    const res = await go(a.c, r.occupancy.id, { deactivateAccount: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HAS_OTHER_OCCUPANCY');
    expect((await go(a.c, r.occupancy.id)).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.resident.id } })).isActive).toBe(true);
    expect(await notes(r.resident.id, 'MOVE_OUT_RECORDED')).toHaveLength(1);
  });

  it('refuses a future date, a date before the stay, and a stay that already ended', async () => {
    const r = await occupy('1A');
    const a = await admin(app);
    expect((await go(a.c, r.occupancy.id, { endDate: addDays(TODAY, 1) })).body.error.fields.endDate.code).toBe('MOVE_OUT_FUTURE');
    expect((await go(a.c, r.occupancy.id, { endDate: '2019-01-01' })).body.error.fields.endDate.code).toBe('END_BEFORE_START');
    expect((await go(a.c, r.occupancy.id)).status).toBe(200);
    expect((await go(a.c, r.occupancy.id)).body.error.code).toBe('OCCUPANCY_ALREADY_ENDED');
    expect((await a.c.get(`/api/occupancies/${r.occupancy.id}/move-out-preview`)).status).toBe(409);
  });

  it('open maintenance requests stay open', async () => {
    const r = await occupy('1A');
    const req = await makeRequest(r.resident.id, r.unit.id, { status: 'IN_PROGRESS' });
    const a = await admin(app);
    await go(a.c, r.occupancy.id);
    expect((await prisma.maintenanceRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('IN_PROGRESS');
  });
});

describe('FR-43 building expenses (BR-23)', () => {
  const manager = () => loginAs(app, 'STAFF', ['expenses.manage']);
  function create(c: C, fields: Record<string, string> = {}, file?: Upload) {
    let req = c.form('/api/expenses');
    for (const [k, v] of Object.entries({ spentOn: TODAY, category: 'CLEANING', amount: '500000', payee: 'Clean Co', ...fields })) req = req.field(k, v);
    if (file) req = req.attach('receipt', file.data, { filename: file.name, contentType: file.type ?? 'application/octet-stream' });
    return req;
  }
  function edit(c: C, id: string, fields: Record<string, string>, file?: Upload) {
    let req = c.agent.patch(`/api/expenses/${id}`).set('X-CSRF-Token', c.token);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    if (file) req = req.attach('receipt', file.data, { filename: file.name, contentType: file.type ?? 'application/octet-stream' });
    return req;
  }

  it('only administrators and staff with expenses.manage', async () => {
    const r = await residentIn(app, '1A');
    const plain = await loginAs(app, 'STAFF', ['reports.view', 'billing.manage']);
    for (const c of [r.c, plain.c]) {
      expect((await c.get('/api/expenses')).status).toBe(403);
      expect((await create(c)).status).toBe(403);
    }
    expect((await (await client(app)).get('/api/expenses')).status).toBe(401);
    expect((await create((await manager()).c)).status).toBe(201);
    expect((await create((await admin(app)).c)).status).toBe(201);
  });

  it('validates the amount, date, category and payee', async () => {
    const { c } = await manager();
    expect((await create(c, { amount: '0' })).status).toBe(400);
    expect((await create(c, { payee: '  ' })).status).toBe(400);
    expect((await create(c, { category: 'PARTY' })).status).toBe(400);
    expect((await create(c, { spentOn: addDays(TODAY, 1) })).body.error.fields.spentOn.code).toBe('SPENT_ON_FUTURE');
    expect(await prisma.expense.count()).toBe(0);
  });

  it('keeps a receipt, shown only to those who manage expenses; residents never see it', async () => {
    const m = await manager();
    const e = (await create(m.c, {}, { name: 'r.pdf', data: PDF })).body;
    expect(e.receiptId).toBeTruthy();
    expect((await m.c.get(`/api/attachments/${e.receiptId}`)).status).toBe(200);
    expect((await (await residentIn(app, '1A')).c.get(`/api/attachments/${e.receiptId}`)).status).toBe(404);
    expect((await (await loginAs(app, 'STAFF', ['reports.view'])).c.get(`/api/attachments/${e.receiptId}`)).status).toBe(404);
    const bad = await create(m.c, {}, { name: 'r.png', data: EXE, type: 'image/png' });
    expect(bad.body.error.fields.receipt.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('can be edited, a new receipt replaces the old file, and a blank description clears it', async () => {
    const { c } = await manager();
    const e = (await create(c, { description: 'Monthly' }, { name: 'a.png', data: PNG })).body;
    const res = await edit(c, e.id, { amount: '600000', description: '' }, { name: 'b.pdf', data: PDF });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amount: 600000, description: null, payee: 'Clean Co' });
    expect(res.body.receiptId).not.toBe(e.receiptId);
    expect(filesOnDisk()).toHaveLength(1);
    expect(filesOnDisk()[0]).toMatch(/\.pdf$/);
  });

  it('voiding needs a reason, keeps it in the list, and a voided expense cannot change', async () => {
    const m = await manager();
    const e = (await create(m.c)).body;
    expect((await m.c.post(`/api/expenses/${e.id}/void`, { reason: '' })).status).toBe(400);
    const res = await m.c.post(`/api/expenses/${e.id}/void`, { reason: 'Entered twice' });
    expect(res.body).toMatchObject({ voided: true, voidReason: 'Entered twice' });
    expect((await m.c.post(`/api/expenses/${e.id}/void`, { reason: 'Again please' })).body.error.code).toBe('EXPENSE_VOIDED');
    expect((await edit(m.c, e.id, { amount: '1000' })).status).toBe(409);
    const list = (await m.c.get('/api/expenses')).body;
    expect(list.items).toHaveLength(1);
    expect(list.totalAmount).toBe(0);
  });

  it('filters by category and month, including the last day of the month', async () => {
    const { c } = await manager();
    const prev = addMonths(MONTH, -1);
    const [y, mo] = prev.split('-').map(Number) as [number, number];
    const lastDay = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    await create(c, { spentOn: lastDay, category: 'LIFT', amount: '1000' });
    await create(c, { spentOn: `${prev}-01`, category: 'WATER', amount: '2000' });
    await create(c, { spentOn: `${MONTH}-01`, category: 'LIFT', amount: '4000' });
    expect((await c.get(`/api/expenses?month=${prev}`)).body).toMatchObject({ total: 2, totalAmount: 3000 });
    expect((await c.get('/api/expenses?category=LIFT')).body).toMatchObject({ total: 2, totalAmount: 5000 });
    expect((await c.get(`/api/expenses?category=LIFT&month=${prev}`)).body).toMatchObject({ total: 1, totalAmount: 1000 });
  });

  describe('FR-44 income and expense report', () => {
    async function scene() {
      const b = await billed();
      const a = await admin(app);
      const prev = addMonths(MONTH, -1);
      await pay(a.c, b.bill.id, 100000, undefined, `${prev}-15`); // this month's bill, paid by date last month: cash basis
      await pay(a.c, b.bill.id, 50000);
      const voided = (await pay(a.c, b.bill.id, 7000)).body.paymentId;
      await a.c.post(`/api/payments/${voided}/void`, { reason: 'Mistake made' });
      await create(a.c, { spentOn: `${prev}-20`, category: 'LIFT', amount: '40000', payee: 'Secret Lift Ltd' });
      await create(a.c, { spentOn: `${MONTH}-01`, category: 'WATER', amount: '10000' });
      const v = (await create(a.c, { amount: '999' })).body.id;
      await a.c.post(`/api/expenses/${v}/void`, { reason: 'Entered twice' });
      return { ...b, a, prev };
    }

    it('compares money received with money spent, month by month, without voided records', async () => {
      const { a, prev } = await scene();
      const res = await a.c.get(`/api/reports/income-expense?from=${prev}&to=${MONTH}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ income: 150000, expenses: 50000, net: 100000 });
      expect(res.body.months).toEqual([
        { month: prev, income: 100000, expenses: 40000, net: 60000 },
        { month: MONTH, income: 50000, expenses: 10000, net: 40000 },
      ]);
      expect(res.body.byCategory).toEqual([
        { category: 'LIFT', amount: 40000 },
        { category: 'WATER', amount: 10000 },
      ]);
    });

    it('needs reports.view', async () => {
      const r = await residentIn(app, '9Z');
      const url = `/api/reports/income-expense?from=${MONTH}&to=${MONTH}`;
      expect((await r.c.get(url)).status).toBe(403);
      expect((await (await loginAs(app, 'STAFF', ['expenses.manage'])).c.get(url)).status).toBe(403);
      expect((await (await loginAs(app, 'STAFF', ['reports.view'])).c.get(url)).status).toBe(200);
    });

    it('residents see nothing until it is shared, then category totals only', async () => {
      const { a, c, prev } = await scene();
      const url = `/api/me/billing/building-summary?month=${prev}`;
      expect((await c.get(url)).status).toBe(404);
      expect((await a.c.put('/api/settings', { shareExpenseSummary: true })).status).toBe(200);
      expect((await c.get('/api/settings/public')).body.shareExpenseSummary).toBe(true);
      const res = await c.get(url);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ month: prev, total: 40000, byCategory: [{ category: 'LIFT', amount: 40000 }] });
      expect(JSON.stringify(res.body)).not.toContain('Secret');
      expect((await a.c.get(url)).status).toBe(403); // this page is the residents' own
    });
  });
});

describe('the database refuses bad finance records', () => {
  async function bill() {
    const o = await occupy('1A');
    const b = await makeBill(o.unit.id, MONTH, [['SERVICE', 1000]], { contactId: o.resident.id });
    return { o, b };
  }
  const base = (billId: string, reportedById: string) => ({ billId, reportedById, amount: 100, paidOn: d(TODAY), method: 'BKASH' as const, reference: 'T' });

  it('a rejected report must have a reason, a verified one a payment, a decided one a reviewer', async () => {
    const { o, b } = await bill();
    const data = base(b.id, o.resident.id);
    await expect(prisma.paymentReport.create({ data: { ...data, status: 'REJECTED', reviewedById: o.resident.id, reviewedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.paymentReport.create({ data: { ...data, status: 'VERIFIED', reviewedById: o.resident.id, reviewedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.paymentReport.create({ data: { ...data, status: 'REJECTED', rejectReason: 'No' } })).rejects.toThrow();
    await expect(prisma.paymentReport.create({ data: { ...data, amount: 0 } })).rejects.toThrow();
    await expect(prisma.paymentReport.create({ data: { ...data, reference: '  ' } })).rejects.toThrow();
  });

  it('an expense needs an amount, and a void records who, when and why', async () => {
    const u = await makeLoginUser('ADMIN');
    const data = { spentOn: d(TODAY), category: 'OTHER' as const, amount: 100, payee: 'X', recordedById: u.id };
    await expect(prisma.expense.create({ data: { ...data, amount: 0 } })).rejects.toThrow();
    await expect(prisma.expense.create({ data: { ...data, voidReason: 'Half a void' } })).rejects.toThrow();
  });

  it('an attachment belongs to exactly one thing', async () => {
    const u = await makeLoginUser('ADMIN');
    const e = await prisma.expense.create({ data: { spentOn: d(TODAY), category: 'OTHER', amount: 100, payee: 'X', recordedById: u.id } });
    const file = { storedName: 'x.png', originalName: 'x.png', mimeType: 'image/png', sizeBytes: 10, uploadedById: u.id };
    await expect(prisma.attachment.create({ data: file })).rejects.toThrow();
    await expect(prisma.attachment.create({ data: { ...file, expenseId: e.id } })).resolves.toBeTruthy();
  });
});
