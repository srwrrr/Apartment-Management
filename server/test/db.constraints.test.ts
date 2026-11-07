import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { d, makeUnit, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('BR-04 unit numbers are unique, case-insensitive', () => {
  it('rejects 4b after 4B', async () => {
    await prisma.unit.create({ data: { unitNumber: '4B', floor: 4 } });
    await expect(prisma.unit.create({ data: { unitNumber: '4b', floor: 4 } })).rejects.toThrow();
  });
  it('allows different units', async () => {
    await prisma.unit.create({ data: { unitNumber: '4B', floor: 4 } });
    await expect(prisma.unit.create({ data: { unitNumber: '4C', floor: 4 } })).resolves.toBeTruthy();
  });
});

describe('BR-01 login IDs are unique', () => {
  it('rejects duplicate loginId', async () => {
    await makeUser({ loginId: 'a@test.local' });
    await expect(makeUser({ loginId: 'a@test.local' })).rejects.toThrow();
  });
});

describe('BR-06 occupancy rules', () => {
  const occ = (unitId: string, residentId: string, startDate: string, endDate: string | null, over = {}) =>
    prisma.occupancy.create({
      data: { unitId, residentId, type: 'TENANT', startDate: d(startDate), endDate: endDate ? d(endDate) : null, ...over },
    });

  it('rejects end date before start date', async () => {
    const [u, r] = [await makeUnit(), await makeUser()];
    await expect(occ(u.id, r.id, '2026-05-10', '2026-05-01')).rejects.toThrow();
  });

  it('rejects overlapping occupancies of the same unit by the same resident', async () => {
    const [u, r] = [await makeUnit(), await makeUser()];
    await occ(u.id, r.id, '2026-01-01', '2026-06-30');
    await expect(occ(u.id, r.id, '2026-06-30', null)).rejects.toThrow(); // inclusive overlap on 30 Jun
  });

  it('rejects a second open-ended occupancy for the same resident and unit', async () => {
    const [u, r] = [await makeUnit(), await makeUser()];
    await occ(u.id, r.id, '2026-01-01', null);
    await expect(occ(u.id, r.id, '2026-09-01', null)).rejects.toThrow();
  });

  it('allows back-to-back stays and different residents sharing a unit', async () => {
    const [u, r1, r2] = [await makeUnit(), await makeUser(), await makeUser()];
    await occ(u.id, r1.id, '2026-01-01', '2026-06-30');
    await expect(occ(u.id, r1.id, '2026-07-01', null)).resolves.toBeTruthy();
    await expect(occ(u.id, r2.id, '2026-07-01', null)).resolves.toBeTruthy();
  });

  it('allows only one active billing contact per unit', async () => {
    const [u, r1, r2] = [await makeUnit(), await makeUser(), await makeUser()];
    await occ(u.id, r1.id, '2026-01-01', null, { isBillingContact: true });
    await expect(occ(u.id, r2.id, '2026-01-01', null, { isBillingContact: true })).rejects.toThrow();
  });

  it('allows a new billing contact once the previous stay has ended', async () => {
    const [u, r1, r2] = [await makeUnit(), await makeUser(), await makeUser()];
    await occ(u.id, r1.id, '2026-01-01', '2026-03-31', { isBillingContact: true });
    await expect(occ(u.id, r2.id, '2026-04-01', null, { isBillingContact: true })).resolves.toBeTruthy();
  });
});

describe('household member dates', () => {
  it('rejects removal before addition', async () => {
    const [u, r, m] = [await makeUnit(), await makeUser(), await makeUser()];
    const o = await prisma.occupancy.create({
      data: { unitId: u.id, residentId: r.id, type: 'OWNER', startDate: d('2026-01-01') },
    });
    await expect(
      prisma.householdMember.create({
        data: { occupancyId: o.id, userId: m.id, relation: 'Spouse', addedAt: d('2026-05-01'), removedAt: d('2026-04-01') },
      }),
    ).rejects.toThrow();
  });
});

describe('unit floor range', () => {
  it('rejects floor 101', async () => {
    await expect(prisma.unit.create({ data: { unitNumber: 'X1', floor: 101 } })).rejects.toThrow();
  });
});
