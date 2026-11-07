import { describe, expect, it } from 'vitest';
import { normalizeLoginId, passwordSchema } from './validation';

describe('BR-01 login ID', () => {
  it('lower-cases emails', () => expect(normalizeLoginId(' Rahim@Example.COM ')).toBe('rahim@example.com'));
  it('normalises BD phones', () => {
    expect(normalizeLoginId('01712345678')).toBe('+8801712345678');
    expect(normalizeLoginId('+8801712345678')).toBe('+8801712345678');
    expect(normalizeLoginId('8801712 345678')).toBe('+8801712345678');
  });
  it('rejects junk', () => {
    expect(normalizeLoginId('12345')).toBeNull();
    expect(normalizeLoginId('01212345678')).toBeNull();
  });
});

describe('BR-02 password', () => {
  it('accepts valid', () => expect(passwordSchema.safeParse('Admin1234').success).toBe(true));
  it('rejects short / no digit / no letter', () => {
    expect(passwordSchema.safeParse('Ab1').success).toBe(false);
    expect(passwordSchema.safeParse('abcdefgh').success).toBe(false);
    expect(passwordSchema.safeParse('12345678').success).toBe(false);
  });
});

import { occupancyCreateSchema, residentCreateSchema, staffCreateSchema, ymdSchema } from './validation';

describe('shared schemas', () => {
  it('ymdSchema accepts real dates only', () => {
    expect(ymdSchema.safeParse('2026-02-28').success).toBe(true);
    expect(ymdSchema.safeParse('2026-02-30').success).toBe(false);
    expect(ymdSchema.safeParse('28/02/2026').success).toBe(false);
    expect(ymdSchema.safeParse('2026-13-01').success).toBe(false); // must not throw
    expect(ymdSchema.safeParse('2026-00-10').success).toBe(false);
    expect(ymdSchema.safeParse(20260228).success).toBe(false);
  });
  it('resident needs a valid login ID and BD phone', () => {
    const ok = { fullName: 'রহিম উদ্দিন', loginId: 'rahim@example.com', phone: '01712345678' };
    expect(residentCreateSchema.safeParse(ok).success).toBe(true); // Bangla names allowed
    expect(residentCreateSchema.safeParse({ ...ok, loginId: 'nope' }).success).toBe(false);
    expect(residentCreateSchema.safeParse({ ...ok, phone: '123' }).success).toBe(false);
    expect(residentCreateSchema.safeParse({ ...ok, fullName: 'A' }).success).toBe(false);
  });
  it('staff permissions must be known ones', () => {
    const base = { fullName: 'Karim', loginId: 'karim@example.com', phone: '01712345678' };
    expect(staffCreateSchema.safeParse({ ...base, permissions: ['units.manage'] }).success).toBe(true);
    expect(staffCreateSchema.safeParse({ ...base, permissions: ['everything'] }).success).toBe(false);
  });
  it('BR-06 occupancy end date cannot be before start', () => {
    const base = { residentId: '3ed6d62d-76b2-4558-87b4-8db3f4c4598a', type: 'TENANT' as const, startDate: '2026-05-10' };
    expect(occupancyCreateSchema.safeParse({ ...base, endDate: '2026-05-01' }).success).toBe(false);
    expect(occupancyCreateSchema.safeParse({ ...base, endDate: '2026-05-10' }).success).toBe(true);
    expect(occupancyCreateSchema.safeParse(base).success).toBe(true);
  });
});
