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
