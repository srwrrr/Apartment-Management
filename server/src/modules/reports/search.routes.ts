import { Router } from 'express';
import { BILL_READ_PERMISSIONS, hasPermission, searchQuerySchema } from '@apt/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { asyncHandler, forbidden } from '../../lib/errors';
import { requireAuth } from '../../middleware/auth';
import type { AuthUser } from '../../types';

const LIMIT = 8;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "4B 2026-11", "4B nov 2026", "4B november" -> the unit part and, if there is one, the month part. */
export function splitBillQuery(q: string, thisYear: number): { unit: string; month: string | null } {
  const unit: string[] = [];
  let year: number | null = null;
  let monthNo: number | null = null;
  let exact: string | null = null;
  for (const word of q.toLowerCase().split(/\s+/)) {
    const named = MONTHS.indexOf(word.slice(0, 3));
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(word)) exact = word;
    else if (/^(19|20)\d{2}$/.test(word)) year = Number(word);
    else if (named >= 0 && /^[a-z]+$/.test(word) && word.length >= 3) monthNo = named + 1;
    else unit.push(word);
  }
  const month = exact ?? (monthNo ? `${year ?? thisYear}-${String(monthNo).padStart(2, '0')}` : null);
  return { unit: unit.join(' '), month };
}

const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });

/**
 * FR-30: one box. Each group only appears for someone who may open what it lists, so searching can never show
 * more than the pages themselves would. Residents have no search: they only see their own records anyway.
 */
export async function search(q: string, user: AuthUser) {
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(user, p);
  const digits = q.replace(/[\s-]/g, '');
  const number = /^#?(\d{1,9})$/.exec(q);
  const { unit, month } = splitBillQuery(q, new Date().getUTCFullYear());

  const [residents, units, bills, requests] = await Promise.all([
    can('residents.manage')
      ? prisma.user.findMany({
          where: { role: 'RESIDENT', OR: [{ fullName: contains(q) }, ...(/^\+?\d{3,}$/.test(digits) ? [{ phone: { contains: digits } }] : [])] },
          orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
          take: LIMIT,
          select: { id: true, fullName: true, phone: true, isActive: true },
        })
      : [],
    can('units.manage') || can('residents.manage')
      ? prisma.unit.findMany({ where: { unitNumber: contains(q) }, orderBy: [{ unitNumber: 'asc' }, { id: 'asc' }], take: LIMIT, select: { id: true, unitNumber: true, floor: true } })
      : [],
    BILL_READ_PERMISSIONS.some(can) && (unit || month)
      ? prisma.$queryRaw<{ id: string; unitNumber: string; billingMonth: string; kind: string; balance: bigint; status: string }[]>`
          SELECT s."billId"::text AS id, u."unitNumber", to_char(s."billingMonth", 'YYYY-MM') AS "billingMonth", s.kind::text AS kind, s.balance, s.status
          FROM bill_summary s JOIN "units" u ON u.id = s."unitId"
          WHERE TRUE
            ${unit ? Prisma.sql`AND u."unitNumber" ILIKE ${`%${unit.replace(/[\\%_]/g, '\\$&')}%`}` : Prisma.empty}
            ${month ? Prisma.sql`AND s."billingMonth" = ${`${month}-01`}::date` : Prisma.empty}
          ORDER BY s."billingMonth" DESC, u."unitNumber", s."billId"
          LIMIT ${LIMIT}`
      : [],
    can('maintenance.view_all') || can('maintenance.review') || can('maintenance.assign')
      ? prisma.maintenanceRequest.findMany({
          where: { OR: [{ title: contains(q) }, ...(number ? [{ number: Number(number[1]) }] : [])] },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: LIMIT,
          select: { id: true, number: true, title: true, status: true, unit: { select: { unitNumber: true } } },
        })
      : [],
  ]);
  return { residents, units, bills: bills.map((b) => ({ ...b, balance: Number(b.balance) })), requests };
}

export const searchRouter = Router();
searchRouter.use(requireAuth);
searchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (req.user!.role === 'RESIDENT') throw forbidden();
    res.json(await search(searchQuerySchema.parse(req.query).q, req.user!));
  }),
);
