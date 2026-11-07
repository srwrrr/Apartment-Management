import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { d, loginAs, makeLoginUser, makeUnit, resetDb } from './helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

const admin = () => loginAs(app, 'ADMIN');
const stay = (residentId: string, over: object = {}) => ({ residentId, type: 'TENANT', startDate: '2026-01-01', ...over });

describe('FR-05 access', () => {
  it('403 for residents and for staff without residents.manage', async () => {
    const unit = await makeUnit('1A');
    const who = await makeLoginUser('RESIDENT');
    for (const a of [await loginAs(app, 'RESIDENT'), await loginAs(app, 'STAFF'), await loginAs(app, 'STAFF', ['units.manage'])]) {
      expect((await a.c.get(`/api/units/${unit.id}/occupancies`)).status).toBe(403);
      expect((await a.c.post(`/api/units/${unit.id}/occupancies`, stay(who.id))).status).toBe(403);
    }
    expect((await (await loginAs(app, 'STAFF', ['residents.manage'])).c.get(`/api/units/${unit.id}/occupancies`)).status).toBe(200);
  });

  it('the units endpoints still need units.manage (route order does not leak access)', async () => {
    const staff = await loginAs(app, 'STAFF', ['residents.manage']);
    expect((await staff.c.get('/api/units')).status).toBe(403);
  });
});

describe('FR-05 assign residents to apartments', () => {
  it('links a resident as owner or tenant; the unit becomes occupied', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const r = await makeLoginUser('RESIDENT');
    expect((await c.get(`/api/units/${unit.id}`)).body.status).toBe('VACANT');
    const res = await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { type: 'OWNER' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'OWNER', resident: { id: r.id }, unit: { unitNumber: '1A' } });
    expect((await c.get(`/api/units/${unit.id}`)).body.status).toBe('OCCUPIED');
  });

  it('BR-06 the first occupant becomes the billing contact, later ones do not', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const [r1, r2] = [await makeLoginUser('RESIDENT'), await makeLoginUser('RESIDENT')];
    const a = await c.post(`/api/units/${unit.id}/occupancies`, stay(r1.id));
    const b = await c.post(`/api/units/${unit.id}/occupancies`, stay(r2.id));
    expect(a.body.isBillingContact).toBe(true);
    expect(b.body.isBillingContact).toBe(false);
  });

  it('BR-06 asking for a second billing contact is rejected; switching is done explicitly', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const [r1, r2] = [await makeLoginUser('RESIDENT'), await makeLoginUser('RESIDENT')];
    await c.post(`/api/units/${unit.id}/occupancies`, stay(r1.id));
    const dup = await c.post(`/api/units/${unit.id}/occupancies`, stay(r2.id, { isBillingContact: true }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('BILLING_CONTACT_EXISTS');

    const second = await c.post(`/api/units/${unit.id}/occupancies`, stay(r2.id));
    const sw = await c.patch(`/api/occupancies/${second.body.id}`, { isBillingContact: true });
    expect(sw.status).toBe(200);
    expect(sw.body.isBillingContact).toBe(true);
    expect(await prisma.occupancy.count({ where: { unitId: unit.id, isBillingContact: true, endDate: null } })).toBe(1);
  });

  it('BR-06 rejects overlapping stays by the same resident, allows back-to-back stays', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const r = await makeLoginUser('RESIDENT');
    await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { startDate: '2026-01-01', endDate: '2026-06-30' }));
    const overlap = await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { startDate: '2026-06-30' }));
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('OCCUPANCY_OVERLAP');
    expect((await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { startDate: '2026-07-01' }))).status).toBe(201);
  });

  it('BR-06 rejects an end date before the start date, and invalid dates', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const r = await makeLoginUser('RESIDENT');
    const back = await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { startDate: '2026-05-10', endDate: '2026-05-01' }));
    expect(back.status).toBe(400);
    expect(back.body.error.fields.endDate.code).toBe('END_BEFORE_START');
    const bad = await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { startDate: '2026-02-30' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.startDate.code).toBe('INVALID_DATE');
  });

  it('BR-05 an Unavailable unit takes no new occupancies', async () => {
    const { c } = await admin();
    const unit = await prisma.unit.create({ data: { unitNumber: '9Z', floor: 9, isAvailable: false } });
    const r = await makeLoginUser('RESIDENT');
    const res = await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_UNAVAILABLE');
  });

  it('only active residents can be assigned (not staff, admins, deactivated or unknown people)', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const people = [
      await makeLoginUser('STAFF'),
      await makeLoginUser('ADMIN'),
      await makeLoginUser('RESIDENT', [], { isActive: false }),
    ];
    for (const p of people) {
      const res = await c.post(`/api/units/${unit.id}/occupancies`, stay(p.id));
      expect(res.status).toBe(400);
      expect(res.body.error.fields.residentId.code).toBe('RESIDENT_NOT_FOUND');
    }
    const unknown = await c.post(`/api/units/${unit.id}/occupancies`, stay('00000000-0000-0000-0000-000000000000'));
    expect(unknown.body.error.fields.residentId.code).toBe('RESIDENT_NOT_FOUND');
  });

  it('404 for an unknown or malformed unit', async () => {
    const { c } = await admin();
    const r = await makeLoginUser('RESIDENT');
    expect((await c.post('/api/units/00000000-0000-0000-0000-000000000000/occupancies', stay(r.id))).status).toBe(404);
    expect((await c.get('/api/units/nope/occupancies')).status).toBe(404);
    expect((await c.patch('/api/occupancies/nope', { endDate: '2026-01-01' })).status).toBe(404);
  });

  it('keeps past occupancy records and lists them, newest first', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const [r1, r2] = [await makeLoginUser('RESIDENT'), await makeLoginUser('RESIDENT')];
    await c.post(`/api/units/${unit.id}/occupancies`, stay(r1.id, { startDate: '2020-01-01', endDate: '2022-12-31' }));
    await c.post(`/api/units/${unit.id}/occupancies`, stay(r2.id, { startDate: '2023-01-01' }));
    const list = await c.get(`/api/units/${unit.id}/occupancies`);
    expect(list.body.items.map((o: { resident: { id: string } }) => o.resident.id)).toEqual([r2.id, r1.id]);
  });
});

describe('FR-05 / BR-06 recording the end of a stay', () => {
  it('ends a stay; the unit shows Vacant; the record is kept', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const r = await makeLoginUser('RESIDENT');
    const occ = await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { startDate: '2020-01-01' }));
    const res = await c.patch(`/api/occupancies/${occ.body.id}`, { endDate: '2024-03-31' });
    expect(res.status).toBe(200);
    expect(res.body.endDate).toBe('2024-03-31T00:00:00.000Z');
    expect((await c.get(`/api/units/${unit.id}`)).body.status).toBe('VACANT');
    expect((await c.get(`/api/units/${unit.id}/occupancies`)).body.items).toHaveLength(1);
  });

  it('rejects an end date before the start, and ending a stay twice', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const r = await makeLoginUser('RESIDENT');
    const occ = await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { startDate: '2026-05-01' }));
    const early = await c.patch(`/api/occupancies/${occ.body.id}`, { endDate: '2026-04-01' });
    expect(early.status).toBe(400);
    expect(early.body.error.fields.endDate.code).toBe('END_BEFORE_START');
    expect((await c.patch(`/api/occupancies/${occ.body.id}`, { endDate: '2026-06-01' })).status).toBe(200);
    const again = await c.patch(`/api/occupancies/${occ.body.id}`, { endDate: '2026-07-01' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('OCCUPANCY_ALREADY_ENDED');
  });

  it('BR-06 when the billing contact leaves, the earliest remaining owner takes over', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const [contact, tenant, owner] = [await makeLoginUser('RESIDENT'), await makeLoginUser('RESIDENT'), await makeLoginUser('RESIDENT')];
    const a = await c.post(`/api/units/${unit.id}/occupancies`, stay(contact.id, { startDate: '2020-01-01' }));
    await c.post(`/api/units/${unit.id}/occupancies`, stay(tenant.id, { startDate: '2020-02-01', type: 'TENANT' }));
    await c.post(`/api/units/${unit.id}/occupancies`, stay(owner.id, { startDate: '2021-01-01', type: 'OWNER' }));

    await c.patch(`/api/occupancies/${a.body.id}`, { endDate: '2025-01-31' });
    const active = await prisma.occupancy.findMany({ where: { unitId: unit.id, endDate: null, isBillingContact: true } });
    expect(active).toHaveLength(1);
    expect(active[0]!.residentId).toBe(owner.id); // owners come before tenants
  });

  it('BR-06 the admin can choose the new billing contact instead', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const [contact, other, chosen] = [await makeLoginUser('RESIDENT'), await makeLoginUser('RESIDENT'), await makeLoginUser('RESIDENT')];
    const a = await c.post(`/api/units/${unit.id}/occupancies`, stay(contact.id));
    await c.post(`/api/units/${unit.id}/occupancies`, stay(other.id, { type: 'OWNER' }));
    const pick = await c.post(`/api/units/${unit.id}/occupancies`, stay(chosen.id));

    await c.patch(`/api/occupancies/${a.body.id}`, { endDate: '2026-12-31', newBillingContactOccupancyId: pick.body.id });
    const now = await prisma.occupancy.findFirstOrThrow({ where: { unitId: unit.id, endDate: null, isBillingContact: true } });
    expect(now.id).toBe(pick.body.id);

    // a choice that is not a current occupant of this unit is rejected, and nothing changes
    const b = await c.post(`/api/units/${unit.id}/occupancies`, stay((await makeLoginUser('RESIDENT')).id));
    const bad = await c.patch(`/api/occupancies/${pick.body.id}`, { endDate: '2027-01-31', newBillingContactOccupancyId: a.body.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.newBillingContactOccupancyId.code).toBe('NEW_BILLING_CONTACT_INVALID');
    expect((await prisma.occupancy.findUniqueOrThrow({ where: { id: pick.body.id } })).endDate).toBeNull();
    expect(b.status).toBe(201);
  });

  it('BR-27 household members lose access when the stay ends', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const [r, member] = [await makeLoginUser('RESIDENT'), await makeLoginUser('RESIDENT')];
    const occ = await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { startDate: '2020-01-01' }));
    const hm = await prisma.householdMember.create({
      data: { occupancyId: occ.body.id, userId: member.id, relation: 'Spouse', addedAt: d('2020-06-01') },
    });
    await c.patch(`/api/occupancies/${occ.body.id}`, { endDate: '2024-03-31' });
    expect((await prisma.householdMember.findUniqueOrThrow({ where: { id: hm.id } })).removedAt).toEqual(d('2024-03-31'));
  });

  it('a past stay cannot become the billing contact', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const r = await makeLoginUser('RESIDENT');
    const occ = await c.post(`/api/units/${unit.id}/occupancies`, stay(r.id, { startDate: '2020-01-01' }));
    await c.patch(`/api/occupancies/${occ.body.id}`, { endDate: '2021-01-01' });
    const res = await c.patch(`/api/occupancies/${occ.body.id}`, { isBillingContact: true });
    expect(res.status).toBe(409);
  });

  it('an empty update is rejected', async () => {
    const { c } = await admin();
    const unit = await makeUnit('1A');
    const occ = await c.post(`/api/units/${unit.id}/occupancies`, stay((await makeLoginUser('RESIDENT')).id));
    expect((await c.patch(`/api/occupancies/${occ.body.id}`, {})).status).toBe(400);
  });
});
