import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { client, d, makeLoginUser, makeUnit, resetDb } from './helpers';

const app = createApp();

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

async function as(role: 'ADMIN' | 'STAFF' | 'RESIDENT', permissions: string[] = []) {
  const u = await makeLoginUser(role, permissions);
  const c = await client(app);
  await c.login(u.loginId);
  return { c, u };
}

describe('NFR-02 / FR-02 role-based access on /api/units', () => {
  it('401 when not logged in', async () => {
    const c = await client(app);
    expect((await c.get('/api/units')).status).toBe(401);
    expect((await c.post('/api/units', { unitNumber: 'A1', floor: 1 })).status).toBe(401);
  });

  it('403 for a resident on every method', async () => {
    const { c } = await as('RESIDENT');
    const unit = await makeUnit('R1');
    expect((await c.get('/api/units')).status).toBe(403);
    expect((await c.get(`/api/units/${unit.id}`)).status).toBe(403);
    expect((await c.post('/api/units', { unitNumber: 'A1', floor: 1 })).status).toBe(403);
    expect((await c.patch(`/api/units/${unit.id}`, { floor: 2 })).status).toBe(403);
  });

  it('403 for staff without the permission, 200 once it is granted', async () => {
    const none = await as('STAFF');
    expect((await none.c.get('/api/units')).status).toBe(403);
    const granted = await as('STAFF', ['units.manage']);
    expect((await granted.c.get('/api/units')).status).toBe(200);
  });

  it('a permission change takes effect without logging out again (FR-06)', async () => {
    const { c, u } = await as('STAFF', ['units.manage']);
    expect((await c.get('/api/units')).status).toBe(200);
    await prisma.staffPermission.deleteMany({ where: { userId: u.id } });
    expect((await c.get('/api/units')).status).toBe(403);
  });

  it('a different permission does not open units', async () => {
    const { c } = await as('STAFF', ['billing.view', 'payments.record']);
    expect((await c.get('/api/units')).status).toBe(403);
  });
});

describe('residents.manage may look units up but not change them', () => {
  it('can list and view, cannot create or edit', async () => {
    const { c } = await as('STAFF', ['residents.manage']);
    const unit = await makeUnit('8A', 8);
    expect((await c.get('/api/units')).status).toBe(200);
    expect((await c.get(`/api/units/${unit.id}`)).status).toBe(200);
    expect((await c.post('/api/units', { unitNumber: 'X1', floor: 1 })).status).toBe(403);
    expect((await c.patch(`/api/units/${unit.id}`, { floor: 2 })).status).toBe(403);
  });
});

describe('FR-04 manage apartment units', () => {
  it('creates a unit and lists it with a calculated status', async () => {
    const { c } = await as('ADMIN');
    const res = await c.post('/api/units', { unitNumber: '4B', floor: 4, sizeSqft: 1200, bedrooms: 3 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ unitNumber: '4B', floor: 4, status: 'VACANT', isAvailable: true });
    const list = await c.get('/api/units');
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].unitNumber).toBe('4B');
  });

  it('BR-04 rejects a duplicate unit number in any letter case', async () => {
    const { c } = await as('ADMIN');
    await c.post('/api/units', { unitNumber: '4B', floor: 4 });
    const dup = await c.post('/api/units', { unitNumber: '4b', floor: 4 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.fields.unitNumber.code).toBe('UNIT_NUMBER_TAKEN');
  });

  it('shows which field to fix when input is invalid', async () => {
    const { c } = await as('ADMIN');
    const res = await c.post('/api/units', { unitNumber: '', floor: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.fields).sort()).toEqual(['floor', 'unitNumber']);
  });

  it('edits unit details and marks a unit Unavailable (BR-05)', async () => {
    const { c } = await as('ADMIN');
    const { body: unit } = await c.post('/api/units', { unitNumber: '5A', floor: 5 });
    const res = await c.patch(`/api/units/${unit.id}`, { bedrooms: 2, isAvailable: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bedrooms: 2, isAvailable: false, status: 'UNAVAILABLE' });
  });

  it('cannot rename a unit to an existing number', async () => {
    const { c } = await as('ADMIN');
    await c.post('/api/units', { unitNumber: '1A', floor: 1 });
    const { body: other } = await c.post('/api/units', { unitNumber: '1B', floor: 1 });
    expect((await c.patch(`/api/units/${other.id}`, { unitNumber: '1a' })).status).toBe(409);
  });

  it('BR-05 status is Occupied while there is an active occupancy, Vacant after it ends', async () => {
    const { c } = await as('ADMIN');
    const unit = await makeUnit('2A', 2);
    const resident = await makeLoginUser('RESIDENT');
    const occ = await prisma.occupancy.create({
      data: { unitId: unit.id, residentId: resident.id, type: 'OWNER', startDate: d('2020-01-01') },
    });
    expect((await c.get(`/api/units/${unit.id}`)).body.status).toBe('OCCUPIED');
    await prisma.occupancy.update({ where: { id: occ.id }, data: { endDate: d('2020-12-31') } });
    expect((await c.get(`/api/units/${unit.id}`)).body.status).toBe('VACANT');
  });

  it('a future-dated occupancy does not make the unit Occupied yet', async () => {
    const { c } = await as('ADMIN');
    const unit = await makeUnit('2B', 2);
    const resident = await makeLoginUser('RESIDENT');
    await prisma.occupancy.create({
      data: { unitId: unit.id, residentId: resident.id, type: 'TENANT', startDate: d('2999-01-01') },
    });
    expect((await c.get(`/api/units/${unit.id}`)).body.status).toBe('VACANT');
  });

  it('searches by unit number (case-insensitive, partial) and paginates', async () => {
    const { c } = await as('ADMIN');
    for (const [n, f] of [['1A', 1], ['1B', 1], ['2A', 2], ['3C', 3]] as const) await makeUnit(n, f);
    const search = await c.get('/api/units?q=a');
    expect(search.body.items.map((u: { unitNumber: string }) => u.unitNumber)).toEqual(['1A', '2A']);
    const page = await c.get('/api/units?pageSize=2&page=2');
    expect(page.body).toMatchObject({ page: 2, pageSize: 2, total: 4 });
    expect(page.body.items).toHaveLength(2);
  });

  it('returns 404 (not a server error) for a missing or malformed unit ID', async () => {
    const { c } = await as('ADMIN');
    expect((await c.get('/api/units/not-a-uuid')).status).toBe(404);
    expect((await c.get('/api/units/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await c.patch('/api/units/00000000-0000-0000-0000-000000000000', { floor: 1 })).status).toBe(404);
  });
});

describe('billing.manage may look units up (to pick one for a bill) but not change them', () => {
  it('can list and view, cannot create or edit; other billing permissions cannot even list', async () => {
    const { c } = await as('STAFF', ['billing.manage']);
    const unit = await makeUnit('8B', 8);
    expect((await c.get('/api/units')).status).toBe(200);
    expect((await c.get(`/api/units/${unit.id}`)).status).toBe(200);
    expect((await c.post('/api/units', { unitNumber: 'X2', floor: 1 })).status).toBe(403);
    expect((await c.patch(`/api/units/${unit.id}`, { floor: 2 })).status).toBe(403);
    for (const perm of ['billing.view', 'payments.record']) {
      expect((await (await as('STAFF', [perm])).c.get('/api/units')).status, perm).toBe(403);
    }
  });
});
