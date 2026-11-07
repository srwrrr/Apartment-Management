import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { staffCreateSchema, staffUpdateSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, notFound } from '../../lib/errors';
import { endAllSessions } from './auth.service';
import { mapLoginIdTaken, newTempPassword, normLogin, normPhone, publicUserSelect } from './accounts';

const staffSelect = {
  ...publicUserSelect,
  permissions: { select: { permission: true }, orderBy: { permission: 'asc' } },
} satisfies Prisma.UserSelect;

type StaffRow = Prisma.UserGetPayload<{ select: typeof staffSelect }>;
const shape = ({ permissions, ...u }: StaffRow) => ({ ...u, permissions: permissions.map((p) => p.permission) });

async function findStaff(id: string) {
  assertUuid(id);
  const s = await prisma.user.findFirst({ where: { id, role: 'STAFF' }, select: staffSelect });
  if (!s) throw notFound();
  return shape(s);
}

export async function listStaff() {
  const rows = await prisma.user.findMany({
    where: { role: 'STAFF' },
    orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    select: staffSelect,
  });
  return { items: rows.map(shape) };
}

export const getStaff = findStaff;

/** FR-06: a new staff account has only the permissions the admin ticks (none by default). */
export async function createStaff(input: z.infer<typeof staffCreateSchema>) {
  const { tempPassword, passwordHash } = await newTempPassword();
  const permissions = [...new Set(input.permissions)];
  try {
    const user = await prisma.user.create({
      data: {
        loginId: normLogin(input.loginId),
        passwordHash,
        role: 'STAFF',
        fullName: input.fullName,
        phone: normPhone(input.phone),
        mustChangePassword: true,
        permissions: { create: permissions.map((permission) => ({ permission })) },
      },
      select: { id: true },
    });
    return { staff: await findStaff(user.id), tempPassword };
  } catch (e) {
    return mapLoginIdTaken(e);
  }
}

export async function updateStaff(id: string, input: z.infer<typeof staffUpdateSchema>) {
  await findStaff(id);
  try {
    await prisma.user.update({
      where: { id },
      data: {
        ...(input.fullName !== undefined && { fullName: input.fullName }),
        ...(input.loginId !== undefined && { loginId: normLogin(input.loginId) }),
        ...(input.phone !== undefined && { phone: normPhone(input.phone) }),
      },
    });
  } catch (e) {
    mapLoginIdTaken(e);
  }
  return findStaff(id);
}

/** Replaces the staff member's whole permission list. Takes effect on their next request. */
export async function setStaffPermissions(id: string, permissions: string[]) {
  await findStaff(id);
  const unique = [...new Set(permissions)];
  await prisma.$transaction([
    prisma.staffPermission.deleteMany({ where: { userId: id } }),
    prisma.staffPermission.createMany({ data: unique.map((permission) => ({ userId: id, permission })) }),
  ]);
  return findStaff(id);
}

export async function setStaffActive(id: string, isActive: boolean) {
  await findStaff(id);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { isActive } });
    if (!isActive) await endAllSessions(tx, id); // a deactivated staff member can no longer use the system (FR-06)
  });
  return findStaff(id);
}

/** FR-31: admin resets any user's password to a new temporary one. Ends all their sessions. */
export async function resetPassword(actorId: string, id: string) {
  assertUuid(id);
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) throw notFound();
  if (id === actorId) throw new ApiError(400, 'CANNOT_RESET_OWN_PASSWORD'); // use change-password instead
  const { tempPassword, passwordHash } = await newTempPassword();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await endAllSessions(tx, id);
  });
  return { tempPassword };
}
