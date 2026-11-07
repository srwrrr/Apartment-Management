import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { client, makeLoginUser, PASSWORD, resetDb } from './helpers';

const app = createApp();

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

describe('FR-01 log in securely', () => {
  it('logs in with correct details and /me returns the user (never the password)', async () => {
    const u = await makeLoginUser('RESIDENT');
    const c = await client(app);
    const res = await c.login(u.loginId);
    expect(res.status).toBe(200);
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.loginId).toBe(u.loginId);
    const body = JSON.stringify([res.body, me.body]);
    expect(body).not.toMatch(/passwordHash/i);
    expect(body).not.toContain("$2"); // no bcrypt hash
    expect(body).not.toContain(PASSWORD);
  });

  it('accepts a phone number in any common format (BR-01)', async () => {
    const u = await makeLoginUser('RESIDENT', [], { loginId: '+8801712345678' });
    const c = await client(app);
    expect((await c.login('01712345678')).status).toBe(200);
    expect(u).toBeTruthy();
  });

  it('gives the same error for a wrong password and an unknown user', async () => {
    const u = await makeLoginUser();
    const c = await client(app);
    const wrong = await c.login(u.loginId, 'WrongPass1');
    const unknown = await c.login('nobody@test.local');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('BR-02 locks the account after 5 wrong attempts, even for the right password', async () => {
    const u = await makeLoginUser();
    const c = await client(app);
    for (let i = 0; i < 4; i++) expect((await c.login(u.loginId, 'WrongPass1')).status).toBe(401);
    expect((await c.login(u.loginId, 'WrongPass1')).status).toBe(423);
    const right = await c.login(u.loginId, PASSWORD);
    expect(right.status).toBe(423);
    expect(right.body.error.code).toBe('LOCKED');
  });

  it('BR-02 lets the user in after the lock expires and resets the counter', async () => {
    const u = await makeLoginUser();
    const c = await client(app);
    for (let i = 0; i < 5; i++) await c.login(u.loginId, 'WrongPass1');
    await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await c.login(u.loginId)).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLoginCount).toBe(0);
  });

  it('BR-03 a deactivated user cannot log in and sees the generic error', async () => {
    const u = await makeLoginUser('STAFF', [], { isActive: false });
    const res = await (await client(app)).login(u.loginId);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('a user deactivated mid-session is logged out on their next request', async () => {
    const u = await makeLoginUser('STAFF');
    const c = await client(app);
    await c.login(u.loginId);
    await prisma.user.update({ where: { id: u.id }, data: { isActive: false } });
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('logout ends the session', async () => {
    const u = await makeLoginUser();
    const c = await client(app);
    await c.login(u.loginId);
    expect((await c.post('/api/auth/logout')).status).toBe(204);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('NFR-03 an expired session is rejected', async () => {
    const u = await makeLoginUser();
    const c = await client(app);
    await c.login(u.loginId);
    await prisma.$executeRaw`UPDATE "session" SET expire = now() - interval '1 minute'`;
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('issues a new session ID at login (no session fixation)', async () => {
    const u = await makeLoginUser();
    const c = await client(app);
    const before = (await prisma.$queryRaw<{ sid: string }[]>`SELECT sid FROM "session"`).map((r) => r.sid);
    await c.login(u.loginId);
    const after = (await prisma.$queryRaw<{ sid: string }[]>`SELECT sid FROM "session"`).map((r) => r.sid);
    expect(after).toHaveLength(1);
    expect(before.some((s) => after.includes(s))).toBe(false);
  });

  it('sets an HttpOnly, SameSite=Lax cookie', async () => {
    const u = await makeLoginUser();
    const c = await client(app);
    const res = await c.login(u.loginId);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });
});

describe('NFR-05 CSRF protection', () => {
  it('rejects a write with no token', async () => {
    const u = await makeLoginUser();
    const agent = request.agent(app);
    await agent.get('/api/auth/csrf');
    const res = await agent.post('/api/auth/login').send({ loginId: u.loginId, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects a write with a wrong token', async () => {
    const u = await makeLoginUser();
    const agent = request.agent(app);
    await agent.get('/api/auth/csrf');
    const res = await agent
      .post('/api/auth/login')
      .set('X-CSRF-Token', 'f'.repeat(64))
      .send({ loginId: u.loginId, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it('rejects the old token after login (token is tied to the new session)', async () => {
    const u = await makeLoginUser('ADMIN');
    const c = await client(app);
    const oldToken = c.token;
    await c.login(u.loginId);
    const res = await c.agent.post('/api/units').set('X-CSRF-Token', oldToken).send({ unitNumber: 'A1', floor: 1 });
    expect(res.status).toBe(403);
  });
});

describe('FR-31 change password', () => {
  it('forces a temporary password to be changed before anything else', async () => {
    const admin = await makeLoginUser('ADMIN', [], { mustChangePassword: true });
    const c = await client(app);
    const login = await c.login(admin.loginId);
    expect(login.body.mustChangePassword).toBe(true);
    const blocked = await c.get('/api/units');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const res = await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'NewPassw0rd' });
    expect(res.status).toBe(204);
    expect((await c.get('/api/units')).status).toBe(200);
  });

  it('rejects a wrong current password, a weak new one, and an unchanged one', async () => {
    const u = await makeLoginUser();
    const c = await client(app);
    await c.login(u.loginId);
    const wrong = await c.post('/api/auth/change-password', { currentPassword: 'Nope1234', newPassword: 'NewPassw0rd' });
    expect(wrong.body.error.fields.currentPassword.code).toBe('WRONG_PASSWORD');
    const weak = await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.body.error.fields.newPassword.code).toBe('PASSWORD_TOO_WEAK');
    const same = await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.body.error.fields.newPassword.code).toBe('PASSWORD_UNCHANGED');
  });

  it('works with the new password and ends the user\'s other sessions', async () => {
    const u = await makeLoginUser();
    const a = await client(app);
    const b = await client(app);
    await a.login(u.loginId);
    await b.login(u.loginId);
    expect((await b.get('/api/auth/me')).status).toBe(200);

    expect((await a.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'NewPassw0rd' })).status).toBe(204);

    expect((await a.get('/api/auth/me')).status).toBe(200); // this session stays
    expect((await b.get('/api/auth/me')).status).toBe(401); // the other one ended
    expect((await (await client(app)).login(u.loginId, PASSWORD)).status).toBe(401);
    expect((await (await client(app)).login(u.loginId, 'NewPassw0rd')).status).toBe(200);
  });

  it('requires login', async () => {
    const c = await client(app);
    expect((await c.post('/api/auth/change-password', { currentPassword: 'a', newPassword: 'b' })).status).toBe(401);
  });
});

describe('NFR-01 passwords are hashed', () => {
  it('stores a bcrypt hash, not the password', async () => {
    const u = await makeLoginUser();
    expect(u.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(u.passwordHash).not.toContain(PASSWORD);
  });
});
