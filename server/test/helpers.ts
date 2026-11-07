import { prisma } from '../src/lib/prisma';

let n = 0;
export const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

export async function resetDb() {
  await prisma.householdMember.deleteMany();
  await prisma.occupancy.deleteMany();
  await prisma.staffPermission.deleteMany();
  await prisma.residentProfile.deleteMany();
  await prisma.unit.deleteMany();
  await prisma.user.deleteMany();
}

export const makeUser = (over: Partial<Parameters<typeof prisma.user.create>[0]['data']> = {}) =>
  prisma.user.create({
    data: {
      loginId: `${uid()}@test.local`,
      passwordHash: 'x',
      role: 'RESIDENT',
      fullName: 'Test User',
      phone: '+8801700000000',
      ...over,
    },
  });

export const makeUnit = (unitNumber = uid().slice(-6).toUpperCase(), floor = 1) =>
  prisma.unit.create({ data: { unitNumber, floor } });

export const d = (s: string) => new Date(s + 'T00:00:00Z');
