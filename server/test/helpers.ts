import request from 'supertest';
import type { Express } from 'express';
import type { Role } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/modules/users/auth.service';

let n = 0;
export const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

export async function resetDb() {
  await prisma.$executeRaw`DELETE FROM "session"`;
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
