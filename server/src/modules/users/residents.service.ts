import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { residentCreateSchema, residentUpdateSchema, ymdSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, notFound } from '../../lib/errors';
import { dateOnly } from '../../lib/dates';
import { endAllSessions } from './auth.service';
import { activeOccupancyWhere } from './units.service';
import { changes, logActivity } from '../activity/activity';
import { endOccupancy } from './occupancies.service';
import {
  mapLoginIdTaken,
  newTempPassword,
  normLogin,
  normPhone,
  optionalPhone,
  publicUserSelect,
} from './accounts';

export const listResidentsSchema = z.object({
  q: z.string().trim().max(50).optional(),
  active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const deactivateSchema = z.object({ endDate: ymdSchema.optional() });

const profileSelect = { altPhone: true, emergencyContactName: true, emergencyContactPhone: true };

const detailSelect = {
  ...publicUserSelect,
  profile: { select: profileSelect },
  occupancies: {
    orderBy: { startDate: 'desc' },
    include: { unit: { select: { id: true, unitNumber: true, floor: true } } },
  },
} satisfies Prisma.UserSelect;

async function findResident(id: string) {
  assertUuid(id);
  const r = await prisma.user.findFirst({ where: { id, role: 'RESIDENT' }, select: detailSelect });
  if (!r) throw notFound();
  return r;
}

/** FR-03: create a resident with a temporary password the admin hands over (shown once). */
export async function createResident(input: z.infer<typeof residentCreateSchema>) {
  const { tempPassword, passwordHash } = await newTempPassword();
  try {
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          loginId: normLogin(input.loginId),
          passwordHash,
          role: 'RESIDENT',
          fullName: input.fullName,
          phone: normPhone(input.phone),
          mustChangePassword: true,
          profile: {
            create: {
              altPhone: optionalPhone(input.altPhone),
              emergencyContactName: input.emergencyContactName || null,
              emergencyContactPhone: optionalPhone(input.emergencyContactPhone),
            },
          },
        },
        select: { id: true },
      });
      await logActivity(tx, 'resident.create', { entityType: 'user', entityId: u.id, details: { fullName: input.fullName } });
      return u;
    });
    return { resident: await findResident(user.id), tempPassword };
  } catch (e) {
    return mapLoginIdTaken(e);
  }
}

export async function listResidents(input: z.infer<typeof listResidentsSchema>) {
  const where: Prisma.UserWhereInput = { role: 'RESIDENT' };
  if (input.active) where.isActive = input.active === 'true';
  if (input.q) {
    where.OR = [
      { fullName: { contains: input.q, mode: 'insensitive' } },
      { phone: { contains: input.q } },
      { loginId: { contains: input.q, mode: 'insensitive' } },
    ];
  }
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        ...publicUserSelect,
        occupancies: {
          where: activeOccupancyWhere(),
          select: { type: true, unit: { select: { id: true, unitNumber: true } } },
        },
      },
    }),
  ]);
  return { items: rows, page: input.page, pageSize: input.pageSize, total };
}

export const getResident = findResident;

export async function updateResident(id: string, input: z.infer<typeof residentUpdateSchema>) {
  const before = await findResident(id);
  const profile: Prisma.ResidentProfileUpdateInput = {};
  if (input.altPhone !== undefined) profile.altPhone = optionalPhone(input.altPhone);
  if (input.emergencyContactName !== undefined) profile.emergencyContactName = input.emergencyContactName || null;
  if (input.emergencyContactPhone !== undefined) profile.emergencyContactPhone = optionalPhone(input.emergencyContactPhone);

  try {
    const fields = {
      ...(input.fullName !== undefined && { fullName: input.fullName }),
      ...(input.loginId !== undefined && { loginId: normLogin(input.loginId) }),
      ...(input.phone !== undefined && { phone: normPhone(input.phone) }),
    };
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { ...fields, profile: { upsert: { create: { ...profile } as Prisma.ResidentProfileCreateWithoutUserInput, update: profile } } },
      });
      await logActivity(tx, 'resident.update', { entityType: 'user', entityId: id, details: { fullName: before.fullName, changes: changes(before, fields) } });
    });
  } catch (e) {
    mapLoginIdTaken(e);
  }
  return findResident(id);
}

/**
 * Deactivate a resident who has moved out, keeping all history (FR-03, BR-03).
 * Open-ended stays need an end date, which is applied to all of them together.
 */
export async function deactivateResident(id: string, endDate?: string) {
  const resident = await findResident(id);
  if (!resident.isActive) return resident;

  await prisma.$transaction(async (tx) => {
    const active = await tx.occupancy.findMany({ where: { residentId: id, ...activeOccupancyWhere(), endDate: null } });
    if (active.length > 0) {
      if (!endDate) throw new ApiError(400, 'VALIDATION_FAILED', { endDate: { code: 'END_DATE_REQUIRED' } });
      for (const occ of active) await endOccupancy(tx, occ, dateOnly(endDate));
    }
    await tx.user.update({ where: { id }, data: { isActive: false } });
    await endAllSessions(tx, id);
    await logActivity(tx, 'resident.deactivate', { entityType: 'user', entityId: id, details: { fullName: resident.fullName, endDate: endDate ?? null } });
  });
  return findResident(id);
}

export async function reactivateResident(id: string) {
  const resident = await findResident(id);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { isActive: true } });
    await logActivity(tx, 'resident.reactivate', { entityType: 'user', entityId: id, details: { fullName: resident.fullName } });
  });
  return findResident(id);
}
