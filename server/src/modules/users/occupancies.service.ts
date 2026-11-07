import { Prisma, type Occupancy } from '@prisma/client';
import { z } from 'zod';
import { occupancyCreateSchema, occupancyUpdateSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, notFound } from '../../lib/errors';
import { dateOnly } from '../../lib/dates';
import { logActivity } from '../activity/activity';

type Tx = Prisma.TransactionClient;
const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');

/** The database also enforces these rules (race-proof); this turns its errors into clear API errors. */
export function mapOccupancyError(e: unknown): never {
  const msg = e instanceof Error ? e.message : '';
  if (msg.includes('occupancies_no_overlap')) throw new ApiError(409, 'OCCUPANCY_OVERLAP');
  if (msg.includes('occupancies_one_billing_contact')) throw new ApiError(409, 'BILLING_CONTACT_EXISTS');
  if (msg.includes('occupancies_dates_chk')) {
    throw new ApiError(400, 'VALIDATION_FAILED', { endDate: { code: 'END_BEFORE_START' } });
  }
  throw e;
}

const withResident = {
  resident: { select: { id: true, fullName: true, phone: true, isActive: true } },
  unit: { select: { id: true, unitNumber: true, floor: true } },
} satisfies Prisma.OccupancyInclude;

/**
 * Ends a stay (BR-06, BR-27). Household members lose access from the same day.
 * If this was the unit's billing contact and others still live there, the contact moves to
 * `newContactId` if given, otherwise to the earliest-arrived owner (else tenant).
 */
export async function endOccupancy(tx: Tx, occ: Occupancy, end: Date, newContactId?: string) {
  if (end < occ.startDate) throw new ApiError(400, 'VALIDATION_FAILED', { endDate: { code: 'END_BEFORE_START' } });

  const wasActiveContact = occ.isBillingContact && occ.endDate === null;
  const others = await tx.occupancy.findMany({
    where: { unitId: occ.unitId, id: { not: occ.id }, endDate: null },
    orderBy: [{ type: 'asc' }, { startDate: 'asc' }], // OWNER is declared before TENANT
  });
  if (newContactId !== undefined && !others.some((o) => o.id === newContactId)) {
    throw new ApiError(400, 'VALIDATION_FAILED', { newBillingContactOccupancyId: { code: 'NEW_BILLING_CONTACT_INVALID' } });
  }

  // Setting the end date first frees the "one active billing contact" slot.
  await tx.occupancy.update({ where: { id: occ.id }, data: { endDate: end } });

  const members = await tx.householdMember.findMany({ where: { occupancyId: occ.id, removedAt: null } });
  for (const m of members) {
    await tx.householdMember.update({ where: { id: m.id }, data: { removedAt: end < m.addedAt ? m.addedAt : end } });
  }

  if (wasActiveContact && others.length > 0) {
    const next = newContactId ?? others[0]!.id;
    await tx.occupancy.update({ where: { id: next }, data: { isBillingContact: true } });
  }
}

export async function listUnitOccupancies(unitId: string) {
  assertUuid(unitId);
  if (!(await prisma.unit.findUnique({ where: { id: unitId }, select: { id: true } }))) throw notFound();
  return prisma.occupancy.findMany({
    where: { unitId },
    include: withResident,
    orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
  });
}

/** FR-05: link a resident to a unit as owner or tenant. */
export async function createOccupancy(unitId: string, input: z.infer<typeof occupancyCreateSchema>) {
  assertUuid(unitId);
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) throw notFound();
  if (!unit.isAvailable) throw new ApiError(409, 'UNIT_UNAVAILABLE'); // BR-05

  const resident = await prisma.user.findFirst({ where: { id: input.residentId, role: 'RESIDENT', isActive: true } });
  if (!resident) {
    throw new ApiError(400, 'VALIDATION_FAILED', { residentId: { code: 'RESIDENT_NOT_FOUND' } });
  }

  const start = dateOnly(input.startDate);
  const end = input.endDate ? dateOnly(input.endDate) : null;
  const isOpen = end === null;

  try {
    return await prisma.$transaction(async (tx) => {
      const overlap = await tx.occupancy.findFirst({
        where: {
          unitId,
          residentId: resident.id,
          startDate: { lte: end ?? FAR_FUTURE },
          OR: [{ endDate: null }, { endDate: { gte: start } }],
        },
      });
      if (overlap) throw new ApiError(409, 'OCCUPANCY_OVERLAP');

      let isBillingContact = input.isBillingContact ?? false;
      if (isOpen) {
        const hasContact = await tx.occupancy.findFirst({ where: { unitId, isBillingContact: true, endDate: null } });
        if (isBillingContact && hasContact) throw new ApiError(409, 'BILLING_CONTACT_EXISTS');
        if (!hasContact) isBillingContact = true; // BR-06: an occupied unit always has a billing contact
      }

      const created = await tx.occupancy.create({
        data: { unitId, residentId: resident.id, type: input.type, startDate: start, endDate: end, isBillingContact },
        include: withResident,
      });
      await logActivity(tx, 'occupancy.create', {
        entityType: 'occupancy',
        entityId: created.id,
        details: { unit: unit.unitNumber, fullName: resident.fullName, type: input.type, startDate: input.startDate },
      });
      return created;
    });
  } catch (e) {
    return mapOccupancyError(e);
  }
}

/** Record the end of a stay, or make this occupant the billing contact. */
export async function updateOccupancy(id: string, input: z.infer<typeof occupancyUpdateSchema>) {
  assertUuid(id);
  const occ = await prisma.occupancy.findUnique({ where: { id } });
  if (!occ) throw notFound();

  try {
    await prisma.$transaction(async (tx) => {
      if (input.endDate !== undefined) {
        if (occ.endDate !== null) throw new ApiError(409, 'OCCUPANCY_ALREADY_ENDED');
        await endOccupancy(tx, occ, dateOnly(input.endDate), input.newBillingContactOccupancyId);
      }
      if (input.isBillingContact) {
        const fresh = await tx.occupancy.findUniqueOrThrow({ where: { id } });
        if (fresh.endDate !== null) throw new ApiError(409, 'OCCUPANCY_NOT_ACTIVE');
        // Unset the old contact first so the one-contact-per-unit index is never violated.
        await tx.occupancy.updateMany({
          where: { unitId: fresh.unitId, isBillingContact: true, endDate: null, id: { not: id } },
          data: { isBillingContact: false },
        });
        await tx.occupancy.update({ where: { id }, data: { isBillingContact: true } });
      }
      await logActivity(tx, 'occupancy.update', { entityType: 'occupancy', entityId: id, details: { endDate: input.endDate, isBillingContact: input.isBillingContact } });
    });
  } catch (e) {
    return mapOccupancyError(e);
  }
  return prisma.occupancy.findUniqueOrThrow({ where: { id }, include: withResident });
}
