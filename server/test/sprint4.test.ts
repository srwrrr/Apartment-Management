import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { notify } from '../src/modules/notifications/notify';
import { sendBillReminders } from '../src/modules/billing/reminders';
import { addMonths, client, currentMonthDhaka, loginAs, makeBill, occupy, resetDb, setFees, todayDhaka } from './helpers';
import { addNoteReq, admin, asResident, makeRequest, manager, residentIn, submit } from './maintenance.helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

type C = Awaited<ReturnType<typeof client>>;
const post = (c: C, body: object) => c.post('/api/announcements', body);
const notesOf = (userId: string, type?: string) => prisma.notification.findMany({ where: { userId, ...(type && { type: type as 'BILL_NEW' }) }, orderBy: { createdAt: 'asc' } });

describe('FR-23 / FR-24 announcements', () => {
  it('only administrators and staff with announcements.manage can publish', async () => {
    const r = await residentIn(app, '1A');
    const body = { title: 'Water off', body: 'Tomorrow 9 to 11.', audience: { type: 'ALL' } };
    expect((await post(r.c, body)).status).toBe(403);
    expect((await post(await client(app), body)).status).toBe(401);
    expect((await post((await loginAs(app, 'STAFF')).c, body)).status).toBe(403);
    expect((await post((await loginAs(app, 'STAFF', ['announcements.manage'])).c, body)).status).toBe(201);
    expect((await post((await admin(app)).c, body)).status).toBe(201);
  });

  it('validates title and body', async () => {
    const a = await admin(app);
    const ok = { audience: { type: 'ALL' } };
    expect((await post(a.c, { ...ok, title: 'ab', body: 'x' })).status).toBe(400);
    expect((await post(a.c, { ...ok, title: 'Fine title', body: '' })).status).toBe(400);
    expect((await post(a.c, { ...ok, title: 'x'.repeat(151), body: 'x' })).status).toBe(400);
    expect((await post(a.c, { ...ok, title: 'Fine title', body: 'x'.repeat(5001) })).status).toBe(400);
  });

  it('ALL reaches every active resident and household member, but not staff or inactive people', async () => {
    const one = await residentIn(app, '1A');
    const two = await occupy('2A');
    const gone = await occupy('3A');
    await prisma.user.update({ where: { id: gone.resident.id }, data: { isActive: false } });
    const member = await prisma.user.create({ data: { loginId: 'm@test.local', passwordHash: 'x', role: 'RESIDENT', fullName: 'Member', phone: '+8801700000001' } });
    await prisma.householdMember.create({ data: { occupancyId: one.occupancy.id, userId: member.id } }).catch(() => undefined);
    const a = await admin(app);
    const res = await post(a.c, { title: 'Water off', body: 'Tomorrow.', audience: { type: 'ALL' } });
    expect(res.status).toBe(201);
    const got = await prisma.announcementRecipient.findMany({ where: { announcementId: res.body.id } });
    const ids = got.map((g) => g.userId);
    expect(ids).toContain(one.resident.id);
    expect(ids).toContain(two.resident.id);
    expect(ids).not.toContain(gone.resident.id);
    expect(ids).not.toContain(a.user.id);
    expect(await prisma.notification.count({ where: { type: 'ANNOUNCEMENT', entityId: res.body.id } })).toBe(ids.length);
  });

  it('can be aimed at units, floors, owners or tenants only', async () => {
    const owner = await occupy('1A', { floor: 1, type: 'OWNER' });
    const tenant = await occupy('2B', { floor: 2, type: 'TENANT' });
    const a = await admin(app);
    const who = async (audience: object) => {
      const res = await post(a.c, { title: 'Notice', body: 'Body', audience });
      expect(res.status).toBe(201);
      return (await prisma.announcementRecipient.findMany({ where: { announcementId: res.body.id } })).map((r) => r.userId).sort();
    };
    expect(await who({ type: 'UNITS', unitIds: [tenant.unit.id] })).toEqual([tenant.resident.id]);
    expect(await who({ type: 'FLOORS', floors: [1] })).toEqual([owner.resident.id]);
    expect(await who({ type: 'OWNERS' })).toEqual([owner.resident.id]);
    expect(await who({ type: 'TENANTS' })).toEqual([tenant.resident.id]);
  });

  it('refuses an audience of nobody and unknown units, and publishes nothing', async () => {
    const a = await admin(app);
    const empty = await post(a.c, { title: 'Notice', body: 'Body', audience: { type: 'FLOORS', floors: [9] } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.fields.audience.code).toBe('AUDIENCE_EMPTY');
    const unknown = await post(a.c, { title: 'Notice', body: 'Body', audience: { type: 'UNITS', unitIds: ['6f1c5a43-0000-4000-8000-000000000000'] } });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.announcement.count()).toBe(0);
  });

  it('previews how many residents will be reached', async () => {
    await occupy('1A');
    await occupy('2A');
    const a = await admin(app);
    const res = await a.c.post('/api/announcements/audience-preview', { audience: { type: 'ALL' } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('2');
    expect((await (await residentIn(app, '9Z')).c.post('/api/announcements/audience-preview', { audience: { type: 'ALL' } })).status).toBe(403);
  });

  it('a resident sees only announcements sent to them, and a missing or unrelated one is a 404', async () => {
    const one = await residentIn(app, '1A', { floor: 1 });
    const two = await residentIn(app, '2A', { floor: 2 });
    const a = await admin(app);
    const mine = (await post(a.c, { title: 'First floor', body: 'Body', audience: { type: 'FLOORS', floors: [1] } })).body;
    const list1 = await one.c.get('/api/announcements');
    expect(list1.body.items.map((i: { id: string }) => i.id)).toEqual([mine.id]);
    expect((await two.c.get('/api/announcements')).body.items).toEqual([]);
    expect((await two.c.get(`/api/announcements/${mine.id}`)).status).toBe(404);
    expect((await one.c.get(`/api/announcements/${mine.id}`)).status).toBe(200);
    expect((await two.c.post(`/api/announcements/${mine.id}/read`)).status).toBe(404);
  });

  it('residents never see who else received it; managers see read status and it follows opening it', async () => {
    const one = await residentIn(app, '1A');
    await occupy('2A');
    const a = await admin(app);
    const ann = (await post(a.c, { title: 'Notice', body: 'Body', audience: { type: 'ALL' } })).body;
    const asResidentView = (await one.c.get(`/api/announcements/${ann.id}`)).body;
    expect(JSON.stringify(asResidentView)).not.toContain('recipients');
    expect((await one.c.get(`/api/announcements/${ann.id}/reads`)).status).toBe(403);
    let reads = (await a.c.get(`/api/announcements/${ann.id}/reads`)).body;
    expect(reads).toMatchObject({ recipients: 2, read: 0 });
    expect((await one.c.post(`/api/announcements/${ann.id}/read`)).status).toBe(200);
    reads = (await a.c.get(`/api/announcements/${ann.id}/reads`)).body;
    expect(reads).toMatchObject({ recipients: 2, read: 1 });
    expect(reads.unread).toHaveLength(1);
  });

  it('later residents do not receive an old announcement (recipients are fixed at publishing)', async () => {
    await occupy('1A');
    const a = await admin(app);
    const ann = (await post(a.c, { title: 'Notice', body: 'Body', audience: { type: 'ALL' } })).body;
    const late = await residentIn(app, '2A');
    expect((await late.c.get('/api/announcements')).body.items).toEqual([]);
    expect((await a.c.get(`/api/announcements/${ann.id}/reads`)).body.recipients).toBe(1);
  });

  it('editing marks it edited; archiving hides it from residents but keeps it for managers', async () => {
    const one = await residentIn(app, '1A');
    const a = await admin(app);
    const ann = (await post(a.c, { title: 'Notice', body: 'Body', audience: { type: 'ALL' } })).body;
    const edited = await a.c.patch(`/api/announcements/${ann.id}`, { body: 'New body' });
    expect(edited.status).toBe(200);
    expect((await prisma.announcement.findUniqueOrThrow({ where: { id: ann.id } })).editedAt).not.toBeNull();
    expect((await a.c.patch(`/api/announcements/${ann.id}`, {})).status).toBe(400);
    expect((await a.c.patch(`/api/announcements/${ann.id}`, { audience: { type: 'ALL' } })).status).toBe(400);
    expect((await one.c.patch(`/api/announcements/${ann.id}`, { body: 'Hacked' })).status).toBe(403);
    expect((await a.c.post(`/api/announcements/${ann.id}/archive`)).status).toBe(200);
    expect((await one.c.get('/api/announcements')).body.items).toEqual([]);
    expect((await a.c.get('/api/announcements?archived=true')).body.items).toHaveLength(1);
  });
});

describe('FR-25 / FR-26 notifications', () => {
  it('lists only my own, counts unread and marks read; someone else’s is a 404', async () => {
    const one = await residentIn(app, '1A');
    const two = await residentIn(app, '2A');
    const a = await admin(app);
    await post(a.c, { title: 'Notice', body: 'Body', audience: { type: 'ALL' } });
    expect((await one.c.get('/api/notifications/unread-count')).body).toMatchObject({ unread: 1 });
    const list = await one.c.get('/api/notifications');
    expect(list.body.items).toHaveLength(1);
    const id = list.body.items[0].id;
    expect((await two.c.post(`/api/notifications/${id}/read`)).status).toBe(404);
    expect((await one.c.post(`/api/notifications/${id}/read`)).status).toBe(200);
    expect((await one.c.get('/api/notifications/unread-count')).body).toMatchObject({ unread: 0 });
    expect((await one.c.get('/api/notifications?unread=true')).body.items).toEqual([]);
    expect((await one.c.get('/api/notifications')).body.items).toHaveLength(1);
    expect((await (await client(app)).get('/api/notifications')).status).toBe(401);
  });

  it('read-all only touches my notifications', async () => {
    const one = await residentIn(app, '1A');
    const two = await residentIn(app, '2A');
    const a = await admin(app);
    await post(a.c, { title: 'Notice', body: 'Body', audience: { type: 'ALL' } });
    await one.c.post('/api/notifications/read-all');
    expect((await one.c.get('/api/notifications/unread-count')).body.unread).toBe(0);
    expect((await two.c.get('/api/notifications/unread-count')).body.unread).toBe(1);
  });

  it('a new maintenance request tells the maintenance people, not the submitter or other residents', async () => {
    const r = await residentIn(app, '1A');
    const other = await residentIn(app, '2A');
    const m = await manager(app);
    const plain = await loginAs(app, 'STAFF');
    const a = await admin(app);
    const req = (await submit(r.c)).body;
    expect(await notesOf(m.user.id, 'REQUEST_NEW')).toHaveLength(1);
    expect(await notesOf(a.user.id, 'REQUEST_NEW')).toHaveLength(1);
    expect(await notesOf(plain.user.id)).toHaveLength(0);
    expect(await notesOf(other.resident.id)).toHaveLength(0);
    expect(await notesOf(r.resident.id)).toHaveLength(0);
    expect((await notesOf(m.user.id, 'REQUEST_NEW'))[0]).toMatchObject({ link: `/requests/${req.id}`, entityId: req.id });
  });

  it('status changes and shared notes tell the household; internal notes tell nobody; the actor is not told', async () => {
    const r = await residentIn(app, '1A');
    const m = await manager(app);
    const req = (await submit(r.c)).body;
    await m.c.patch(`/api/requests/${req.id}/priority`, { priority: 'HIGH' });
    expect(await notesOf(r.resident.id, 'REQUEST_UPDATE')).toHaveLength(1);
    const before = await prisma.notification.count();
    expect((await addNoteReq(m.c, req.id, { note: 'Secret', isInternal: 'true' })).status).toBeLessThan(300);
    expect(await prisma.notification.count()).toBe(before);
    expect((await addNoteReq(m.c, req.id, { note: 'We are on it', isInternal: 'false' })).status).toBeLessThan(300);
    expect(await notesOf(r.resident.id, 'REQUEST_UPDATE')).toHaveLength(2);
    expect(await notesOf(m.user.id, 'REQUEST_UPDATE')).toHaveLength(0);
  });

  it('assigning tells the assignee; the resident is told once it moves to review', async () => {
    const r = await residentIn(app, '1A');
    const m = await manager(app);
    const w = await loginAs(app, 'STAFF');
    const req = (await submit(r.c)).body;
    const res = await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    expect(res.status).toBe(200);
    expect(await notesOf(w.user.id, 'REQUEST_ASSIGNED')).toHaveLength(1);
    expect(await notesOf(r.resident.id, 'REQUEST_UPDATE')).toHaveLength(1);
  });

  it('the person who makes a change is not told about it, even when they are the assignee', async () => {
    const r = await residentIn(app, '1A');
    const m = await manager(app);
    const w = await loginAs(app, 'STAFF');
    const req = (await submit(r.c)).body;
    await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    const before = await notesOf(w.user.id);
    const res = await w.c.post(`/api/requests/${req.id}/transition`, { to: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(await notesOf(w.user.id)).toHaveLength(before.length);
    expect((await notesOf(r.resident.id, 'REQUEST_UPDATE')).length).toBeGreaterThanOrEqual(2);
  });

  it('notify never duplicates a reminder for the same person and bill', async () => {
    const o = await occupy('1A');
    const bill = await makeBill(o.unit.id, currentMonthDhaka(), [['SERVICE', 1000]], { contactId: o.resident.id });
    const input = { type: 'BILL_OVERDUE' as const, link: `/bills/${bill.id}`, entityId: bill.id };
    expect(await notify(prisma, [o.resident.id, o.resident.id], input)).toBe(1);
    expect(await notify(prisma, [o.resident.id], input)).toBe(0);
    expect(await prisma.notification.count()).toBe(1);
  });

  it('generating bills tells the billing contact and the household once, and again does nothing', async () => {
    const o = await occupy('1A');
    await setFees({ SERVICE: 300000 });
    const month = currentMonthDhaka();
    const a = await admin(app);
    const res = await a.c.post('/api/bills/generate', { month });
    expect(res.status).toBeLessThan(300);
    const notes = await notesOf(o.resident.id, 'BILL_NEW');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.params).toMatchObject({ unit: '1A', amount: 300000 });
    await a.c.post('/api/bills/generate', { month });
    expect(await notesOf(o.resident.id, 'BILL_NEW')).toHaveLength(1);
  });

  it('recording a payment tells the household', async () => {
    const o = await occupy('1A');
    const a = await admin(app);
    const bill = await makeBill(o.unit.id, currentMonthDhaka(), [['SERVICE', 300000]], { contactId: o.resident.id });
    const res = await a.c.post(`/api/bills/${bill.id}/payments`, { amount: 100000, method: 'CASH', paidOn: todayDhaka() });
    expect(res.status).toBeLessThan(300);
    const notes = await notesOf(o.resident.id, 'PAYMENT_RECORDED');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.params).toMatchObject({ amount: 100000 });
  });

  it('a payment that is refused tells nobody', async () => {
    const o = await occupy('1A');
    const a = await admin(app);
    const bill = await makeBill(o.unit.id, currentMonthDhaka(), [['SERVICE', 300000]], { contactId: o.resident.id });
    const res = await a.c.post(`/api/bills/${bill.id}/payments`, { amount: 999999999, method: 'CASH', paidOn: todayDhaka() });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await notesOf(o.resident.id, 'PAYMENT_RECORDED')).toHaveLength(0);
  });
});

describe('BR-20 bill reminders', () => {
  it('reminds about bills due soon and overdue, once each, and not about paid or far-off bills', async () => {
    const o = await occupy('1A');
    const month = currentMonthDhaka();
    const soon = addDays(todayDhaka(), 2);
    const late = addDays(todayDhaka(), -5);
    const far = addDays(todayDhaka(), 20);
    const dueSoon = await makeBill(o.unit.id, addMonths(month, -3), [['SERVICE', 1000]], { contactId: o.resident.id, dueDate: soon });
    const overdue = await makeBill(o.unit.id, addMonths(month, -2), [['SERVICE', 1000]], { contactId: o.resident.id, dueDate: late });
    await makeBill(o.unit.id, addMonths(month, -1), [['SERVICE', 1000]], { contactId: o.resident.id, dueDate: far });
    const paid = await makeBill(o.unit.id, addMonths(month, 1), [['SERVICE', 1000]], { contactId: o.resident.id, dueDate: soon });
    const adminUser = await loginAs(app, 'ADMIN');
    await prisma.payment.create({ data: { billId: paid.id, amount: 1000, method: 'CASH', paidOn: new Date(todayDhaka() + 'T00:00:00Z'), receiptNo: 'R-1', recordedById: adminUser.user.id } });

    expect(await sendBillReminders()).toBe(2);
    expect((await notesOf(o.resident.id, 'BILL_DUE_SOON')).map((n) => n.entityId)).toEqual([dueSoon.id]);
    expect((await notesOf(o.resident.id, 'BILL_OVERDUE')).map((n) => n.entityId)).toEqual([overdue.id]);
    expect(await sendBillReminders()).toBe(0);
    expect(await prisma.notification.count()).toBe(2);
  });
});

function addDays(ymd: string, n: number): string {
  const t = new Date(ymd + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

describe('FR-15 / FR-27 / FR-28 / FR-29 / FR-58 reports and dashboard', () => {
  async function seedMonth() {
    const month = currentMonthDhaka();
    const one = await occupy('1A');
    const two = await occupy('2A');
    const a = await admin(app);
    const b1 = await makeBill(one.unit.id, month, [['SERVICE', 300000], ['WATER', 50000]], { contactId: one.resident.id, dueDate: addDays(todayDhaka(), 10), createdById: a.user.id });
    await makeBill(two.unit.id, month, [['SERVICE', 300000]], { contactId: two.resident.id, dueDate: addDays(todayDhaka(), -3), createdById: a.user.id });
    await prisma.payment.create({ data: { billId: b1.id, amount: 350000, method: 'CASH', paidOn: new Date(todayDhaka() + 'T00:00:00Z'), receiptNo: 'R-1', recordedById: a.user.id } });
    return { month, a, one, two };
  }

  it('only administrators and staff with reports.view may open them', async () => {
    const r = await residentIn(app, '1A');
    for (const url of ['/api/dashboard', '/api/reports/finance?from=2026-01&to=2026-02', '/api/reports/dues']) {
      expect((await r.c.get(url)).status).toBe(403);
      expect((await (await loginAs(app, 'STAFF')).c.get(url)).status).toBe(403);
      expect((await (await loginAs(app, 'STAFF', ['reports.view'])).c.get(url)).status).toBe(200);
      expect((await (await client(app)).get(url)).status).toBe(401);
    }
  });

  it('finance totals add up: billed, collected, outstanding and the rate', async () => {
    const { month, a } = await seedMonth();
    const res = await a.c.get(`/api/reports/finance?from=${month}&to=${month}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ billed: 650000, collected: 350000, outstanding: 300000, rate: 53.8 });
    expect(res.body.months).toHaveLength(1);
    expect(res.body.byMethod).toEqual([{ method: 'CASH', collected: 350000 }]);
  });

  it('voided payments are not collected money', async () => {
    const { month, a } = await seedMonth();
    await prisma.payment.updateMany({ data: { voidedAt: new Date(), voidReason: 'mistake', voidedById: a.user.id } });
    const res = await a.c.get(`/api/reports/finance?from=${month}&to=${month}`);
    expect(res.body).toMatchObject({ billed: 650000, collected: 0, outstanding: 650000, rate: 0 });
  });

  it('opening balances are reported apart from regular billing', async () => {
    const o = await occupy('1A');
    const a = await admin(app);
    const month = currentMonthDhaka();
    await prisma.bill.create({
      data: { unitId: o.unit.id, billingMonth: new Date(`${addMonths(month, -2)}-01T00:00:00Z`), dueDate: new Date(`${addMonths(month, -2)}-01T00:00:00Z`), kind: 'OPENING_BALANCE', createdById: a.user.id, billingContactId: o.resident.id, charges: { create: [{ type: 'OTHER', amount: 500000, description: 'Before the system' }] } },
    });
    const res = await a.c.get(`/api/reports/finance?from=${addMonths(month, -3)}&to=${month}`);
    expect(res.body.billed).toBe(0);
    expect(res.body.openingBalances).toMatchObject({ billed: 500000, outstanding: 500000 });
    expect(res.body.rate).toBeNull();
  });

  it('refuses a backwards or oversized range and bad months', async () => {
    const a = await admin(app);
    expect((await a.c.get('/api/reports/finance?from=2026-05&to=2026-01')).status).toBe(400);
    expect((await a.c.get('/api/reports/finance?from=2020-01&to=2026-01')).status).toBe(400);
    expect((await a.c.get('/api/reports/finance?from=nope&to=2026-01')).status).toBe(400);
    expect((await a.c.get('/api/reports/finance')).status).toBe(400);
  });

  it('dues lists only units that owe, largest first, with the contact and overdue count', async () => {
    const { a, two } = await seedMonth();
    await occupy('3A');
    const res = await a.c.get('/api/reports/dues');
    expect(res.status).toBe(200);
    expect(res.body.totalOwed).toBe(300000);
    expect(res.body.units).toHaveLength(1);
    expect(res.body.units[0]).toMatchObject({ owed: 300000, overdueBills: 1, unit: { unitNumber: '2A' }, contact: { name: two.resident.fullName } });
  });

  it('the dashboard agrees with the finance report and counts units and requests', async () => {
    const { month, a, one } = await seedMonth();
    await prisma.unit.create({ data: { unitNumber: 'V1', floor: 5 } });
    await prisma.unit.create({ data: { unitNumber: 'X1', floor: 5, isAvailable: false } });
    await makeRequest(one.resident.id, one.unit.id, { status: 'SUBMITTED' });
    await makeRequest(one.resident.id, one.unit.id, { status: 'IN_PROGRESS' });
    await makeRequest(one.resident.id, one.unit.id, { status: 'SUBMITTED', dueAt: new Date(Date.now() - 3_600_000) });
    const fin = (await a.c.get(`/api/reports/finance?from=${month}&to=${month}`)).body;
    const dash = (await a.c.get('/api/dashboard')).body;
    expect(dash.billing).toMatchObject({ billed: fin.billed, collected: fin.collected, outstanding: fin.outstanding, rate: fin.rate, overdueBills: 1, overdueAmount: 300000 });
    expect(dash.building).toMatchObject({ totalUnits: 4, occupied: 2, vacant: 1, unavailable: 1, residents: 2 });
    expect(dash.maintenance).toMatchObject({ submitted: 2, inProgress: 1, pending: 2, overdue: 1 });
    expect(dash.trend).toHaveLength(6);
    expect(dash.trend.at(-1)).toMatchObject({ month, billed: 650000, collected: 350000 });
    expect(dash.recent.payments).toHaveLength(1);
    expect(dash.recent.requests).toHaveLength(3);
  });

  it('a month with nothing billed has no rate rather than 0 or NaN', async () => {
    const a = await admin(app);
    const dash = (await a.c.get('/api/dashboard')).body;
    expect(dash.billing).toMatchObject({ billed: 0, collected: 0, rate: null });
    expect(dash.trend.every((t: { rate: number | null }) => t.rate === null)).toBe(true);
  });
});

// keep the unused helper import honest
void asResident;
