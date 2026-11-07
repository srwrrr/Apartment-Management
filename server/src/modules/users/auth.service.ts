import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { normalizeLoginId, passwordSchema } from '@apt/shared';
import { BCRYPT_COST } from '../../config';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';

export const MAX_FAILED_LOGINS = 5; // BR-02
export const LOCK_MINUTES = 15; // BR-02

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_COST);

// Compared against when the login ID doesn't exist, so response time doesn't reveal which IDs are real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

/** FR-01 / BR-02. Returns the user on success; throws ApiError otherwise. */
export async function verifyLogin(loginIdInput: string, password: string): Promise<User> {
  const loginId = normalizeLoginId(loginIdInput) ?? loginIdInput.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { loginId } });

  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw new ApiError(401, 'INVALID_CREDENTIALS');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new ApiError(423, 'LOCKED');
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    if (failed >= MAX_FAILED_LOGINS) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
      });
      throw new ApiError(423, 'LOCKED');
    }
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: failed } });
    throw new ApiError(401, 'INVALID_CREDENTIALS');
  }

  // A deactivated account gets the same message as a wrong password (BR-03).
  if (!user.isActive) throw new ApiError(401, 'INVALID_CREDENTIALS');

  if (user.failedLoginCount > 0 || user.lockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  }
  return user;
}

/** FR-31: change own password. Ends the user's other sessions. */
export async function changePassword(userId: string, currentSessionId: string, current: string, next: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(current, user.passwordHash))) {
    throw new ApiError(400, 'VALIDATION_FAILED', { currentPassword: { code: 'WRONG_PASSWORD' } });
  }
  const parsed = passwordSchema.safeParse(next);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_FAILED', { newPassword: { code: 'PASSWORD_TOO_WEAK' } });
  }
  if (next === current) {
    throw new ApiError(400, 'VALIDATION_FAILED', { newPassword: { code: 'PASSWORD_UNCHANGED' } });
  }
  const passwordHash = await hashPassword(next);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: false } }),
    prisma.$executeRaw`DELETE FROM "session" WHERE "userId" = ${userId}::uuid AND sid <> ${currentSessionId}`,
  ]);
}
