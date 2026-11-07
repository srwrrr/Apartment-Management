import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { client, d, loginAs, makeLoginUser, makeUnit, PASSWORD, resetDb } from './helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

const valid = { fullName: 'Rahim Uddin', loginId: 'rahim@example.com', phone: '01712345678' };

describe('FR-02 who can manage residents', () => {
  it('401 anonymous, 403 resident, 403 staff without the permission, 200 with it', async () => {
    expect((await (await client(app)).get('/api/residents')).status).toBe(401);
    expect((await (await loginAs(app, 'RESIDENT')).c.get('/api/residents')).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF')).c.get('/api/residents')).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['billing.view'])).c.get('/api/residents')).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['residents.manage'])).c.get('/api/residents')).status).toBe(200);
    expect((await (await loginAs(app, 'ADMIN')).c.get('/api/residents')).status).toBe(200);
  });
});

describe('FR-03 register residents', () => {
  it('creates a resident with a temporary password that must be changed (FR-31)', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const res = await c.post('/api/residents', { ...valid, altPhone: '01812345678', emergencyContactName: 'Karim' });
    expect(res.status).toBe(201);
    expect(res.body.tempPassword).toMatch(/^(?=.*[A-Za-z])(?=.*\d).{8,}$/);
    expect(res.body.resident).toMatchObject({
      loginId: 'rahim@example.com',
      role: 'RESIDENT',
      isActive: true,
      mustChangePassword: true,
      phone: '+8801712345678',
      profile: { altPhone: '+8801812345678', emergencyContactName: 'Karim' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    const resident = await client(app);
    const login = await resident.login('rahim@example.com', res.body.tempPassword);
    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);
    expect((await resident.get('/api/me/profile')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('accepts Bangla names and a phone number as the login ID (BR-01)', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const res = await c.post('/api/residents', { fullName: 'রহিম উদ্দিন', loginId: '017 1234-5679', phone: '01712345679' });
    expect(res.status).toBe(201);
    expect(res.body.resident.fullName).toBe('রহিম উদ্দিন');
    expect(res.body.resident.loginId).toBe('+8801712345679');
    expect((await (await client(app)).login('01712345679', res.body.tempPassword)).status).toBe(200);
  });

  it('every temporary password is different', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const a = await c.post('/api/residents', valid);
    const b = await c.post('/api/residents', { ...valid, loginId: 'other@example.com' });
    expect(a.body.tempPassword).not.toBe(b.body.tempPassword);
  });

  it('BR-01 rejects a login ID already in use, in any letter case', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    await c.post('/api/residents', valid);
    const dup = await c.post('/api/residents', { ...valid, loginId: 'RAHIM@Example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.fields.loginId.code).toBe('LOGIN_ID_TAKEN');
  });

  it('shows which fields to fix', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const res = await c.post('/api/residents', { fullName: 'A', loginId: 'nope', phone: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.loginId.code).toBe('LOGIN_ID_INVALID');
    expect(res.body.error.fields.phone.code).toBe('PHONE_INVALID');
    expect(res.body.error.fields.fullName).toBeTruthy();
    const missing = await c.post('/api/residents', {});
    expect(Object.keys(missing.body.error.fields).sort()).toEqual(['fullName', 'loginId', 'phone']);
  });

  it('does not collect national ID numbers (NFR-25) and cannot be used to create admins', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const res = await c.post('/api/residents', { ...valid, nationalId: '1234567890', role: 'ADMIN' });
    expect(res.status).toBe(201);
    expect(res.body.resident.role).toBe('RESIDENT');
    expect(JSON.stringify(res.body)).not.toContain('1234567890');
  });

  it('edits details and the changes are saved', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const { body } = await c.post('/api/residents', valid);
    const id = body.resident.id;
    const res = await c.patch(`/api/residents/${id}`, {
      fullName: 'Rahim U.',
      phone: '01999999999',
      emergencyContactPhone: '01712340000',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      fullName: 'Rahim U.',
      phone: '+8801999999999',
      profile: { emergencyContactPhone: '+8801712340000' },
    });
    expect((await c.get(`/api/residents/${id}`)).body.fullName).toBe('Rahim U.');
  });

  it('cannot change a login ID to one that is taken', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    await c.post('/api/residents', valid);
    const other = await c.post('/api/residents', { ...valid, loginId: 'b@example.com' });
    const res = await c.patch(`/api/residents/${other.body.resident.id}`, { loginId: 'rahim@example.com' });
    expect(res.status).toBe(409);
  });

  it('lists, searches (name, phone, login ID) and filters by active', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    await c.post('/api/residents', valid);
    await c.post('/api/residents', { fullName: 'Karim Ali', loginId: 'karim@example.com', phone: '01555555555' });
    const gone = await c.post('/api/residents', { fullName: 'Selim Khan', loginId: 'selim@example.com', phone: '01666666666' });
    await c.post(`/api/residents/${gone.body.resident.id}/deactivate`);

    expect((await c.get('/api/residents')).body.total).toBe(3);
    expect((await c.get('/api/residents?q=rah')).body.items.map((r: { fullName: string }) => r.fullName)).toEqual(['Rahim Uddin']);
    expect((await c.get('/api/residents?q=01555')).body.total).toBe(1);
    expect((await c.get('/api/residents?q=SELIM@')).body.total).toBe(1);
    expect((await c.get('/api/residents?active=true')).body.total).toBe(2);
    expect((await c.get('/api/residents?active=false')).body.total).toBe(1);
    expect((await c.get('/api/residents?pageSize=2&page=2')).body.items).toHaveLength(1);
  });

  it('only residents are listed or fetched here, never staff or admins', async () => {
    const { c, user: admin } = await loginAs(app, 'ADMIN');
    const staff = await makeLoginUser('STAFF');
    const all = (await c.get('/api/residents')).body.items.map((r: { id: string }) => r.id);
    expect(all).not.toContain(admin.id);
    expect(all).not.toContain(staff.id);
    expect((await c.get(`/api/residents/${staff.id}`)).status).toBe(404);
    expect((await c.get('/api/residents/not-a-uuid')).status).toBe(404);
  });
});

describe('FR-03 / BR-03 deactivate and reactivate', () => {
  it('deactivates a resident with no active stay, keeps the record, blocks login', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const { body } = await c.post('/api/residents', valid);
    const id = body.resident.id;
    const res = await c.post(`/api/residents/${id}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect((await c.get(`/api/residents/${id}`)).status).toBe(200); // history is kept
    expect((await (await client(app)).login('rahim@example.com', body.tempPassword)).status).toBe(401);
  });

  it('BR-03 needs an end date when the resident has an open stay, and changes nothing without it', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const unit = await makeUnit('3A', 3);
    const { body } = await c.post('/api/residents', valid);
    const id = body.resident.id;
    await c.post(`/api/units/${unit.id}/occupancies`, { residentId: id, type: 'TENANT', startDate: '2020-01-01' });

    const res = await c.post(`/api/residents/${id}/deactivate`);
    expect(res.status).toBe(400);
    expect(res.body.error.fields.endDate.code).toBe('END_DATE_REQUIRED');
    expect((await c.get(`/api/residents/${id}`)).body.isActive).toBe(true);
    expect((await prisma.occupancy.findFirstOrThrow({ where: { residentId: id } })).endDate).toBeNull();
  });

  it('ends every open stay with the given date, frees the units, and keeps the history', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const [u1, u2] = [await makeUnit('3A', 3), await makeUnit('3B', 3)];
    const { body } = await c.post('/api/residents', valid);
    const id = body.resident.id;
    await c.post(`/api/units/${u1.id}/occupancies`, { residentId: id, type: 'OWNER', startDate: '2020-01-01' });
    await c.post(`/api/units/${u2.id}/occupancies`, { residentId: id, type: 'TENANT', startDate: '2021-01-01' });
    expect((await c.get(`/api/units/${u1.id}`)).body.status).toBe('OCCUPIED');

    const res = await c.post(`/api/residents/${id}/deactivate`, { endDate: '2024-06-30' });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(res.body.occupancies).toHaveLength(2);
    for (const o of res.body.occupancies) expect(o.endDate).toBe('2024-06-30T00:00:00.000Z');
    expect((await c.get(`/api/units/${u1.id}`)).body.status).toBe('VACANT');
  });

  it('rejects an end date before a stay started, and rolls everything back', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const [u1, u2] = [await makeUnit('3A', 3), await makeUnit('3B', 3)];
    const { body } = await c.post('/api/residents', valid);
    const id = body.resident.id;
    await c.post(`/api/units/${u1.id}/occupancies`, { residentId: id, type: 'OWNER', startDate: '2020-01-01' });
    await c.post(`/api/units/${u2.id}/occupancies`, { residentId: id, type: 'TENANT', startDate: '2023-01-01' });
    const res = await c.post(`/api/residents/${id}/deactivate`, { endDate: '2022-01-01' }); // before the second stay began
    expect(res.status).toBe(400);
    expect(await prisma.occupancy.count({ where: { residentId: id, endDate: null } })).toBe(2);
    expect((await c.get(`/api/residents/${id}`)).body.isActive).toBe(true);
  });

  it("ends the resident's active sessions", async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const resident = await loginAs(app, 'RESIDENT');
    expect((await resident.c.get('/api/me/profile')).status).toBe(200);
    await c.post(`/api/residents/${resident.user.id}/deactivate`);
    expect((await resident.c.get('/api/me/profile')).status).toBe(401);
  });

  it('reactivates a resident', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const { body } = await c.post('/api/residents', valid);
    const id = body.resident.id;
    await c.post(`/api/residents/${id}/deactivate`);
    expect((await c.post(`/api/residents/${id}/reactivate`)).body.isActive).toBe(true);
    expect((await (await client(app)).login('rahim@example.com', body.tempPassword)).status).toBe(200);
  });

  it('a resident whose stays already ended can be deactivated without an end date', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const unit = await makeUnit('4A', 4);
    const resident = await makeLoginUser('RESIDENT');
    await prisma.occupancy.create({
      data: { unitId: unit.id, residentId: resident.id, type: 'TENANT', startDate: d('2020-01-01'), endDate: d('2021-01-01') },
    });
    expect((await c.post(`/api/residents/${resident.id}/deactivate`)).status).toBe(200);
  });
});

describe('NFR-01 passwords are never exposed', () => {
  it('no resident endpoint returns a hash or lockout data', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    const { body } = await c.post('/api/residents', valid);
    const texts = [
      JSON.stringify((await c.get('/api/residents')).body),
      JSON.stringify((await c.get(`/api/residents/${body.resident.id}`)).body),
    ].join();
    expect(texts).not.toMatch(/passwordHash|\$2[aby]\$|failedLoginCount|lockedUntil/);
    expect(texts).not.toContain(PASSWORD);
  });
});
