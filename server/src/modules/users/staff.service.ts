import { Prisma } from '@prisma/client';
import { changes, logActivity } from '../activity/activity';
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
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
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
      await logActivity(tx, 'staff.create', { entityType: 'user', entityId: u.id, details: { fullName: input.fullName, permissions } });
      return u;
    });
    return { staff: await findStaff(user.id), tempPassword };
  } catch (e) {
    return mapLoginIdTaken(e);
  }
}

export async function updateStaff(id: string, input: z.infer<typeof staffUpdateSchema>) {
  const before = await findStaff(id);
  try {
    const fields = {
      ...(input.fullName !== undefined && { fullName: input.fullName }),
      ...(input.loginId !== undefined && { loginId: normLogin(input.loginId) }),
      ...(input.phone !== undefined && { phone: normPhone(input.phone) }),
    };
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: fields });
      await logActivity(tx, 'staff.update', { entityType: 'user', entityId: id, details: { fullName: before.fullName, changes: changes(before, fields) } });
    });
  } catch (e) {
    mapLoginIdTaken(e);
  }
  return findStaff(id);
}

/** Replaces the staff member's whole permission list. Takes effect on their next request. */
export async function setStaffPermissions(id: string, permissions: string[]) {
  const before = await findStaff(id);
  const unique = [...new Set(permissions)];
  await prisma.$transaction(async (tx) => {
    await tx.staffPermission.deleteMany({ where: { userId: id } });
    await tx.staffPermission.createMany({ data: unique.map((permission) => ({ userId: id, permission })) });
    await logActivity(tx, 'staff.permissions', { entityType: 'user', entityId: id, details: { fullName: before.fullName, before: before.permissions, after: unique } });
  });
  return findStaff(id);
}

export async function setStaffActive(id: string, isActive: boolean) {
  const staff = await findStaff(id);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { isActive } });
    if (!isActive) await endAllSessions(tx, id); // a deactivated staff member can no longer use the system (FR-06)
    await logActivity(tx, isActive ? 'staff.activate' : 'staff.deactivate', { entityType: 'user', entityId: id, details: { fullName: staff.fullName } });
  });
  return findStaff(id);
}

/** FR-31: admin resets any user's password to a new temporary one. Ends all their sessions. */
export async function resetPassword(actorId: string, id: string) {
  assertUuid(id);
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, fullName: true } });
  if (!user) throw notFound();
  if (id === actorId) throw new ApiError(400, 'CANNOT_RESET_OWN_PASSWORD'); // use change-password instead
  const { tempPassword, passwordHash } = await newTempPassword();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await endAllSessions(tx, id);
    await logActivity(tx, 'password.reset', { entityType: 'user', entityId: id, details: { fullName: user.fullName } });
  });
  return { tempPassword };
}
