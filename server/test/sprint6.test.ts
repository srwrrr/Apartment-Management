import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_ACTIONS } from '@apt/shared';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { autoCloseResolved } from '../src/modules/maintenance/requests.service';
import { splitBillQuery } from '../src/modules/reports/search.routes';
import { PASSWORD, addMonths, client, currentMonthDhaka, loginAs, makeBill, makeLoginUser, makeUnit, occupy, resetDb, todayDhaka } from './helpers';
import { PNG, admin, clearUploads, makeRequest, manager, residentIn, submit } from './maintenance.helpers';

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

const MONTH = currentMonthDhaka();
const TODAY = todayDhaka();
const entries = (action: string) => prisma.activityLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });
const hasOne = async (action: string, actorId: string | null) => {
  const rows = await entries(action);
  expect(rows, action).toHaveLength(1);
  expect(rows[0]!.actorId, action).toBe(actorId);
  return rows[0]!;
};

describe('FR-34 what is recorded', () => {
  it('every action in the list is actually written somewhere in the code', () => {
    const root = path.resolve(__dirname, '../src');
    const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    const code = files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
    for (const a of ACTIVITY_ACTIONS) expect(code.includes(`'${a}'`), a).toBe(true);
  });

  it('only logging in may write outside a transaction, so a change and its record cannot come apart', () => {
    const root = path.resolve(__dirname, '../src');
    const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    const outside = files.filter((f) => fs.readFileSync(path.join(root, f), 'utf8').includes('logActivity(prisma,')).map((f) => path.basename(f));
    expect(outside.sort()).toEqual(['auth.routes.ts', 'auth.service.ts']);
  });

  it('logins and failed logins, with the address, and never what was typed for an unknown account', async () => {
    const u = await makeLoginUser('ADMIN');
    const c = await client(app);
    await c.login(u.loginId, 'Wrong-password-1');
    await c.login('MySecretPassword99');
    await c.login(u.loginId);

    await hasOne('login.success', u.id);
    const failed = await entries('login.failed');
    expect(failed.map((f) => [f.actorId, f.entityId, (f.details as { reason: string }).reason])).toEqual([
      [null, u.id, 'WRONG_PASSWORD'],
      [null, null, 'UNKNOWN_ACCOUNT'],
    ]);
    expect(failed[0]!.ip).toBeTruthy();
    // Login IDs are lower-cased, so compare without regard to case.
    expect(JSON.stringify(failed).toLowerCase()).not.toContain('mysecretpassword99');
    expect(JSON.stringify(failed).toLowerCase()).not.toContain('wrong-password-1');
  });

  it('a locked or deactivated account is recorded with the reason', async () => {
    const u = await makeLoginUser('RESIDENT');
    const c = await client(app);
    for (let i = 0; i < 6; i++) await c.login(u.loginId, 'Wrong-password-1');
    const reasons = (await entries('login.failed')).map((f) => (f.details as { reason: string }).reason);
    expect(reasons.at(-2)).toBe('LOCKED_NOW');
    expect(reasons.at(-1)).toBe('LOCKED');
    const gone = await makeLoginUser('RESIDENT', [], { isActive: false });
    await c.login(gone.loginId);
    expect((await entries('login.failed')).at(-1)!.details).toMatchObject({ reason: 'INACTIVE' });
  });

  it('people, units and stays: who changed what, with the old and new values', async () => {
    const a = await admin(app);
    const res = (await a.c.post('/api/residents', { fullName: 'Karim Mia', loginId: 'karim@example.com', phone: '01711111111' })).body.resident;
    const unit = (await a.c.post('/api/units', { unitNumber: '7C', floor: 7 })).body;
    await a.c.patch(`/api/units/${unit.id}`, { floor: 8 });
    await a.c.patch(`/api/residents/${res.id}`, { fullName: 'Karim Uddin' });
    const stay = (await a.c.post(`/api/units/${unit.id}/occupancies`, { residentId: res.id, type: 'OWNER', startDate: '2024-01-01' })).body;
    await a.c.patch(`/api/occupancies/${stay.id}`, { endDate: TODAY });
    await a.c.post(`/api/residents/${res.id}/deactivate`, {});
    await a.c.post(`/api/residents/${res.id}/reactivate`, {});

    await hasOne('resident.create', a.user.id);
    expect((await hasOne('unit.update', a.user.id)).details).toMatchObject({ unit: '7C', changes: { floor: [7, 8] } });
    expect((await hasOne('resident.update', a.user.id)).details).toMatchObject({ changes: { fullName: ['Karim Mia', 'Karim Uddin'] } });
    await hasOne('unit.create', a.user.id);
    await hasOne('occupancy.create', a.user.id);
    await hasOne('occupancy.update', a.user.id);
    await hasOne('resident.deactivate', a.user.id);
    await hasOne('resident.reactivate', a.user.id);
  });

  it('staff, permissions and password resets, never the password itself', async () => {
    const a = await admin(app);
    const created = (await a.c.post('/api/staff', { fullName: 'New Staff', loginId: 'new@example.com', phone: '01722222222', permissions: ['billing.view'] })).body;
    const id = created.staff.id as string;
    await a.c.put(`/api/staff/${id}/permissions`, { permissions: ['reports.view'] });
    const reset = await a.c.post(`/api/users/${id}/reset-password`);
    expect(reset.status).toBe(200);

    await hasOne('staff.create', a.user.id);
    expect((await hasOne('staff.permissions', a.user.id)).details).toMatchObject({ before: ['billing.view'], after: ['reports.view'] });
    await hasOne('password.reset', a.user.id);
    const all = JSON.stringify(await prisma.activityLog.findMany());
    expect(all).not.toContain(created.tempPassword);
    expect(all).not.toContain(reset.body.tempPassword);
    expect(all).not.toContain('$2'); // no bcrypt hash
  });

  it('changing your own password is recorded, without the password', async () => {
    const { c, user } = await loginAs(app, 'RESIDENT');
    await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'BrandNew123' });
    await hasOne('password.change', user.id);
    expect(JSON.stringify(await prisma.activityLog.findMany())).not.toContain('BrandNew123');
  });

  it('money: bills, charges, payments and voids', async () => {
    const a = await admin(app);
    const o = await occupy('1A');
    const bill = (await a.c.post('/api/bills', { unitId: o.unit.id, month: MONTH, charges: [{ type: 'SERVICE', amount: 300000, description: 'Service' }] })).body;
    await a.c.post(`/api/bills/${bill.id}/charges`, { type: 'WATER', amount: 5000, description: 'Water' });
    const water = bill && (await prisma.charge.findFirstOrThrow({ where: { billId: bill.id, type: 'WATER' } }));
    await a.c.patch(`/api/charges/${water.id}`, { amount: 6000 });
    await a.c.delete(`/api/charges/${water.id}`);
    const p = (await a.c.post(`/api/bills/${bill.id}/payments`, { amount: 1000, method: 'CASH', paidOn: TODAY })).body;
    await a.c.post(`/api/payments/${p.paymentId}/void`, { reason: 'Entered by mistake' });

    await hasOne('bill.create', a.user.id);
    await hasOne('charge.add', a.user.id);
    expect((await hasOne('charge.update', a.user.id)).details).toMatchObject({ changes: { amount: [5000, 6000] } });
    await hasOne('charge.delete', a.user.id);
    await hasOne('payment.record', a.user.id);
    expect((await hasOne('payment.void', a.user.id)).details).toMatchObject({ reason: 'Entered by mistake' });
  });

  it('actions with a file are logged under the right person', async () => {
    const r = await residentIn(app, '1A');
    const m = await manager(app);
    const a = await admin(app);
    const bill = await makeBill(r.unit.id, MONTH, [['SERVICE', 300000]], { contactId: r.resident.id });
    const report = (await r.c.form(`/api/bills/${bill.id}/payment-reports`).field('amount', '1000').field('paidOn', TODAY).field('method', 'BKASH').field('reference', 'T1').attach('screenshot', PNG, 'a.png')).body;
    await a.c.post(`/api/payment-reports/${report.id}/verify`);
    await hasOne('payment_report.verify', a.user.id);

    await a.c.form('/api/expenses').field('spentOn', TODAY).field('category', 'LIFT').field('amount', '5000').field('payee', 'Lift Co').attach('receipt', PNG, 'r.png');
    await hasOne('expense.create', a.user.id);

    const req = (await submit(r.c, {}, [{ name: 'p.png', data: PNG }])).body;
    await m.c.post(`/api/requests/${req.id}/transition`, { to: 'REJECTED', note: 'Not a building matter' });
    // A resident cancelling or a manager rejecting: whoever did it.
    await hasOne('request.status', m.user.id);
  });

  it('a refused action leaves no entry: the record and the change go together', async () => {
    const r = await residentIn(app, '1A');
    const a = await admin(app);
    const bill = await makeBill(r.unit.id, MONTH, [['SERVICE', 300000]], { contactId: r.resident.id });
    expect((await a.c.post(`/api/bills/${bill.id}/payments`, { amount: 999999999, method: 'CASH', paidOn: TODAY })).status).toBe(400);
    expect(await entries('payment.record')).toHaveLength(0);
    // Move-out fails at its last step, so nothing before it may be recorded either.
    const res = await a.c.post(`/api/occupancies/${r.occupancy.id}/move-out`, { endDate: TODAY, expectedBalance: 300000, duesNote: 'Paying later', issueCertificate: true });
    expect(res.status).toBe(409);
    expect(await entries('occupancy.move_out')).toHaveLength(0);
    expect(await entries('certificate.issue')).toHaveLength(0);
  });

  it('the move-out entry holds the whole summary', async () => {
    const r = await occupy('1A');
    const a = await admin(app);
    await a.c.post(`/api/occupancies/${r.occupancy.id}/move-out`, { endDate: TODAY, expectedBalance: 0, deactivateAccount: true });
    expect((await hasOne('occupancy.move_out', a.user.id)).details).toMatchObject({ unit: '1A', endDate: TODAY, balance: 0, deactivated: true });
  });

  it('the system’s own actions have no person', async () => {
    const r = await occupy('1A');
    await makeRequest(r.resident.id, r.unit.id, { status: 'RESOLVED', resolvedAt: new Date(Date.now() - 30 * 86_400_000) });
    expect(await autoCloseResolved()).toBe(1);
    expect((await hasOne('request.status', null)).details).toMatchObject({ to: 'CLOSED', automatic: true });
  });

  it('announcements and settings', async () => {
    const a = await admin(app);
    await occupy('1A');
    const ann = (await a.c.post('/api/announcements', { title: 'Water off', body: 'Tomorrow', audience: { type: 'ALL' } })).body;
    await a.c.patch(`/api/announcements/${ann.id}`, { body: 'Friday' });
    await a.c.post(`/api/announcements/${ann.id}/archive`);
    await a.c.put('/api/settings', { buildingName: 'Sunrise Tower' });
    await hasOne('announcement.publish', a.user.id);
    await hasOne('announcement.update', a.user.id);
    await hasOne('announcement.archive', a.user.id);
    expect((await hasOne('settings.update', a.user.id)).details).toMatchObject({ changed: { buildingName: 'Sunrise Tower' } });
  });
});

describe('FR-34 reading the log', () => {
  it('administrators only, never grantable', async () => {
    const r = await residentIn(app, '1A');
    const everything = await loginAs(app, 'STAFF', ['reports.view', 'residents.manage', 'billing.manage', 'payments.record', 'expenses.manage']);
    expect((await r.c.get('/api/activity')).status).toBe(403);
    expect((await everything.c.get('/api/activity')).status).toBe(403);
    expect((await (await client(app)).get('/api/activity')).status).toBe(401);
    expect((await (await admin(app)).c.get('/api/activity')).status).toBe(200);
  });

  it('filters by person, action and date, newest first', async () => {
    const a = await admin(app);
    const other = await admin(app);
    await a.c.post('/api/units', { unitNumber: 'A1', floor: 1 });
    await other.c.post('/api/units', { unitNumber: 'B1', floor: 1 });
    const mine = (await a.c.get(`/api/activity?actorId=${other.user.id}&action=unit.create`)).body;
    expect(mine.total).toBe(1);
    expect(mine.items[0]).toMatchObject({ action: 'unit.create', actor: { id: other.user.id }, details: { unit: 'B1' } });
    expect((await a.c.get('/api/activity?action=unit.create')).body.items.map((i: { details: { unit: string } }) => i.details.unit)).toEqual(['B1', 'A1']);
    expect((await a.c.get(`/api/activity?from=${TODAY}&to=${TODAY}&action=unit.create`)).body.total).toBe(2);
    expect((await a.c.get('/api/activity?to=2020-01-01')).body.total).toBe(0);
    expect((await a.c.get('/api/activity?action=made.up')).status).toBe(400);
    expect((await a.c.get('/api/activity/actors')).body.items.map((u: { id: string }) => u.id).sort()).toEqual([a.user.id, other.user.id].sort());
  });

  it('entries cannot be changed or deleted, even directly in the database', async () => {
    const a = await admin(app);
    await a.c.post('/api/units', { unitNumber: 'A1', floor: 1 });
    const row = (await entries('unit.create'))[0]!;
    await expect(prisma.activityLog.update({ where: { id: row.id }, data: { action: 'login.success' } })).rejects.toThrow(/cannot be changed/);
    await expect(prisma.activityLog.delete({ where: { id: row.id } })).rejects.toThrow(/cannot be changed/);
    await expect(prisma.activityLog.deleteMany()).rejects.toThrow(/cannot be changed/);
    expect((await a.c.delete(`/api/activity/${row.id}`)).status).toBe(404);
    expect((await a.c.patch(`/api/activity/${row.id}`, { action: 'x' })).status).toBe(404);
    expect(await prisma.activityLog.count({ where: { id: row.id } })).toBe(1);
  });

  it('someone in the log cannot be removed, so it never loses who did something', async () => {
    const a = await admin(app);
    await a.c.post('/api/units', { unitNumber: 'A1', floor: 1 });
    await expect(prisma.user.delete({ where: { id: a.user.id } })).rejects.toThrow();
  });
});

describe('FR-30 search', () => {
  async function scene() {
    const r = await occupy('4B', { name: 'Rahim Uddin' });
    await prisma.user.update({ where: { id: r.resident.id }, data: { phone: '+8801712345678' } });
    const bill = await makeBill(r.unit.id, MONTH, [['SERVICE', 100000]], { contactId: r.resident.id });
    const old = await makeBill(r.unit.id, addMonths(MONTH, -1), [['SERVICE', 100000]], { contactId: r.resident.id });
    const req = await makeRequest(r.resident.id, r.unit.id, { title: 'Broken lift button' });
    return { ...r, bill, old, req };
  }
  const q = (c: Awaited<ReturnType<typeof client>>, text: string) => c.get(`/api/search?q=${encodeURIComponent(text)}`);

  it('finds residents by name or phone, units, bills and requests, grouped by type', async () => {
    const s = await scene();
    const { c } = await admin(app);
    expect((await q(c, 'rahim')).body.residents.map((r: { id: string }) => r.id)).toEqual([s.resident.id]);
    expect((await q(c, '01712345')).body.residents.map((r: { id: string }) => r.id)).toEqual([s.resident.id]);
    const unit = (await q(c, '4b')).body;
    expect(unit.units.map((u: { unitNumber: string }) => u.unitNumber)).toEqual(['4B']);
    expect(unit.bills).toHaveLength(2);
    expect((await q(c, 'lift')).body.requests.map((r: { id: string }) => r.id)).toEqual([s.req.id]);
    expect((await q(c, `#${s.req.number}`)).body.requests.map((r: { id: string }) => r.id)).toEqual([s.req.id]);
  });

  it('finds a bill by unit and month', async () => {
    const s = await scene();
    const { c } = await admin(app);
    expect((await q(c, `4B ${MONTH}`)).body.bills.map((b: { id: string }) => b.id)).toEqual([s.bill.id]);
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const prev = addMonths(MONTH, -1);
    const named = `4B ${names[Number(prev.slice(5)) - 1]} ${prev.slice(0, 4)}`;
    expect((await q(c, named)).body.bills.map((b: { id: string }) => b.id)).toEqual([s.old.id]);
  });

  it('understands how people write a bill search', () => {
    expect(splitBillQuery('4B 2026-11', 2026)).toEqual({ unit: '4b', month: '2026-11' });
    expect(splitBillQuery('4B Nov', 2026)).toEqual({ unit: '4b', month: '2026-11' });
    expect(splitBillQuery('november 2025 12A', 2026)).toEqual({ unit: '12a', month: '2025-11' });
    expect(splitBillQuery('4B', 2026)).toEqual({ unit: '4b', month: null });
    expect(splitBillQuery('A1', 2026)).toEqual({ unit: 'a1', month: null });
  });

  it('never shows a group the person could not open', async () => {
    await scene();
    const groups = async (perms: string[], text: string) => {
      const b = (await q((await loginAs(app, 'STAFF', perms)).c, text)).body;
      return Object.entries(b).filter(([, v]) => (v as unknown[]).length > 0).map(([k]) => k);
    };
    expect(await groups([], '4B')).toEqual([]);
    expect(await groups(['billing.view'], '4B')).toEqual(['bills']);
    expect(await groups(['units.manage'], '4B')).toEqual(['units']);
    expect(await groups(['residents.manage'], 'rahim')).toEqual(['residents']);
    expect(await groups(['maintenance.view_all'], 'lift')).toEqual(['requests']);
    expect(await groups(['billing.view'], 'rahim')).not.toContain('residents');
    expect(await groups(['billing.view', 'units.manage'], 'lift')).toEqual([]);
  });

  it('is not for residents, needs two characters, and treats wildcards as plain text', async () => {
    await scene();
    const r = await residentIn(app, '9Z');
    const { c } = await admin(app);
    expect((await q(r.c, 'rahim')).status).toBe(403);
    expect((await (await client(app)).get('/api/search?q=rahim')).status).toBe(401);
    expect((await q(c, 'a')).status).toBe(400);
    expect((await q(c, '%%')).body.bills).toEqual([]);
    expect((await q(c, "'; DROP TABLE units; --")).status).toBe(200);
  });
});

describe('FR-22 maintenance report', () => {
  const HOUR = 3_600_000;
  async function scene() {
    const one = await occupy('1A');
    const two = await occupy('2A');
    const now = Date.now() - 10 * HOUR;
    const made = (r: typeof one, over: Parameters<typeof makeRequest>[2]) => makeRequest(r.resident.id, r.unit.id, { createdAt: new Date(now), ...over });
    await made(one, { status: 'RESOLVED', category: 'PLUMBING', resolvedAt: new Date(now + 2 * HOUR) });
    await made(one, { status: 'RESOLVED', category: 'PLUMBING', resolvedAt: new Date(now + 4 * HOUR) });
    await made(one, { status: 'SUBMITTED', category: 'ELECTRICAL' });
    await made(two, { status: 'RESOLVED', category: 'ELECTRICAL', resolvedAt: new Date(now + 9 * HOUR) });
    await makeRequest(two.resident.id, two.unit.id, { createdAt: new Date('2020-03-01T00:00:00Z'), status: 'CLOSED' }); // outside the period
  }

  it('counts by status, averages the time to resolve, and ranks units and categories', async () => {
    await scene();
    const { c } = await admin(app);
    const res = await c.get(`/api/reports/maintenance?from=${MONTH}&to=${MONTH}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.byStatus).toEqual(expect.arrayContaining([{ status: 'RESOLVED', n: 3 }, { status: 'SUBMITTED', n: 1 }]));
    expect(res.body.averageHours).toBe(5); // (2 + 4 + 9) / 3
    expect(res.body.byCategory).toEqual([
      { category: 'PLUMBING', requests: 2, resolved: 2, averageHours: 3 },
      { category: 'ELECTRICAL', requests: 2, resolved: 1, averageHours: 9 },
    ].sort((a, b) => a.category.localeCompare(b.category)));
    expect(res.body.topUnits.map((u: { unitNumber: string; requests: number }) => [u.unitNumber, u.requests])).toEqual([['1A', 3], ['2A', 1]]);
  });

  it('a period with nothing has no average rather than zero, and needs reports.view', async () => {
    await scene();
    const { c } = await admin(app);
    expect((await c.get('/api/reports/maintenance?from=2021-01&to=2021-02')).body).toMatchObject({ total: 0, averageHours: null, byCategory: [] });
    expect((await (await loginAs(app, 'STAFF', ['maintenance.view_all'])).c.get(`/api/reports/maintenance?from=${MONTH}&to=${MONTH}`)).status).toBe(403);
  });
});

describe('FR-30 dashboard', () => {
  it('administrators see the 10 latest activities; staff with reports.view do not', async () => {
    const a = await admin(app);
    for (let i = 0; i < 12; i++) await makeUnit();
    for (let i = 0; i < 12; i++) await a.c.post('/api/units', { unitNumber: `U${i}`, floor: 1 });
    const dash = (await a.c.get('/api/dashboard')).body;
    expect(dash.recent.activity).toHaveLength(10);
    expect(dash.recent.activity[0]).toMatchObject({ action: 'unit.create', actor: { id: a.user.id } });
    expect((await (await loginAs(app, 'STAFF', ['reports.view'])).c.get('/api/dashboard')).body.recent.activity).toBeNull();
  });
});
