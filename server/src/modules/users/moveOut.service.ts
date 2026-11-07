import { z } from 'zod';
import { moveOutSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, notFound } from '../../lib/errors';
import { dateOnly, todayDhaka, ymdOf } from '../../lib/dates';
import { issueCertificateIn, unitDues } from '../billing/certificates.service';
import { notify } from '../notifications/notify';
import { logActivity } from '../activity/activity';
import { endAllSessions } from './auth.service';
import { endOccupancy, mapOccupancyError } from './occupancies.service';

const OPEN_REQUESTS = ['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS'] as const;

/** Does this person still live somewhere else, in their own stay or as someone's household member? */
async function livesElsewhere(db: Pick<typeof prisma, 'occupancy' | 'householdMember'>, residentId: string, occupancyId: string) {
  const [own, member] = await Promise.all([
    db.occupancy.count({ where: { residentId, id: { not: occupancyId }, endDate: null } }),
    db.householdMember.count({ where: { userId: residentId, removedAt: null, occupancyId: { not: occupancyId }, occupancy: { endDate: null } } }),
  ]);
  return own + member > 0;
}

/** FR-56: everything the administrator should see before deciding. Changes nothing. */
export async function moveOutPreview(id: string) {
  assertUuid(id);
  const occ = await prisma.occupancy.findUnique({
    where: { id },
    include: {
      resident: { select: { id: true, fullName: true, phone: true } },
      unit: { select: { id: true, unitNumber: true, floor: true } },
      household: { where: { removedAt: null }, include: { user: { select: { id: true, fullName: true } } } },
    },
  });
  if (!occ) throw notFound();
  if (occ.endDate) throw new ApiError(409, 'OCCUPANCY_ALREADY_ENDED');

  const [dues, unpaid, reports, requests, others, elsewhere] = await Promise.all([
    unitDues(prisma, occ.unitId),
    prisma.$queryRaw<{ id: string; billingMonth: string; kind: string; balance: bigint; status: string }[]>`
      SELECT "billId"::text AS id, to_char("billingMonth", 'YYYY-MM') AS "billingMonth", kind::text AS kind, balance, status
      FROM bill_summary WHERE "unitId" = ${occ.unitId}::uuid AND balance > 0 ORDER BY "billingMonth", "billId"`,
    prisma.paymentReport.findMany({
      where: { status: 'PENDING', bill: { unitId: occ.unitId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, amount: true, method: true, reference: true, billId: true },
    }),
    prisma.maintenanceRequest.findMany({
      where: { submittedById: occ.residentId, unitId: occ.unitId, status: { in: [...OPEN_REQUESTS] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, number: true, title: true, status: true },
    }),
    prisma.occupancy.findMany({
      where: { unitId: occ.unitId, id: { not: id }, endDate: null },
      orderBy: [{ type: 'asc' }, { startDate: 'asc' }, { id: 'asc' }],
      select: { id: true, type: true, resident: { select: { fullName: true } } },
    }),
    livesElsewhere(prisma, occ.residentId, id),
  ]);

  return {
    occupancy: { id: occ.id, type: occ.type, startDate: ymdOf(occ.startDate), isBillingContact: occ.isBillingContact },
    resident: occ.resident,
    unit: occ.unit,
    balance: dues.balance,
    unpaidBills: unpaid.map((b) => ({ ...b, balance: Number(b.balance) })),
    pendingReports: reports,
    openRequests: requests,
    otherOccupants: others.map((o) => ({ occupancyId: o.id, type: o.type, fullName: o.resident.fullName })),
    householdMembers: occ.household.map((h) => ({ id: h.user.id, fullName: h.user.fullName })),
    hasOtherActiveOccupancy: elsewhere,
    canIssueCertificate: dues.balance === 0 && dues.bills > 0,
  };
}

/**
 * FR-56: one confirmation, applied together or not at all (NFR-14). Open maintenance requests stay open: they
 * belong to the unit's problem, not the person. The move-out date cannot be in the future, because deactivating
 * the account takes effect now.
 */
export async function moveOut(id: string, input: z.infer<typeof moveOutSchema>, actor: { id: string }) {
  assertUuid(id);
  const field = (name: string, code: string) => new ApiError(400, 'VALIDATION_FAILED', { [name]: { code } });
  if (input.endDate > todayDhaka()) throw field('endDate', 'MOVE_OUT_FUTURE');

  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "occupancies" WHERE id = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw notFound();
      const occ = await tx.occupancy.findUniqueOrThrow({ where: { id }, include: { unit: { select: { unitNumber: true } } } });
      if (occ.endDate) throw new ApiError(409, 'OCCUPANCY_ALREADY_ENDED');

      // The administrator confirmed a summary; if the money changed since, they must look again.
      const { balance } = await unitDues(tx, occ.unitId);
      if (balance !== input.expectedBalance) throw new ApiError(409, 'STALE_PREVIEW');
      if (balance > 0 && !input.duesNote) throw field('duesNote', 'NOTE_REQUIRED');

      const others = await tx.occupancy.count({ where: { unitId: occ.unitId, id: { not: id }, endDate: null } });
      if (occ.isBillingContact && others > 0 && !input.newBillingContactOccupancyId) throw field('newBillingContactOccupancyId', 'NEW_BILLING_CONTACT_REQUIRED');
      if (input.deactivateAccount && (await livesElsewhere(tx, occ.residentId, id))) throw new ApiError(409, 'HAS_OTHER_OCCUPANCY');

      await endOccupancy(tx, occ, dateOnly(input.endDate), input.newBillingContactOccupancyId);
      if (input.duesNote) await tx.occupancy.update({ where: { id }, data: { moveOutNote: input.duesNote } });

      const certificate = input.issueCertificate ? await issueCertificateIn(tx, occ.unitId, occ.residentId, actor) : null;

      if (input.deactivateAccount) {
        await tx.user.update({ where: { id: occ.residentId }, data: { isActive: false } });
        await endAllSessions(tx, occ.residentId);
      } else {
        await notify(tx, [occ.residentId], {
          type: 'MOVE_OUT_RECORDED',
          params: { unit: occ.unit.unitNumber, date: input.endDate },
          link: '/',
          entityId: id,
        });
      }
      await logActivity(tx, 'occupancy.move_out', {
        entityType: 'occupancy',
        entityId: id,
        details: {
          unit: occ.unit.unitNumber,
          endDate: input.endDate,
          balance,
          duesNote: input.duesNote ?? null,
          newBillingContactOccupancyId: input.newBillingContactOccupancyId ?? null,
          certificate: certificate?.number ?? null,
          deactivated: input.deactivateAccount,
        },
      });
      return { occupancyId: id, unitId: occ.unitId, certificate, deactivated: input.deactivateAccount };
    });
  } catch (e) {
    return mapOccupancyError(e);
  }
}
