// Shared helpers for creating and describing user accounts (residents and staff).
import { Prisma } from '@prisma/client';
import { normalizeLoginId, normalizePhone } from '@apt/shared';
import { ApiError } from '../../lib/errors';
import { hashPassword } from './auth.service';
import { generateTempPassword } from './password';

/** Never includes passwordHash, failed-login counters, or anything else private. */
export const publicUserSelect = {
  id: true,
  loginId: true,
  fullName: true,
  phone: true,
  role: true,
  language: true,
  isActive: true,
  mustChangePassword: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export const normLogin = (v: string) => normalizeLoginId(v)!; // already validated by the Zod schema
export const normPhone = (v: string) => normalizePhone(v)!;
/** '' (cleared field) and null both mean "no value". */
export const optionalPhone = (v: string | null | undefined) => (v ? normalizePhone(v) : null);

export async function newTempPassword() {
  const tempPassword = generateTempPassword();
  return { tempPassword, passwordHash: await hashPassword(tempPassword) };
}

/** Turns "login ID already used" into a field error (BR-01). */
export function mapLoginIdTaken(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new ApiError(409, 'CONFLICT', { loginId: { code: 'LOGIN_ID_TAKEN' } });
  }
  throw e;
}
