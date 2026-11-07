import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@apt/shared';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { generateTempPassword } from '../src/modules/users/password';
import { client, loginAs, makeLoginUser, PASSWORD, resetDb } from './helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

const valid = { fullName: 'Karim Caretaker', loginId: 'karim@example.com', phone: '01712345678' };

describe('FR-06 only administrators manage staff', () => {
  it('401 anonymous; 403 for residents and even for staff holding every permission', async () => {
    expect((await (await client(app)).get('/api/staff')).status).toBe(401);
    expect((await (await loginAs(app, 'RESIDENT')).c.get('/api/staff')).status).toBe(403);
    const powerful = await loginAs(app, 'STAFF', [...PERMISSIONS]);
    expect((await powerful.c.get('/api/staff')).status).toBe(403);
    expect((await powerful.c.post('/api/staff', valid)).status).toBe(403);
    expect((await powerful.c.put(`/api/staff/${powerful.user.id}/permissions`, { permissions: [] })).status).toBe(403);
    expect((await powerful.c.post(`/api/users/${powerful.user.id}/reset-password`)).status).toBe(403);
    expect((await (await loginAs(app, 'ADMIN')).c.get('/api/staff')).status).toBe(200);
  });
});

describe('FR-06 staff accounts', () => {
  it('creates a staff account with a temporary password and no permissions by default', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const res = await c.post('/api/staff', valid);
    expect(res.status).toBe(201);
    expect(res.body.staff).toMatchObject({ role: 'STAFF', isActive: true, mustChangePassword: true, permissions: [] });
    expect(res.body.tempPassword).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect((await (await client(app)).login('karim@example.com', res.body.tempPassword)).status).toBe(200);
  });

  it('creates staff with chosen permissions (duplicates ignored)', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const res = await c.post('/api/staff', { ...valid, permissions: ['units.manage', 'billing.view', 'units.manage'] });
    expect(res.body.staff.permissions).toEqual(['billing.view', 'units.manage']);
  });

  it('rejects unknown permissions and bad input', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    expect((await c.post('/api/staff', { ...valid, permissions: ['rule.everything'] })).status).toBe(400);
    expect((await c.post('/api/staff', { fullName: 'K', loginId: 'x', phone: '1' })).status).toBe(400);
  });

  it('BR-01 rejects a login ID already in use', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    await c.post('/api/staff', valid);
    const dup = await c.post('/api/staff', valid);
    expect(dup.status).toBe(409);
    expect(dup.body.error.fields.loginId.code).toBe('LOGIN_ID_TAKEN');
  });

  it('lists only staff, edits details', async () => {
    const { c, user: admin } = await loginAs(app, 'ADMIN');
    const resident = await makeLoginUser('RESIDENT');
    const { body } = await c.post('/api/staff', valid);
    const list = (await c.get('/api/staff')).body.items.map((s: { id: string }) => s.id);
    expect(list).toEqual([body.staff.id]);
    expect(list).not.toContain(admin.id);
    expect(list).not.toContain(resident.id);

    const res = await c.patch(`/api/staff/${body.staff.id}`, { fullName: 'Karim Mia' });
    expect(res.body.fullName).toBe('Karim Mia');
    expect((await c.get(`/api/staff/${resident.id}`)).status).toBe(404); // not a staff account
    expect((await c.get('/api/staff/nope')).status).toBe(404);
  });

  it('replaces permissions, and the change applies to the staff member immediately (FR-06)', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const staff = await loginAs(app, 'STAFF', ['units.manage']);
    expect((await staff.c.get('/api/units')).status).toBe(200);
    expect((await staff.c.get('/api/residents')).status).toBe(403);

    const res = await c.put(`/api/staff/${staff.user.id}/permissions`, { permissions: ['residents.manage'] });
    expect(res.body.permissions).toEqual(['residents.manage']);
    expect((await staff.c.get('/api/units')).status).toBe(403);
    expect((await staff.c.get('/api/residents')).status).toBe(200);

    expect((await c.put(`/api/staff/${staff.user.id}/permissions`, { permissions: [] })).body.permissions).toEqual([]);
    expect((await staff.c.get('/api/residents')).status).toBe(403);
  });

  it('a deactivated staff member can no longer log in, and is logged out at once', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const staff = await loginAs(app, 'STAFF', ['units.manage']);
    expect((await staff.c.get('/api/units')).status).toBe(200);

    const res = await c.post(`/api/staff/${staff.user.id}/deactivate`);
    expect(res.body.isActive).toBe(false);
    expect((await staff.c.get('/api/units')).status).toBe(401);
    expect((await (await client(app)).login(staff.user.loginId)).status).toBe(401);

    await c.post(`/api/staff/${staff.user.id}/reactivate`);
    expect((await (await client(app)).login(staff.user.loginId)).status).toBe(200);
  });
});

describe('FR-31 admin resets a password', () => {
  it('issues a new temporary password, ends sessions, clears lockout, forces a change', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const resident = await loginAs(app, 'RESIDENT');
    await prisma.user.update({ where: { id: resident.user.id }, data: { failedLoginCount: 3, lockedUntil: new Date(Date.now() + 600_000) } });

    const res = await c.post(`/api/users/${resident.user.id}/reset-password`);
    expect(res.status).toBe(200);
    expect(res.body.tempPassword).toBeTruthy();
    expect((await resident.c.get('/api/me/profile')).status).toBe(401); // session ended

    const fresh = await client(app);
    expect((await fresh.login(resident.user.loginId, PASSWORD)).status).toBe(401); // old password is dead
    const login = await fresh.login(resident.user.loginId, res.body.tempPassword);
    expect(login.status).toBe(200); // lockout cleared
    expect(login.body.mustChangePassword).toBe(true);
  });

  it('works for staff too, 404 for unknown users, and cannot be used on yourself', async () => {
    const { c, user: admin } = await loginAs(app, 'ADMIN');
    const staff = await makeLoginUser('STAFF');
    expect((await c.post(`/api/users/${staff.id}/reset-password`)).status).toBe(200);
    expect((await c.post('/api/users/00000000-0000-0000-0000-000000000000/reset-password')).status).toBe(404);
    expect((await c.post('/api/users/nope/reset-password')).status).toBe(404);
    const own = await c.post(`/api/users/${admin.id}/reset-password`);
    expect(own.status).toBe(400);
    expect(own.body.error.code).toBe('CANNOT_RESET_OWN_PASSWORD');
  });
});

describe('temporary password generator (BR-02)', () => {
  it('always meets the password rules and avoids look-alike characters', () => {
    for (let i = 0; i < 500; i++) {
      const p = generateTempPassword();
      expect(p).toHaveLength(10);
      expect(p).toMatch(/[A-Za-z]/);
      expect(p).toMatch(/\d/);
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });
  it('is not predictable', () => {
    expect(new Set(Array.from({ length: 200 }, () => generateTempPassword())).size).toBe(200);
  });
});
