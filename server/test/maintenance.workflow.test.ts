import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { autoCloseResolved } from '../src/modules/maintenance/requests.service';
import { client, loginAs, makeLoginUser, resetDb } from './helpers';
import { EXE, JPEG, PNG, addNoteReq, admin, caretaker, clearUploads, filesOnDisk, makeRequest, manager, residentIn, submit } from './maintenance.helpers';

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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type C = Awaited<ReturnType<typeof client>>;
const go = (c: C, id: string, to: string, note?: string) => c.post(`/api/requests/${id}/transition`, { to, ...(note !== undefined && { note }) });
const statusOf = async (id: string) => (await prisma.maintenanceRequest.findUniqueOrThrow({ where: { id } })).status;
const history = async (id: string) => prisma.requestUpdate.findMany({ where: { requestId: id }, orderBy: { seq: 'asc' } });

/** A resident, a request from them, a reviewer/assigner, and a caretaker. */
async function scene() {
  const r = await residentIn(app, '4B', { name: 'Rahim Uddin' });
  const req = (await submit(r.c)).body as { id: string; number: number; createdAt: string };
  const m = await manager(app);
  const w = await caretaker(app);
  return { r, req, m, w };
}

describe('FR-18 prioritise a request (BR-17)', () => {
  it('setting a priority starts the review and sets the deadline from the submission time', async () => {
    const { req, m } = await scene();
    const res = await m.c.patch(`/api/requests/${req.id}/priority`, { priority: 'HIGH' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ priority: 'HIGH', status: 'UNDER_REVIEW' });
    expect((new Date(res.body.dueAt).getTime() - new Date(res.body.createdAt).getTime()) / HOUR).toBeCloseTo(24, 2);
    const kinds = (await history(req.id)).map((u) => [u.kind, u.fromValue, u.toValue]);
    expect(kinds).toEqual([['STATUS_CHANGE', null, 'SUBMITTED'], ['PRIORITY_CHANGE', null, 'HIGH'], ['STATUS_CHANGE', 'SUBMITTED', 'UNDER_REVIEW']]);
  });

  it('each priority has its own deadline: high 1 day, medium 3 days, low 7 days', async () => {
    const { req, m } = await scene();
    for (const [priority, hours] of [['MEDIUM', 72], ['LOW', 168], ['HIGH', 24]] as const) {
      const res = await m.c.patch(`/api/requests/${req.id}/priority`, { priority });
      expect((new Date(res.body.dueAt).getTime() - new Date(res.body.createdAt).getTime()) / HOUR).toBeCloseTo(hours, 2);
    }
  });

  it('asking for the priority it already has changes nothing and adds nothing to the history', async () => {
    const { req, m } = await scene();
    await m.c.patch(`/api/requests/${req.id}/priority`, { priority: 'LOW' });
    const before = (await history(req.id)).length;
    expect((await m.c.patch(`/api/requests/${req.id}/priority`, { priority: 'LOW' })).status).toBe(200);
    expect((await history(req.id)).length).toBe(before);
  });

  it('the deadlines can be changed in the settings table', async () => {
    const { req, m } = await scene();
    await prisma.setting.create({ data: { key: 'slaHighHours', value: '6' } });
    const res = await m.c.patch(`/api/requests/${req.id}/priority`, { priority: 'HIGH' });
    expect((new Date(res.body.dueAt).getTime() - new Date(res.body.createdAt).getTime()) / HOUR).toBeCloseTo(6, 2);
  });

  it('a request whose deadline has passed shows as overdue, and a later priority can rescue or worsen that', async () => {
    const r = await residentIn(app, '4B');
    const old = await makeRequest(r.resident.id, r.unit.id, { createdAt: new Date(Date.now() - 2 * DAY), dueAt: new Date(Date.now() - 1 * DAY) });
    const m = await manager(app);
    expect((await m.c.get(`/api/requests/${old.id}`)).body.overdue).toBe(true);
    const low = await m.c.patch(`/api/requests/${old.id}/priority`, { priority: 'LOW' }); // 7 days from submission: not overdue after all
    expect(low.body.overdue).toBe(false);
    expect((await m.c.patch(`/api/requests/${old.id}/priority`, { priority: 'HIGH' })).body.overdue).toBe(true); // 1 day from 2 days ago
  });

  it('needs the review permission; finished requests cannot be reprioritised', async () => {
    const { req, r, w } = await scene();
    expect((await r.c.patch(`/api/requests/${req.id}/priority`, { priority: 'HIGH' })).status).toBe(403);
    expect((await w.c.patch(`/api/requests/${req.id}/priority`, { priority: 'HIGH' })).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['maintenance.assign', 'maintenance.view_all'])).c.patch(`/api/requests/${req.id}/priority`, { priority: 'HIGH' })).status).toBe(403);
    expect((await (await client(app)).patch(`/api/requests/${req.id}/priority`, { priority: 'HIGH' })).status).toBe(401);
    expect(await statusOf(req.id)).toBe('SUBMITTED');
    expect((await (await admin(app)).c.patch(`/api/requests/${req.id}/priority`, { priority: 'HIGH' })).status).toBe(200);
    await prisma.maintenanceRequest.update({ where: { id: req.id }, data: { status: 'CLOSED', closedAt: new Date() } });
    const m = await manager(app);
    const res = await m.c.patch(`/api/requests/${req.id}/priority`, { priority: 'LOW' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REQUEST_FINISHED');
  });

  it('rejects an unknown priority; 404 for an unknown request', async () => {
    const { req, m } = await scene();
    expect((await m.c.patch(`/api/requests/${req.id}/priority`, { priority: 'URGENT' })).status).toBe(400);
    expect((await m.c.patch(`/api/requests/${req.id}/priority`, {})).status).toBe(400);
    expect((await m.c.patch('/api/requests/00000000-0000-0000-0000-000000000000/priority', { priority: 'LOW' })).status).toBe(404);
    expect((await m.c.patch('/api/requests/nope/priority', { priority: 'LOW' })).status).toBe(404);
  });
});

describe('FR-19 assign a request', () => {
  it('assigns it to a staff member; it moves to Under review and shows in their tasks', async () => {
    const { req, m, w } = await scene();
    const res = await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'UNDER_REVIEW', assignedTo: { id: w.user.id } });
    expect((await w.c.get('/api/me/tasks')).body.items.map((t: { id: string }) => t.id)).toEqual([req.id]);
    expect((await history(req.id)).map((u) => u.kind)).toEqual(['STATUS_CHANGE', 'ASSIGNMENT', 'STATUS_CHANGE']);
  });

  it('keeps the assignment history, with who it moved from and to', async () => {
    const { req, m, w } = await scene();
    const other = await makeLoginUser('STAFF', [], { fullName: 'Selim Plumber' });
    await prisma.user.update({ where: { id: w.user.id }, data: { fullName: 'Karim Caretaker' } });
    await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    await m.c.post(`/api/requests/${req.id}/assign`, { staffId: other.id });
    const moves = (await history(req.id)).filter((u) => u.kind === 'ASSIGNMENT').map((u) => [u.fromValue, u.toValue]);
    expect(moves).toEqual([[null, 'Karim Caretaker'], ['Karim Caretaker', 'Selim Plumber']]);
    expect((await w.c.get('/api/me/tasks')).body.items).toEqual([]); // no longer theirs
  });

  it('assigning the same person again changes nothing', async () => {
    const { req, m, w } = await scene();
    await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    const before = (await history(req.id)).length;
    expect((await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id })).status).toBe(200);
    expect((await history(req.id)).length).toBe(before);
  });

  it('only active staff members can be assigned, not residents, admins, or deactivated staff', async () => {
    const { req, m, r } = await scene();
    const gone = await makeLoginUser('STAFF', [], { isActive: false });
    const boss = await makeLoginUser('ADMIN');
    for (const id of [r.resident.id, boss.id, gone.id, '00000000-0000-0000-0000-000000000000']) {
      const res = await m.c.post(`/api/requests/${req.id}/assign`, { staffId: id });
      expect(res.status).toBe(400);
      expect(res.body.error.fields.staffId.code).toBe('STAFF_NOT_FOUND');
    }
    expect((await m.c.post(`/api/requests/${req.id}/assign`, { staffId: 'nope' })).status).toBe(400);
    expect((await prisma.maintenanceRequest.findUniqueOrThrow({ where: { id: req.id } })).assignedToId).toBeNull();
  });

  it('lists only active staff as people to assign to', async () => {
    const { m, w } = await scene();
    const gone = await makeLoginUser('STAFF', [], { isActive: false });
    const ids = (await m.c.get('/api/requests/assignees')).body.items.map((s: { id: string }) => s.id);
    expect(ids).toContain(w.user.id);
    expect(ids).toContain(m.user.id);
    expect(ids).not.toContain(gone.id);
  });

  it('needs the assign permission (reviewing alone is not enough)', async () => {
    const { req, r, w } = await scene();
    const reviewer = await loginAs(app, 'STAFF', ['maintenance.review', 'maintenance.view_all']);
    for (const c of [r.c, w.c, reviewer.c]) {
      expect((await c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id })).status).toBe(403);
      expect((await c.get('/api/requests/assignees')).status).toBe(403);
    }
    expect((await (await admin(app)).c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id })).status).toBe(200);
  });

  it('a finished request cannot be assigned', async () => {
    const { req, m, w } = await scene();
    await prisma.maintenanceRequest.update({ where: { id: req.id }, data: { status: 'REJECTED' } });
    expect((await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id })).status).toBe(409);
  });
});

describe('BR-16 status changes (Appendix A)', () => {
  it('the whole journey: review, assign, start, resolve, and the resident confirms', async () => {
    const { r, req, m, w } = await scene();
    expect((await go(m.c, req.id, 'UNDER_REVIEW')).body.status).toBe('UNDER_REVIEW');
    await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    expect((await go(w.c, req.id, 'IN_PROGRESS')).body.status).toBe('IN_PROGRESS');
    const resolved = await go(w.c, req.id, 'RESOLVED', 'Replaced the washer');
    expect(resolved.body).toMatchObject({ status: 'RESOLVED', overdue: false });
    expect(resolved.body.resolvedAt).toBeTruthy();
    const closed = await go(r.c, req.id, 'CLOSED');
    expect(closed.body).toMatchObject({ status: 'CLOSED' });
    expect(closed.body.closedAt).toBeTruthy();

    // every step is in the history with who did it
    const steps = closed.body.updates.filter((u: { kind: string }) => u.kind === 'STATUS_CHANGE').map((u: { toValue: string; author: string }) => [u.toValue, u.author]);
    expect(steps).toEqual([['SUBMITTED', 'Rahim Uddin'], ['UNDER_REVIEW', m.user.fullName], ['UNDER_REVIEW', m.user.fullName], ['IN_PROGRESS', w.user.fullName], ['RESOLVED', w.user.fullName], ['CLOSED', 'Rahim Uddin']].filter((_, i) => i !== 2));
  });

  it('the resident sees the staff member’s name, and the note, but not internal ones', async () => {
    const { r, req, m, w } = await scene();
    await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    await go(w.c, req.id, 'IN_PROGRESS');
    await go(w.c, req.id, 'RESOLVED', 'Replaced the washer');
    const view = (await r.c.get(`/api/requests/${req.id}`)).body;
    expect(view.assignedTo.fullName).toBe(w.user.fullName);
    expect(view.updates.find((u: { toValue: string }) => u.toValue === 'RESOLVED').note).toBe('Replaced the washer');
  });

  it('only the listed moves exist: everything else is refused and changes nothing', async () => {
    const allowed: Record<string, string[]> = {
      SUBMITTED: ['UNDER_REVIEW', 'CANCELLED', 'REJECTED'],
      UNDER_REVIEW: ['IN_PROGRESS', 'REJECTED'],
      IN_PROGRESS: ['RESOLVED'],
      RESOLVED: ['CLOSED', 'IN_PROGRESS'],
      CLOSED: [],
      REJECTED: [],
      CANCELLED: [],
    };
    const statuses = Object.keys(allowed);
    const r = await residentIn(app, '4B');
    const boss = await admin(app);
    for (const from of statuses) {
      for (const to of statuses) {
        if (allowed[from]!.includes(to)) continue;
        const req = await makeRequest(r.resident.id, r.unit.id, { status: from });
        const res = await go(boss.c, req.id, to, 'a reason');
        expect(res.status, `${from} -> ${to}`).toBe(409);
        expect(res.body.error.code).toBe('INVALID_TRANSITION');
        expect(await statusOf(req.id), `${from} -> ${to}`).toBe(from);
      }
    }
  });

  it('finished requests are final', async () => {
    const r = await residentIn(app, '4B');
    const boss = await admin(app);
    for (const status of ['CLOSED', 'REJECTED', 'CANCELLED']) {
      const req = await makeRequest(r.resident.id, r.unit.id, { status });
      for (const c of [boss.c, r.c]) expect((await go(c, req.id, 'IN_PROGRESS', 'again')).status).toBe(409);
    }
  });

  it('review and reject belong to reviewers (and the administrator)', async () => {
    const { r, req, w } = await scene();
    const assigner = await loginAs(app, 'STAFF', ['maintenance.assign', 'maintenance.view_all']);
    for (const c of [r.c, w.c, assigner.c]) {
      expect((await go(c, req.id, 'UNDER_REVIEW')).status).toBe(r.c === c ? 403 : 403);
      expect((await go(c, req.id, 'REJECTED', 'not our job')).status).toBe(403);
    }
    expect(await statusOf(req.id)).toBe('SUBMITTED');
    const reviewer = await loginAs(app, 'STAFF', ['maintenance.review']);
    expect((await go(reviewer.c, req.id, 'UNDER_REVIEW')).status).toBe(200);
  });

  it('starting and resolving work belong to the assigned person (and the administrator), not to other staff', async () => {
    const { req, m, w } = await scene();
    await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    const stranger = await loginAs(app, 'STAFF', ['maintenance.view_all', 'maintenance.review']); // sees everything, but it is not theirs to do
    expect((await go(stranger.c, req.id, 'IN_PROGRESS')).status).toBe(403);
    expect((await go(m.c, req.id, 'IN_PROGRESS')).status).toBe(403); // the manager reviews and assigns, but does not do the work
    expect(await statusOf(req.id)).toBe('UNDER_REVIEW');
    expect((await go(w.c, req.id, 'IN_PROGRESS')).status).toBe(200);
    expect((await go(stranger.c, req.id, 'RESOLVED', 'done')).status).toBe(403);
    expect((await go((await admin(app)).c, req.id, 'RESOLVED', 'Fixed by the administrator')).status).toBe(200);
  });

  it('cancelling, confirming and reopening belong to the resident’s household, never to staff or the administrator', async () => {
    const { r, req, m, w } = await scene();
    for (const c of [m.c, w.c, (await admin(app)).c]) expect((await go(c, req.id, 'CANCELLED')).status).toBe(403);
    expect(await statusOf(req.id)).toBe('SUBMITTED');
    expect((await go(r.c, req.id, 'CANCELLED')).body.status).toBe('CANCELLED');

    const resolved = await makeRequest(r.resident.id, r.unit.id, { status: 'RESOLVED' });
    for (const c of [m.c, w.c, (await admin(app)).c]) {
      expect((await go(c, resolved.id, 'CLOSED')).status).toBe(403);
      expect((await go(c, resolved.id, 'IN_PROGRESS', 'not really fixed')).status).toBe(403);
    }
    expect(await statusOf(resolved.id)).toBe('RESOLVED');
  });

  it('another resident cannot cancel, confirm or reopen', async () => {
    const { req } = await scene();
    const stranger = await residentIn(app, '9Z', { name: 'Stranger' });
    const res = await go(stranger.c, req.id, 'CANCELLED');
    expect(res.status).toBe(404);
    expect(await statusOf(req.id)).toBe('SUBMITTED');
  });

  it('FR-35: the resident can cancel only while it is still Submitted', async () => {
    const { r, req, m } = await scene();
    await go(m.c, req.id, 'UNDER_REVIEW');
    const res = await go(r.c, req.id, 'CANCELLED');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('resolving, rejecting and reopening each need a note; other moves do not', async () => {
    const { r, req, m, w } = await scene();
    for (const note of [undefined, '', '   ']) {
      const res = await go(m.c, req.id, 'REJECTED', note);
      expect(res.status, JSON.stringify(note)).toBe(400);
      expect(res.body.error.fields.note.code).toBe('NOTE_REQUIRED');
    }
    expect(await statusOf(req.id)).toBe('SUBMITTED');
    await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    expect((await go(w.c, req.id, 'IN_PROGRESS')).status).toBe(200); // no note needed to start
    expect((await go(w.c, req.id, 'RESOLVED')).body.error.fields.note.code).toBe('NOTE_REQUIRED');
    expect((await go(w.c, req.id, 'RESOLVED', 'Fixed')).status).toBe(200);
    expect((await go(r.c, req.id, 'IN_PROGRESS')).body.error.fields.note.code).toBe('NOTE_REQUIRED'); // reopening
    expect((await go(r.c, req.id, 'IN_PROGRESS', 'Still dripping')).status).toBe(200);
  });

  it('a rejection carries its reason, which the resident can read', async () => {
    const { r, req, m } = await scene();
    const res = await go(m.c, req.id, 'REJECTED', 'This is the landlord’s responsibility, not the building’s');
    expect(res.body.status).toBe('REJECTED');
    const view = (await r.c.get(`/api/requests/${req.id}`)).body;
    expect(view.updates.at(-1)).toMatchObject({ toValue: 'REJECTED', note: 'This is the landlord’s responsibility, not the building’s' });
  });

  it('FR-35 / BR-18: the resident can reopen within 7 days, and it goes back to In progress', async () => {
    const { r, req, m, w } = await scene();
    await m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id });
    await go(w.c, req.id, 'IN_PROGRESS');
    await go(w.c, req.id, 'RESOLVED', 'Fixed');
    await prisma.maintenanceRequest.update({ where: { id: req.id }, data: { resolvedAt: new Date(Date.now() - 6 * DAY) } });
    const res = await go(r.c, req.id, 'IN_PROGRESS', 'It started leaking again');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null });
    expect(res.body.assignedTo.id).toBe(w.user.id); // the same person picks it up again
    await go(w.c, req.id, 'RESOLVED', 'Fixed properly this time'); // and it can be resolved again
    expect(await statusOf(req.id)).toBe('RESOLVED');
  });

  it('BR-18: after 7 days it can no longer be reopened', async () => {
    const r = await residentIn(app, '4B');
    const req = await makeRequest(r.resident.id, r.unit.id, { status: 'RESOLVED', resolvedAt: new Date(Date.now() - 8 * DAY) });
    const res = await go(r.c, req.id, 'IN_PROGRESS', 'Still broken');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REOPEN_WINDOW_PASSED');
    expect(await statusOf(req.id)).toBe('RESOLVED');
    expect((await go(r.c, req.id, 'CLOSED')).status).toBe(200); // confirming is still fine
  });

  it('the history only grows: every step is kept, in order, with author and time', async () => {
    const { r, req, m, w } = await scene();
    const sizes: number[] = [];
    for (const step of [
      () => go(m.c, req.id, 'UNDER_REVIEW'),
      () => m.c.patch(`/api/requests/${req.id}/priority`, { priority: 'HIGH' }),
      () => m.c.post(`/api/requests/${req.id}/assign`, { staffId: w.user.id }),
      () => go(w.c, req.id, 'IN_PROGRESS'),
      () => addNoteReq(w.c, req.id, { note: 'Ordered a part', isInternal: 'false' }),
      () => go(w.c, req.id, 'RESOLVED', 'Fixed'),
      () => go(r.c, req.id, 'CLOSED'),
    ]) {
      expect((await step()).status).toBeLessThan(300);
      sizes.push((await history(req.id)).length);
    }
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(sizes.length); // each step added at least one row
    const rows = await history(req.id);
    expect(rows.every((u) => u.createdAt instanceof Date && (u.authorId === null || typeof u.authorId === 'string'))).toBe(true);
    const times = rows.map((u) => u.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('NFR-14: two people acting at the same moment cannot both win', async () => {
    const { r, req, m } = await scene();
    const [cancel, review] = await Promise.all([go(r.c, req.id, 'CANCELLED'), go(m.c, req.id, 'UNDER_REVIEW')]);
    const codes = [cancel.status, review.status].sort();
    expect(codes).toEqual([200, 409]);
    expect(['CANCELLED', 'UNDER_REVIEW']).toContain(await statusOf(req.id));
    const changes = (await history(req.id)).filter((u) => u.kind === 'STATUS_CHANGE' && u.toValue !== 'SUBMITTED');
    expect(changes).toHaveLength(1);
  });

  it('404 for an unknown request; 400 for an unknown status', async () => {
    const { req, m } = await scene();
    expect((await go(m.c, '00000000-0000-0000-0000-000000000000', 'UNDER_REVIEW')).status).toBe(404);
    expect((await go(m.c, 'nope', 'UNDER_REVIEW')).status).toBe(404);
    expect((await go(m.c, req.id, 'EXPLODED')).status).toBe(400);
  });
});

describe('FR-20 progress notes', () => {
  async function working() {
    const s = await scene();
    await s.m.c.post(`/api/requests/${s.req.id}/assign`, { staffId: s.w.user.id });
    await go(s.w.c, s.req.id, 'IN_PROGRESS');
    return s;
  }

  it('the assigned person adds notes with the date and their name, and the resident reads them', async () => {
    const { r, req, w } = await working();
    const res = await addNoteReq(w.c, req.id, { note: 'Ordered the spare part', isInternal: 'false' });
    expect(res.status).toBe(201);
    const mine = res.body.updates.at(-1);
    expect(mine).toMatchObject({ kind: 'NOTE', note: 'Ordered the spare part', author: w.user.fullName, isInternal: false });
    expect(new Date(mine.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await r.c.get(`/api/requests/${req.id}`)).body.updates.map((u: { note: string | null }) => u.note)).toContain('Ordered the spare part');
  });

  it('internal notes are for staff only', async () => {
    const { r, req, w, m } = await working();
    await addNoteReq(w.c, req.id, { note: 'Tenant has a dog, call first', isInternal: 'true' });
    const resident = JSON.stringify((await r.c.get(`/api/requests/${req.id}`)).body);
    expect(resident).not.toContain('Tenant has a dog');
    expect(JSON.stringify((await m.c.get(`/api/requests/${req.id}`)).body)).toContain('Tenant has a dog');
    expect(JSON.stringify((await w.c.get(`/api/requests/${req.id}`)).body)).toContain('Tenant has a dog');
  });

  it('a note can carry up to three real photos, checked like any other', async () => {
    const { r, req, w } = await working();
    const png = { name: 'part.png', data: PNG, type: 'image/png' };
    const ok = await addNoteReq(w.c, req.id, { note: 'The old part', isInternal: 'false' }, [png, { name: 'b.jpg', data: JPEG, type: 'image/jpeg' }]);
    expect(ok.status).toBe(201);
    expect(ok.body.updates.at(-1).photos.map((p: { name: string }) => p.name)).toEqual(['part.png', 'b.jpg']);
    expect((await r.c.get(`/api/requests/${req.id}`)).body.updates.at(-1).photos).toHaveLength(2);

    const before = filesOnDisk().length;
    const bad = await addNoteReq(w.c, req.id, { note: 'x', isInternal: 'false' }, [png, { name: 'virus.png', data: EXE, type: 'image/png' }]);
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.photos.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const four = await addNoteReq(w.c, req.id, { note: 'x', isInternal: 'false' }, [png, png, png, png]);
    expect(four.body.error.fields.photos.code).toBe('TOO_MANY_FILES');
    expect(filesOnDisk()).toHaveLength(before); // refused notes leave nothing behind
  });

  it('who may write notes: assigned staff, reviewers and the administrator; not other staff, and not residents', async () => {
    const { r, req, m, w } = await working();
    const body = { note: 'A note', isInternal: 'false' };
    const viewer = await loginAs(app, 'STAFF', ['maintenance.view_all']);
    const otherWorker = await caretaker(app);
    expect((await addNoteReq(r.c, req.id, body)).status).toBe(403);
    expect((await addNoteReq(viewer.c, req.id, body)).status).toBe(403);
    expect((await addNoteReq(otherWorker.c, req.id, body)).status).toBe(403);
    expect((await addNoteReq(await client(app), req.id, body)).status).toBe(401);
    for (const c of [w.c, m.c, (await admin(app)).c]) expect((await addNoteReq(c, req.id, body)).status).toBe(201);
  });

  it('needs some text; a note on a finished request is refused', async () => {
    const { req, w } = await working();
    for (const note of ['', '   ']) expect((await addNoteReq(w.c, req.id, { note, isInternal: 'false' })).status).toBe(400);
    expect((await addNoteReq(w.c, req.id, { note: 'x'.repeat(1001), isInternal: 'false' })).status).toBe(400);
    await prisma.maintenanceRequest.update({ where: { id: req.id }, data: { status: 'CLOSED', closedAt: new Date() } });
    const res = await addNoteReq(w.c, req.id, { note: 'Too late', isInternal: 'false' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REQUEST_FINISHED');
  });

  it('a note on a resolved request is still allowed (the resident may be told something)', async () => {
    const { req, w } = await working();
    await go(w.c, req.id, 'RESOLVED', 'Fixed');
    expect((await addNoteReq(w.c, req.id, { note: 'Please run the tap for a minute', isInternal: 'false' })).status).toBe(201);
  });
});

describe('BR-18 automatic close', () => {
  async function resolvedAgo(days: number) {
    const r = await residentIn(app, `${Math.floor(Math.random() * 90) + 10}Z`);
    return makeRequest(r.resident.id, r.unit.id, { status: 'RESOLVED', resolvedAt: new Date(Date.now() - days * DAY) });
  }

  it('closes requests that were resolved more than 7 days ago, recording that the system did it', async () => {
    const old = await resolvedAgo(8);
    expect(await autoCloseResolved()).toBe(1);
    const row = await prisma.maintenanceRequest.findUniqueOrThrow({ where: { id: old.id } });
    expect(row.status).toBe('CLOSED');
    expect(row.closedAt).toBeInstanceOf(Date);
    const last = (await history(old.id)).at(-1)!;
    expect(last).toMatchObject({ kind: 'STATUS_CHANGE', fromValue: 'RESOLVED', toValue: 'CLOSED', authorId: null });
  });

  it('leaves recent resolutions, and every other status, alone', async () => {
    const recent = await resolvedAgo(6);
    const r = await residentIn(app, '8Y');
    const others = await Promise.all(['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS', 'REJECTED', 'CANCELLED'].map((status) => makeRequest(r.resident.id, r.unit.id, { status })));
    expect(await autoCloseResolved()).toBe(0);
    expect(await statusOf(recent.id)).toBe('RESOLVED');
    for (const o of others) expect(await statusOf(o.id)).toBe(o.status);
  });

  it('is safe to run again: nothing happens the second time', async () => {
    await resolvedAgo(9);
    await resolvedAgo(10);
    expect(await autoCloseResolved()).toBe(2);
    expect(await autoCloseResolved()).toBe(0);
    expect(await prisma.requestUpdate.count({ where: { toValue: 'CLOSED', authorId: null } })).toBe(2);
  });

  it('uses the waiting period from the settings table', async () => {
    const req = await resolvedAgo(3);
    expect(await autoCloseResolved()).toBe(0);
    await prisma.setting.create({ data: { key: 'autoCloseDays', value: '2' } });
    expect(await autoCloseResolved()).toBe(1);
    expect(await statusOf(req.id)).toBe('CLOSED');
  });

  it('the resident can no longer confirm or reopen once it is closed', async () => {
    const req = await resolvedAgo(8);
    const owner = await prisma.maintenanceRequest.findUniqueOrThrow({ where: { id: req.id }, include: { submittedBy: true } });
    await autoCloseResolved();
    const c = await client(app);
    await c.login(owner.submittedBy!.loginId); // this request was submitted by a resident
    expect((await go(c, req.id, 'CLOSED')).status).toBe(409);
    expect((await go(c, req.id, 'IN_PROGRESS', 'Broken again')).status).toBe(409);
  });
});
