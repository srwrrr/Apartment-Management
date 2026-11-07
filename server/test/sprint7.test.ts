import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { dateOnly, ymdOf } from '../src/lib/dates';
import { taka, toCsv } from '../src/lib/csv';
import { demoAccountsFor } from '../src/modules/users/auth.routes';
import { autoCloseResolved } from '../src/modules/maintenance/requests.service';
import { addDays, addMonthsToDate, createDueScheduledRequests, upcomingScheduledTasks } from '../src/modules/maintenance/scheduledTasks.service';
import { noticeHtml, publishDueAnnouncements } from '../src/modules/announcements/announcements.service';
import { committeeData, committeeHtml } from '../src/modules/reports/committee';
import { duesReport, financeReport, maintenanceReport } from '../src/modules/reports/reports.service';
import { incomeExpenseReport } from '../src/modules/expenses/expenses.service';
import { PASSWORD, addMonths, client, currentMonthDhaka, d, loginAs, makeBill, makeLoginUser, makeUnit, occupy, resetDb, todayDhaka } from './helpers';
import { admin, asResident, caretaker, clearUploads, makeRequest, manager, residentIn } from './maintenance.helpers';

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

const TODAY = todayDhaka();
const MONTH = currentMonthDhaka();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const MEMBER = { fullName: 'Rina Begum', relation: 'Wife', loginId: 'rina@test.local' };

describe('FR-54 household members', () => {
  it('a member gets their own login, must change the password, and sees what the household sees', async () => {
    const a = await admin(app);
    const o = await occupy('5A');
    await makeBill(o.unit.id, MONTH, [['SERVICE', 300000]], { contactId: o.resident.id });

    const res = await a.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER);
    expect(res.status).toBe(201);
    expect(res.body.tempPassword).toBeTruthy();
    const user = await prisma.user.findUniqueOrThrow({ where: { loginId: MEMBER.loginId } });
    expect(user).toMatchObject({ role: 'RESIDENT', mustChangePassword: true, phone: o.resident.phone });

    const m = await client(app);
    expect((await m.login(MEMBER.loginId, res.body.tempPassword)).status).toBe(200);
    expect((await m.get('/api/me/billing/bills')).status).toBe(403); // PASSWORD_CHANGE_REQUIRED first
    await m.post('/api/auth/change-password', { currentPassword: res.body.tempPassword, newPassword: PASSWORD });
    const bills = await m.get('/api/me/billing/bills');
    expect(bills.status).toBe(200);
    expect(bills.body.items).toHaveLength(1);
  });

  it('never puts the temporary password in the log', async () => {
    const a = await admin(app);
    const o = await occupy('5A');
    const res = await a.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER);
    const logged = await prisma.activityLog.findFirstOrThrow({ where: { action: 'household.add' } });
    expect(logged.actorId).toBe(a.user.id);
    expect(JSON.stringify(logged)).not.toContain(res.body.tempPassword);
  });

  it('a login ID in use, a stay that has ended, and a missing stay are refused', async () => {
    const a = await admin(app);
    const o = await occupy('5A');
    await a.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER);
    const dup = await a.c.post(`/api/occupancies/${o.occupancy.id}/members`, { ...MEMBER, fullName: 'Someone Else' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.fields.loginId.code).toBe('LOGIN_ID_TAKEN');

    const ended = await occupy('5B', { start: '2020-01-01', end: '2021-01-01' });
    const late = await a.c.post(`/api/occupancies/${ended.occupancy.id}/members`, { ...MEMBER, loginId: 'late@test.local' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OCCUPANCY_ENDED');
    expect(await prisma.user.count({ where: { loginId: 'late@test.local' } })).toBe(0);

    expect((await a.c.post('/api/occupancies/00000000-0000-4000-8000-000000000000/members', { ...MEMBER, loginId: 'x@test.local' })).status).toBe(404);
  });

  it('only people who manage residents can add or remove', async () => {
    const o = await occupy('5A');
    const staff = await loginAs(app, 'STAFF', ['billing.view']);
    expect((await staff.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER)).status).toBe(403);
    expect((await (await asResident(app, o.resident)).post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER)).status).toBe(403);
    const office = await loginAs(app, 'STAFF', ['residents.manage']);
    const add = await office.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER);
    expect(add.status).toBe(201);
    expect((await staff.c.delete(`/api/household-members/${add.body.member.id}`)).status).toBe(403);
  });

  it('removing a member stops them at once, and keeps their history', async () => {
    const a = await admin(app);
    const o = await occupy('5A');
    const add = await a.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER);
    await prisma.user.update({ where: { loginId: MEMBER.loginId }, data: { mustChangePassword: false, passwordHash: o.resident.passwordHash } });
    const m = await client(app);
    await m.login(MEMBER.loginId);
    expect((await m.get('/api/auth/me')).status).toBe(200);
    const request = await makeRequest(add.body.member.user.id, o.unit.id);

    expect((await a.c.delete(`/api/household-members/${add.body.member.id}`)).status).toBe(204);
    // Checked before any request from them, because a request from an inactive user also clears its own session.
    expect(await prisma.$queryRaw`SELECT 1 FROM "session" WHERE "userId" = ${add.body.member.user.id}::uuid`).toEqual([]);
    expect((await m.get('/api/auth/me')).status).toBe(401); // the open session ends too
    expect((await (await client(app)).login(MEMBER.loginId)).status).toBe(401);

    const row = await prisma.householdMember.findUniqueOrThrow({ where: { id: add.body.member.id } });
    expect(ymdOf(row.removedAt!)).toBe(TODAY);
    expect(await prisma.maintenanceRequest.count({ where: { id: request.id, submittedById: add.body.member.user.id } })).toBe(1);
    expect((await a.c.delete(`/api/household-members/${add.body.member.id}`)).status).toBe(204); // removing twice changes nothing
    expect(await prisma.activityLog.count({ where: { action: 'household.remove' } })).toBe(1);
  });

  it('someone who still has a home elsewhere keeps their account', async () => {
    const a = await admin(app);
    const o = await occupy('5A');
    const other = await occupy('5B');
    const add = await a.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER);
    await prisma.householdMember.create({ data: { occupancyId: other.occupancy.id, userId: add.body.member.user.id, relation: 'Sister', addedAt: dateOnly(TODAY) } });
    await a.c.delete(`/api/household-members/${add.body.member.id}`);
    expect((await prisma.user.findUniqueOrThrow({ where: { loginId: MEMBER.loginId } })).isActive).toBe(true);
  });

  it('the move-out wizard ending a stay closes the household member’s account too', async () => {
    const a = await admin(app);
    const o = await occupy('5A');
    await a.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER);
    const res = await a.c.post(`/api/occupancies/${o.occupancy.id}/move-out`, { endDate: TODAY, expectedBalance: 0 });
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { loginId: MEMBER.loginId } })).isActive).toBe(false);
  });

  it('a stay ending in the future leaves them able to log in until then', async () => {
    const a = await admin(app);
    const o = await occupy('5A');
    await a.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER);
    await a.c.patch(`/api/occupancies/${o.occupancy.id}`, { endDate: addDays(TODAY, 10) });
    expect((await prisma.user.findUniqueOrThrow({ where: { loginId: MEMBER.loginId } })).isActive).toBe(true);
  });

  it('the unit page lists them with their stay', async () => {
    const a = await admin(app);
    const o = await occupy('5A');
    await a.c.post(`/api/occupancies/${o.occupancy.id}/members`, MEMBER);
    const stays = await a.c.get(`/api/units/${o.unit.id}/occupancies`);
    expect(stays.body.items[0].household[0]).toMatchObject({ relation: 'Wife', user: { fullName: 'Rina Begum' } });
    expect(JSON.stringify(stays.body)).not.toContain('passwordHash');
  });
});

describe('FR-50 ratings (BR-26)', () => {
  async function closed(over: Parameters<typeof makeRequest>[2] = {}) {
    const r = await residentIn(app, '6A');
    const req = await makeRequest(r.resident.id, r.unit.id, { status: 'CLOSED', ...over });
    return { ...r, req };
  }

  it('the submitter rates a closed request once, and cannot change it', async () => {
    const { c, req } = await closed();
    expect((await c.get(`/api/requests/${req.id}`)).body.canRate).toBe(true);
    const res = await c.post(`/api/requests/${req.id}/rating`, { stars: 4, comment: 'Quick work' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ canRate: false, rating: { stars: 4, comment: 'Quick work' } });
    const again = await c.post(`/api/requests/${req.id}/rating`, { stars: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_RATED');
    await expect(prisma.$executeRaw`UPDATE request_ratings SET stars = 1`).rejects.toThrow(/cannot be changed/);
    await expect(prisma.$executeRaw`DELETE FROM request_ratings`).rejects.toThrow(/cannot be changed/);
  });

  it('confirming a resolved request opens the rating', async () => {
    const r = await residentIn(app, '6A');
    const req = await makeRequest(r.resident.id, r.unit.id, { status: 'RESOLVED' });
    expect((await r.c.get(`/api/requests/${req.id}`)).body.canRate).toBe(false);
    const res = await r.c.post(`/api/requests/${req.id}/transition`, { to: 'CLOSED' });
    expect(res.body.canRate).toBe(true);
  });

  it('a request closed automatically can still be rated', async () => {
    const r = await residentIn(app, '6A');
    const req = await makeRequest(r.resident.id, r.unit.id, { status: 'RESOLVED', resolvedAt: hoursAgo(24 * 30) });
    expect(await autoCloseResolved()).toBe(1);
    expect((await r.c.post(`/api/requests/${req.id}/rating`, { stars: 3 })).status).toBe(201);
  });

  it('the window is 7 days after closing', async () => {
    const inside = await closed({ closedAt: hoursAgo(24 * 7 - 1) });
    expect((await inside.c.post(`/api/requests/${inside.req.id}/rating`, { stars: 5 })).status).toBe(201);

    const old = await makeRequest(inside.resident.id, inside.unit.id, { status: 'CLOSED', closedAt: hoursAgo(24 * 7 + 1) });
    expect((await inside.c.get(`/api/requests/${old.id}`)).body.canRate).toBe(false);
    const res = await inside.c.post(`/api/requests/${old.id}/rating`, { stars: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RATING_CLOSED');
  });

  it.each(['SUBMITTED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED', 'CANCELLED'])('a %s request cannot be rated', async (status) => {
    const r = await residentIn(app, '6A');
    const req = await makeRequest(r.resident.id, r.unit.id, { status });
    expect((await r.c.post(`/api/requests/${req.id}/rating`, { stars: 5 })).status).toBe(409);
  });

  it.each([0, 6, 2.5])('%s stars is refused', async (stars) => {
    const { c, req } = await closed();
    expect((await c.post(`/api/requests/${req.id}/rating`, { stars })).status).toBe(400);
  });

  it('only the submitter: the household is refused, and neighbours learn nothing', async () => {
    const { req, occupancy, unit } = await closed();
    const member = await makeLoginUser('RESIDENT');
    await prisma.householdMember.create({ data: { occupancyId: occupancy.id, userId: member.id, relation: 'Son', addedAt: d('2020-06-01') } });
    expect((await (await asResident(app, member)).post(`/api/requests/${req.id}/rating`, { stars: 5 })).status).toBe(403);
    expect((await (await residentIn(app, '6B')).c.post(`/api/requests/${req.id}/rating`, { stars: 5 })).status).toBe(404);
    expect((await (await admin(app)).c.post(`/api/requests/${req.id}/rating`, { stars: 5 })).status).toBe(403);
    expect(unit.id).toBeTruthy();
  });

  it('the administrator and the assigned staff member see it; other staff and the household do not', async () => {
    const staff = await caretaker(app);
    const { c, req, occupancy } = await closed({ assignedToId: undefined });
    await prisma.maintenanceRequest.update({ where: { id: req.id }, data: { assignedToId: staff.user.id } });
    await c.post(`/api/requests/${req.id}/rating`, { stars: 2 });

    expect((await staff.c.get(`/api/requests/${req.id}`)).body.rating.stars).toBe(2);
    expect((await (await admin(app)).c.get(`/api/requests/${req.id}`)).body.rating.stars).toBe(2);
    expect((await (await manager(app)).c.get(`/api/requests/${req.id}`)).body.rating).toBeNull();
    const member = await makeLoginUser('RESIDENT');
    await prisma.householdMember.create({ data: { occupancyId: occupancy.id, userId: member.id, relation: 'Son', addedAt: d('2020-06-01') } });
    expect((await (await asResident(app, member)).get(`/api/requests/${req.id}`)).body.rating).toBeNull();
  });

  it('the report shows the average overall, by category and by staff member', async () => {
    const one = await loginAs(app, 'STAFF', [], { fullName: 'Karim' });
    const two = await loginAs(app, 'STAFF', [], { fullName: 'Jamal' });
    const r = await residentIn(app, '6A');
    const give = async (stars: number, category: string, assignedToId: string) => {
      const req = await makeRequest(r.resident.id, r.unit.id, { status: 'CLOSED', category, assignedToId });
      await r.c.post(`/api/requests/${req.id}/rating`, { stars });
    };
    await give(5, 'PLUMBING', one.user.id);
    await give(4, 'PLUMBING', one.user.id);
    await give(1, 'LIFT', two.user.id);
    await makeRequest(r.resident.id, r.unit.id, { status: 'CLOSED', category: 'GAS' }); // not rated

    const report = await maintenanceReport(MONTH, MONTH);
    expect(report.averageRating).toBe(3.3);
    expect(report.ratings).toBe(3);
    expect(report.byCategory.find((c) => c.category === 'PLUMBING')!.averageRating).toBe(4.5);
    expect(report.byCategory.find((c) => c.category === 'GAS')!.averageRating).toBeNull();
    expect(report.byStaff.map((s) => [s.fullName, s.averageRating, s.ratings])).toEqual([['Karim', 4.5, 2], ['Jamal', 1, 1]]);
  });
});

describe('FR-49 scheduled tasks (BR-25)', () => {
  const TASK = { title: 'Service the lift', description: 'Monthly service by the lift company.', category: 'LIFT', intervalMonths: 1 };
  const make = (over: Partial<{ nextDueDate: Date; intervalMonths: number; isPaused: boolean; defaultAssigneeId: string | null; createdById: string }> & { createdById: string }) =>
    prisma.scheduledTask.create({ data: { ...TASK, category: 'LIFT', nextDueDate: dateOnly(TODAY), ...over } });

  it('only maintenance.assign can manage them', async () => {
    const body = { ...TASK, nextDueDate: addDays(TODAY, 30) };
    expect((await (await caretaker(app)).c.post('/api/scheduled-tasks', body)).status).toBe(403);
    expect((await (await residentIn(app, '7A')).c.get('/api/scheduled-tasks')).status).toBe(403);
    const m = await manager(app);
    expect((await m.c.post('/api/scheduled-tasks', body)).status).toBe(201);
    expect((await m.c.get('/api/scheduled-tasks')).body.items).toHaveLength(1);
  });

  it.each([0, 25, 1.5])('an interval of %s months is refused', async (intervalMonths) => {
    const a = await admin(app);
    expect((await a.c.post('/api/scheduled-tasks', { ...TASK, intervalMonths, nextDueDate: addDays(TODAY, 30) })).status).toBe(400);
  });

  it('a past date and a non-staff assignee are refused', async () => {
    const a = await admin(app);
    const past = await a.c.post('/api/scheduled-tasks', { ...TASK, nextDueDate: addDays(TODAY, -1) });
    expect(past.body.error.fields.nextDueDate.code).toBe('DATE_IN_PAST');
    const r = await occupy('7A');
    const who = await a.c.post('/api/scheduled-tasks', { ...TASK, nextDueDate: addDays(TODAY, 3), defaultAssigneeId: r.resident.id });
    expect(who.body.error.fields.defaultAssigneeId.code).toBe('STAFF_NOT_FOUND');
  });

  it('the database refuses an impossible interval too', async () => {
    const a = await admin(app);
    await expect(prisma.scheduledTask.create({ data: { ...TASK, category: 'LIFT', intervalMonths: 25, nextDueDate: dateOnly(TODAY), createdById: a.user.id } })).rejects.toThrow();
  });

  it('seven days before, a request appears: common area, Medium, Under review, due on the due date, from the system', async () => {
    const a = await admin(app);
    const staff = await caretaker(app);
    const due = addDays(TODAY, 7);
    const task = await make({ nextDueDate: dateOnly(due), defaultAssigneeId: staff.user.id, createdById: a.user.id });

    expect(await createDueScheduledRequests()).toBe(1);
    const r = await prisma.maintenanceRequest.findFirstOrThrow({ where: { scheduledTaskId: task.id }, include: { updates: true } });
    expect(r).toMatchObject({ location: 'COMMON_AREA', priority: 'MEDIUM', status: 'UNDER_REVIEW', submittedById: null, unitId: null, assignedToId: staff.user.id, title: TASK.title });
    expect(r.dueAt.toISOString()).toBe(new Date(`${due}T23:59:59+06:00`).toISOString());
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]).toMatchObject({ authorId: null, toValue: 'UNDER_REVIEW' });

    const told = await prisma.notification.findMany({ where: { type: 'REQUEST_SCHEDULED' } });
    expect(told.map((n) => n.userId)).toEqual([staff.user.id]);
    expect(told[0]!.params).toMatchObject({ title: TASK.title, dueDate: due });

    const next = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(ymdOf(next.nextDueDate)).toBe(addMonthsToDate(due, 1));
    const logged = await prisma.activityLog.findFirstOrThrow({ where: { action: 'request.scheduled' } });
    expect(logged.actorId).toBeNull();
  });

  it('eight days before, nothing happens yet', async () => {
    const a = await admin(app);
    await make({ nextDueDate: dateOnly(addDays(TODAY, 8)), createdById: a.user.id });
    expect(await createDueScheduledRequests()).toBe(0);
  });

  it('running it twice creates one request', async () => {
    const a = await admin(app);
    await make({ nextDueDate: dateOnly(addDays(TODAY, 3)), createdById: a.user.id });
    expect((await Promise.all([createDueScheduledRequests(), createDueScheduledRequests()])).reduce((x, y) => x + y, 0)).toBe(1);
    expect(await createDueScheduledRequests()).toBe(0);
    expect(await prisma.maintenanceRequest.count()).toBe(1);
  });

  it('after downtime it catches up on each missed date, then stops', async () => {
    const a = await admin(app);
    const task = await make({ nextDueDate: dateOnly(addMonthsToDate(TODAY, -2)), createdById: a.user.id });
    expect(await createDueScheduledRequests()).toBe(3);
    expect(ymdOf((await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).nextDueDate) > addDays(TODAY, 7)).toBe(true);
  });

  it('a paused task creates nothing; resuming skips what was missed', async () => {
    const a = await admin(app);
    const task = await make({ nextDueDate: dateOnly(addDays(TODAY, 2)), createdById: a.user.id });
    await a.c.post(`/api/scheduled-tasks/${task.id}/pause`);
    expect(await createDueScheduledRequests()).toBe(0);

    await prisma.scheduledTask.update({ where: { id: task.id }, data: { nextDueDate: dateOnly(addMonthsToDate(TODAY, -2)) } });
    const res = await a.c.post(`/api/scheduled-tasks/${task.id}/resume`);
    expect(res.body.isPaused).toBe(false);
    expect(res.body.nextDueDate >= TODAY).toBe(true);
    expect(await prisma.activityLog.count({ where: { action: { in: ['scheduled_task.pause', 'scheduled_task.resume'] } } })).toBe(2);
  });

  it('with nobody assigned, the people who look after maintenance are told', async () => {
    const a = await admin(app);
    const m = await manager(app);
    const other = await caretaker(app);
    await make({ nextDueDate: dateOnly(TODAY), createdById: a.user.id });
    await createDueScheduledRequests();
    const told = (await prisma.notification.findMany({ where: { type: 'REQUEST_SCHEDULED' } })).map((n) => n.userId);
    expect(told.sort()).toEqual([a.user.id, m.user.id].sort());
    expect(told).not.toContain(other.user.id);
  });

  it('an assignee who has left is not given the job', async () => {
    const a = await admin(app);
    const staff = await caretaker(app);
    const task = await make({ nextDueDate: dateOnly(TODAY), defaultAssigneeId: staff.user.id, createdById: a.user.id });
    await prisma.user.update({ where: { id: staff.user.id }, data: { isActive: false } });
    await createDueScheduledRequests();
    expect((await prisma.maintenanceRequest.findFirstOrThrow({ where: { scheduledTaskId: task.id } })).assignedToId).toBeNull();
  });

  it('changing the priority keeps the due date (BR-25)', async () => {
    const a = await admin(app);
    const task = await make({ nextDueDate: dateOnly(addDays(TODAY, 7)), createdById: a.user.id });
    await createDueScheduledRequests();
    const before = await prisma.maintenanceRequest.findFirstOrThrow({ where: { scheduledTaskId: task.id } });
    const res = await a.c.patch(`/api/requests/${before.id}/priority`, { priority: 'HIGH' });
    expect(res.status).toBe(200);
    expect(new Date(res.body.dueAt).toISOString()).toBe(before.dueAt.toISOString());
  });

  it('the job works from start to finish without a unit or a submitter', async () => {
    const a = await admin(app);
    const staff = await caretaker(app);
    const task = await make({ nextDueDate: dateOnly(TODAY), defaultAssigneeId: staff.user.id, createdById: a.user.id });
    await createDueScheduledRequests();
    const { id } = await prisma.maintenanceRequest.findFirstOrThrow({ where: { scheduledTaskId: task.id } });

    const detail = await staff.c.get(`/api/requests/${id}`);
    expect(detail.body).toMatchObject({ unit: null, submittedBy: null, scheduled: true, canRate: false });
    expect((await a.c.get('/api/requests')).body.items[0]).toMatchObject({ id, unit: null, submittedBy: null, scheduled: true });
    expect((await staff.c.get('/api/me/tasks')).body.items[0].unit).toBeNull();
    expect((await a.c.get(`/api/search?q=${encodeURIComponent('lift')}`)).body.requests[0].unit).toBeNull();
    expect((await a.c.get('/api/dashboard')).body.recent.requests[0].unitNumber).toBeNull();
    expect((await a.c.get('/api/requests/export.csv')).status).toBe(200);

    expect((await staff.c.post(`/api/requests/${id}/transition`, { to: 'IN_PROGRESS' })).status).toBe(200);
    expect((await staff.c.post(`/api/requests/${id}/transition`, { to: 'RESOLVED', note: 'Serviced' })).status).toBe(200);
    await prisma.maintenanceRequest.update({ where: { id }, data: { resolvedAt: hoursAgo(24 * 30) } });
    expect(await autoCloseResolved()).toBe(1);
    expect((await a.c.get(`/api/requests/${id}`)).body.status).toBe('CLOSED');
  });

  it('a resident cannot open a scheduled job', async () => {
    const a = await admin(app);
    const task = await make({ nextDueDate: dateOnly(TODAY), createdById: a.user.id });
    await createDueScheduledRequests();
    const { id } = await prisma.maintenanceRequest.findFirstOrThrow({ where: { scheduledTaskId: task.id } });
    const r = await residentIn(app, '7A');
    expect((await r.c.get(`/api/requests/${id}`)).status).toBe(404);
    expect((await r.c.get('/api/me/requests')).body.items).toHaveLength(0);
  });

  it('the next 90 days lists each date, and leaves out paused tasks', async () => {
    const a = await admin(app);
    await make({ nextDueDate: dateOnly(addDays(TODAY, 10)), intervalMonths: 1, createdById: a.user.id });
    await make({ nextDueDate: dateOnly(addDays(TODAY, 10)), isPaused: true, createdById: a.user.id });
    await make({ nextDueDate: dateOnly(addDays(TODAY, 91)), createdById: a.user.id });
    const { items } = await upcomingScheduledTasks();
    expect(items.map((i) => i.dueDate)).toEqual([addDays(TODAY, 10), addMonthsToDate(addDays(TODAY, 10), 1), addMonthsToDate(addDays(TODAY, 10), 2)].filter((x) => x <= addDays(TODAY, 90)));
  });

  it('months of different lengths', () => {
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDate('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsToDate('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonthsToDate('2026-12-31', 24)).toBe('2028-12-31');
  });

  it('editing changes the task, and a past date is still refused', async () => {
    const a = await admin(app);
    const t = await make({ nextDueDate: dateOnly(addDays(TODAY, 40)), createdById: a.user.id });
    const res = await a.c.patch(`/api/scheduled-tasks/${t.id}`, { title: 'Service both lifts', intervalMonths: 2 });
    expect(res.body).toMatchObject({ title: 'Service both lifts', intervalMonths: 2 });
    expect((await a.c.patch(`/api/scheduled-tasks/${t.id}`, { nextDueDate: addDays(TODAY, -3) })).status).toBe(400);
    expect((await a.c.patch('/api/scheduled-tasks/not-a-uuid', { intervalMonths: 2 })).status).toBe(404);
  });
});

const NOTICE = { title: 'Gas off on Tuesday', body: 'Gas will be off from 10am to 2pm.', audience: { type: 'ALL' } };

describe('FR-51 scheduled and ending announcements', () => {
  it('nobody sees it or is told until its time; then the audience is decided', async () => {
    const a = await admin(app);
    const r = await residentIn(app, '8A');
    const res = await a.c.post('/api/announcements', { ...NOTICE, publishAt: inHours(2) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: 'SCHEDULED', recipients: 0 });
    expect((await r.c.get('/api/announcements')).body.items).toHaveLength(0);
    expect((await r.c.get(`/api/announcements/${res.body.id}`)).status).toBe(404);
    expect(await prisma.notification.count()).toBe(0);
    expect((await a.c.get('/api/dashboard')).body.recent.announcements).toHaveLength(0);
    expect(await publishDueAnnouncements()).toBe(0);

    const late = await residentIn(app, '8B'); // moved in after it was written
    expect(await publishDueAnnouncements(new Date(Date.now() + 3 * 3_600_000))).toBe(1);
    expect((await late.c.get('/api/announcements')).body.items).toHaveLength(1);
    expect((await r.c.get('/api/announcements')).body.items).toHaveLength(1);
    expect(await prisma.notification.count({ where: { type: 'ANNOUNCEMENT' } })).toBe(2);
    expect((await a.c.get(`/api/announcements/${res.body.id}`)).body).toMatchObject({ state: 'ACTIVE', recipients: 2 });
  });

  it('running the job twice sends once', async () => {
    const a = await admin(app);
    await residentIn(app, '8A');
    await a.c.post('/api/announcements', { ...NOTICE, publishAt: inHours(1) });
    const later = new Date(Date.now() + 2 * 3_600_000);
    const counts = await Promise.all([publishDueAnnouncements(later), publishDueAnnouncements(later)]);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1);
    expect(await publishDueAnnouncements(later)).toBe(0);
    expect(await prisma.notification.count()).toBe(1);
  });

  it('a floor audience chosen earlier is used at publish time', async () => {
    const a = await admin(app);
    await residentIn(app, '2A', { floor: 2 });
    await residentIn(app, '3A', { floor: 3 });
    const res = await a.c.post('/api/announcements', { ...NOTICE, audience: { type: 'FLOORS', floors: [2] }, publishAt: inHours(1) });
    await publishDueAnnouncements(new Date(Date.now() + 2 * 3_600_000));
    expect((await a.c.get(`/api/announcements/${res.body.id}`)).body.recipients).toBe(1);
  });

  it('archived before its time, it never goes out', async () => {
    const a = await admin(app);
    await residentIn(app, '8A');
    const res = await a.c.post('/api/announcements', { ...NOTICE, publishAt: inHours(1) });
    await a.c.post(`/api/announcements/${res.body.id}/archive`);
    expect(await publishDueAnnouncements(new Date(Date.now() + 2 * 3_600_000))).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('a publish time in the past just publishes now', async () => {
    const a = await admin(app);
    await residentIn(app, '8A');
    const res = await a.c.post('/api/announcements', { ...NOTICE, publishAt: inHours(-1) });
    expect(res.body).toMatchObject({ state: 'ACTIVE', recipients: 1 });
    expect(new Date(res.body.publishedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('after its end time it moves to past announcements, and can still be opened', async () => {
    const a = await admin(app);
    const r = await residentIn(app, '8A');
    const res = await a.c.post('/api/announcements', { ...NOTICE, endsAt: inHours(1) });
    expect((await r.c.get('/api/announcements')).body.items).toHaveLength(1);
    expect((await r.c.get('/api/announcements?past=true')).body.items).toHaveLength(0);

    await prisma.announcement.update({ where: { id: res.body.id }, data: { endsAt: hoursAgo(1) } });
    const current = await r.c.get('/api/announcements');
    expect(current.body).toMatchObject({ items: [], total: 0 });
    const past = await r.c.get('/api/announcements?past=true');
    expect(past.body.total).toBe(1);
    expect((await r.c.get(`/api/announcements/${res.body.id}`)).status).toBe(200);
    expect((await a.c.get(`/api/announcements/${res.body.id}`)).body.state).toBe('ENDED');
  });

  it('the end must come after the start', async () => {
    const a = await admin(app);
    await residentIn(app, '8A');
    const res = await a.c.post('/api/announcements', { ...NOTICE, publishAt: inHours(5), endsAt: inHours(4) });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.endsAt.code).toBe('ENDS_BEFORE_PUBLISH');
    const noStart = await a.c.post('/api/announcements', { ...NOTICE, endsAt: inHours(-1) });
    expect(noStart.body.error.fields.endsAt.code).toBe('ENDS_BEFORE_PUBLISH');
  });

  it('before it goes out it can be rescheduled without being marked as edited; afterwards it cannot', async () => {
    const a = await admin(app);
    await residentIn(app, '8A');
    const res = await a.c.post('/api/announcements', { ...NOTICE, publishAt: inHours(1) });
    const moved = await a.c.patch(`/api/announcements/${res.body.id}`, { publishAt: inHours(3), title: 'Gas off on Wednesday' });
    expect(moved.status).toBe(200);
    expect(moved.body.editedAt).toBeNull();

    const sent = await a.c.post('/api/announcements', NOTICE);
    const late = await a.c.patch(`/api/announcements/${sent.body.id}`, { publishAt: inHours(3) });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ANNOUNCEMENT_ALREADY_SENT');
    expect((await a.c.patch(`/api/announcements/${sent.body.id}`, { title: 'Gas off Tuesday' })).body.editedAt).toBeTruthy();
  });

  it('the job records what it sent, as the system', async () => {
    const a = await admin(app);
    await residentIn(app, '8A');
    await a.c.post('/api/announcements', { ...NOTICE, publishAt: inHours(1) });
    await publishDueAnnouncements(new Date(Date.now() + 2 * 3_600_000));
    expect((await prisma.activityLog.findFirstOrThrow({ where: { action: 'announcement.schedule' } })).actorId).toBe(a.user.id);
    expect((await prisma.activityLog.findFirstOrThrow({ where: { action: 'announcement.publish' } })).actorId).toBeNull();
  });
});

describe('FR-36 resident groups', () => {
  async function group(c: Awaited<ReturnType<typeof admin>>['c'], name: string, userIds: string[]) {
    const g = await c.post('/api/groups', { name });
    await c.put(`/api/groups/${g.body.id}/members`, { userIds });
    return g.body.id as string;
  }

  it('created, renamed, filled and emptied by people who manage announcements', async () => {
    const m = await loginAs(app, 'STAFF', ['announcements.manage']);
    const r = await occupy('9A');
    const created = await m.c.post('/api/groups', { name: 'Committee' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await m.c.patch(`/api/groups/${id}`, { name: 'Building committee' })).body.name).toBe('Building committee');
    expect((await m.c.put(`/api/groups/${id}/members`, { userIds: [r.resident.id, r.resident.id] })).body.members).toHaveLength(1);
    expect((await m.c.get('/api/groups')).body.items).toEqual([{ id, name: 'Building committee', members: 1 }]);
    expect((await m.c.put(`/api/groups/${id}/members`, { userIds: [] })).body.members).toHaveLength(0);
  });

  it('others cannot, and a resident cannot read who is in a group', async () => {
    const r = await residentIn(app, '9A');
    const staff = await loginAs(app, 'STAFF', ['residents.manage']);
    expect((await r.c.get('/api/groups')).status).toBe(403);
    expect((await staff.c.post('/api/groups', { name: 'Nope' })).status).toBe(403);
    expect((await r.c.get('/api/groups/residents?q=a')).status).toBe(403);
  });

  it('names are unique, and only residents can be members', async () => {
    const a = await admin(app);
    await a.c.post('/api/groups', { name: 'Committee' });
    const dup = await a.c.post('/api/groups', { name: 'Committee' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.fields.name.code).toBe('GROUP_NAME_TAKEN');
    const g = await a.c.post('/api/groups', { name: 'Other' });
    const bad = await a.c.put(`/api/groups/${g.body.id}/members`, { userIds: [a.user.id] });
    expect(bad.status).toBe(400);
    expect((await a.c.get(`/api/groups/${g.body.id}`)).body.members).toHaveLength(0);
  });

  it('an announcement reaches the group’s active members only', async () => {
    const a = await admin(app);
    const one = await residentIn(app, '9A');
    const left = await residentIn(app, '9B');
    const outside = await residentIn(app, '9C');
    const id = await group(a.c, 'Committee', [one.resident.id, left.resident.id]);
    await prisma.user.update({ where: { id: left.resident.id }, data: { isActive: false } });

    const preview = await a.c.post('/api/announcements/audience-preview', { audience: { type: 'GROUP', groupId: id } });
    expect(preview.body.count).toBe(1);
    const res = await a.c.post('/api/announcements', { ...NOTICE, audience: { type: 'GROUP', groupId: id } });
    expect(res.body.recipients).toBe(1);
    expect(res.body.audience).toMatchObject({ type: 'GROUP', group: 'Committee' });
    expect((await one.c.get('/api/announcements')).body.items).toHaveLength(1);
    expect((await outside.c.get('/api/announcements')).body.items).toHaveLength(0);
  });

  it('an unknown or empty group is a clear error', async () => {
    const a = await admin(app);
    const missing = await a.c.post('/api/announcements', { ...NOTICE, audience: { type: 'GROUP', groupId: '00000000-0000-4000-8000-000000000000' } });
    expect(missing.body.error.fields.audience.code).toBe('GROUP_NOT_FOUND');
    const id = await group(a.c, 'Empty', []);
    const empty = await a.c.post('/api/announcements', { ...NOTICE, audience: { type: 'GROUP', groupId: id } });
    expect(empty.body.error.fields.audience.code).toBe('AUDIENCE_EMPTY');
  });

  it('deleting a group leaves what was sent to it as it was', async () => {
    const a = await admin(app);
    const r = await residentIn(app, '9A');
    const id = await group(a.c, 'Committee', [r.resident.id]);
    const sent = await a.c.post('/api/announcements', { ...NOTICE, audience: { type: 'GROUP', groupId: id } });
    expect((await a.c.delete(`/api/groups/${id}`)).status).toBe(204);
    expect((await r.c.get('/api/announcements')).body.items).toHaveLength(1);
    expect((await a.c.get(`/api/announcements/${sent.body.id}`)).body.audience.group).toBe('Committee');
    expect((await a.c.get(`/api/groups/${id}`)).status).toBe(404);
  });

  it('a scheduled announcement whose group is deleted goes to nobody, and does not get stuck', async () => {
    const a = await admin(app);
    const r = await residentIn(app, '9A');
    const id = await group(a.c, 'Committee', [r.resident.id]);
    const res = await a.c.post('/api/announcements', { ...NOTICE, audience: { type: 'GROUP', groupId: id }, publishAt: inHours(1) });
    await a.c.delete(`/api/groups/${id}`);
    expect(await publishDueAnnouncements(new Date(Date.now() + 2 * 3_600_000))).toBe(1);
    expect((await a.c.get(`/api/announcements/${res.body.id}`)).body).toMatchObject({ state: 'ACTIVE', recipients: 0 });
    expect(await publishDueAnnouncements(new Date(Date.now() + 2 * 3_600_000))).toBe(0);
  });

  it('the lookup for choosing members gives names and nothing else', async () => {
    const m = await loginAs(app, 'STAFF', ['announcements.manage']);
    await occupy('9A', { name: 'Rahim Uddin' });
    const res = await m.c.get('/api/groups/residents?q=rah');
    expect(res.body.items).toHaveLength(1);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['fullName', 'id']);
    expect((await m.c.get('/api/groups/residents')).body.items).toEqual([]);
  });
});

describe('FR-52 emergency contacts', () => {
  const FIRE = { name: 'Fire service', role: 'Fire', phone: '999', hours: 'Always' };
  const GUARD = { name: 'Guard desk', role: 'Security', phone: '01712345678', hours: '24 hours' };

  it('everyone logged in can read them, in the order saved', async () => {
    const a = await admin(app);
    await a.c.put('/api/emergency-contacts', { contacts: [FIRE, GUARD] });
    const r = await residentIn(app, '1A');
    expect((await r.c.get('/api/emergency-contacts')).body.items.map((c: { name: string }) => c.name)).toEqual(['Fire service', 'Guard desk']);
    expect((await (await caretaker(app)).c.get('/api/emergency-contacts')).status).toBe(200);
    expect((await (await client(app)).get('/api/emergency-contacts')).status).toBe(401);

    await a.c.put('/api/emergency-contacts', { contacts: [GUARD, FIRE] });
    expect((await r.c.get('/api/emergency-contacts')).body.items[0].name).toBe('Guard desk');
  });

  it('only people who manage announcements can change them, and bad numbers are refused', async () => {
    expect((await (await residentIn(app, '1A')).c.put('/api/emergency-contacts', { contacts: [FIRE] })).status).toBe(403);
    expect((await (await caretaker(app)).c.put('/api/emergency-contacts', { contacts: [FIRE] })).status).toBe(403);
    const m = await loginAs(app, 'STAFF', ['announcements.manage']);
    expect((await m.c.put('/api/emergency-contacts', { contacts: [FIRE] })).status).toBe(200);
    const bad = await m.c.put('/api/emergency-contacts', { contacts: [{ ...FIRE, phone: 'call me' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields['contacts.0.phone'].code).toBe('EMERGENCY_PHONE_INVALID');
    expect((await m.c.get('/api/emergency-contacts')).body.items).toHaveLength(1); // nothing was lost
    expect(await prisma.activityLog.count({ where: { action: 'emergency_contacts.update' } })).toBe(1);
  });
});

describe('FR-53 printable notice', () => {
  it('a real PDF for people who manage announcements, and nobody else', async () => {
    const a = await admin(app);
    const r = await residentIn(app, '1A');
    const n = await a.c.post('/api/announcements', NOTICE);
    const pdf = await a.c.get(`/api/announcements/${n.body.id}/notice.pdf`).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (x: Buffer) => parts.push(x));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await r.c.get(`/api/announcements/${n.body.id}/notice.pdf`)).status).toBe(403);
    expect((await a.c.get('/api/announcements/00000000-0000-4000-8000-000000000000/notice.pdf')).status).toBe(404);
  });

  it('shows the building, title, message and date, in black, with typed text made safe', () => {
    const html = noticeHtml({ title: 'গ্যাস <b>বন্ধ</b>', body: 'line one\nline two', publishedAt: new Date('2026-11-08T20:00:00Z') }, 'Demo & Tower', 'BN');
    expect(html).toContain('গ্যাস &lt;b&gt;বন্ধ&lt;/b&gt;');
    expect(html).toContain('Demo &amp; Tower');
    expect(html).toContain('line one\nline two');
    expect(html).toContain('09'); // 8 Nov 20:00 UTC is 9 Nov in Dhaka
    expect(html).toContain('lang="bn"');
    const colours = [...html.replace(/@font-face\{[^}]*\}/g, '').matchAll(/color:(#[0-9a-f]+)/gi)].map((m) => m[1]);
    expect(new Set(colours)).toEqual(new Set(['#000']));
  });
});

describe('FR-57 committee report', () => {
  async function building() {
    const a = await admin(app);
    const r = await occupy('1A');
    const bill = await makeBill(r.unit.id, MONTH, [['SERVICE', 500000]], { contactId: r.resident.id, createdById: a.user.id });
    await a.c.post(`/api/bills/${bill.id}/payments`, { amount: 200000, method: 'CASH', paidOn: TODAY });
    await a.c.post('/api/announcements', { title: 'Hello there', body: 'Hi', audience: { type: 'ALL' } });
    await a.c.post('/api/announcements', { title: 'Later on', body: 'Hi', audience: { type: 'ALL' }, publishAt: inHours(100) });
    await makeRequest(r.resident.id, r.unit.id, { status: 'SUBMITTED', dueAt: hoursAgo(1) });
    await prisma.expense.create({ data: { spentOn: dateOnly(TODAY), category: 'REPAIRS', amount: 50000, payee: 'Mistri', recordedById: a.user.id } });
    await makeUnit('1B');
    return a;
  }

  it('every figure is the same as in the matching report', async () => {
    await building();
    const data = await committeeData(MONTH);
    const finance = await financeReport(MONTH, MONTH);
    const dues = await duesReport();
    const money = await incomeExpenseReport(MONTH, MONTH);
    const maintenance = await maintenanceReport(MONTH, MONTH);

    expect(data.billing).toMatchObject({ billed: finance.billed, collected: finance.collected, outstanding: finance.outstanding, rate: finance.rate });
    expect(data.billing.billed).toBe(500000);
    expect(data.billing.rate).toBe(40);
    expect(data.building).toMatchObject({ totalUnits: 2, occupied: 1, vacant: 1 });
    expect(data.topDues).toEqual(dues.units);
    expect(data.money).toEqual(money);
    expect(data.money.net).toBe(150000);
    expect(data.maintenance).toEqual(maintenance);
    expect(data.maintenance.overdue).toBe(1);
    expect(data.announcements).toBe(1); // the one that has not gone out does not count
    expect(data.trend).toHaveLength(6);
  });

  it('lists at most 10 units, those owing the most', async () => {
    const a = await admin(app);
    for (let i = 1; i <= 12; i++) {
      const u = await makeUnit(`U${i}`);
      await makeBill(u.id, MONTH, [['SERVICE', i * 10000]], { createdById: a.user.id });
    }
    const { topDues } = await committeeData(MONTH);
    expect(topDues).toHaveLength(10);
    expect(topDues[0]!.unit.unitNumber).toBe('U12');
  });

  it('a month with nothing in it still works', async () => {
    await admin(app);
    const data = await committeeData(addMonths(MONTH, -30));
    expect(committeeHtml(data, 'Tower', 'EN')).toContain('Nothing billed');
    expect(committeeHtml(data, 'Tower', 'BN')).toContain('lang="bn"');
  });

  it('is written in the reader’s language, with typed names made safe', async () => {
    const a = await building();
    await prisma.user.updateMany({ where: { role: 'RESIDENT' }, data: { fullName: '<b>Rahim</b>' } });
    const data = await committeeData(MONTH);
    const html = committeeHtml(data, 'Tower', 'BN');
    expect(html).toContain('মাসিক কমিটি প্রতিবেদন');
    expect(html).toContain('&lt;b&gt;Rahim&lt;/b&gt;');
    expect(html).not.toContain('{{');
    expect(a.user.id).toBeTruthy();
  });

  it('a PDF for reports.view, and nobody else', async () => {
    const a = await admin(app);
    const res = await a.c.get(`/api/reports/committee.pdf?month=${MONTH}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect((await a.c.get('/api/reports/committee.pdf?month=2026-13')).status).toBe(400);
    expect((await (await loginAs(app, 'STAFF', ['reports.view'])).c.get(`/api/reports/committee.pdf?month=${MONTH}`)).status).toBe(200);
    expect((await (await caretaker(app)).c.get(`/api/reports/committee.pdf?month=${MONTH}`)).status).toBe(403);
    expect((await (await residentIn(app, '1A')).c.get(`/api/reports/committee.pdf?month=${MONTH}`)).status).toBe(403);
  });
});

describe('FR-38 CSV export', () => {
  it('opens correctly in a spreadsheet: byte order mark, Windows line ends, quoted cells', () => {
    const csv = toCsv(['Name', 'Note'], [['রহিম উদ্দিন', 'a, "b"\nc'], [null, 5]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('Name,Note\r\nরহিম উদ্দিন,"a, ""b""\nc"\r\n,5\r\n');
  });

  it.each(['=SUM(A1)', '+cmd', '-2+3', '@x', '\tx'])('typed text like %j cannot run as a formula', (v) => {
    expect(toCsv(['A'], [[v]]).split('\r\n')[1]!.replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('phone numbers and real negative amounts stay as they are', () => {
    expect(toCsv(['A', 'B'], [['+8801712345678', -125.5]]).split('\r\n')[1]).toBe('+8801712345678,-125.5');
  });

  it('money is in taka, so the column adds up', () => {
    expect(taka(1250050)).toBe(12500.5);
  });

  it('the collection and dues reports match what is on screen', async () => {
    const a = await admin(app);
    const r = await occupy('1A', { name: 'রহিম, উদ্দিন' });
    await makeBill(r.unit.id, MONTH, [['SERVICE', 300050]], { contactId: r.resident.id, createdById: a.user.id });

    const finance = await a.c.get(`/api/reports/finance.csv?from=${MONTH}&to=${MONTH}`);
    expect(finance.status).toBe(200);
    expect(finance.headers['content-type']).toContain('text/csv');
    expect(finance.headers['content-disposition']).toContain('.csv');
    expect(finance.text).toContain(`${MONTH},1,3000.5,0,3000.5,0`);

    const dues = await a.c.get('/api/reports/dues.csv');
    expect(dues.text).toContain(`1A,"রহিম, উদ্দিন",${r.resident.phone},3000.5,`);
  });

  it('headings follow the reader’s language', async () => {
    const a = await loginAs(app, 'ADMIN', [], { language: 'BN' });
    expect((await a.c.get('/api/reports/dues.csv')).text).toContain('ইউনিট');
  });

  it('the request list keeps its filters, and is for those who can see the list', async () => {
    const a = await admin(app);
    const r = await residentIn(app, '1A');
    await makeRequest(r.resident.id, r.unit.id, { title: 'Open tap', status: 'SUBMITTED' });
    await makeRequest(r.resident.id, r.unit.id, { title: 'Fixed door', status: 'CLOSED' });
    const res = await a.c.get('/api/requests/export.csv?status=CLOSED');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Fixed door');
    expect(res.text).not.toContain('Open tap');
    expect((await r.c.get('/api/requests/export.csv')).status).toBe(403);
    expect((await (await caretaker(app)).c.get('/api/requests/export.csv')).status).toBe(403);
  });

  it('reports are closed to people without reports.view', async () => {
    const staff = await caretaker(app);
    expect((await staff.c.get('/api/reports/dues.csv')).status).toBe(403);
    expect((await staff.c.get(`/api/reports/finance.csv?from=${MONTH}&to=${MONTH}`)).status).toBe(403);
  });
});

describe('demo mode', () => {
  it('the login shortcuts exist only when switched on, and never in production', () => {
    expect(demoAccountsFor({ DEMO_MODE: true, NODE_ENV: 'development' }).map((a) => a.role)).toEqual(['ADMIN', 'STAFF', 'RESIDENT']);
    expect(demoAccountsFor({ DEMO_MODE: false, NODE_ENV: 'development' })).toEqual([]);
    expect(demoAccountsFor({ DEMO_MODE: true, NODE_ENV: 'production' })).toEqual([]);
  });
});

describe('the dashboard', () => {
  it('shows everything still owed from before the system, whichever month is chosen', async () => {
    const a = await admin(app);
    const r = await occupy('1A');
    await a.c.post(`/api/units/${r.unit.id}/opening-balance`, { amount: 450000 });
    expect((await a.c.get(`/api/dashboard?month=${MONTH}`)).body.billing.openingBalances.outstanding).toBe(450000);
    expect((await a.c.get(`/api/dashboard?month=${addMonths(MONTH, -3)}`)).body.billing.openingBalances.outstanding).toBe(450000);
  });
});

describe('deleting records that requests point to', () => {
  it('a unit with requests cannot be deleted, so the requests never lose it silently', async () => {
    const r = await occupy('1A');
    await makeRequest(r.resident.id, r.unit.id);
    await prisma.occupancy.deleteMany();
    await expect(prisma.unit.delete({ where: { id: r.unit.id } })).rejects.toThrow();
  });
});
