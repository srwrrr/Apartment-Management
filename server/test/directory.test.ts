import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { client, d, loginAs, makeLoginUser, makeUnit, resetDb } from './helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

async function lives(unitNumber: string, floor: number, name: string, phone: string, over: Record<string, unknown> = {}, occ: Record<string, unknown> = {}) {
  const unit = (await prisma.unit.findFirst({ where: { unitNumber } })) ?? (await makeUnit(unitNumber, floor));
  const user = await makeLoginUser('RESIDENT', [], { fullName: name, phone, ...over });
  await prisma.occupancy.create({
    data: { unitId: unit.id, residentId: user.id, type: 'TENANT', startDate: d('2020-01-01'), ...occ },
  });
  return user;
}
const names = (res: { body: { items: { resident: { fullName: string } }[] } }) => res.body.items.map((i) => i.resident.fullName);

describe('FR-08 who may open the directory', () => {
  it('401 anonymous; 403 residents and staff without directory.view; allowed with it and for admins', async () => {
    expect((await (await client(app)).get('/api/directory')).status).toBe(401);
    expect((await (await loginAs(app, 'RESIDENT')).c.get('/api/directory')).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF')).c.get('/api/directory')).status).toBe(403);
    // other permissions, even residents.manage, do not open it
    expect((await (await loginAs(app, 'STAFF', ['residents.manage', 'billing.view', 'reports.view'])).c.get('/api/directory')).status).toBe(403);
    expect((await (await loginAs(app, 'STAFF', ['directory.view'])).c.get('/api/directory')).status).toBe(200);
    expect((await (await loginAs(app, 'ADMIN')).c.get('/api/directory')).status).toBe(200);
  });
});

describe('FR-08 resident directory', () => {
  it('shows name, unit, owner/tenant and phone, and nothing financial or private', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    await lives('4B', 4, 'Rahim Rahman', '+8801712345678');
    const res = await c.get('/api/directory');
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toEqual({
      id: expect.any(String),
      type: 'TENANT',
      resident: { id: expect.any(String), fullName: 'Rahim Rahman', phone: '+8801712345678' },
      unit: { id: expect.any(String), unitNumber: '4B', floor: 4 },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/loginId|passwordHash|email|@test\.local|isBillingContact|balance|bill/i);
  });

  it('partial matches on name, unit number and phone, in any letter case', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    await lives('4B', 4, 'Rahim Rahman', '+8801712345678');
    await lives('1A', 1, 'Karim Ali', '+8801812345678');
    await lives('2C', 2, 'Selim Rahmani', '+8801912345678');
    expect(names(await c.get('/api/directory?q=rah')).sort()).toEqual(['Rahim Rahman', 'Selim Rahmani']);
    expect(names(await c.get('/api/directory?q=RAHMAN')).sort()).toEqual(['Rahim Rahman', 'Selim Rahmani']);
    expect(names(await c.get('/api/directory?q=4b'))).toEqual(['Rahim Rahman']);
    expect(names(await c.get('/api/directory?q=01812345678'))).toEqual(['Karim Ali']); // typed the local way, stored as +880…
    expect(names(await c.get('/api/directory?q=0181 234'))).toEqual(['Karim Ali']); // spaces are ignored
    expect(names(await c.get('/api/directory?q=%2B8801812'))).toEqual(['Karim Ali']);
    expect(names(await c.get('/api/directory?q=1234'))).toHaveLength(3);
    expect(names(await c.get('/api/directory?q=nobody'))).toEqual([]);
  });

  it('lists only people who live there now: not moved-out, not future, not deactivated', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    await lives('1A', 1, 'Current Resident', '+8801711111111');
    await lives('1B', 1, 'Moved Out', '+8801722222222', {}, { endDate: d('2021-12-31') });
    await lives('1C', 1, 'Not Yet Arrived', '+8801733333333', {}, { startDate: d('2999-01-01') });
    await lives('1D', 1, 'Deactivated', '+8801744444444', { isActive: false });
    expect(names(await c.get('/api/directory'))).toEqual(['Current Resident']);
  });

  it('shows every occupant of a shared unit, owners before tenants, ordered by floor then unit', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    await lives('3B', 3, 'Third Floor B', '+8801711111111');
    await lives('1A', 1, 'First Floor A Tenant', '+8801722222222');
    await lives('1A', 1, 'First Floor A Owner', '+8801733333333', {}, { type: 'OWNER' });
    expect(names(await c.get('/api/directory'))).toEqual(['First Floor A Owner', 'First Floor A Tenant', 'Third Floor B']);
  });

  it('paginates', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    for (let i = 1; i <= 5; i++) await lives(`${i}A`, i, `Person ${i}`, `+88017000000${i}0`);
    const res = await c.get('/api/directory?pageSize=2&page=3');
    expect(res.body).toMatchObject({ page: 3, pageSize: 2, total: 5 });
    expect(names(res)).toEqual(['Person 5']);
  });

  it('a search cannot be used to inject filters', async () => {
    const { c } = await loginAs(app, 'ADMIN');
    await lives('1A', 1, 'Safe Person', '+8801711111111');
    const res = await c.get(`/api/directory?q=${encodeURIComponent("' OR 1=1 --")}`);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual([]);
  });
});
