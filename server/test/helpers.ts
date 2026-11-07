import request from 'supertest';
import type { Express } from 'express';
import type { Role } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/modules/users/auth.service';

let n = 0;
export const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

export async function resetDb() {
  await prisma.$executeRaw`DELETE FROM "session"`;
  await prisma.notification.deleteMany();
  await prisma.announcementRecipient.deleteMany();
  await prisma.announcementAudience.deleteMany();
  await prisma.announcement.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.requestUpdate.deleteMany();
  await prisma.maintenanceRequest.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.charge.deleteMany();
  await prisma.bill.deleteMany();
  await prisma.unitFee.deleteMany();
  await prisma.counter.deleteMany();
  await prisma.setting.deleteMany();
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

export const PASSWORD = 'Passw0rd1';

/** A user with a real, known password. */
export async function makeLoginUser(role: Role = 'RESIDENT', permissions: string[] = [], over = {}) {
  const user = await makeUser({ role, passwordHash: await hashPassword(PASSWORD), mustChangePassword: false, ...over });
  if (permissions.length) {
    await prisma.staffPermission.createMany({ data: permissions.map((permission) => ({ userId: user.id, permission })) });
  }
  return user;
}

export const makeUnit = (unitNumber = uid().slice(-6).toUpperCase(), floor = 1) =>
  prisma.unit.create({ data: { unitNumber, floor } });

export const d = (s: string) => new Date(s + 'T00:00:00Z');

/** A browser-like client: keeps cookies and sends the CSRF token on writes. */
export async function client(app: Express) {
  const agent = request.agent(app);
  let token: string = (await agent.get('/api/auth/csrf')).body.csrfToken;
  const c = {
    agent,
    get token() {
      return token;
    },
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => agent.post(url).set('X-CSRF-Token', token).send(body),
    patch: (url: string, body: object = {}) => agent.patch(url).set('X-CSRF-Token', token).send(body),
    put: (url: string, body: object = {}) => agent.put(url).set('X-CSRF-Token', token).send(body),
    delete: (url: string) => agent.delete(url).set('X-CSRF-Token', token),
    /** A multipart request (photos). Chain .field(...) and .attach(...). */
    form: (url: string) => agent.post(url).set('X-CSRF-Token', token),
    async login(loginId: string, password = PASSWORD) {
      const res = await c.post('/api/auth/login', { loginId, password });
      if (res.status === 200) token = res.body.csrfToken;
      return res;
    },
  };
  return c;
}

/** Log in as a fresh user of the given role. */
export async function loginAs(app: Express, role: Role, permissions: string[] = [], over = {}) {
  const user = await makeLoginUser(role, permissions, over);
  const c = await client(app);
  const res = await c.login(user.loginId);
  if (res.status !== 200) throw new Error('test login failed: ' + res.status);
  return { c, user };
}

// ---------------------------------------------------------------- billing helpers
export { addMonths, currentMonthDhaka, todayDhaka } from '../src/lib/dates';

/** A unit with a resident living in it (creating the unit if needed). */
export async function occupy(
  unitNumber: string,
  o: { floor?: number; name?: string; type?: 'OWNER' | 'TENANT'; start?: string; end?: string | null; contact?: boolean } = {},
) {
  const unit = (await prisma.unit.findFirst({ where: { unitNumber } })) ?? (await prisma.unit.create({ data: { unitNumber, floor: o.floor ?? 1 } }));
  const resident = await makeLoginUser('RESIDENT', [], { fullName: o.name ?? `Resident ${unitNumber}` });
  const occupancy = await prisma.occupancy.create({
    data: {
      unitId: unit.id,
      residentId: resident.id,
      type: o.type ?? 'TENANT',
      startDate: d(o.start ?? '2020-01-01'),
      endDate: o.end ? d(o.end) : null,
      isBillingContact: o.contact ?? true,
    },
  });
  return { unit, resident, occupancy };
}

/** Building-wide fees, in poisha: setFees({ SERVICE: 300000, WATER: 50000 }). */
export async function setFees(fees: Partial<Record<'SERVICE' | 'RENT' | 'WATER' | 'GAS' | 'ELECTRICITY', number>>, unitId: string | null = null) {
  await prisma.unitFee.createMany({
    data: Object.entries(fees).map(([chargeType, amount]) => ({ unitId, chargeType: chargeType as 'SERVICE', amount: amount!, description: chargeType })),
  });
}

/** A bill straight in the database, for tests that are not about generating bills. */
export async function makeBill(unitId: string, month: string, charges: [string, number][], over: { dueDate?: string; contactId?: string | null; createdById?: string } = {}) {
  const creator = over.createdById ?? (await makeLoginUser('ADMIN')).id;
  return prisma.bill.create({
    data: {
      unitId,
      billingMonth: d(`${month}-01`),
      dueDate: d(over.dueDate ?? `${month}-10`),
      billingContactId: over.contactId ?? null,
      createdById: creator,
      charges: { create: charges.map(([type, amount]) => ({ type: type as 'SERVICE', amount, description: type })) },
    },
  });
}
