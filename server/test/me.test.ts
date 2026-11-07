import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { client, d, loginAs, makeUnit, resetDb } from './helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

async function residentIn(unitNumber: string, name: string) {
  const unit = await makeUnit(unitNumber, 1);
  const me = await loginAs(app, 'RESIDENT', [], { fullName: name });
  await prisma.occupancy.create({
    data: { unitId: unit.id, residentId: me.user.id, type: 'TENANT', startDate: d('2025-01-01') },
  });
  return { ...me, unit };
}

describe('FR-07 view my profile and apartment information', () => {
  it('shows my details and my unit, and nothing of anyone else', async () => {
    const a = await residentIn('1A', 'Alice Rahman');
    const b = await residentIn('1B', 'Bob Karim');
    const res = await a.c.get('/api/me/profile');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: a.user.id, fullName: 'Alice Rahman' });
    expect(res.body.occupancies).toHaveLength(1);
    expect(res.body.occupancies[0].unit.unitNumber).toBe('1A');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('Bob Karim'); // NFR-24
    expect(text).not.toContain(b.user.loginId);
    expect(text).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('401 anonymous; 403 for staff and admins (no resident profile)', async () => {
    expect((await (await client(app)).get('/api/me/profile')).status).toBe(401);
    expect((await (await loginAs(app, 'STAFF')).c.get('/api/me/profile')).status).toBe(403);
    expect((await (await loginAs(app, 'ADMIN')).c.get('/api/me/profile')).status).toBe(403);
  });

  it('there is no way to ask for another resident by ID', async () => {
    const a = await residentIn('1A', 'Alice');
    const b = await residentIn('1B', 'Bob');
    const res = await a.c.get(`/api/me/profile?id=${b.user.id}`);
    expect(res.body.id).toBe(a.user.id);
    expect((await a.c.get(`/api/residents/${b.user.id}`)).status).toBe(403);
  });
});

describe('FR-37 update my contact details', () => {
  it('changes my phone and emergency contact', async () => {
    const a = await residentIn('1A', 'Alice');
    const res = await a.c.patch('/api/me/profile', {
      phone: '01711111111',
      altPhone: '01822222222',
      emergencyContactName: 'Mother',
      emergencyContactPhone: '01933333333',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      phone: '+8801711111111',
      profile: { altPhone: '+8801822222222', emergencyContactName: 'Mother', emergencyContactPhone: '+8801933333333' },
    });
  });

  it('can clear optional fields', async () => {
    const a = await residentIn('1A', 'Alice');
    await a.c.patch('/api/me/profile', { altPhone: '01822222222' });
    const res = await a.c.patch('/api/me/profile', { altPhone: '' });
    expect(res.body.profile.altPhone).toBeNull();
  });

  it('cannot change name, login ID, role, or unit', async () => {
    const a = await residentIn('1A', 'Alice');
    for (const body of [{ fullName: 'Mallory' }, { loginId: 'x@y.com' }, { role: 'ADMIN' }, { unitId: 'x' }]) {
      const res = await a.c.patch('/api/me/profile', body);
      expect(res.status).toBe(400);
    }
    const after = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } });
    expect(after.fullName).toBe('Alice');
    expect(after.role).toBe('RESIDENT');
  });

  it('rejects an invalid phone number', async () => {
    const a = await residentIn('1A', 'Alice');
    const res = await a.c.patch('/api/me/profile', { phone: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.phone.code).toBe('PHONE_INVALID');
  });
});
