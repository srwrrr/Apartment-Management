import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { addMonths, currentMonthDhaka, todayDhaka } from '../../lib/dates';
import { recentActivity } from '../activity/activity.service';

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);
/** BR-29: the share of the amount billed that has been paid so far, to one decimal place. Nothing billed means no rate. */
const rate = (billed: number, collected: number): number | null => (billed > 0 ? Math.round((collected * 1000) / billed) / 10 : null);

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/**
 * FR-15: what was billed, collected and is still outstanding for a period of billing months.
 * "Collected" means valid payments (never voided ones) against those months' bills, whenever they were paid, so it
 * always matches the bills themselves. Opening balances (dues from before the system) are kept apart (FR-41).
 * The dashboard uses this same function, so its figures cannot differ from this report (FR-28).
 */
export async function financeReport(from: string, to: string) {
  const first = `${from}-01`;
  const last = `${to}-01`;

  const byMonth = await prisma.$queryRaw<{ month: string; kind: string; billed: bigint; collected: bigint; bills: number }[]>`
    SELECT to_char(s."billingMonth", 'YYYY-MM') AS month, s.kind::text AS kind,
           SUM(s.total)::bigint AS billed, SUM(s.paid)::bigint AS collected, COUNT(*)::int AS bills
    FROM bill_summary s
    WHERE s."billingMonth" BETWEEN ${first}::date AND ${last}::date
    GROUP BY 1, 2 ORDER BY 1, 2`;

  const regular = new Map<string, { billed: number; collected: number; bills: number }>();
  let opening = { billed: 0, collected: 0, bills: 0 };
  for (const r of byMonth) {
    if (r.kind === 'OPENING_BALANCE') opening = { billed: opening.billed + num(r.billed), collected: opening.collected + num(r.collected), bills: opening.bills + r.bills };
    else regular.set(r.month, { billed: num(r.billed), collected: num(r.collected), bills: r.bills });
  }

  const months = monthsBetween(from, to).map((month) => {
    const m = regular.get(month) ?? { billed: 0, collected: 0, bills: 0 };
    return { month, bills: m.bills, billed: m.billed, collected: m.collected, outstanding: m.billed - m.collected, rate: rate(m.billed, m.collected) };
  });
  const billed = months.reduce((s, m) => s + m.billed, 0);
  const collected = months.reduce((s, m) => s + m.collected, 0);

  const byChargeType = await prisma.$queryRaw<{ type: string; billed: bigint }[]>`
    SELECT c.type::text AS type, SUM(c.amount)::bigint AS billed
    FROM "charges" c JOIN "bills" b ON b.id = c."billId"
    WHERE b."billingMonth" BETWEEN ${first}::date AND ${last}::date
    GROUP BY c.type ORDER BY c.type`;
  const byMethod = await prisma.$queryRaw<{ method: string; collected: bigint }[]>`
    SELECT p.method::text AS method, SUM(p.amount)::bigint AS collected
    FROM "payments" p JOIN "bills" b ON b.id = p."billId"
    WHERE p."voidedAt" IS NULL AND b."billingMonth" BETWEEN ${first}::date AND ${last}::date
    GROUP BY p.method ORDER BY p.method`;

  return {
    from,
    to,
    billed,
    collected,
    outstanding: billed - collected,
    rate: rate(billed, collected),
    openingBalances: { ...opening, outstanding: opening.billed - opening.collected },
    months,
    byChargeType: byChargeType.map((r) => ({ type: r.type, billed: num(r.billed) })),
    byMethod: byMethod.map((r) => ({ method: r.method, collected: num(r.collected) })),
  };
}

/** FR-15: which units owe money, and how much. */
export async function duesReport() {
  const rows = await prisma.$queryRaw<
    { id: string; unitNumber: string; floor: number; owed: bigint; bills: number; overdueBills: number; oldestOverdue: string | null; contactName: string | null; contactPhone: string | null }[]
  >`
    SELECT u.id::text AS id, u."unitNumber", u.floor,
           SUM(s.balance)::bigint AS owed, COUNT(*)::int AS bills,
           COUNT(*) FILTER (WHERE s.status = 'OVERDUE')::int AS "overdueBills",
           (MIN(s."dueDate") FILTER (WHERE s.status = 'OVERDUE'))::text AS "oldestOverdue",
           (SELECT us."fullName" FROM "occupancies" o JOIN "users" us ON us.id = o."residentId"
              WHERE o."unitId" = u.id AND o."isBillingContact" AND o."endDate" IS NULL LIMIT 1) AS "contactName",
           (SELECT us.phone FROM "occupancies" o JOIN "users" us ON us.id = o."residentId"
              WHERE o."unitId" = u.id AND o."isBillingContact" AND o."endDate" IS NULL LIMIT 1) AS "contactPhone"
    FROM bill_summary s JOIN "units" u ON u.id = s."unitId"
    WHERE s.balance > 0
    GROUP BY u.id
    ORDER BY owed DESC, u."unitNumber"`;
  const units = rows.map((r) => ({
    unit: { id: r.id, unitNumber: r.unitNumber, floor: r.floor },
    owed: num(r.owed),
    bills: r.bills,
    overdueBills: r.overdueBills,
    oldestOverdue: r.oldestOverdue,
    contact: r.contactName ? { name: r.contactName, phone: r.contactPhone } : null,
  }));
  return { totalOwed: units.reduce((s, u) => s + u.owed, 0), units };
}

/**
 * FR-22: requests opened in a period of months (Dhaka time). The average covers those that reached Resolved
 * (AVG skips the rest, whose time is empty).
 * A reopened request is measured to its latest resolution, which is what the resident actually waited for.
 */
export async function maintenanceReport(from: string, to: string) {
  const start = `${from}-01T00:00:00+06:00`;
  const end = `${addMonths(to, 1)}-01T00:00:00+06:00`;
  const period = Prisma.sql`r."createdAt" >= ${start}::timestamptz AND r."createdAt" < ${end}::timestamptz`;

  const [byStatus, byCategory, topUnits] = await Promise.all([
    prisma.$queryRaw<{ status: string; n: number }[]>`
      SELECT r.status::text AS status, COUNT(*)::int AS n FROM "maintenance_requests" r WHERE ${period} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ category: string; n: number; resolved: number; hours: number | null }[]>`
      SELECT r.category::text AS category, COUNT(*)::int AS n, COUNT(r."resolvedAt")::int AS resolved,
             (AVG(EXTRACT(EPOCH FROM (r."resolvedAt" - r."createdAt"))) / 3600)::float8 AS hours
      FROM "maintenance_requests" r WHERE ${period} GROUP BY 1 ORDER BY n DESC, 1`,
    prisma.$queryRaw<{ id: string; unitNumber: string; n: number }[]>`
      SELECT u.id::text AS id, u."unitNumber", COUNT(*)::int AS n
      FROM "maintenance_requests" r JOIN "units" u ON u.id = r."unitId" WHERE ${period}
      GROUP BY u.id ORDER BY n DESC, u."unitNumber" LIMIT 5`,
  ]);
  const [overall] = await prisma.$queryRaw<{ hours: number | null }[]>`
    SELECT (AVG(EXTRACT(EPOCH FROM (r."resolvedAt" - r."createdAt"))) / 3600)::float8 AS hours
    FROM "maintenance_requests" r WHERE ${period}`;

  const hours = (h: number | null | undefined) => (h === null || h === undefined ? null : Math.round(h * 10) / 10);
  return {
    from,
    to,
    total: byStatus.reduce((s, r) => s + r.n, 0),
    byStatus,
    averageHours: hours(overall?.hours),
    byCategory: byCategory.map((c) => ({ category: c.category, requests: c.n, resolved: c.resolved, averageHours: hours(c.hours) })),
    topUnits: topUnits.map((u) => ({ id: u.id, unitNumber: u.unitNumber, requests: u.n })),
  };
}

/** FR-27, FR-28, FR-29, FR-58: the administrator's overview. */
export async function dashboard(month: string = currentMonthDhaka(), opts: { activity?: boolean } = {}) {
  const today = todayDhaka();
  const [b] = await prisma.$queryRaw<{ total: number; occupied: number; unavailable: number; residents: number }[]>`
    SELECT (SELECT COUNT(*)::int FROM "units") AS total,
           (SELECT COUNT(*)::int FROM "units" un WHERE EXISTS (
              SELECT 1 FROM "occupancies" o WHERE o."unitId" = un.id AND o."startDate" <= ${today}::date AND (o."endDate" IS NULL OR o."endDate" > ${today}::date))) AS occupied,
           (SELECT COUNT(*)::int FROM "units" un WHERE NOT un."isAvailable" AND NOT EXISTS (
              SELECT 1 FROM "occupancies" o WHERE o."unitId" = un.id AND o."startDate" <= ${today}::date AND (o."endDate" IS NULL OR o."endDate" > ${today}::date))) AS unavailable,
           (SELECT COUNT(*)::int FROM "users" WHERE role = 'RESIDENT' AND "isActive") AS residents`;

  const [thisMonth, trend] = await Promise.all([financeReport(month, month), financeReport(addMonths(month, -5), month)]);
  const [overdue] = await prisma.$queryRaw<{ n: number; amount: bigint }[]>`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(balance), 0)::bigint AS amount FROM bill_summary WHERE status = 'OVERDUE'`;

  const pendingReports = await prisma.paymentReport.count({ where: { status: 'PENDING' } });

  const grouped = await prisma.maintenanceRequest.groupBy({ by: ['status'], _count: { _all: true } });
  const by = Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Record<string, number>;
  const overdueRequests = await prisma.maintenanceRequest.count({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS'] }, dueAt: { lt: new Date() } } });

  const [announcements, payments, requests] = await Promise.all([
    prisma.announcement.findMany({ where: { archivedAt: null }, orderBy: { publishedAt: 'desc' }, take: 5, select: { id: true, title: true, publishedAt: true, isImportant: true } }),
    prisma.payment.findMany({
      where: { voidedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 5,
      select: { id: true, amount: true, paidOn: true, receiptNo: true, billId: true, bill: { select: { unit: { select: { unitNumber: true } } } } },
    }),
    prisma.maintenanceRequest.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 5,
      select: { id: true, number: true, title: true, status: true, createdAt: true, unit: { select: { unitNumber: true } } },
    }),
  ]);

  // The activity log is for administrators only (Appendix B), even on a shared dashboard.
  const activity = opts.activity ? await recentActivity(10) : null;

  const m = thisMonth.months[0]!;
  return {
    month,
    building: { totalUnits: b!.total, occupied: b!.occupied, vacant: b!.total - b!.occupied - b!.unavailable, unavailable: b!.unavailable, residents: b!.residents },
    billing: {
      billed: m.billed,
      collected: m.collected,
      outstanding: m.outstanding,
      rate: m.rate,
      openingBalances: thisMonth.openingBalances,
      overdueBills: overdue!.n,
      overdueAmount: num(overdue!.amount),
      pendingReports,
    },
    maintenance: {
      pending: (by.SUBMITTED ?? 0) + (by.UNDER_REVIEW ?? 0),
      submitted: by.SUBMITTED ?? 0,
      underReview: by.UNDER_REVIEW ?? 0,
      inProgress: by.IN_PROGRESS ?? 0,
      resolved: by.RESOLVED ?? 0,
      overdue: overdueRequests,
    },
    trend: trend.months.map((t) => ({ month: t.month, billed: t.billed, collected: t.collected, rate: t.rate })),
    recent: {
      activity,
      announcements: announcements.map((a) => ({ id: a.id, title: a.title, publishedAt: a.publishedAt, isImportant: a.isImportant })),
      payments: payments.map((p) => ({ id: p.id, amount: p.amount, paidOn: p.paidOn.toISOString().slice(0, 10), receiptNo: p.receiptNo, billId: p.billId, unitNumber: p.bill.unit.unitNumber })),
      requests: requests.map((r) => ({ id: r.id, number: r.number, title: r.title, status: r.status, createdAt: r.createdAt, unitNumber: r.unit.unitNumber })),
    },
  };
}
