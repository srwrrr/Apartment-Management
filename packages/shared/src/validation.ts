import { z } from 'zod';
import { PERMISSIONS } from './permissions';

const BD_MOBILE = /^(\+?88)?01[3-9]\d{8}$/;

/** Normalise a Bangladeshi mobile number to +8801XXXXXXXXX. Returns null if invalid. */
export function normalizePhone(input: string): string | null {
  const digits = input.trim().replace(/[\s-]/g, '');
  return BD_MOBILE.test(digits) ? '+88' + digits.replace(/^(\+?88)/, '') : null;
}

/** Normalise a login ID: lower-case email, or +8801XXXXXXXXX phone (BR-01). Returns null if invalid. */
export function normalizeLoginId(input: string): string | null {
  const v = input.trim();
  if (z.string().email().safeParse(v).success) return v.toLowerCase();
  return normalizePhone(v);
}

/** BR-02: at least 8 characters, one letter, one digit. */
export const passwordSchema = z
  .string()
  .min(8)
  .regex(/[A-Za-z]/, 'needs a letter')
  .regex(/\d/, 'needs a digit');

function isRealDate(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00Z`);
  // Date.parse returns NaN for month 13, and rolls 30 Feb over to 2 Mar; the round trip catches both.
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** A real calendar date as YYYY-MM-DD. */
export const ymdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'INVALID_DATE')
  .refine(isRealDate, 'INVALID_DATE');

// Custom refinement messages become machine codes in API errors (the web translates them).
const loginIdSchema = z
  .string()
  .trim()
  .max(254)
  .refine((v) => normalizeLoginId(v) !== null, 'LOGIN_ID_INVALID');
const phoneSchema = z
  .string()
  .trim()
  .refine((v) => normalizePhone(v) !== null, 'PHONE_INVALID');
const optionalPhone = z
  .string()
  .trim()
  .refine((v) => v === '' || normalizePhone(v) !== null, 'PHONE_INVALID')
  .nullish();
const optionalText = (max: number) => z.string().trim().max(max).nullish();

export const unitInputSchema = z.object({
  unitNumber: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9-]+$/),
  floor: z.number().int().min(-2).max(100),
  sizeSqft: z.number().int().positive().nullish(),
  bedrooms: z.number().int().min(0).max(20).nullish(),
});

/** FR-03: create a resident. */
export const residentCreateSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  loginId: loginIdSchema,
  phone: phoneSchema,
  altPhone: optionalPhone,
  emergencyContactName: optionalText(100),
  emergencyContactPhone: optionalPhone,
});
export const residentUpdateSchema = residentCreateSchema.partial();

/** FR-37: what a resident may change about themselves. */
export const selfProfileUpdateSchema = z.object({
  phone: phoneSchema.optional(),
  altPhone: optionalPhone,
  emergencyContactName: optionalText(100),
  emergencyContactPhone: optionalPhone,
});

/** FR-06: create a staff account. */
export const permissionEnum = z.enum(PERMISSIONS);
export const staffCreateSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  loginId: loginIdSchema,
  phone: phoneSchema,
  permissions: z.array(permissionEnum).max(PERMISSIONS.length).default([]),
});
export const staffUpdateSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  loginId: loginIdSchema.optional(),
  phone: phoneSchema.optional(),
});
export const staffPermissionsSchema = z.object({ permissions: z.array(permissionEnum).max(PERMISSIONS.length) });

/** FR-05 / BR-06: link a resident to a unit. */
export const occupancyCreateSchema = z
  .object({
    residentId: z.string().uuid(),
    type: z.enum(['OWNER', 'TENANT']),
    startDate: ymdSchema,
    endDate: ymdSchema.nullish(),
    isBillingContact: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'END_BEFORE_START' });
    }
  });

export const occupancyUpdateSchema = z
  .object({
    endDate: ymdSchema.optional(),
    isBillingContact: z.literal(true).optional(),
    newBillingContactOccupancyId: z.string().uuid().optional(),
  })
  .refine((v) => v.endDate !== undefined || v.isBillingContact !== undefined, 'NOTHING_TO_UPDATE');
