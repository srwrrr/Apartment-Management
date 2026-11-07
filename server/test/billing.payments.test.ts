import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { addMonths, client, currentMonthDhaka, loginAs, makeBill, occupy, resetDb, todayDhaka } from './helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

const THIS = currentMonthDhaka();
const PREV = addMonths(THIS, -1);
const NEXT = addMonths(THIS, 1);
const FUTURE_DUE = `${NEXT}-28`; // always still ahead
const PAST_DUE = `${PREV}-10`; // always already gone
const YEAR = Number(todayDhaka().slice(0, 4));
const receiptNo = (year: number, n: number) => `RCPT-${year}-${String(n).padStart(5, '0')}`;

/** An occupied unit with one bill of ৳5,000 (service 4,000 + water 1,000), due in the future. */
async function setup(over: { dueDate?: string; month?: string } = {}) {
  const o = await occupy('1A', { name: 'Rahim Uddin' });
  const bill = await makeBill(o.unit.id, over.month ?? THIS, [['SERVICE', 400000], ['WATER', 100000]], { dueDate: over.dueDate ?? FUTURE_DUE, contactId: o.resident.id });
  return { ...o, bill };
}
const cashier = () => loginAs(app, 'STAFF', ['payments.record']);
const pay = (c: Awaited<ReturnType<typeof client>>, billId: string, body: object) =>
  c.post(`/api/bills/${billId}/payments`, { paidOn: todayDhaka(), method: 'CASH', ...body });
const billOf = async (c: Awaited<ReturnType<typeof client>>, id: string) => (await c.get(`/api/bills/${id}`)).body;

describe('FR-11 record payments', () => {
  it('reduces the balance and moves the bill from unpaid to partly paid to paid', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    expect((await billOf(c, bill.id)).status).toBe('UNPAID');

    const first = await pay(c, bill.id, { amount: 200000, method: 'BKASH', reference: 'TX1001' });
    expect(first.status).toBe(201);
    expect(first.body.bill).toMatchObject({ total: 500000, paid: 200000, balance: 300000, status: 'PARTIALLY_PAID' });
    expect(first.body.bill.payments[0]).toMatchObject({ amount: 200000, method: 'BKASH', reference: 'TX1001', voided: false, recordedBy: expect.any(String) });

    const second = await pay(c, bill.id, { amount: 300000 });
    expect(second.body.bill).toMatchObject({ paid: 500000, balance: 0, status: 'PAID' });
    expect(second.body.bill.payments).toHaveLength(2);
  });

  it('BR-14: receipt numbers run RCPT-year-00001, 00002, … and never repeat', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    const a = await pay(c, bill.id, { amount: 100000 });
    const b = await pay(c, bill.id, { amount: 100000 });
    const nos = [a, b].map((r) => r.body.bill.payments.at(-1).receiptNo);
    expect(nos).toEqual([receiptNo(YEAR, 1), receiptNo(YEAR, 2)]);
  });

  it('the receipt year follows the payment date, each year counting on its own', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    const old = await pay(c, bill.id, { amount: 100000, paidOn: `${YEAR - 1}-12-30` });
    const now = await pay(c, bill.id, { amount: 100000 });
    expect(old.body.bill.payments[0].receiptNo).toBe(receiptNo(YEAR - 1, 1));
    expect(now.body.bill.payments[1].receiptNo).toBe(receiptNo(YEAR, 1));
  });

  it('BR-11: refuses zero, negative, fractional, huge and non-numeric amounts, and saves nothing', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    for (const amount of [0, -100, 1.5, 1_000_000_001, '1000', null, undefined]) {
      const res = await pay(c, bill.id, { amount });
      expect(res.status, String(amount)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(await prisma.payment.count()).toBe(0);
  });

  it('BR-11: refuses more than the balance and says what the balance is; paying exactly the balance is fine', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    const over = await pay(c, bill.id, { amount: 500001 });
    expect(over.status).toBe(400);
    expect(over.body.error.fields.amount).toEqual({ code: 'AMOUNT_EXCEEDS_BALANCE', params: { balance: 500000 } });
    await pay(c, bill.id, { amount: 200000 });
    expect((await pay(c, bill.id, { amount: 300001 })).body.error.fields.amount.params.balance).toBe(300000);
    expect((await pay(c, bill.id, { amount: 300000 })).status).toBe(201);
    expect(await prisma.payment.count()).toBe(2);
  });

  it('a fully paid bill takes no more payments', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    await pay(c, bill.id, { amount: 500000 });
    const more = await pay(c, bill.id, { amount: 100 });
    expect(more.status).toBe(400);
    expect(more.body.error.fields.amount.params.balance).toBe(0);
  });

  it('refuses a payment dated in the future, accepts today and the past', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await pay(c, bill.id, { amount: 100, paidOn: tomorrow })).body.error.fields.paidOn.code).toBe('PAID_ON_FUTURE');
    expect((await pay(c, bill.id, { amount: 100, paidOn: todayDhaka() })).status).toBe(201);
    expect((await pay(c, bill.id, { amount: 100, paidOn: `${YEAR - 1}-01-15` })).status).toBe(201);
    expect((await pay(c, bill.id, { amount: 100, paidOn: '2026-02-30' })).status).toBe(400);
  });

  it('every payment method is accepted, and unknown ones are not', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    for (const method of ['CASH', 'BANK', 'BKASH', 'NAGAD', 'ROCKET', 'OTHER']) expect((await pay(c, bill.id, { amount: 100, method })).status, method).toBe(201);
    expect((await pay(c, bill.id, { amount: 100, method: 'PAYPAL' })).status).toBe(400);
  });

  it('warns when a transaction ID was already used with the same method, and saves only when confirmed', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    await pay(c, bill.id, { amount: 100000, method: 'BKASH', reference: 'TX9F3K2' });
    const dup = await pay(c, bill.id, { amount: 100000, method: 'BKASH', reference: 'tx9f3k2' }); // any letter case
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await prisma.payment.count()).toBe(1);

    expect((await pay(c, bill.id, { amount: 100000, method: 'BKASH', reference: 'TX9F3K2', confirm: true })).status).toBe(201);
    expect((await pay(c, bill.id, { amount: 50000, method: 'NAGAD', reference: 'TX9F3K2' })).status).toBe(201); // other method
    expect(await prisma.payment.count()).toBe(3);
  });

  it('the duplicate warning also covers other bills, ignores voided payments and empty references', async () => {
    const a = await setup();
    const other = await occupy('2B');
    const otherBill = await makeBill(other.unit.id, THIS, [['SERVICE', 300000]], { dueDate: FUTURE_DUE });
    const { c } = await cashier();
    const admin = await loginAs(app, 'ADMIN');
    const first = await pay(c, a.bill.id, { amount: 100000, method: 'BANK', reference: 'CHQ-77' });
    expect((await pay(c, otherBill.id, { amount: 100000, method: 'BANK', reference: 'CHQ-77' })).status).toBe(409);
    await admin.c.post(`/api/payments/${first.body.paymentId}/void`, { reason: 'Entered twice by mistake' });
    expect((await pay(c, otherBill.id, { amount: 100000, method: 'BANK', reference: 'CHQ-77' })).status).toBe(201);
    expect((await pay(c, a.bill.id, { amount: 100 })).status).toBe(201); // no reference at all
    expect((await pay(c, a.bill.id, { amount: 100, reference: '' })).status).toBe(201);
  });

  it('NFR-14 / BR-11: two people paying the full balance at the same moment cannot overpay', async () => {
    const { bill } = await setup();
    const [x, y] = [await cashier(), await cashier()];
    const [r1, r2] = await Promise.all([pay(x.c, bill.id, { amount: 500000 }), pay(y.c, bill.id, { amount: 500000 })]);
    expect([r1.status, r2.status].sort()).toEqual([201, 400]);
    const b = await billOf(x.c, bill.id);
    expect(b).toMatchObject({ paid: 500000, balance: 0, status: 'PAID' });
    expect(b.payments).toHaveLength(1);
  });

  it('BR-14: many simultaneous payments get distinct, gap-free receipt numbers and never exceed the total', async () => {
    const { bill } = await setup();
    const people = await Promise.all([1, 2, 3, 4, 5, 6].map(() => cashier()));
    const results = await Promise.all(people.map((p) => pay(p.c, bill.id, { amount: 100000 })));
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(5); // 5 × 1,000 = 5,000 exactly fills the bill
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
    const nos = (await prisma.payment.findMany({ select: { receiptNo: true } })).map((p) => p.receiptNo).sort();
    expect(nos).toEqual([1, 2, 3, 4, 5].map((n) => receiptNo(YEAR, n)));
  });

  it('only staff with payments.record (and admins) may record payments', async () => {
    const { bill } = await setup();
    expect((await pay(await client(app), bill.id, { amount: 100 })).status).toBe(401);
    expect((await pay((await loginAs(app, 'RESIDENT')).c, bill.id, { amount: 100 })).status).toBe(403);
    for (const perm of ['billing.view', 'billing.manage', 'residents.manage']) {
      expect((await pay((await loginAs(app, 'STAFF', [perm])).c, bill.id, { amount: 100 })).status, perm).toBe(403);
    }
    expect((await pay((await loginAs(app, 'ADMIN')).c, bill.id, { amount: 100 })).status).toBe(201);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('404 for an unknown or malformed bill', async () => {
    const { c } = await cashier();
    expect((await pay(c, '00000000-0000-0000-0000-000000000000', { amount: 100 })).status).toBe(404);
    expect((await pay(c, 'nope', { amount: 100 })).status).toBe(404);
  });
});

describe('BR-09 bill status', () => {
  it('is overdue after the due date until it is fully paid', async () => {
    const { bill } = await setup({ month: PREV, dueDate: PAST_DUE });
    const { c } = await cashier();
    expect((await billOf(c, bill.id)).status).toBe('OVERDUE');
    expect((await pay(c, bill.id, { amount: 100000 })).body.bill.status).toBe('OVERDUE'); // partly paid but late
    expect((await pay(c, bill.id, { amount: 400000 })).body.bill.status).toBe('PAID');
  });

  it('is not overdue on the due date itself, only the day after', async () => {
    const { unit } = await occupy('3C');
    const today = todayDhaka();
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const dueToday = await makeBill(unit.id, THIS, [['SERVICE', 100000]], { dueDate: today });
    const { unit: u2 } = await occupy('3D');
    const dueYesterday = await makeBill(u2.id, THIS, [['SERVICE', 100000]], { dueDate: yesterday });
    const { c } = await cashier();
    expect((await billOf(c, dueToday.id)).status).toBe('UNPAID');
    expect((await billOf(c, dueYesterday.id)).status).toBe('OVERDUE');
  });
});

describe('BR-13 void a payment', () => {
  it('restores the balance, keeps the payment in the history as void, and records who and why', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    const p = await pay(c, bill.id, { amount: 500000, reference: 'WRONG' });
    expect(p.body.bill.status).toBe('PAID');

    const admin = await loginAs(app, 'ADMIN');
    const res = await admin.c.post(`/api/payments/${p.body.paymentId}/void`, { reason: 'Entered against the wrong unit' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paid: 0, balance: 500000, status: 'UNPAID' });
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]).toMatchObject({ voided: true, voidReason: 'Entered against the wrong unit', voidedBy: expect.any(String), amount: 500000 });
    expect(await prisma.payment.count()).toBe(1); // never deleted
  });

  it('a voided payment no longer counts, so the balance can be paid again, and its receipt number is not reused', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    const admin = await loginAs(app, 'ADMIN');
    const p = await pay(c, bill.id, { amount: 500000 });
    await admin.c.post(`/api/payments/${p.body.paymentId}/void`, { reason: 'Mistake' });
    const again = await pay(c, bill.id, { amount: 500000 });
    expect(again.status).toBe(201);
    expect(again.body.bill.payments.map((x: { receiptNo: string }) => x.receiptNo)).toEqual([receiptNo(YEAR, 1), receiptNo(YEAR, 2)]);
    expect(again.body.bill).toMatchObject({ paid: 500000, status: 'PAID' });
  });

  it('only administrators may void, and a reason is required', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    const p = await pay(c, bill.id, { amount: 100000 });
    const id = p.body.paymentId;
    expect((await (await client(app)).post(`/api/payments/${id}/void`, { reason: 'x'.repeat(5) })).status).toBe(401);
    expect((await (await loginAs(app, 'RESIDENT')).c.post(`/api/payments/${id}/void`, { reason: 'Because' })).status).toBe(403);
    const powerful = await loginAs(app, 'STAFF', ['payments.record', 'billing.manage', 'billing.view', 'reports.view']);
    expect((await powerful.c.post(`/api/payments/${id}/void`, { reason: 'Because' })).status).toBe(403);
    expect((await c.post(`/api/payments/${id}/void`, { reason: 'Because' })).status).toBe(403);

    const admin = await loginAs(app, 'ADMIN');
    for (const reason of ['', '  ', 'ab', undefined]) expect((await admin.c.post(`/api/payments/${id}/void`, { reason })).status).toBe(400);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id } })).voidedAt).toBeNull();
    expect((await admin.c.post(`/api/payments/${id}/void`, { reason: 'Entered twice' })).status).toBe(200);
  });

  it('cannot be voided twice; unknown payments are 404', async () => {
    const { bill } = await setup();
    const { c } = await cashier();
    const admin = await loginAs(app, 'ADMIN');
    const p = await pay(c, bill.id, { amount: 100000 });
    expect((await admin.c.post(`/api/payments/${p.body.paymentId}/void`, { reason: 'Mistake' })).status).toBe(200);
    const twice = await admin.c.post(`/api/payments/${p.body.paymentId}/void`, { reason: 'Mistake again' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('PAYMENT_ALREADY_VOIDED');
    expect((await admin.c.post('/api/payments/00000000-0000-0000-0000-000000000000/void', { reason: 'Mistake' })).status).toBe(404);
    expect((await admin.c.post('/api/payments/nope/void', { reason: 'Mistake' })).status).toBe(404);
  });
});

describe('BR-12 changing charges on a bill', () => {
  const editor = () => loginAs(app, 'STAFF', ['billing.manage']);

  it('adds a charge and the total, balance and status follow', async () => {
    const { bill } = await setup();
    const { c } = await editor();
    const res = await c.post(`/api/bills/${bill.id}/charges`, { type: 'GAS', amount: 70000, description: 'Gas bill' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ total: 570000, balance: 570000 });
    expect(res.body.charges).toHaveLength(3);
  });

  it('BR-07: a recurring type only once per bill; "Other" as often as needed', async () => {
    const { bill } = await setup();
    const { c } = await editor();
    const dup = await c.post(`/api/bills/${bill.id}/charges`, { type: 'SERVICE', amount: 1000, description: 'Again' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.fields.type.code).toBe('CHARGE_TYPE_EXISTS');
    for (const n of [1, 2]) expect((await c.post(`/api/bills/${bill.id}/charges`, { type: 'OTHER', amount: 1000 * n, description: `Extra ${n}` })).status).toBe(201);
    expect((await c.post(`/api/bills/${bill.id}/charges`, { type: 'OPENING_BALANCE', amount: 1000, description: 'x' })).status).toBe(400);
  });

  it('adding a charge to a paid bill makes it owe money again', async () => {
    const { bill } = await setup();
    const cash = await cashier();
    await pay(cash.c, bill.id, { amount: 500000 });
    const { c } = await editor();
    const res = await c.post(`/api/bills/${bill.id}/charges`, { type: 'OTHER', amount: 25000, description: 'Late fee' });
    expect(res.body).toMatchObject({ total: 525000, paid: 500000, balance: 25000, status: 'PARTIALLY_PAID' });
  });

  it('edits an amount or description; the total follows', async () => {
    const { bill } = await setup();
    const { c } = await editor();
    const charge = await prisma.charge.findFirstOrThrow({ where: { billId: bill.id, type: 'WATER' } });
    const res = await c.patch(`/api/charges/${charge.id}`, { amount: 150000, description: 'Water (corrected)' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(550000);
    expect(res.body.charges.find((x: { id: string }) => x.id === charge.id)).toMatchObject({ amount: 150000, description: 'Water (corrected)' });
  });

  it('cannot lower or remove a charge if the total would fall below what has been paid', async () => {
    const { bill } = await setup();
    const cash = await cashier();
    await pay(cash.c, bill.id, { amount: 450000 });
    const { c } = await editor();
    const service = await prisma.charge.findFirstOrThrow({ where: { billId: bill.id, type: 'SERVICE' } });
    const water = await prisma.charge.findFirstOrThrow({ where: { billId: bill.id, type: 'WATER' } });

    const lower = await c.patch(`/api/charges/${service.id}`, { amount: 300000 }); // total 4,000 < paid 4,500
    expect(lower.status).toBe(409);
    expect(lower.body.error.code).toBe('CHARGE_BELOW_PAID');
    expect((await c.delete(`/api/charges/${service.id}`)).status).toBe(409);
    expect((await c.patch(`/api/charges/${water.id}`, { amount: 50000 })).status).toBe(200); // total 4,500 = paid: allowed
    expect((await billOf(c, bill.id))).toMatchObject({ total: 450000, balance: 0, status: 'PAID' });
    expect(await prisma.charge.count({ where: { billId: bill.id } })).toBe(2);
  });

  it('removes a charge when nothing forbids it', async () => {
    const { bill } = await setup();
    const { c } = await editor();
    const water = await prisma.charge.findFirstOrThrow({ where: { billId: bill.id, type: 'WATER' } });
    const res = await c.delete(`/api/charges/${water.id}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(400000);
    expect(res.body.charges).toHaveLength(1);
  });

  it('after a payment is voided, the room it took up is free again', async () => {
    const { bill } = await setup();
    const cash = await cashier();
    const p = await pay(cash.c, bill.id, { amount: 500000 });
    const { c } = await editor();
    const water = await prisma.charge.findFirstOrThrow({ where: { billId: bill.id, type: 'WATER' } });
    expect((await c.delete(`/api/charges/${water.id}`)).status).toBe(409);
    const admin = await loginAs(app, 'ADMIN');
    await admin.c.post(`/api/payments/${p.body.paymentId}/void`, { reason: 'Mistake' });
    expect((await c.delete(`/api/charges/${water.id}`)).status).toBe(200);
  });

  it('needs billing.manage; 404 for unknown bills and charges', async () => {
    const { bill } = await setup();
    const charge = await prisma.charge.findFirstOrThrow({ where: { billId: bill.id } });
    const body = { type: 'OTHER', amount: 100, description: 'x' };
    expect((await (await loginAs(app, 'RESIDENT')).c.post(`/api/bills/${bill.id}/charges`, body)).status).toBe(403);
    for (const perm of ['billing.view', 'payments.record']) {
      const s = await loginAs(app, 'STAFF', [perm]);
      expect((await s.c.post(`/api/bills/${bill.id}/charges`, body)).status, perm).toBe(403);
      expect((await s.c.patch(`/api/charges/${charge.id}`, { amount: 5 })).status, perm).toBe(403);
      expect((await s.c.delete(`/api/charges/${charge.id}`)).status, perm).toBe(403);
    }
    const { c } = await editor();
    expect((await c.post('/api/bills/00000000-0000-0000-0000-000000000000/charges', body)).status).toBe(404);
    expect((await c.patch('/api/charges/00000000-0000-0000-0000-000000000000', { amount: 5 })).status).toBe(404);
    expect((await c.delete('/api/charges/nope')).status).toBe(404);
  });
});

describe('FR-12 finding bills', () => {
  async function fill() {
    const a = await occupy('1A');
    const b = await occupy('2B', { floor: 2 });
    const c3 = await occupy('3C', { floor: 3 });
    const paid = await makeBill(a.unit.id, THIS, [['SERVICE', 300000]], { dueDate: FUTURE_DUE, contactId: a.resident.id });
    const partly = await makeBill(b.unit.id, THIS, [['SERVICE', 300000]], { dueDate: FUTURE_DUE, contactId: b.resident.id });
    const overdue = await makeBill(c3.unit.id, THIS, [['SERVICE', 300000]], { dueDate: PAST_DUE, contactId: c3.resident.id });
    const old = await makeBill(a.unit.id, PREV, [['SERVICE', 250000]], { dueDate: PAST_DUE });
    const cash = await cashier();
    await pay(cash.c, paid.id, { amount: 300000 });
    await pay(cash.c, partly.id, { amount: 100000 });
    await pay(cash.c, old.id, { amount: 250000 });
    return { a, b, c3, paid, partly, overdue, old };
  }
  const viewer = () => loginAs(app, 'STAFF', ['billing.view']);

  it('filters by status, month, unit and text, and totals what it found', async () => {
    const f = await fill();
    const { c } = await viewer();
    const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id).sort();

    expect((await c.get('/api/bills')).body.total).toBe(4);
    expect(ids(await c.get('/api/bills?status=PAID'))).toEqual([f.paid.id, f.old.id].sort());
    expect(ids(await c.get('/api/bills?status=PARTIALLY_PAID'))).toEqual([f.partly.id]);
    expect(ids(await c.get('/api/bills?status=OVERDUE'))).toEqual([f.overdue.id]);
    expect((await c.get('/api/bills?status=UNPAID')).body.total).toBe(0);
    expect(ids(await c.get(`/api/bills?month=${PREV}`))).toEqual([f.old.id]);
    expect(ids(await c.get(`/api/bills?unitId=${f.a.unit.id}`))).toEqual([f.paid.id, f.old.id].sort());
    expect(ids(await c.get('/api/bills?q=3c'))).toEqual([f.overdue.id]);

    const sums = (await c.get(`/api/bills?month=${THIS}`)).body.sums;
    expect(sums).toEqual({ total: 900000, paid: 400000, balance: 500000 });
  });

  it('lists the newest month first, then by floor and unit, and paginates', async () => {
    await fill();
    const { c } = await viewer();
    const all = (await c.get('/api/bills')).body.items.map((i: { billingMonth: string; unit: { unitNumber: string } }) => `${i.billingMonth.slice(0, 7)} ${i.unit.unitNumber}`);
    expect(all).toEqual([`${THIS} 1A`, `${THIS} 2B`, `${THIS} 3C`, `${PREV} 1A`]);
    const page2 = await c.get('/api/bills?pageSize=3&page=2');
    expect(page2.body).toMatchObject({ page: 2, pageSize: 3, total: 4 });
    expect(page2.body.items).toHaveLength(1);
    expect((await c.get('/api/bills?status=NONSENSE')).status).toBe(400);
  });

  it('the list and the detail page always agree on the numbers', async () => {
    const f = await fill();
    const { c } = await viewer();
    for (const id of [f.paid.id, f.partly.id, f.overdue.id, f.old.id]) {
      const row = (await c.get('/api/bills?pageSize=100')).body.items.find((i: { id: string }) => i.id === id);
      const detail = (await c.get(`/api/bills/${id}`)).body;
      for (const k of ['total', 'paid', 'balance', 'status']) expect(detail[k], `${id} ${k}`).toBe(row[k]);
      expect(detail.charges.reduce((s: number, x: { amount: number }) => s + x.amount, 0)).toBe(detail.total);
      expect(detail.payments.filter((p: { voided: boolean }) => !p.voided).reduce((s: number, p: { amount: number }) => s + p.amount, 0)).toBe(detail.paid);
    }
  });

  it('staff who work with bills (any of the three permissions) can list; others and residents cannot', async () => {
    await fill();
    expect((await (await client(app)).get('/api/bills')).status).toBe(401);
    expect((await (await loginAs(app, 'RESIDENT')).c.get('/api/bills')).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF')).c.get('/api/bills')).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['residents.manage', 'reports.view'])).c.get('/api/bills')).status).toBe(403);
    for (const perm of ['billing.view', 'billing.manage', 'payments.record']) {
      expect((await (await loginAs(app, 'STAFF', [perm])).c.get('/api/bills')).status, perm).toBe(200);
    }
  });

  it('shows the charges, payments and billing contact of one bill', async () => {
    const f = await fill();
    const { c } = await viewer();
    const detail = (await c.get(`/api/bills/${f.partly.id}`)).body;
    expect(detail).toMatchObject({ unit: { unitNumber: '2B' }, billingMonth: `${THIS}-01`, dueDate: FUTURE_DUE, billingContact: { id: f.b.resident.id } });
    expect(detail.payments).toHaveLength(1);
    expect((await c.get('/api/bills/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await c.get('/api/bills/nope')).status).toBe(404);
  });
});
