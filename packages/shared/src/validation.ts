import { z } from 'zod';

const BD_MOBILE = /^(\+?88)?01[3-9]\d{8}$/;

/** Normalise a login ID: lower-case email, or +8801XXXXXXXXX phone (BR-01). Returns null if invalid. */
export function normalizeLoginId(input: string): string | null {
  const v = input.trim();
  if (z.string().email().safeParse(v).success) return v.toLowerCase();
  const digits = v.replace(/[\s-]/g, '');
  if (BD_MOBILE.test(digits)) return '+88' + digits.replace(/^(\+?88)/, '');
  return null;
}

/** BR-02: at least 8 characters, one letter, one digit. */
export const passwordSchema = z
  .string()
  .min(8)
  .regex(/[A-Za-z]/, 'needs a letter')
  .regex(/\d/, 'needs a digit');

export const unitInputSchema = z.object({
  unitNumber: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9-]+$/),
  floor: z.number().int().min(-2).max(100),
  sizeSqft: z.number().int().positive().nullish(),
  bedrooms: z.number().int().min(0).max(20).nullish(),
});
