import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { addMonths, client, currentMonthDhaka, loginAs, makeUnit, occupy, resetDb, setFees } from './helpers';

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
const admin = () => loginAs(app, 'ADMIN');
type C = Awaited<ReturnType<typeof client>>;
const gen = (c: C, body: object, dry = false) => c.post(`/api/bills/generate${dry ? '?dryRun=true' : ''}`, body);
const taka = (n: number) => n * 100;

describe('FR-32 fees', () => {
  const fee = (chargeType: string, amount: number, description = chargeType) => ({ chargeType, amount, description });

  it('only administrators and staff with billing.manage can see or change fees', async () => {
    expect((await (await client(app)).get('/api/fees')).status).toBe(401);
    expect((await (await loginAs(app, 'RESIDENT')).c.get('/api/fees')).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF')).c.get('/api/fees')).status).toBe(403);
    for (const perm of ['billing.view', 'payments.record', 'residents.manage']) {
      const s = await loginAs(app, 'STAFF', [perm]);
      expect((await s.c.get('/api/fees')).status).toBe(403);
      expect((await s.c.put('/api/fees/defaults', { fees: [] })).status).toBe(403);
    }
    expect((await (await loginAs(app, 'STAFF', ['billing.manage'])).c.get('/api/fees')).status).toBe(200);
    expect((await (await admin()).c.get('/api/fees')).status).toBe(200);
  });

  it('sets the building-wide fees, lists them in a fixed order, and replaces the whole list each time', async () => {
    const { c } = await admin();
    const res = await c.put('/api/fees/defaults', { fees: [fee('WATER', 50000), fee('SERVICE', 300000, 'Monthly service charge')] });
    expect(res.status).toBe(200);
    expect(res.body.defaults.map((f: { chargeType: string }) => f.chargeType)).toEqual(['SERVICE', 'WATER']);
    expect(res.body.defaults[0]).toEqual({ chargeType: 'SERVICE', amount: 300000, description: 'Monthly service charge' });

    const again = await c.put('/api/fees/defaults', { fees: [fee('GAS', 70000)] });
    expect(again.body.defaults).toHaveLength(1);
    expect(again.body.defaults[0].chargeType).toBe('GAS');
    expect((await c.put('/api/fees/defaults', { fees: [] })).body.defaults).toEqual([]);
  });

  it('rejects a repeated type, a type that is not recurring, and bad amounts', async () => {
    const { c } = await admin();
    expect((await c.put('/api/fees/defaults', { fees: [fee('SERVICE', 1000), fee('SERVICE', 2000)] })).body.error.fields.fees.code).toBe('FEE_TYPE_REPEATED');
    for (const bad of [fee('OTHER', 1000), fee('OPENING_BALANCE', 1000), fee('SERVICE', 0), fee('SERVICE', -5), fee('SERVICE', 1.5), fee('SERVICE', 1_000_000_001), fee('SERVICE', 1000, '')]) {
      expect((await c.put('/api/fees/defaults', { fees: [bad] })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await prisma.unitFee.count()).toBe(0);
  });

  it('a unit can have its own fees, listed with the building defaults', async () => {
    const { c } = await admin();
    const unit = await makeUnit('4B', 4);
    await c.put('/api/fees/defaults', { fees: [fee('SERVICE', 300000)] });
    const res = await c.put(`/api/units/${unit.id}/fees`, { fees: [fee('SERVICE', 400000), fee('RENT', 1500000)] });
    expect(res.status).toBe(200);
    expect(res.body.fees.map((f: { chargeType: string }) => f.chargeType)).toEqual(['SERVICE', 'RENT']);

    const all = await c.get('/api/fees');
    expect(all.body.defaults).toHaveLength(1);
    expect(all.body.units).toEqual([{ unitId: unit.id, unitNumber: '4B', fees: expect.any(Array) }]);
    expect((await c.get(`/api/units/${unit.id}/fees`)).body.fees).toHaveLength(2);

    expect((await c.put(`/api/units/${unit.id}/fees`, { fees: [] })).body.fees).toEqual([]); // back to the defaults
    expect((await c.get('/api/fees')).body.units).toEqual([]);
  });

  it('404 for an unknown or malformed unit; 403 without billing.manage', async () => {
    const { c } = await admin();
    expect((await c.get('/api/units/00000000-0000-0000-0000-000000000000/fees')).status).toBe(404);
    expect((await c.put('/api/units/nope/fees', { fees: [] })).status).toBe(404);
    const unit = await makeUnit('1A');
    const s = await loginAs(app, 'STAFF', ['units.manage']);
    expect((await s.c.put(`/api/units/${unit.id}/fees`, { fees: [] })).status).toBe(403);
  });
});

describe('FR-09 generate monthly bills', () => {
  it('a preview shows what would happen and saves nothing', async () => {
    const { c } = await admin();
    await occupy('1A');
    await occupy('1B');
    await setFees({ SERVICE: taka(3000), WATER: taka(500) });
    const res = await gen(c, { month: THIS }, true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ month: THIS, count: 2, total: taka(7000), created: 0, skipped: [] });
    expect(res.body.willCreate.map((u: { unitNumber: string }) => u.unitNumber)).toEqual(['1A', '1B']);
    expect(await prisma.bill.count()).toBe(0);
  });

  it('creates one bill per occupied unit, with the charges from the fees', async () => {
    const { c } = await admin();
    const { resident } = await occupy('1A', { name: 'Rahim Uddin' });
    await setFees({ SERVICE: taka(3000), WATER: taka(500) });
    const res = await gen(c, { month: THIS });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, count: 1, total: taka(3500) });

    const bills = await prisma.bill.findMany({ include: { charges: true } });
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ kind: 'REGULAR', billingContactId: resident.id });
    expect(bills[0]!.charges.map((x) => [x.type, x.amount]).sort()).toEqual([['SERVICE', taka(3000)], ['WATER', taka(500)]]);

    const list = await c.get(`/api/bills?month=${THIS}`);
    expect(list.body.items[0]).toMatchObject({ total: taka(3500), paid: 0, balance: taka(3500), status: 'UNPAID', billingMonth: `${THIS}-01` });
  });

  it('BR-05: vacant and unavailable units are never billed', async () => {
    const { c } = await admin();
    await occupy('1A');
    await makeUnit('1B'); // vacant
    const unavailable = await occupy('1C');
    await prisma.unit.update({ where: { id: unavailable.unit.id }, data: { isAvailable: false } });
    await setFees({ SERVICE: taka(3000) });
    const res = await gen(c, { month: THIS });
    expect(res.body.willCreate.map((u: { unitNumber: string }) => u.unitNumber)).toEqual(['1A']);
    expect(await prisma.bill.count()).toBe(1);
  });

  it('a unit’s own fees replace the building default for that type, and add types of their own', async () => {
    const { c } = await admin();
    const plain = await occupy('1A');
    const special = await occupy('1B');
    await setFees({ SERVICE: taka(3000), WATER: taka(500) });
    await setFees({ SERVICE: taka(4000), GAS: taka(700) }, special.unit.id);
    const res = await gen(c, { month: THIS });
    expect(res.body.total).toBe(taka(3500) + taka(5200));
    const charges = async (unitId: string) =>
      (await prisma.charge.findMany({ where: { bill: { unitId } } })).map((x) => [x.type, x.amount]).sort();
    expect(await charges(plain.unit.id)).toEqual([['SERVICE', taka(3000)], ['WATER', taka(500)]]);
    expect(await charges(special.unit.id)).toEqual([['GAS', taka(700)], ['SERVICE', taka(4000)], ['WATER', taka(500)]]);
  });

  it('a unit with no fees at all is skipped, with the reason', async () => {
    const { c } = await admin();
    const a = await occupy('1A');
    await occupy('1B');
    await setFees({ RENT: taka(9000) }, a.unit.id); // only 1A has any fee
    const res = await gen(c, { month: THIS });
    expect(res.body.count).toBe(1);
    expect(res.body.skipped).toEqual([{ unitId: expect.any(String), unitNumber: '1B', reason: 'NO_FEES' }]);
    expect(await prisma.bill.count()).toBe(1);
  });

  it('BR-07: running it twice never creates a second bill; already-billed units are reported', async () => {
    const { c } = await admin();
    await occupy('1A');
    await occupy('1B');
    await setFees({ SERVICE: taka(3000) });
    expect((await gen(c, { month: THIS })).body.created).toBe(2);
    const again = await gen(c, { month: THIS });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: 0, count: 0 });
    expect(again.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(['ALREADY_BILLED', 'ALREADY_BILLED']);
    expect(await prisma.bill.count()).toBe(2);
    // a later month is a different bill
    expect((await gen(c, { month: NEXT })).body.created).toBe(2);
    expect(await prisma.bill.count()).toBe(4);
  });

  it('a unit that already has a one-off bill for the month is not billed again', async () => {
    const { c } = await admin();
    const { unit } = await occupy('1A');
    await occupy('1B');
    await setFees({ SERVICE: taka(3000) });
    expect((await c.post('/api/bills', { unitId: unit.id, month: THIS, charges: [{ type: 'OTHER', amount: 1000, description: 'Repair' }] })).status).toBe(201);
    const res = await gen(c, { month: THIS });
    expect(res.body.created).toBe(1);
    expect(res.body.skipped[0]).toMatchObject({ unitNumber: '1A', reason: 'ALREADY_BILLED' });
  });

  it('BR-10: due on the 10th by default, on the day set in the settings, or on the date chosen', async () => {
    const { c } = await admin();
    await occupy('1A');
    await setFees({ SERVICE: taka(3000) });
    expect((await gen(c, { month: THIS }, true)).body.dueDate).toBe(`${THIS}-10`);
    await prisma.setting.create({ data: { key: 'defaultDueDay', value: '20' } });
    expect((await gen(c, { month: THIS }, true)).body.dueDate).toBe(`${THIS}-20`);
    expect((await gen(c, { month: THIS, dueDate: `${THIS}-28` }, true)).body.dueDate).toBe(`${THIS}-28`);
    await gen(c, { month: THIS, dueDate: `${NEXT}-05` });
    expect((await c.get(`/api/bills?month=${THIS}`)).body.items[0].dueDate).toBe(`${NEXT}-05`);
  });

  it('rejects a due date before the billing month, and months that are too far away or malformed', async () => {
    const { c } = await admin();
    await occupy('1A');
    await setFees({ SERVICE: taka(3000) });
    expect((await gen(c, { month: THIS, dueDate: `${PREV}-28` })).body.error.fields.dueDate.code).toBe('DUE_DATE_BEFORE_MONTH');
    expect((await gen(c, { month: addMonths(THIS, 2) })).body.error.fields.month.code).toBe('MONTH_TOO_FAR');
    expect((await gen(c, { month: '1999-12' })).body.error.fields.month.code).toBe('MONTH_TOO_EARLY');
    for (const bad of ['2026-13', '2026-1', 'November', '', '2026-11-01']) expect((await gen(c, { month: bad })).status, bad).toBe(400);
    expect((await gen(c, { month: NEXT })).status).toBe(200); // next month is allowed
    expect(await prisma.bill.count()).toBe(1);
  });

  it('BR-06: the bill names the unit’s billing contact', async () => {
    const { c } = await admin();
    const owner = await occupy('1A', { name: 'The Owner', type: 'OWNER', contact: false, start: '2019-01-01' });
    const tenant = await occupy('1A', { name: 'The Tenant', type: 'TENANT', contact: true, start: '2020-01-01' });
    await setFees({ SERVICE: taka(3000) });
    await gen(c, { month: THIS });
    const bill = await prisma.bill.findFirstOrThrow();
    expect(bill.billingContactId).toBe(tenant.resident.id);
    expect(bill.billingContactId).not.toBe(owner.resident.id);
  });

  it('bills a unit only if someone lived there during that month', async () => {
    const { c } = await admin();
    const m = PREV; // a full past month
    const days = (d: number) => `${m}-${String(d).padStart(2, '0')}`;
    await occupy('1A', { start: '2020-01-01', end: addMonths(m, -1) + '-28' }); // left before the month
    await occupy('1B', { start: addMonths(m, 1) + '-01' }); // arrives after the month
    await occupy('1C', { start: '2020-01-01', end: days(5) }); // leaves early in the month
    await occupy('1D', { start: days(20) }); // arrives late in the month
    await occupy('1E', { start: '2020-01-01', end: days(1) }); // last day is the first of the month
    await setFees({ SERVICE: taka(3000) });
    const res = await gen(c, { month: m });
    expect(res.body.willCreate.map((u: { unitNumber: string }) => u.unitNumber)).toEqual(['1C', '1D', '1E']);
  });

  it('changing fees later never changes bills that already exist', async () => {
    const { c } = await admin();
    await occupy('1A');
    await setFees({ SERVICE: taka(3000) });
    await gen(c, { month: THIS });
    await c.put('/api/fees/defaults', { fees: [{ chargeType: 'SERVICE', amount: taka(9999), description: 'New price' }] });
    expect((await c.get(`/api/bills?month=${THIS}`)).body.items[0].total).toBe(taka(3000));
    expect((await gen(c, { month: NEXT })).body.total).toBe(taka(9999)); // the next run uses the new fee
  });

  it('NFR-14: two runs at the same moment still leave exactly one bill per unit', async () => {
    const a = await admin();
    const b = await admin();
    for (let i = 1; i <= 8; i++) await occupy(`2${String.fromCharCode(64 + i)}`);
    await setFees({ SERVICE: taka(3000) });
    const [r1, r2] = await Promise.all([gen(a.c, { month: THIS }), gen(b.c, { month: THIS })]);
    expect([r1.status, r2.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect(await prisma.bill.count()).toBe(8);
    expect(await prisma.charge.count()).toBe(8);
    const created = [r1, r2].filter((r) => r.status === 200).reduce((n, r) => n + r.body.created, 0);
    expect(created).toBe(8);
    for (const r of [r1, r2]) if (r.status === 409) expect(r.body.error.code).toBe('BILLS_ALREADY_EXIST');
  });

  it('only staff with billing.manage (and admins) may generate bills', async () => {
    expect((await gen(await client(app), { month: THIS })).status).toBe(401);
    expect((await gen((await loginAs(app, 'RESIDENT')).c, { month: THIS })).status).toBe(403);
    for (const perm of ['billing.view', 'payments.record']) {
      expect((await gen((await loginAs(app, 'STAFF', [perm])).c, { month: THIS })).status).toBe(403);
    }
    expect((await gen((await loginAs(app, 'STAFF', ['billing.manage'])).c, { month: THIS })).status).toBe(200);
    expect(await prisma.bill.count()).toBe(0);
  });
});

describe('FR-10 one-off bills', () => {
  const charge = (type: string, amount: number, description = type) => ({ type, amount, description });

  it('creates a bill for a unit that has none for the month', async () => {
    const { c } = await admin();
    const { unit, resident } = await occupy('1A');
    const res = await c.post('/api/bills', { unitId: unit.id, month: THIS, charges: [charge('SERVICE', 300000), charge('OTHER', 50000, 'Lift repair')] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ total: 350000, balance: 350000, status: 'UNPAID', billingContact: { id: resident.id }, billingMonth: `${THIS}-01` });
    expect(res.body.charges).toHaveLength(2);
  });

  it('BR-07: a second bill for the same unit and month is refused', async () => {
    const { c } = await admin();
    const { unit } = await occupy('1A');
    const body = { unitId: unit.id, month: THIS, charges: [charge('SERVICE', 300000)] };
    expect((await c.post('/api/bills', body)).status).toBe(201);
    const dup = await c.post('/api/bills', body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('BILL_EXISTS');
    expect(await prisma.bill.count()).toBe(1);
  });

  it('a vacant unit can be billed too; the contact is simply empty', async () => {
    const { c } = await admin();
    const unit = await makeUnit('9V');
    const res = await c.post('/api/bills', { unitId: unit.id, month: THIS, charges: [charge('OTHER', 10000, 'Cleaning')] });
    expect(res.status).toBe(201);
    expect(res.body.billingContact).toBeNull();
  });

  it('rejects an unknown unit, no charges, a repeated recurring type, and bad amounts', async () => {
    const { c } = await admin();
    const { unit } = await occupy('1A');
    expect((await c.post('/api/bills', { unitId: '00000000-0000-0000-0000-000000000000', month: THIS, charges: [charge('SERVICE', 100)] })).body.error.fields.unitId.code).toBe('UNIT_NOT_FOUND');
    for (const charges of [[], [charge('SERVICE', 100), charge('SERVICE', 200)], [charge('SERVICE', 0)], [charge('OPENING_BALANCE', 100)], [charge('SERVICE', 100, '')]]) {
      expect((await c.post('/api/bills', { unitId: unit.id, month: THIS, charges })).status, JSON.stringify(charges)).toBe(400);
    }
    expect(await prisma.bill.count()).toBe(0);
  });

  it('repeated "Other" charges are allowed', async () => {
    const { c } = await admin();
    const { unit } = await occupy('1A');
    const res = await c.post('/api/bills', { unitId: unit.id, month: THIS, charges: [charge('OTHER', 100, 'A'), charge('OTHER', 200, 'B')] });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(300);
  });

  it('needs billing.manage', async () => {
    const { unit } = await occupy('1A');
    const body = { unitId: unit.id, month: THIS, charges: [charge('SERVICE', 100)] };
    expect((await (await loginAs(app, 'RESIDENT')).c.post('/api/bills', body)).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['billing.view'])).c.post('/api/bills', body)).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['billing.manage'])).c.post('/api/bills', body)).status).toBe(201);
  });
});
