import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { closePdfBrowser } from '../src/pdf/render';
import { getReceiptData } from '../src/modules/billing/payments.service';
import { receiptHtml } from '../src/modules/billing/receipt';
import type { AuthUser } from '../src/types';
import { addMonths, client, currentMonthDhaka, d, loginAs, makeBill, makeLoginUser, occupy, resetDb, todayDhaka } from './helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await closePdfBrowser();
  await prisma.$disconnect();
  await pool.end();
});

const THIS = currentMonthDhaka();
const PREV = addMonths(THIS, -1);
const OLDER = addMonths(THIS, -2);
const FUTURE_DUE = `${addMonths(THIS, 1)}-28`;
const TODAY = todayDhaka();

/** Log in as a resident created by occupy(). */
async function as(resident: { loginId: string }) {
  const c = await client(app);
  const res = await c.login(resident.loginId);
  if (res.status !== 200) throw new Error('login failed');
  return c;
}
const cashier = () => loginAs(app, 'STAFF', ['payments.record']);
const pay = (c: Awaited<ReturnType<typeof client>>, billId: string, amount: number, extra: object = {}) =>
  c.post(`/api/bills/${billId}/payments`, { amount, paidOn: TODAY, method: 'CASH', ...extra });
const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id).sort();

describe('NFR-16 / NFR-24 a resident sees only their own bills', () => {
  async function twoNeighbours() {
    const a = await occupy('1A', { name: 'Alice Rahman' });
    const b = await occupy('1B', { name: 'Bob Karim' });
    const billA = await makeBill(a.unit.id, THIS, [['SERVICE', 300000]], { dueDate: FUTURE_DUE, contactId: a.resident.id });
    const billB = await makeBill(b.unit.id, THIS, [['SERVICE', 450000]], { dueDate: FUTURE_DUE, contactId: b.resident.id });
    const cash = await cashier();
    const payA = await pay(cash.c, billA.id, 100000, { reference: 'ALICE-TX' });
    const payB = await pay(cash.c, billB.id, 200000, { reference: 'BOB-TX' });
    return { a, b, billA, billB, payA: payA.body.paymentId as string, payB: payB.body.paymentId as string };
  }

  it('lists only their own bills, payments and balance', async () => {
    const n = await twoNeighbours();
    const alice = await as(n.a.resident);
    expect(ids(await alice.get('/api/me/billing/bills'))).toEqual([n.billA.id]);
    expect((await alice.get('/api/me/billing/balance')).body).toEqual({ outstanding: 200000, overdueBills: 0, openBills: 1 });
    const pays = (await alice.get('/api/me/billing/payments')).body.items;
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ amount: 100000, unitNumber: '1A', reference: 'ALICE-TX' });
    const everything = JSON.stringify([(await alice.get('/api/me/billing/bills')).body, pays]);
    expect(everything).not.toMatch(/Bob|1B|BOB-TX|450000/);
  });

  it('opens their own bill, without seeing who recorded the payments', async () => {
    const n = await twoNeighbours();
    const alice = await as(n.a.resident);
    const res = await alice.get(`/api/bills/${n.billA.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 300000, paid: 100000, balance: 200000, unit: { unitNumber: '1A' } });
    expect(res.body.payments[0].recordedBy).toBeUndefined();
  });

  it('gets "not found" (not "forbidden") for a neighbour’s bill, so IDs cannot be probed', async () => {
    const n = await twoNeighbours();
    const alice = await as(n.a.resident);
    const res = await alice.get(`/api/bills/${n.billB.id}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND' } });
    expect((await alice.get('/api/bills/00000000-0000-0000-0000-000000000000')).body).toEqual(res.body); // same answer as for a bill that does not exist
    expect((await alice.get('/api/bills/not-a-uuid')).status).toBe(404);
  });

  it('cannot download a neighbour’s receipt, but can download their own', async () => {
    const n = await twoNeighbours();
    const alice = await as(n.a.resident);
    expect((await alice.get(`/api/payments/${n.payB}/receipt.pdf`)).status).toBe(404);
    expect((await alice.get(`/api/payments/${n.payA}/receipt.pdf`)).status).toBe(200);
  });

  it('cannot reach any staff action on bills, payments or fees, even for their own bill', async () => {
    const n = await twoNeighbours();
    const alice = await as(n.a.resident);
    expect((await alice.get('/api/bills')).status).toBe(403);
    expect((await alice.post(`/api/bills/${n.billA.id}/payments`, { amount: 100, paidOn: TODAY, method: 'CASH' })).status).toBe(403);
    expect((await alice.post(`/api/bills/${n.billA.id}/charges`, { type: 'OTHER', amount: 1, description: 'x' })).status).toBe(403);
    expect((await alice.post(`/api/payments/${n.payA}/void`, { reason: 'No reason' })).status).toBe(403);
    expect((await alice.get('/api/fees')).status).toBe(403);
    expect((await alice.post('/api/bills/generate', { month: THIS })).status).toBe(403);
  });

  it('the resident endpoints are for residents only', async () => {
    expect((await (await client(app)).get('/api/me/billing/bills')).status).toBe(401);
    expect((await (await loginAs(app, 'STAFF', ['billing.view'])).c.get('/api/me/billing/bills')).status).toBe(403);
    expect((await (await loginAs(app, 'ADMIN')).c.get('/api/me/billing/balance')).status).toBe(403);
  });

  it('staff without any billing permission cannot open a bill; with one they can', async () => {
    const n = await twoNeighbours();
    expect((await (await client(app)).get(`/api/bills/${n.billA.id}`)).status).toBe(401);
    expect((await (await loginAs(app, 'STAFF')).c.get(`/api/bills/${n.billA.id}`)).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['reports.view'])).c.get(`/api/bills/${n.billA.id}`)).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['billing.view'])).c.get(`/api/bills/${n.billA.id}`)).status).toBe(200);
  });

  it('a resident with no unit sees nothing', async () => {
    await twoNeighbours();
    const loner = await loginAs(app, 'RESIDENT');
    expect((await loner.c.get('/api/me/billing/bills')).body.total).toBe(0);
    expect((await loner.c.get('/api/me/billing/balance')).body).toEqual({ outstanding: 0, overdueBills: 0, openBills: 0 });
  });
});

describe('BR-08 which bills a resident may see over time', () => {
  async function handover() {
    // The old resident lived there until the 15th of last month; the new one from the 16th.
    const old = await occupy('5A', { name: 'Old Tenant', start: '2020-01-01', end: `${PREV}-15`, contact: true });
    const fresh = await occupy('5A', { name: 'New Tenant', start: `${PREV}-16`, contact: true });
    const unit = old.unit;
    const bOlder = await makeBill(unit.id, OLDER, [['SERVICE', 100000]], { dueDate: `${OLDER}-10`, contactId: old.resident.id });
    const bPrev = await makeBill(unit.id, PREV, [['SERVICE', 200000]], { dueDate: `${PREV}-10`, contactId: fresh.resident.id });
    const bThis = await makeBill(unit.id, THIS, [['SERVICE', 300000]], { dueDate: FUTURE_DUE, contactId: fresh.resident.id });
    return { old, fresh, bOlder, bPrev, bThis };
  }

  it('someone who moved out still sees the bills for months they lived there, not later ones', async () => {
    const h = await handover();
    const old = await as(h.old.resident);
    expect(ids(await old.get('/api/me/billing/bills?pageSize=100'))).toEqual([h.bOlder.id, h.bPrev.id].sort());
    expect((await old.get(`/api/bills/${h.bThis.id}`)).status).toBe(404);
  });

  it('a new resident does not see the previous occupant’s earlier bills', async () => {
    const h = await handover();
    const fresh = await as(h.fresh.resident);
    expect(ids(await fresh.get('/api/me/billing/bills?pageSize=100'))).toEqual([h.bPrev.id, h.bThis.id].sort());
    expect((await fresh.get(`/api/bills/${h.bOlder.id}`)).status).toBe(404);
    expect((await fresh.get('/api/me/billing/balance')).body.outstanding).toBe(500000);
  });

  it('BR-27: a household member sees the unit’s bills while their membership lasts', async () => {
    const o = await occupy('6A', { name: 'Head of house', start: '2020-01-01' });
    const member = await makeLoginUser('RESIDENT', [], { fullName: 'Spouse' });
    await prisma.householdMember.create({ data: { occupancyId: o.occupancy.id, userId: member.id, relation: 'Spouse', addedAt: d('2020-06-01') } });
    const bill = await makeBill(o.unit.id, THIS, [['SERVICE', 100000]], { dueDate: FUTURE_DUE });
    const spouse = await as(member);
    expect(ids(await spouse.get('/api/me/billing/bills'))).toEqual([bill.id]);
    expect((await spouse.get(`/api/bills/${bill.id}`)).status).toBe(200);
  });

  it('BR-27: a removed household member loses access to later bills but keeps the earlier ones', async () => {
    const o = await occupy('6B', { start: '2020-01-01' });
    const member = await makeLoginUser('RESIDENT');
    await prisma.householdMember.create({
      data: { occupancyId: o.occupancy.id, userId: member.id, relation: 'Son', addedAt: d('2020-06-01'), removedAt: d(`${PREV}-15`) },
    });
    const earlier = await makeBill(o.unit.id, OLDER, [['SERVICE', 100000]], { dueDate: `${OLDER}-10` });
    const later = await makeBill(o.unit.id, THIS, [['SERVICE', 100000]], { dueDate: FUTURE_DUE });
    const son = await as(member);
    expect(ids(await son.get('/api/me/billing/bills'))).toEqual([earlier.id]);
    expect((await son.get(`/api/bills/${later.id}`)).status).toBe(404);
  });
});

describe('FR-13 balance and payment history', () => {
  it('adds up what is owed across bills, counting overdue ones, and ignores paid bills', async () => {
    const o = await occupy('7A');
    const overdue = await makeBill(o.unit.id, PREV, [['SERVICE', 300000]], { dueDate: `${PREV}-10` });
    await makeBill(o.unit.id, THIS, [['SERVICE', 200000]], { dueDate: FUTURE_DUE });
    const settled = await makeBill(o.unit.id, OLDER, [['SERVICE', 100000]], { dueDate: `${OLDER}-10` });
    const cash = await cashier();
    await pay(cash.c, settled.id, 100000);
    await pay(cash.c, overdue.id, 50000);
    const me = await as(o.resident);
    expect((await me.get('/api/me/billing/balance')).body).toEqual({ outstanding: 450000, overdueBills: 1, openBills: 2 });
  });

  it('lists each payment with date, amount, method, reference and receipt number, newest first', async () => {
    const o = await occupy('7B');
    const bill = await makeBill(o.unit.id, THIS, [['SERVICE', 500000]], { dueDate: FUTURE_DUE });
    const cash = await cashier();
    await pay(cash.c, bill.id, 100000, { method: 'BKASH', reference: 'TX-A', paidOn: `${PREV}-20` });
    await pay(cash.c, bill.id, 200000, { method: 'CASH' });
    const me = await as(o.resident);
    const items = (await me.get('/api/me/billing/payments')).body.items;
    expect(items.map((i: { amount: number }) => i.amount)).toEqual([200000, 100000]);
    expect(items[1]).toMatchObject({ method: 'BKASH', reference: 'TX-A', paidOn: `${PREV}-20`, voided: false });
    expect(items[0].receiptNo).toMatch(/^RCPT-\d{4}-\d{5}$/);
  });

  it('shows a voided payment as void, and it no longer counts toward the balance', async () => {
    const o = await occupy('7C');
    const bill = await makeBill(o.unit.id, THIS, [['SERVICE', 500000]], { dueDate: FUTURE_DUE });
    const cash = await cashier();
    const p = await pay(cash.c, bill.id, 500000);
    await (await loginAs(app, 'ADMIN')).c.post(`/api/payments/${p.body.paymentId}/void`, { reason: 'Wrong unit' });
    const me = await as(o.resident);
    expect((await me.get('/api/me/billing/payments')).body.items[0].voided).toBe(true);
    expect((await me.get('/api/me/billing/balance')).body.outstanding).toBe(500000);
  });
});

describe('FR-41 opening balances (BR-22)', () => {
  const goLive = TODAY;
  const OB_MONTH = addMonths(goLive.slice(0, 7), -1);
  async function withGoLive(date = goLive) {
    await prisma.setting.upsert({ where: { key: 'goLiveDate' }, update: { value: date }, create: { key: 'goLiveDate', value: date } });
  }
  const record = (c: Awaited<ReturnType<typeof client>>, unitId: string, body: object) => c.post(`/api/units/${unitId}/opening-balance`, body);

  it('records the dues from before the system, dated the month before go-live and due on go-live day', async () => {
    await withGoLive();
    const { c } = await loginAs(app, 'ADMIN');
    const { unit } = await occupy('8A');
    const res = await record(c, unit.id, { amount: 1250000, note: 'Dues up to last month' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'OPENING_BALANCE',
      billingMonth: `${OB_MONTH}-01`,
      dueDate: goLive,
      total: 1250000,
      status: expect.stringMatching(/UNPAID|OVERDUE/),
      note: 'Dues up to last month',
    });
    expect(res.body.charges).toEqual([{ id: expect.any(String), type: 'OPENING_BALANCE', amount: 1250000, description: 'Dues up to last month' }]);
  });

  it('uses a chosen due date, and a plain description when there is no note', async () => {
    await withGoLive();
    const { c } = await loginAs(app, 'ADMIN');
    const { unit } = await occupy('8A');
    const res = await record(c, unit.id, { amount: 100000, dueDate: FUTURE_DUE });
    expect(res.body.dueDate).toBe(FUTURE_DUE);
    expect(res.body.charges[0].description).toBe('Opening balance');
  });

  it('only administrators may record one', async () => {
    await withGoLive();
    const { unit } = await occupy('8A');
    expect((await record(await client(app), unit.id, { amount: 100 })).status).toBe(401);
    expect((await record((await loginAs(app, 'RESIDENT')).c, unit.id, { amount: 100 })).status).toBe(403);
    for (const perm of ['billing.manage', 'payments.record', 'billing.view', 'units.manage']) {
      expect((await record((await loginAs(app, 'STAFF', [perm])).c, unit.id, { amount: 100 })).status, perm).toBe(403);
    }
    expect(await prisma.bill.count()).toBe(0);
  });

  it('a unit can have only one, and not in a month that already has a bill', async () => {
    await withGoLive();
    const { c } = await loginAs(app, 'ADMIN');
    const { unit } = await occupy('8A');
    expect((await record(c, unit.id, { amount: 100 })).status).toBe(201);
    const dup = await record(c, unit.id, { amount: 200 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('OPENING_BALANCE_EXISTS');

    const { unit: other } = await occupy('8B');
    await makeBill(other.id, OB_MONTH, [['SERVICE', 1000]]);
    expect((await record(c, other.id, { amount: 100 })).body.error.code).toBe('BILL_EXISTS');
    expect(await prisma.bill.count({ where: { kind: 'OPENING_BALANCE' } })).toBe(1);
  });

  it('rejects zero, negative, fractional and huge amounts; 404 for an unknown unit', async () => {
    await withGoLive();
    const { c } = await loginAs(app, 'ADMIN');
    const { unit } = await occupy('8A');
    for (const amount of [0, -1, 1.5, 1_000_000_001, '100', undefined]) expect((await record(c, unit.id, { amount })).status, String(amount)).toBe(400);
    expect((await record(c, '00000000-0000-0000-0000-000000000000', { amount: 100 })).status).toBe(404);
    expect((await record(c, 'nope', { amount: 100 })).status).toBe(404);
  });

  it('is visible to everyone who had access to the unit on go-live day, and nobody else', async () => {
    await withGoLive();
    const { c } = await loginAs(app, 'ADMIN');
    const present = await occupy('8A', { name: 'Present', start: '2020-01-01' });
    const left = await occupy('8A', { name: 'Left before', start: '2018-01-01', end: `${OB_MONTH}-05`, contact: false });
    const arrives = await occupy('8A', { name: 'Arrives later', start: `${addMonths(goLive.slice(0, 7), 1)}-01`, contact: false });
    const startsOnDay = await occupy('8A', { name: 'Starts on go-live day', start: goLive, contact: false });
    const ob = (await record(c, present.unit.id, { amount: 800000 })).body;
    for (const [who, sees] of [[present, true], [startsOnDay, true], [left, false], [arrives, false]] as const) {
      const me = await as(who.resident);
      expect((await me.get(`/api/bills/${ob.id}`)).status, who.resident.fullName).toBe(sees ? 200 : 404);
    }
  });

  it('can be paid like any bill, appears in lists by kind, and counts in the resident’s balance', async () => {
    await withGoLive();
    const { c } = await loginAs(app, 'ADMIN');
    const o = await occupy('8A');
    const ob = (await record(c, o.unit.id, { amount: 800000 })).body;
    await makeBill(o.unit.id, THIS, [['SERVICE', 300000]], { dueDate: FUTURE_DUE });
    const cash = await cashier();
    expect((await pay(cash.c, ob.id, 300000)).body.bill).toMatchObject({ paid: 300000, balance: 500000, status: expect.stringMatching(/PARTIALLY_PAID|OVERDUE/) });
    expect(ids(await c.get('/api/bills?kind=OPENING_BALANCE'))).toEqual([ob.id]);
    expect((await c.get('/api/bills?kind=REGULAR')).body.total).toBe(1);
    const me = await as(o.resident);
    expect((await me.get('/api/me/billing/balance')).body.outstanding).toBe(500000 + 300000);
  });

  it('cannot have charges added or removed; only an administrator may change its amount', async () => {
    await withGoLive();
    const { c } = await loginAs(app, 'ADMIN');
    const { unit } = await occupy('8A');
    const ob = (await record(c, unit.id, { amount: 800000 })).body;
    const charge = ob.charges[0].id;
    const editor = await loginAs(app, 'STAFF', ['billing.manage']);
    const add = await editor.c.post(`/api/bills/${ob.id}/charges`, { type: 'OTHER', amount: 100, description: 'x' });
    expect(add.status).toBe(409);
    expect(add.body.error.code).toBe('OPENING_BALANCE_FIXED');
    expect((await editor.c.patch(`/api/charges/${charge}`, { amount: 100 })).status).toBe(403);
    expect((await editor.c.delete(`/api/charges/${charge}`)).status).toBe(409);
    expect((await c.delete(`/api/charges/${charge}`)).status).toBe(409);
    const fixed = await c.patch(`/api/charges/${charge}`, { amount: 900000 });
    expect(fixed.status).toBe(200);
    expect(fixed.body.total).toBe(900000);
  });

  it('can be removed to correct a mistake, but only while nothing has been paid', async () => {
    await withGoLive();
    const { c } = await loginAs(app, 'ADMIN');
    const { unit } = await occupy('8A');
    const ob = (await record(c, unit.id, { amount: 800000 })).body;
    const cash = await cashier();
    await pay(cash.c, ob.id, 100);
    const blocked = await c.delete(`/api/bills/${ob.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BILL_HAS_PAYMENTS');

    const { unit: u2 } = await occupy('8B');
    const fresh = (await record(c, u2.id, { amount: 500000 })).body;
    expect((await (await loginAs(app, 'STAFF', ['billing.manage'])).c.delete(`/api/bills/${fresh.id}`)).status).toBe(403);
    expect((await c.delete(`/api/bills/${fresh.id}`)).status).toBe(204);
    expect(await prisma.bill.count({ where: { id: fresh.id } })).toBe(0);
    expect(await prisma.charge.count({ where: { billId: fresh.id } })).toBe(0);
    expect((await record(c, u2.id, { amount: 600000 })).status).toBe(201); // can be entered again, correctly
  });

  it('a regular bill cannot be removed this way', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const { unit } = await occupy('8A');
    const bill = await makeBill(unit.id, THIS, [['SERVICE', 1000]]);
    const res = await c.delete(`/api/bills/${bill.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_AN_OPENING_BALANCE');
    expect((await c.delete('/api/bills/nope')).status).toBe(404);
  });

  it('the go-live date cannot move once an opening balance exists', async () => {
    await withGoLive();
    const { c } = await loginAs(app, 'ADMIN');
    expect((await c.put('/api/settings', { goLiveDate: `${PREV}-01` })).status).toBe(200); // still free to change
    const { unit } = await occupy('8A');
    expect((await record(c, unit.id, { amount: 100 })).status).toBe(201);
    const locked = await c.put('/api/settings', { goLiveDate: `${OLDER}-01` });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('GO_LIVE_LOCKED');
    expect((await c.put('/api/settings', { goLiveDate: `${PREV}-01`, buildingName: 'Same date is fine' })).status).toBe(200);
  });
});

describe('FR-41 opening balances in the units import', () => {
  const run = (c: Awaited<ReturnType<typeof client>>, csv: string, dry = false) => c.post(`/api/import/units${dry ? '?dryRun=true' : ''}`, { csv });

  it('creates the units and their opening balances together', async () => {
    await prisma.setting.create({ data: { key: 'goLiveDate', value: TODAY } });
    const { c } = await loginAs(app, 'ADMIN');
    const res = await run(c, 'unit_number,floor,opening_balance\r\n1A,1,12500\r\n1B,1,500.50\r\n1C,1,\r\n1D,1,"1,00,000"\r\n');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(4);
    const bills = await prisma.bill.findMany({ include: { unit: true, charges: true }, orderBy: { unit: { unitNumber: 'asc' } } });
    expect(bills.map((b) => [b.unit.unitNumber, b.charges[0]!.amount])).toEqual([['1A', 1250000], ['1B', 50050], ['1D', 10000000]]);
    expect(bills.every((b) => b.kind === 'OPENING_BALANCE' && b.billingContactId === null)).toBe(true);
    expect(bills.every((b) => b.billingMonth.toISOString().slice(0, 7) === addMonths(TODAY.slice(0, 7), -1))).toBe(true);
    expect((await c.get('/api/bills?kind=OPENING_BALANCE')).body.total).toBe(3);
  });

  it('a dry run saves neither units nor balances', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    expect((await run(c, 'unit_number,floor,opening_balance\r\n1A,1,12500\r\n', true)).body).toMatchObject({ valid: true });
    expect(await prisma.bill.count()).toBe(0);
    expect(await prisma.unit.count()).toBe(0);
  });

  it('points at an invalid amount, and then saves nothing at all', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const csv = ['unit_number,floor,opening_balance', '1A,1,100', '1B,1,abc', '1C,1,0', '1D,1,-5', '1E,1,1.234', '1F,1,99999999999'].join('\r\n');
    const res = await run(c, csv);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([2, 3, 4, 5].map((i) => ({ line: i + 1, field: 'opening_balance', code: 'OPENING_BALANCE_INVALID' })).concat([{ line: 7, field: 'opening_balance', code: 'OPENING_BALANCE_INVALID' }]).sort((a, b) => a.line - b.line));
    expect(await prisma.unit.count()).toBe(0);
    expect(await prisma.bill.count()).toBe(0);
  });
});

describe('settings', () => {
  it('administrators read and change them; everyone else is refused', async () => {
    expect((await (await client(app)).get('/api/settings')).status).toBe(401);
    expect((await (await loginAs(app, 'RESIDENT')).c.get('/api/settings')).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['billing.manage', 'reports.view'])).c.put('/api/settings', { defaultDueDay: 5 })).status).toBe(403);

    const { c } = await loginAs(app, 'ADMIN');
    expect((await c.get('/api/settings')).body).toEqual({ buildingName: 'My Building', goLiveDate: TODAY, defaultDueDay: 10 });
    const res = await c.put('/api/settings', { buildingName: 'Sunrise Tower', defaultDueDay: 15 });
    expect(res.body).toEqual({ buildingName: 'Sunrise Tower', goLiveDate: TODAY, defaultDueDay: 15 });
    expect((await c.get('/api/settings')).body.buildingName).toBe('Sunrise Tower');
  });

  it('BR-10: the due day must be 1 to 28; other values and unknown fields are refused', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    for (const body of [{ defaultDueDay: 0 }, { defaultDueDay: 29 }, { defaultDueDay: 1.5 }, { defaultDueDay: '10' }, { buildingName: '' }, { goLiveDate: '2026-02-30' }, { password: 'x' }]) {
      expect((await c.put('/api/settings', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await c.put('/api/settings', { defaultDueDay: 28 })).status).toBe(200);
    expect((await c.put('/api/settings', { defaultDueDay: 1 })).status).toBe(200);
  });

  it('every logged-in user can read the building name, even one still on a temporary password', async () => {
    await prisma.setting.create({ data: { key: 'buildingName', value: 'Sunrise Tower' } });
    expect((await (await client(app)).get('/api/settings/public')).status).toBe(401);
    for (const role of ['RESIDENT', 'STAFF', 'ADMIN'] as const) {
      expect((await (await loginAs(app, role)).c.get('/api/settings/public')).body).toEqual({ buildingName: 'Sunrise Tower' });
    }
    const temp = await loginAs(app, 'RESIDENT', [], { mustChangePassword: true });
    expect((await temp.c.get('/api/settings/public')).status).toBe(200);
    expect(JSON.stringify((await temp.c.get('/api/settings/public')).body)).not.toMatch(/goLive|DueDay/);
  });
});

describe('FR-14 receipts', () => {
  async function paid() {
    const o = await occupy('9A', { name: 'Rahim Uddin' });
    const bill = await makeBill(o.unit.id, THIS, [['SERVICE', 400000], ['WATER', 100000]], { dueDate: FUTURE_DUE, contactId: o.resident.id });
    const cash = await cashier();
    const p1 = await pay(cash.c, bill.id, 200000, { method: 'BKASH', reference: 'TX1' });
    const p2 = await pay(cash.c, bill.id, 100000, { method: 'CASH' });
    return { o, bill, cash, p1: p1.body.paymentId as string, p2: p2.body.paymentId as string };
  }
  const admin = (p: { id: string }): AuthUser => ({ id: p.id, loginId: 'a', fullName: 'A', role: 'ADMIN', language: 'EN', textSize: 'NORMAL', mustChangePassword: false, permissions: [] });

  it('downloads as a real PDF named after the receipt number', async () => {
    const { p1, o } = await paid();
    const { c } = await loginAs(app, 'ADMIN');
    const res = await c.agent.get(`/api/payments/${p1}/receipt.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (x: Buffer) => chunks.push(x));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(new RegExp(`filename="RCPT-\\d{4}-00001\\.pdf"`));
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.length).toBeGreaterThan(5000);
    void o;
  });

  it('the resident can download their own; staff need a billing permission; strangers get nothing', async () => {
    const { p1, o } = await paid();
    const get = (c: Awaited<ReturnType<typeof client>>) => c.get(`/api/payments/${p1}/receipt.pdf`);
    expect((await get(await client(app))).status).toBe(401);
    expect((await get(await as(o.resident))).status).toBe(200);
    expect((await get((await loginAs(app, 'STAFF')).c)).status).toBe(403);
    expect((await get((await loginAs(app, 'STAFF', ['residents.manage'])).c)).status).toBe(403);
    for (const perm of ['billing.view', 'billing.manage', 'payments.record']) expect((await get((await loginAs(app, 'STAFF', [perm])).c)).status, perm).toBe(200);
    expect((await get((await loginAs(app, 'RESIDENT')).c)).status).toBe(404); // another resident
    const c = (await loginAs(app, 'ADMIN')).c;
    expect((await c.get('/api/payments/00000000-0000-0000-0000-000000000000/receipt.pdf')).status).toBe(404);
    expect((await c.get('/api/payments/nope/receipt.pdf')).status).toBe(404);
  });

  it('a voided payment still has a receipt, marked void', async () => {
    const { p1 } = await paid();
    const { c, user } = await loginAs(app, 'ADMIN');
    await c.post(`/api/payments/${p1}/void`, { reason: 'Entered twice' });
    expect((await c.get(`/api/payments/${p1}/receipt.pdf`)).status).toBe(200);
    const data = await getReceiptData(p1, admin(user));
    expect(data).toMatchObject({ voided: true, voidReason: 'Entered twice' });
    expect(receiptHtml(data, 'Demo Tower', 'EN')).toContain('VOID');
  });

  it('works in Bangla for a user who chose Bangla, with the Bengali font embedded', async () => {
    const { p1 } = await paid();
    const { c } = await loginAs(app, 'ADMIN', [], { language: 'BN' });
    const res = await c.agent.get(`/api/payments/${p1}/receipt.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (x: Buffer) => chunks.push(x));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((res.body as Buffer).toString('latin1')).toContain('NotoSansBengali');
  });

  it('shows the balance remaining after each payment, in the order they were made', async () => {
    const { p1, p2 } = await paid();
    const { user } = await loginAs(app, 'ADMIN');
    expect((await getReceiptData(p1, admin(user))).balanceAfter).toBe(300000);
    expect((await getReceiptData(p2, admin(user))).balanceAfter).toBe(200000);
    expect(await getReceiptData(p2, admin(user))).toMatchObject({ unitNumber: '9A', residentName: 'Rahim Uddin', billMonth: THIS, billKind: 'REGULAR', amount: 100000, method: 'CASH' });
  });

  it('the page escapes everything people type, so a name cannot inject markup', async () => {
    const { p1 } = await paid();
    const { user } = await loginAs(app, 'ADMIN');
    const data = { ...(await getReceiptData(p1, admin(user))), residentName: '<script>alert(1)</script> & "Co"', reference: '<img src=x onerror=alert(1)>' };
    const html = receiptHtml(data, 'Tower <b>One</b>', 'EN');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>One</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;');
  });

  it('prints the labels in Bangla, with amounts and dates in Western digits', async () => {
    const { p1 } = await paid();
    const { user } = await loginAs(app, 'ADMIN');
    const html = receiptHtml(await getReceiptData(p1, admin(user)), 'ডেমো টাওয়ার', 'BN');
    expect(html).toContain('পেমেন্টের রসিদ');
    expect(html).toContain('৳ 2,000.00'); // Bengali taka sign, but ordinary digits (BR-28)
    expect(html).not.toMatch(/[০-৯]/);
    expect(html).toContain('lang="bn"');
  });
});
