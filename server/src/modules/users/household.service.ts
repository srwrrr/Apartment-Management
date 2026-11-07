import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { householdMemberCreateSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, notFound } from '../../lib/errors';
import { dateOnly, todayDhaka, ymdOf } from '../../lib/dates';
import { logActivity } from '../activity/activity';
import { endAllSessions } from './auth.service';
import { mapLoginIdTaken, newTempPassword, normLogin, normPhone } from './accounts';

type Tx = Prisma.TransactionClient;

/** A household member with no home left cannot log in any more (FR-54). Their history stays. */
export async function closeAccountIfNoHome(tx: Tx, userId: string) {
  const today = dateOnly(todayDhaka());
  const [stays, memberships] = await Promise.all([
    tx.occupancy.count({ where: { residentId: userId, OR: [{ endDate: null }, { endDate: { gt: today } }] } }),
    tx.householdMember.count({ where: { userId, OR: [{ removedAt: null }, { removedAt: { gt: today } }] } }),
  ]);
  if (stays + memberships > 0) return;
  await tx.user.update({ where: { id: userId }, data: { isActive: false } });
  await endAllSessions(tx, userId);
}

/** FR-54: a family member gets their own login, and a temporary password to change at first login (FR-31). */
export async function addHouseholdMember(occupancyId: string, input: z.infer<typeof householdMemberCreateSchema>) {
  assertUuid(occupancyId);
  const { tempPassword, passwordHash } = await newTempPassword();
  const loginId = normLogin(input.loginId);
  const today = todayDhaka();
  try {
    const member = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "occupancies" WHERE id = ${occupancyId}::uuid FOR UPDATE`;
      if (rows.length === 0) throw notFound();
      const occ = await tx.occupancy.findUniqueOrThrow({ where: { id: occupancyId }, include: { resident: { select: { phone: true } }, unit: { select: { unitNumber: true } } } });
      if (occ.endDate && ymdOf(occ.endDate) <= today) throw new ApiError(409, 'OCCUPANCY_ENDED');

      const phone = input.phone ? normPhone(input.phone) : loginId.startsWith('+') ? loginId : occ.resident.phone;
      const user = await tx.user.create({
        data: { loginId, passwordHash, role: 'RESIDENT', fullName: input.fullName, phone, mustChangePassword: true },
        select: { id: true, fullName: true, loginId: true },
      });
      const m = await tx.householdMember.create({
        data: { occupancyId, userId: user.id, relation: input.relation, addedAt: dateOnly(today) },
        select: { id: true, relation: true, addedAt: true },
      });
      await logActivity(tx, 'household.add', { entityType: 'user', entityId: user.id, details: { fullName: user.fullName, relation: input.relation, unit: occ.unit.unitNumber } });
      return { id: m.id, relation: m.relation, addedAt: ymdOf(m.addedAt), user };
    });
    return { member, tempPassword };
  } catch (e) {
    return mapLoginIdTaken(e);
  }
}

/** FR-54: they stop having access at once, and everything they did stays on record. */
export async function removeHouseholdMember(id: string) {
  assertUuid(id);
  await prisma.$transaction(async (tx) => {
    const m = await tx.householdMember.findUnique({ where: { id }, include: { user: { select: { fullName: true } } } });
    if (!m) throw notFound();
    if (m.removedAt) return;
    await tx.householdMember.update({ where: { id }, data: { removedAt: dateOnly(todayDhaka()) } });
    await closeAccountIfNoHome(tx, m.userId);
    await logActivity(tx, 'household.remove', { entityType: 'user', entityId: m.userId, details: { fullName: m.user.fullName } });
  });
}
