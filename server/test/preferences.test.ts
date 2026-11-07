import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { pool } from '../src/lib/pool';
import { client, loginAs, resetDb } from './helpers';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
  await pool.end();
});

describe('FR-47 / FR-55 language and text size', () => {
  it('every role can save their own language and text size', async () => {
    for (const role of ['RESIDENT', 'STAFF', 'ADMIN'] as const) {
      const { c, user } = await loginAs(app, role);
      const res = await c.patch('/api/me/preferences', { language: 'BN', textSize: 'LARGE' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ language: 'BN', textSize: 'LARGE' });
      const saved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(saved).toMatchObject({ language: 'BN', textSize: 'LARGE' });
      expect((await c.get('/api/auth/me')).body.user).toMatchObject({ language: 'BN', textSize: 'LARGE' });
    }
  });

  it('can change just one setting', async () => {
    const { c } = await loginAs(app, 'RESIDENT');
    await c.patch('/api/me/preferences', { language: 'BN' });
    const res = await c.patch('/api/me/preferences', { textSize: 'LARGE' });
    expect(res.body).toEqual({ language: 'BN', textSize: 'LARGE' });
  });

  it('rejects unknown values and unknown fields (no privilege changes through here)', async () => {
    const { c, user } = await loginAs(app, 'RESIDENT');
    expect((await c.patch('/api/me/preferences', { language: 'FR' })).status).toBe(400);
    expect((await c.patch('/api/me/preferences', { role: 'ADMIN' })).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('RESIDENT');
  });

  it('needs login', async () => {
    expect((await (await client(app)).patch('/api/me/preferences', { language: 'BN' })).status).toBe(401);
  });
});
