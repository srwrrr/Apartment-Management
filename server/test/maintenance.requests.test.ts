import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { client, d, loginAs, makeLoginUser, makeUnit, occupy, resetDb } from './helpers';
import { EXE, GIF, JPEG, PNG, SCRIPT, WEBP, addNoteReq, asResident, caretaker, clearUploads, filesOnDisk, makeRequest, manager, residentIn, submit, uploadPath } from './maintenance.helpers';

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

describe('FR-16 / FR-17 submit a maintenance request', () => {
  it('creates a request in status Submitted, filling in the resident and unit by itself', async () => {
    const r = await residentIn(app, '4B', { name: 'Rahim Uddin' });
    const res = await submit(r.c, { title: 'Kitchen tap is leaking' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      number: expect.any(Number),
      title: 'Kitchen tap is leaking',
      status: 'SUBMITTED',
      priority: null,
      category: 'PLUMBING',
      location: 'UNIT',
      unit: { unitNumber: '4B' },
      submittedBy: { id: r.resident.id, fullName: 'Rahim Uddin' },
      assignedTo: null,
      overdue: false,
    });
    expect(res.body.updates).toEqual([expect.objectContaining({ kind: 'STATUS_CHANGE', toValue: 'SUBMITTED', author: 'Rahim Uddin' })]);
    const mine = await r.c.get('/api/me/requests');
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ status: 'SUBMITTED', unit: { unitNumber: '4B' } });
  });

  it('BR-17: it has to be reviewed within 2 days', async () => {
    const r = await residentIn(app, '4B');
    const res = await submit(r.c);
    const hours = (new Date(res.body.dueAt).getTime() - new Date(res.body.createdAt).getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(48, 1);
  });

  it('request numbers keep increasing', async () => {
    const r = await residentIn(app, '4B');
    const a = await submit(r.c);
    const b = await submit(r.c);
    expect(b.body.number).toBeGreaterThan(a.body.number);
  });

  it('the resident cannot choose who it is from, or set its status, priority or assignee', async () => {
    const r = await residentIn(app, '4B');
    const other = await occupy('9Z', { name: 'Someone Else' });
    const caretakerUser = await makeLoginUser('STAFF');
    const res = await submit(r.c, { submittedById: other.resident.id, status: 'RESOLVED', priority: 'HIGH', assignedToId: caretakerUser.id, unitId: '' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'SUBMITTED', priority: null, assignedTo: null, submittedBy: { id: r.resident.id } });
  });

  it('shows which fields to fix, and saves nothing', async () => {
    const r = await residentIn(app, '4B');
    for (const [fields, field] of [
      [{ title: '' }, 'title'],
      [{ title: 'Hi' }, 'title'],
      [{ title: 'x'.repeat(121) }, 'title'],
      [{ description: 'too short' }, 'description'],
      [{ description: 'y'.repeat(2001) }, 'description'],
      [{ category: 'MAGIC' }, 'category'],
      [{ category: '' }, 'category'],
      [{ location: 'ROOF' }, 'location'],
    ] as const) {
      const res = await submit(r.c, fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.error.fields)).toContain(field);
    }
    expect(await prisma.maintenanceRequest.count()).toBe(0);
  });

  it('every category and both locations are accepted', async () => {
    const r = await residentIn(app, '4B');
    for (const category of ['PLUMBING', 'ELECTRICAL', 'LIFT', 'GENERATOR', 'WATER_SUPPLY', 'GAS', 'CLEANING', 'SECURITY', 'COMMON_AREA', 'OTHER']) {
      expect((await submit(r.c, { category })).status, category).toBe(201);
    }
    expect((await submit(r.c, { location: 'COMMON_AREA' })).body.location).toBe('COMMON_AREA');
  });

  it('only residents can submit', async () => {
    expect((await submit(await client(app))).status).toBe(401);
    expect((await submit((await caretaker(app)).c)).status).toBe(403);
    expect((await submit((await manager(app)).c)).status).toBe(403);
    expect((await submit((await loginAs(app, 'ADMIN')).c)).status).toBe(403);
    expect(await prisma.maintenanceRequest.count()).toBe(0);
  });

  it('FR-17: with one unit it is chosen automatically; with none the resident is told', async () => {
    const homeless = await loginAs(app, 'RESIDENT');
    const res = await submit(homeless.c);
    expect(res.status).toBe(400);
    expect(res.body.error.fields.unitId.code).toBe('NO_ACTIVE_UNIT');
    // a stay that has ended does not count
    const gone = await occupy('1A', { start: '2020-01-01', end: '2021-12-31' });
    const c = await asResident(app, gone.resident);
    expect((await submit(c)).body.error.fields.unitId.code).toBe('NO_ACTIVE_UNIT');
  });

  it('FR-17: with two units the resident must say which, and only their own units are allowed', async () => {
    const a = await occupy('2A', { name: 'Owner of two' });
    const secondUnit = await makeUnit('2B', 2);
    await prisma.occupancy.create({ data: { unitId: secondUnit.id, residentId: a.resident.id, type: 'OWNER', startDate: d('2020-01-01'), isBillingContact: true } });
    const stranger = await occupy('3C');
    const c = await asResident(app, a.resident);

    const unspecified = await submit(c);
    expect(unspecified.status).toBe(400);
    expect(unspecified.body.error.fields.unitId.code).toBe('UNIT_REQUIRED');
    expect((await submit(c, { unitId: stranger.unit.id })).body.error.fields.unitId.code).toBe('INVALID_UNIT'); // not theirs
    expect((await submit(c, { unitId: 'not-a-uuid' })).status).toBe(400);
    const chosen = await submit(c, { unitId: secondUnit.id });
    expect(chosen.status).toBe(201);
    expect(chosen.body.unit.unitNumber).toBe('2B');
  });

  it('BR-27: a household member can report a problem for the household’s unit', async () => {
    const head = await occupy('5A', { name: 'Head of house' });
    const member = await makeLoginUser('RESIDENT', [], { fullName: 'Spouse' });
    await prisma.householdMember.create({ data: { occupancyId: head.occupancy.id, userId: member.id, relation: 'Spouse', addedAt: d('2020-06-01') } });
    const res = await submit(await asResident(app, member));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ unit: { unitNumber: '5A' }, submittedBy: { id: member.id } });
  });
});

describe('BR-19 photos', () => {
  const png = (n = 'tap.png') => ({ name: n, data: PNG, type: 'image/png' });

  it('accepts up to three real JPG, PNG and WEBP photos, stored under random names', async () => {
    const r = await residentIn(app, '4B');
    const res = await submit(r.c, {}, [png('a.png'), { name: 'b.jpg', data: JPEG, type: 'image/jpeg' }, { name: 'c.webp', data: WEBP, type: 'image/webp' }]);
    expect(res.status).toBe(201);
    expect(res.body.photos.map((p: { name: string }) => p.name)).toEqual(['a.png', 'b.jpg', 'c.webp']);
    const rows = await prisma.attachment.findMany({ orderBy: { originalName: 'asc' } });
    expect(rows.map((a) => a.mimeType)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(rows.every((a) => /^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(a.storedName))).toBe(true);
    expect(filesOnDisk()).toHaveLength(3);
    expect(fs.readFileSync(uploadPath(rows[0]!.storedName)).equals(PNG)).toBe(true); // a.png was saved byte for byte
  });

  it('a request needs no photo at all', async () => {
    const r = await residentIn(app, '4B');
    expect((await submit(r.c)).body.photos).toEqual([]);
    expect(filesOnDisk()).toHaveLength(0);
  });

  it('refuses a fourth photo, and saves nothing', async () => {
    const r = await residentIn(app, '4B');
    const res = await submit(r.c, {}, [png('1.png'), png('2.png'), png('3.png'), png('4.png')]);
    expect(res.status).toBe(400);
    expect(res.body.error.fields.photos.code).toBe('TOO_MANY_FILES');
    expect(await prisma.maintenanceRequest.count()).toBe(0);
    expect(filesOnDisk()).toHaveLength(0);
  });

  it('refuses a photo over 5 MB', async () => {
    const r = await residentIn(app, '4B');
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await submit(r.c, {}, [{ name: 'big.png', data: big, type: 'image/png' }]);
    expect(res.status).toBe(400);
    expect(res.body.error.fields.photos.code).toBe('FILE_TOO_LARGE');
    expect(await prisma.maintenanceRequest.count()).toBe(0);
    expect(filesOnDisk()).toHaveLength(0);
  });

  it('NFR-06: judges a file by what it is, not what it is called', async () => {
    const r = await residentIn(app, '4B');
    for (const bad of [
      { name: 'holiday.png', data: EXE, type: 'image/png' }, // a program with a picture name
      { name: 'notes.jpg', data: SCRIPT, type: 'image/jpeg' }, // a script
      { name: 'empty.png', data: Buffer.alloc(0), type: 'image/png' },
      { name: 'cat.gif', data: GIF, type: 'image/gif' }, // a real picture, but not an allowed kind
      { name: 'doc.pdf', data: Buffer.from('%PDF-1.4 hello'), type: 'application/pdf' },
    ]) {
      const res = await submit(r.c, {}, [bad]);
      expect(res.status, bad.name).toBe(400);
      expect(res.body.error.fields.photos.code, bad.name).toBe('FILE_TYPE_NOT_ALLOWED');
    }
    expect(await prisma.maintenanceRequest.count()).toBe(0);
    expect(filesOnDisk()).toHaveLength(0);
  });

  it('accepts a real photo even if its name or declared type is wrong', async () => {
    const r = await residentIn(app, '4B');
    const res = await submit(r.c, {}, [{ name: 'photo.txt', data: PNG, type: 'text/plain' }]);
    expect(res.status).toBe(201);
    expect((await prisma.attachment.findFirstOrThrow()).mimeType).toBe('image/png'); // the real type is what is stored
  });

  it('one bad photo among good ones means none are saved', async () => {
    const r = await residentIn(app, '4B');
    const res = await submit(r.c, {}, [png('good1.png'), { name: 'bad.png', data: EXE, type: 'image/png' }, png('good2.png')]);
    expect(res.status).toBe(400);
    expect(filesOnDisk()).toHaveLength(0);
    expect(await prisma.attachment.count()).toBe(0);
    expect(await prisma.maintenanceRequest.count()).toBe(0);
  });

  it('keeps only a plain display name, so a path in the name cannot reach the disk', async () => {
    const r = await residentIn(app, '4B');
    const res = await submit(r.c, {}, [png('../../../evil.png'), png('C:\\Windows\\win.png')]);
    expect(res.status).toBe(201);
    expect(res.body.photos.map((p: { name: string }) => p.name)).toEqual(['evil.png', 'win.png']);
    for (const a of await prisma.attachment.findMany()) expect(a.storedName).not.toMatch(/[\\/]/);
    expect(filesOnDisk()).toHaveLength(2);
  });

  it('a request that fails validation leaves no photos behind', async () => {
    const r = await residentIn(app, '4B');
    const res = await submit(r.c, { title: '' }, [png()]);
    expect(res.status).toBe(400);
    expect(filesOnDisk()).toHaveLength(0);
  });
});

describe('FR-21 / NFR-16 / NFR-24 who can see a request', () => {
  async function neighbours() {
    const a = await residentIn(app, '1A', { name: 'Alice' });
    const b = await residentIn(app, '1B', { name: 'Bob' });
    const ra = (await submit(a.c, { title: 'Alice has a leak' }, [{ name: 'a.png', data: PNG, type: 'image/png' }])).body;
    const rb = (await submit(b.c, { title: 'Bob has a broken light' }, [{ name: 'b.png', data: PNG, type: 'image/png' }])).body;
    return { a, b, ra, rb };
  }

  it('a resident’s list has only their own requests', async () => {
    const n = await neighbours();
    const mine = (await n.a.c.get('/api/me/requests')).body.items;
    expect(mine.map((x: { id: string }) => x.id)).toEqual([n.ra.id]);
    expect(JSON.stringify(mine)).not.toMatch(/Bob/);
  });

  it('a neighbour’s request is "not found", the same as one that does not exist', async () => {
    const n = await neighbours();
    const res = await n.a.c.get(`/api/requests/${n.rb.id}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND' } });
    expect((await n.a.c.get('/api/requests/00000000-0000-0000-0000-000000000000')).body).toEqual(res.body);
    expect((await n.a.c.get('/api/requests/not-a-uuid')).status).toBe(404);
    expect((await n.a.c.get(`/api/requests/${n.ra.id}`)).status).toBe(200);
  });

  it('a neighbour cannot do anything to another resident’s request either', async () => {
    const n = await neighbours();
    for (const to of ['CANCELLED']) expect((await n.a.c.post(`/api/requests/${n.rb.id}/transition`, { to })).status).toBe(404);
    expect((await addNoteReq(n.a.c, n.rb.id, { note: 'hello', isInternal: 'false' })).status).toBe(404);
    expect((await prisma.maintenanceRequest.findUniqueOrThrow({ where: { id: n.rb.id } })).status).toBe('SUBMITTED');
  });

  it('residents cannot use the staff list, assignee list, priority or assign actions', async () => {
    const n = await neighbours();
    expect((await n.a.c.get('/api/requests')).status).toBe(403);
    expect((await n.a.c.get('/api/requests/assignees')).status).toBe(403);
    expect((await n.a.c.patch(`/api/requests/${n.ra.id}/priority`, { priority: 'HIGH' })).status).toBe(403);
    expect((await n.a.c.post(`/api/requests/${n.ra.id}/assign`, { staffId: n.a.resident.id })).status).toBe(403);
    expect((await n.a.c.get('/api/me/tasks')).status).toBe(403);
  });

  it('BR-27: a household member sees and can act on the household’s requests', async () => {
    const head = await residentIn(app, '5A', { name: 'Head' });
    const member = await makeLoginUser('RESIDENT', [], { fullName: 'Spouse' });
    await prisma.householdMember.create({ data: { occupancyId: head.occupancy.id, userId: member.id, relation: 'Spouse', addedAt: d('2020-06-01') } });
    const req = (await submit(head.c)).body;
    const spouse = await asResident(app, member);
    expect((await spouse.get('/api/me/requests')).body.items.map((x: { id: string }) => x.id)).toEqual([req.id]);
    expect((await spouse.get(`/api/requests/${req.id}`)).status).toBe(200);
    expect((await spouse.post(`/api/requests/${req.id}/transition`, { to: 'CANCELLED' })).body.status).toBe('CANCELLED');
  });

  it('BR-27: two different households in one unit (an owner and a tenant) do not see each other’s requests', async () => {
    const owner = await residentIn(app, '6A', { name: 'Owner', type: 'OWNER', contact: false, start: '2019-01-01' });
    const tenant = await residentIn(app, '6A', { name: 'Tenant', type: 'TENANT', contact: true });
    const ownersRequest = (await submit(owner.c, { title: 'Owner’s own problem' })).body;
    expect((await tenant.c.get(`/api/requests/${ownersRequest.id}`)).status).toBe(404);
    expect((await tenant.c.get('/api/me/requests')).body.items).toEqual([]);
  });

  it('a resident who has moved out still sees the requests they made', async () => {
    const r = await residentIn(app, '7A');
    const req = (await submit(r.c)).body;
    await prisma.occupancy.update({ where: { id: r.occupancy.id }, data: { endDate: d('2024-01-01') } });
    expect((await r.c.get(`/api/requests/${req.id}`)).status).toBe(200);
  });

  it('staff with no maintenance permission see only what is assigned to them', async () => {
    const n = await neighbours();
    const worker = await caretaker(app);
    expect((await worker.c.get('/api/requests')).status).toBe(403);
    expect((await worker.c.get(`/api/requests/${n.ra.id}`)).status).toBe(403);
    expect((await worker.c.get('/api/me/tasks')).body.items).toEqual([]);
    await prisma.maintenanceRequest.update({ where: { id: n.ra.id }, data: { assignedToId: worker.user.id, status: 'UNDER_REVIEW' } });
    expect((await worker.c.get(`/api/requests/${n.ra.id}`)).status).toBe(200);
    expect((await worker.c.get(`/api/requests/${n.rb.id}`)).status).toBe(403); // not theirs
    expect((await worker.c.get('/api/me/tasks')).body.items.map((x: { id: string }) => x.id)).toEqual([n.ra.id]);
  });

  it('each maintenance permission opens the staff list; unrelated permissions do not', async () => {
    await neighbours();
    for (const perm of ['maintenance.view_all', 'maintenance.review', 'maintenance.assign']) {
      expect((await (await loginAs(app, 'STAFF', [perm])).c.get('/api/requests')).status, perm).toBe(200);
    }
    for (const perm of ['billing.view', 'residents.manage', 'reports.view']) {
      expect((await (await loginAs(app, 'STAFF', [perm])).c.get('/api/requests')).status, perm).toBe(403);
    }
    expect((await (await client(app)).get('/api/requests')).status).toBe(401);
    expect((await (await loginAs(app, 'ADMIN')).c.get('/api/requests')).status).toBe(200);
  });

  it('staff see the resident’s phone number and internal notes; the resident never does', async () => {
    const n = await neighbours();
    const m = await manager(app);
    await prisma.requestUpdate.create({ data: { requestId: n.ra.id, authorId: m.user.id, kind: 'NOTE', note: 'Internal: tenant is often out', isInternal: true } });
    await prisma.requestUpdate.create({ data: { requestId: n.ra.id, authorId: m.user.id, kind: 'NOTE', note: 'We will visit tomorrow', isInternal: false } });
    const staffView = (await m.c.get(`/api/requests/${n.ra.id}`)).body;
    expect(staffView.submittedBy.phone).toBeTruthy();
    expect(staffView.updates.map((u: { note: string | null }) => u.note)).toEqual(expect.arrayContaining(['Internal: tenant is often out', 'We will visit tomorrow']));

    const residentView = (await n.a.c.get(`/api/requests/${n.ra.id}`)).body;
    expect(residentView.submittedBy.phone).toBeUndefined();
    const notes = residentView.updates.map((u: { note: string | null }) => u.note);
    expect(notes).toContain('We will visit tomorrow');
    expect(notes).not.toContain('Internal: tenant is often out');
    expect(JSON.stringify(residentView)).not.toMatch(/Internal: tenant|"isInternal":true/);
  });
});

describe('FR-18 / FR-22 finding requests', () => {
  async function fill() {
    const a = await occupy('1A');
    const b = await occupy('2B', { floor: 2 });
    const worker = await makeLoginUser('STAFF', [], { fullName: 'Karim Caretaker' });
    const now = Date.now();
    const old = await makeRequest(a.resident.id, a.unit.id, { title: 'Old leak', createdAt: new Date(now - 5 * 86_400_000), dueAt: new Date(now - 3 * 86_400_000) });
    const lift = await makeRequest(b.resident.id, b.unit.id, { title: 'Lift is stuck', category: 'LIFT', priority: 'HIGH', status: 'IN_PROGRESS', assignedToId: worker.id, createdAt: new Date(now - 2 * 86_400_000), dueAt: new Date(now + 86_400_000) });
    const fresh = await makeRequest(a.resident.id, a.unit.id, { title: 'Hallway light', category: 'ELECTRICAL', createdAt: new Date(now - 3_600_000), dueAt: new Date(now + 47 * 3_600_000) });
    const done = await makeRequest(b.resident.id, b.unit.id, { title: 'Fixed pipe', status: 'RESOLVED', createdAt: new Date(now - 9 * 86_400_000), dueAt: new Date(now - 7 * 86_400_000) });
    return { a, b, worker, old, lift, fresh, done };
  }
  const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id);

  it('filters by status, category, priority, unit, assignee and text', async () => {
    const f = await fill();
    const { c } = await manager(app);
    expect((await c.get('/api/requests')).body.total).toBe(4);
    expect(ids(await c.get('/api/requests?status=SUBMITTED')).sort()).toEqual([f.old.id, f.fresh.id].sort());
    expect(ids(await c.get('/api/requests?category=LIFT'))).toEqual([f.lift.id]);
    expect(ids(await c.get('/api/requests?priority=HIGH'))).toEqual([f.lift.id]);
    expect(ids(await c.get(`/api/requests?unitId=${f.b.unit.id}`)).sort()).toEqual([f.lift.id, f.done.id].sort());
    expect(ids(await c.get(`/api/requests?assignedTo=${f.worker.id}`))).toEqual([f.lift.id]);
    expect(ids(await c.get('/api/requests?assignedTo=none')).sort()).toEqual([f.old.id, f.fresh.id, f.done.id].sort());
    expect(ids(await c.get('/api/requests?q=lift'))).toEqual([f.lift.id]);
    expect(ids(await c.get('/api/requests?q=2b')).sort()).toEqual([f.lift.id, f.done.id].sort());
    expect(ids(await c.get(`/api/requests?q=%23${f.fresh.number}`))).toEqual([f.fresh.id]); // "#12"
    expect((await c.get('/api/requests?status=NONSENSE')).status).toBe(400);
  });

  it('"assigned to me" shows the signed-in person’s own requests', async () => {
    const f = await fill();
    const worker = await loginAs(app, 'STAFF', ['maintenance.view_all'], { fullName: 'Me' });
    await prisma.maintenanceRequest.update({ where: { id: f.fresh.id }, data: { assignedToId: worker.user.id } });
    expect(ids(await worker.c.get('/api/requests?assignedTo=me'))).toEqual([f.fresh.id]);
  });

  it('BR-17: overdue means still open and past its deadline; finished requests are never overdue', async () => {
    const f = await fill();
    const { c } = await manager(app);
    const all = (await c.get('/api/requests?pageSize=50')).body.items as { id: string; overdue: boolean }[];
    const flags = Object.fromEntries(all.map((i) => [i.id, i.overdue]));
    expect(flags).toEqual({ [f.old.id]: true, [f.lift.id]: false, [f.fresh.id]: false, [f.done.id]: false }); // the resolved one is past due but finished
    expect(ids(await c.get('/api/requests?overdue=true'))).toEqual([f.old.id]);
  });

  it('filters by date (Dhaka days) and sorts oldest or newest first', async () => {
    const f = await fill();
    const { c } = await manager(app);
    const day = (offset: number) => new Date(Date.now() + 6 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10); // today in Dhaka, plus offset
    expect(ids(await c.get(`/api/requests?from=${day(-3)}`)).sort()).toEqual([f.lift.id, f.fresh.id].sort());
    expect(ids(await c.get(`/api/requests?to=${day(-4)}`)).sort()).toEqual([f.old.id, f.done.id].sort());
    expect(ids(await c.get('/api/requests?sort=oldest'))).toEqual([f.done.id, f.old.id, f.lift.id, f.fresh.id]);
    expect(ids(await c.get('/api/requests?sort=newest'))).toEqual([f.fresh.id, f.lift.id, f.old.id, f.done.id]);
  });

  it('paginates', async () => {
    await fill();
    const { c } = await manager(app);
    const res = await c.get('/api/requests?pageSize=3&page=2');
    expect(res.body).toMatchObject({ page: 2, pageSize: 3, total: 4 });
    expect(res.body.items).toHaveLength(1);
  });

  it('FR-19: the tasks list is the assigned, unfinished requests, highest priority first', async () => {
    const f = await fill();
    const worker = await loginAs(app, 'STAFF');
    const a = await makeRequest(f.a.resident.id, f.a.unit.id, { title: 'Low priority job', priority: 'LOW', status: 'UNDER_REVIEW', assignedToId: worker.user.id, dueAt: new Date(Date.now() + 3 * 86_400_000) });
    const b = await makeRequest(f.a.resident.id, f.a.unit.id, { title: 'High priority job', priority: 'HIGH', status: 'IN_PROGRESS', assignedToId: worker.user.id, dueAt: new Date(Date.now() + 86_400_000) });
    await makeRequest(f.a.resident.id, f.a.unit.id, { title: 'Finished job here', status: 'RESOLVED', assignedToId: worker.user.id });
    await makeRequest(f.a.resident.id, f.a.unit.id, { title: 'Someone else’s job', status: 'IN_PROGRESS', assignedToId: f.worker.id });
    expect(ids(await worker.c.get('/api/me/tasks'))).toEqual([b.id, a.id]);
  });
});

describe('photos are only shown to people who may see the request', () => {
  async function withPhotos() {
    const a = await residentIn(app, '1A', { name: 'Alice' });
    const b = await residentIn(app, '1B', { name: 'Bob' });
    const req = (await submit(a.c, {}, [{ name: 'leak.png', data: PNG, type: 'image/png' }])).body;
    const m = await manager(app);
    const withNote = (await addNoteReq(m.c, req.id, { note: 'Photo of the pipe', isInternal: 'false' }, [{ name: 'pipe.jpg', data: JPEG, type: 'image/jpeg' }])).body;
    const internal = (await addNoteReq(m.c, req.id, { note: 'Our own photo', isInternal: 'true' }, [{ name: 'inside.webp', data: WEBP, type: 'image/webp' }])).body;
    const photoId = req.photos[0].id as string;
    const notePhotoId = withNote.updates.find((u: { photos: unknown[] }) => u.photos.length).photos[0].id as string;
    const internalPhotoId = internal.updates.find((u: { isInternal: boolean; photos: unknown[] }) => u.isInternal && u.photos.length).photos[0].id as string;
    return { a, b, m, req, photoId, notePhotoId, internalPhotoId };
  }

  it('serves the resident their own photo, byte for byte, with safe headers', async () => {
    const w = await withPhotos();
    const res = await w.a.c.agent.get(`/api/attachments/${w.photoId}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (x: Buffer) => chunks.push(x));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect((res.body as Buffer).equals(PNG)).toBe(true);
  });

  it('a neighbour gets "not found" for it', async () => {
    const w = await withPhotos();
    expect((await w.b.c.get(`/api/attachments/${w.photoId}`)).status).toBe(404);
    expect((await w.b.c.get(`/api/attachments/${w.notePhotoId}`)).status).toBe(404);
  });

  it('staff with access see every photo; the resident does not see photos on internal notes', async () => {
    const w = await withPhotos();
    for (const id of [w.photoId, w.notePhotoId, w.internalPhotoId]) expect((await w.m.c.get(`/api/attachments/${id}`)).status).toBe(200);
    expect((await w.a.c.get(`/api/attachments/${w.notePhotoId}`)).status).toBe(200);
    expect((await w.a.c.get(`/api/attachments/${w.internalPhotoId}`)).status).toBe(404);
  });

  it('staff with no access to that request, and strangers, cannot get it', async () => {
    const w = await withPhotos();
    expect((await (await client(app)).get(`/api/attachments/${w.photoId}`)).status).toBe(401);
    expect((await (await caretaker(app)).c.get(`/api/attachments/${w.photoId}`)).status).toBe(403);
    expect((await w.a.c.get('/api/attachments/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await w.a.c.get('/api/attachments/not-a-uuid')).status).toBe(404);
  });

  it('a missing file is "not found", not a server error', async () => {
    const w = await withPhotos();
    clearUploads();
    expect((await w.a.c.get(`/api/attachments/${w.photoId}`)).status).toBe(404);
  });
});
