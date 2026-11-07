import crypto from 'node:crypto';
import { Prisma, type ChargeType } from '@prisma/client';
import { z } from 'zod';
import type { BillStatus } from '@apt/shared';
import { billListQuerySchema, chargeInputSchema, chargeUpdateSchema, generateBillsSchema, oneOffBillSchema, openingBalanceSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, forbidden, notFound } from '../../lib/errors';
import { addMonths, currentMonthDhaka, dateOnly, monthRange, ymdOf } from '../../lib/dates';
import { getSettings } from '../settings/settings.service';
import { householdsOf } from '../notifications/notify';

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: 'RESIDENT' | 'STAFF' | 'ADMIN' };

interface SummaryRow {
  billId: string;
  total: bigint;
  paid: bigint;
  balance: bigint;
  status: BillStatus;
}
const summaryOf = (r: SummaryRow) => ({ total: Number(r.total), paid: Number(r.paid), balance: Number(r.balance), status: r.status });

/** Locks the bill row so two people cannot change its money at the same moment (BR-11, BR-12, NFR-14). */
export async function lockBill(tx: Tx, billId: string): Promise<{ kind: 'REGULAR' | 'OPENING_BALANCE' }> {
  assertUuid(billId);
  const rows = await tx.$queryRaw<{ kind: 'REGULAR' | 'OPENING_BALANCE' }[]>`SELECT kind FROM "bills" WHERE id = ${billId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw notFound();
  return rows[0]!;
}

export async function summaryFor(db: Tx | typeof prisma, billId: string): Promise<ReturnType<typeof summaryOf>> {
  const rows = await db.$queryRaw<SummaryRow[]>`SELECT "billId", total, paid, balance, status FROM bill_summary WHERE "billId" = ${billId}::uuid`;
  if (rows.length === 0) throw notFound();
  return summaryOf(rows[0]!);
}

// ------------------------------------------------------------------ lists

interface ListRow {
  billId: string;
  kind: 'REGULAR' | 'OPENING_BALANCE';
  billingMonth: string;
  dueDate: string;
  total: bigint;
  paid: bigint;
  balance: bigint;
  status: BillStatus;
  unitId: string;
  unitNumber: string;
  floor: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Bills with their computed status (FR-12, FR-13). With `viewerId`, only the bills that person may see:
 * this is how residents are kept away from each other's bills (NFR-16, NFR-24).
 */
export async function listBills(query: z.infer<typeof billListQuerySchema>, viewerId?: string) {
  const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.status) conds.push(Prisma.sql`s.status = ${query.status}`);
  if (query.month) conds.push(Prisma.sql`s."billingMonth" = (${query.month} || '-01')::date`);
  if (query.unitId) conds.push(Prisma.sql`s."unitId" = ${query.unitId}::uuid`);
  if (query.kind) conds.push(Prisma.sql`s.kind = ${query.kind}::"BillKind"`);
  if (query.q) conds.push(Prisma.sql`u."unitNumber" ILIKE ${'%' + escapeLike(query.q) + '%'}`);
  if (viewerId) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM bill_access ba WHERE ba."userId" = ${viewerId}::uuid AND ba."billId" = s."billId")`);
  }
  const where = Prisma.join(conds, ' AND ');

  const [counts] = await prisma.$queryRaw<{ n: number; total: bigint; paid: bigint; balance: bigint }[]>`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(s.total), 0)::bigint AS total, COALESCE(SUM(s.paid), 0)::bigint AS paid,
           COALESCE(SUM(s.balance), 0)::bigint AS balance
    FROM bill_summary s JOIN "units" u ON u.id = s."unitId" WHERE ${where}`;

  const rows = await prisma.$queryRaw<ListRow[]>`
    SELECT s."billId", s.kind, s."billingMonth"::text AS "billingMonth", s."dueDate"::text AS "dueDate",
           s.total, s.paid, s.balance, s.status, u.id AS "unitId", u."unitNumber", u.floor
    FROM bill_summary s JOIN "units" u ON u.id = s."unitId"
    WHERE ${where}
    ORDER BY s."billingMonth" DESC, u.floor ASC, u."unitNumber" ASC, s."billId" ASC
    LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;

  return {
    items: rows.map((r) => ({
      id: r.billId,
      kind: r.kind,
      billingMonth: r.billingMonth,
      dueDate: r.dueDate,
      total: Number(r.total),
      paid: Number(r.paid),
      balance: Number(r.balance),
      status: r.status,
      unit: { id: r.unitId, unitNumber: r.unitNumber, floor: r.floor },
    })),
    page: query.page,
    pageSize: query.pageSize,
    total: counts!.n,
    sums: { total: Number(counts!.total), paid: Number(counts!.paid), balance: Number(counts!.balance) },
  };
}

/** A resident's outstanding balance across every bill they may see (FR-13). */
export async function myBalance(userId: string) {
  const [r] = await prisma.$queryRaw<{ outstanding: bigint; overdue: number; open: number }[]>`
    SELECT COALESCE(SUM(s.balance) FILTER (WHERE s.balance > 0), 0)::bigint AS outstanding,
           COUNT(*) FILTER (WHERE s.status = 'OVERDUE')::int AS overdue,
           COUNT(*) FILTER (WHERE s.balance > 0)::int AS open
    FROM bill_summary s
    WHERE EXISTS (SELECT 1 FROM bill_access ba WHERE ba."userId" = ${userId}::uuid AND ba."billId" = s."billId")`;
  return { outstanding: Number(r!.outstanding), overdueBills: r!.overdue, openBills: r!.open };
}

// ----------------------------------------------------------------- detail

/** Everything about one bill. `forResident` hides who recorded or voided payments. */
export async function getBill(id: string, opts: { forResident?: boolean } = {}) {
  assertUuid(id);
  const bill = await prisma.bill.findUnique({
    where: { id },
    include: {
      unit: { select: { id: true, unitNumber: true, floor: true } },
      billingContact: { select: { id: true, fullName: true } },
      charges: { orderBy: [{ type: 'asc' }, { description: 'asc' }, { id: 'asc' }] },
      payments: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { recordedBy: { select: { fullName: true } }, voidedBy: { select: { fullName: true } } },
      },
    },
  });
  if (!bill) throw notFound();
  const summary = await summaryFor(prisma, id);
  return {
    id: bill.id,
    kind: bill.kind,
    unit: bill.unit,
    billingMonth: ymdOf(bill.billingMonth),
    dueDate: ymdOf(bill.dueDate),
    billingContact: bill.billingContact,
    note: bill.note,
    createdAt: bill.createdAt,
    ...summary,
    charges: bill.charges.map((c) => ({ id: c.id, type: c.type, amount: c.amount, description: c.description })),
    payments: bill.payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      paidOn: ymdOf(p.paidOn),
      method: p.method,
      reference: p.reference,
      receiptNo: p.receiptNo,
      createdAt: p.createdAt,
      voided: p.voidedAt !== null,
      voidedAt: p.voidedAt,
      voidReason: p.voidReason,
      ...(opts.forResident ? {} : { recordedBy: p.recordedBy.fullName, voidedBy: p.voidedBy?.fullName ?? null }),
    })),
  };
}

// ------------------------------------------------------- generation (FR-09)

const RECURRING_ORDER: ChargeType[] = ['SERVICE', 'RENT', 'WATER', 'GAS', 'ELECTRICITY'];

export interface PlannedBill {
  unitId: string;
  unitNumber: string;
  charges: { type: ChargeType; amount: number; description: string }[];
  total: number;
  billingContactId: string | null;
}
export interface SkippedUnit {
  unitId: string;
  unitNumber: string;
  reason: 'ALREADY_BILLED' | 'NO_FEES';
}

function checkMonth(month: string) {
  const bad = (code: string) => new ApiError(400, 'VALIDATION_FAILED', { month: { code } });
  if (month < '2000-01') throw bad('MONTH_TOO_EARLY');
  if (month > addMonths(currentMonthDhaka(), 1)) throw bad('MONTH_TOO_FAR'); // at most next month
}

async function resolveDueDate(month: string, requested?: string): Promise<Date> {
  const { start } = monthRange(month);
  if (requested) {
    const due = dateOnly(requested);
    if (due < start) throw new ApiError(400, 'VALIDATION_FAILED', { dueDate: { code: 'DUE_DATE_BEFORE_MONTH' } });
    return due;
  }
  const { defaultDueDay } = await getSettings(); // BR-10: the 10th unless changed in settings
  return dateOnly(`${month}-${String(defaultDueDay).padStart(2, '0')}`);
}

/** Works out which bills a month's run would create, without saving anything. */
async function planMonth(month: string): Promise<{ planned: PlannedBill[]; skipped: SkippedUnit[] }> {
  const { start, end } = monthRange(month);
  const overlap: Prisma.OccupancyWhereInput = { startDate: { lte: end }, OR: [{ endDate: null }, { endDate: { gte: start } }] };

  const [units, billed, fees] = await Promise.all([
    prisma.unit.findMany({
      where: { isAvailable: true, occupancies: { some: overlap } }, // BR-05: unavailable units are never billed
      orderBy: [{ floor: 'asc' }, { unitNumber: 'asc' }],
      select: {
        id: true,
        unitNumber: true,
        occupancies: { where: overlap, orderBy: [{ isBillingContact: 'desc' }, { type: 'asc' }, { startDate: 'asc' }], take: 1, select: { residentId: true } },
      },
    }),
    prisma.bill.findMany({ where: { billingMonth: start }, select: { unitId: true } }),
    prisma.unitFee.findMany(),
  ]);

  const alreadyBilled = new Set(billed.map((b) => b.unitId));
  const defaults = new Map(fees.filter((f) => !f.unitId).map((f) => [f.chargeType, f]));
  const overrides = new Map<string, Map<ChargeType, (typeof fees)[number]>>();
  for (const f of fees.filter((f) => f.unitId)) {
    if (!overrides.has(f.unitId!)) overrides.set(f.unitId!, new Map());
    overrides.get(f.unitId!)!.set(f.chargeType, f);
  }

  const planned: PlannedBill[] = [];
  const skipped: SkippedUnit[] = [];
  for (const u of units) {
    if (alreadyBilled.has(u.id)) {
      skipped.push({ unitId: u.id, unitNumber: u.unitNumber, reason: 'ALREADY_BILLED' }); // BR-07
      continue;
    }
    // Building defaults, with the unit's own fees taking the place of the same type, plus any extra types it has.
    const merged = new Map(defaults);
    for (const [type, fee] of overrides.get(u.id) ?? []) merged.set(type, fee);
    const charges = RECURRING_ORDER.filter((t) => merged.has(t)).map((t) => ({
      type: t,
      amount: merged.get(t)!.amount,
      description: merged.get(t)!.description,
    }));
    if (charges.length === 0) {
      skipped.push({ unitId: u.id, unitNumber: u.unitNumber, reason: 'NO_FEES' });
      continue;
    }
    planned.push({
      unitId: u.id,
      unitNumber: u.unitNumber,
      charges,
      total: charges.reduce((s, c) => s + c.amount, 0),
      billingContactId: u.occupancies[0]?.residentId ?? null,
    });
  }
  return { planned, skipped };
}

/**
 * Generates a month's bills for every occupied unit (FR-09). With dryRun it only reports what would happen.
 * The whole run is one transaction, and a unit can never get two bills for a month (BR-07).
 */
export async function generateBills(input: z.infer<typeof generateBillsSchema>, actor: Actor, dryRun: boolean) {
  checkMonth(input.month);
  const dueDate = await resolveDueDate(input.month, input.dueDate);
  const { planned, skipped } = await planMonth(input.month);
  const total = planned.reduce((s, p) => s + p.total, 0);
  const summary = {
    month: input.month,
    dueDate: ymdOf(dueDate),
    count: planned.length,
    total,
    willCreate: planned.map((p) => ({ unitId: p.unitId, unitNumber: p.unitNumber, total: p.total })),
    skipped,
  };
  if (dryRun || planned.length === 0) return { ...summary, created: 0 };

  const billingMonth = monthRange(input.month).start;
  try {
    await prisma.$transaction(async (tx) => {
      const bills = planned.map((p) => ({ id: crypto.randomUUID(), plan: p }));
      await tx.bill.createMany({
        data: bills.map(({ id, plan }) => ({
          id,
          unitId: plan.unitId,
          kind: 'REGULAR' as const,
          billingMonth,
          dueDate,
          billingContactId: plan.billingContactId,
          createdById: actor.id,
        })),
      });
      await tx.charge.createMany({
        data: bills.flatMap(({ id, plan }) => plan.charges.map((c) => ({ billId: id, type: c.type, amount: c.amount, description: c.description }))),
      });
      // FR-09, FR-25: each billing contact, and their household, hears about the new bill, in the same transaction.
      const contacts = [...new Set(planned.flatMap((p) => (p.billingContactId ? [p.billingContactId] : [])))];
      const households = await householdsOf(tx, contacts);
      const notices = bills.flatMap(({ id, plan }) =>
        (plan.billingContactId ? (households.get(plan.billingContactId) ?? []) : []).map((userId) => ({
          userId,
          type: 'BILL_NEW' as const,
          params: { unit: plan.unitNumber, month: input.month, amount: plan.total, dueDate: ymdOf(dueDate) },
          link: `/bills/${id}`,
          entityId: id,
        })),
      );
      if (notices.length) await tx.notification.createMany({ data: notices, skipDuplicates: true });
    });
  } catch (e) {
    // Someone else generated the same month a moment ago. Nothing was saved; check the preview again.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError(409, 'BILLS_ALREADY_EXIST');
    throw e;
  }
  return { ...summary, created: planned.length };
}

// ------------------------------------------------------ one-off bill (FR-10)

async function contactForMonth(unitId: string, month: string): Promise<string | null> {
  const { start, end } = monthRange(month);
  const occ = await prisma.occupancy.findFirst({
    where: { unitId, startDate: { lte: end }, OR: [{ endDate: null }, { endDate: { gte: start } }] },
    orderBy: [{ isBillingContact: 'desc' }, { type: 'asc' }, { startDate: 'asc' }],
    select: { residentId: true },
  });
  return occ?.residentId ?? null;
}

export async function createOneOffBill(input: z.infer<typeof oneOffBillSchema>, actor: Actor) {
  checkMonth(input.month);
  if (!(await prisma.unit.findUnique({ where: { id: input.unitId }, select: { id: true } }))) {
    throw new ApiError(400, 'VALIDATION_FAILED', { unitId: { code: 'UNIT_NOT_FOUND' } });
  }
  const dueDate = await resolveDueDate(input.month, input.dueDate);
  const billingMonth = monthRange(input.month).start;
  if (await prisma.bill.findUnique({ where: { unitId_billingMonth: { unitId: input.unitId, billingMonth } }, select: { id: true } })) {
    throw new ApiError(409, 'BILL_EXISTS'); // BR-07
  }
  const billingContactId = await contactForMonth(input.unitId, input.month);
  try {
    const bill = await prisma.bill.create({
      data: {
        unitId: input.unitId,
        billingMonth,
        dueDate,
        billingContactId,
        createdById: actor.id,
        charges: { create: input.charges },
      },
      select: { id: true },
    });
    return getBill(bill.id);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError(409, 'BILL_EXISTS');
    throw e;
  }
}

// ------------------------------------------------------------ charges (FR-10)

const chargeBelowPaid = () => new ApiError(409, 'CHARGE_BELOW_PAID', { amount: { code: 'CHARGE_BELOW_PAID' } });

export async function addCharge(billId: string, input: z.infer<typeof chargeInputSchema>) {
  try {
    await prisma.$transaction(async (tx) => {
      const { kind } = await lockBill(tx, billId);
      if (kind === 'OPENING_BALANCE') throw new ApiError(409, 'OPENING_BALANCE_FIXED'); // it holds one charge only (BR-22)
      await tx.charge.create({ data: { billId, ...input } });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ApiError(409, 'CONFLICT', { type: { code: 'CHARGE_TYPE_EXISTS' } }); // BR-07
    }
    throw e;
  }
  return getBill(billId);
}

async function loadCharge(tx: Tx, chargeId: string) {
  assertUuid(chargeId);
  const charge = await tx.charge.findUnique({ where: { id: chargeId } });
  if (!charge) throw notFound();
  const { kind } = await lockBill(tx, charge.billId);
  // Re-read under the lock, in case it changed while we waited.
  const fresh = await tx.charge.findUnique({ where: { id: chargeId } });
  if (!fresh) throw notFound();
  return { charge: fresh, kind };
}

/** BR-12: a charge can change as long as the bill's total does not drop below what has already been paid. */
export async function updateCharge(chargeId: string, input: z.infer<typeof chargeUpdateSchema>, actor: Actor) {
  const billId = await prisma.$transaction(async (tx) => {
    const { charge, kind } = await loadCharge(tx, chargeId);
    if (kind === 'OPENING_BALANCE' && actor.role !== 'ADMIN') throw forbidden(); // BR-22: administrators only
    if (input.amount !== undefined) {
      const s = await summaryFor(tx, charge.billId);
      if (s.total - charge.amount + input.amount < s.paid) throw chargeBelowPaid();
    }
    await tx.charge.update({ where: { id: chargeId }, data: input });
    return charge.billId;
  });
  return getBill(billId);
}

export async function deleteCharge(chargeId: string, actor: Actor) {
  const billId = await prisma.$transaction(async (tx) => {
    const { charge, kind } = await loadCharge(tx, chargeId);
    if (kind === 'OPENING_BALANCE') throw new ApiError(409, 'OPENING_BALANCE_FIXED'); // remove the whole opening balance instead
    const s = await summaryFor(tx, charge.billId);
    if (s.total - charge.amount < s.paid) throw chargeBelowPaid();
    await tx.charge.delete({ where: { id: chargeId } });
    return charge.billId;
  });
  void actor;
  return getBill(billId);
}

// ----------------------------------------------------- opening balance (FR-41)

/** The month an opening balance is dated: the month before go-live (BR-22). */
export async function openingBalanceMonth(): Promise<{ month: string; goLive: string }> {
  const { goLiveDate } = await getSettings();
  return { month: addMonths(goLiveDate.slice(0, 7), -1), goLive: goLiveDate };
}

/** The rows that make up one opening-balance bill. Shared with the units CSV import. */
export function openingBalanceRows(args: {
  unitId: string;
  amount: number;
  month: string;
  dueDate: Date;
  note?: string;
  actorId: string;
  billingContactId: string | null;
}) {
  const billId = crypto.randomUUID();
  return {
    bill: {
      id: billId,
      unitId: args.unitId,
      kind: 'OPENING_BALANCE' as const,
      billingMonth: monthRange(args.month).start,
      dueDate: args.dueDate,
      billingContactId: args.billingContactId,
      note: args.note ?? null,
      createdById: args.actorId,
    },
    charge: { billId, type: 'OPENING_BALANCE' as const, amount: args.amount, description: args.note || 'Opening balance' },
  };
}

export async function createOpeningBalance(unitId: string, input: z.infer<typeof openingBalanceSchema>, actor: Actor) {
  assertUuid(unitId);
  if (!(await prisma.unit.findUnique({ where: { id: unitId }, select: { id: true } }))) throw notFound();
  const { month, goLive } = await openingBalanceMonth();
  if (await prisma.bill.findFirst({ where: { unitId, kind: 'OPENING_BALANCE' }, select: { id: true } })) {
    throw new ApiError(409, 'OPENING_BALANCE_EXISTS'); // BR-22
  }
  if (await prisma.bill.findFirst({ where: { unitId, billingMonth: monthRange(month).start }, select: { id: true } })) {
    throw new ApiError(409, 'BILL_EXISTS');
  }
  const contact = await prisma.occupancy.findFirst({ where: { unitId, isBillingContact: true, endDate: null }, select: { residentId: true } });
  const rows = openingBalanceRows({
    unitId,
    amount: input.amount,
    month,
    dueDate: dateOnly(input.dueDate ?? goLive),
    note: input.note,
    actorId: actor.id,
    billingContactId: contact?.residentId ?? null,
  });
  try {
    await prisma.$transaction([prisma.bill.create({ data: rows.bill }), prisma.charge.create({ data: rows.charge })]);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError(409, 'OPENING_BALANCE_EXISTS');
    throw e;
  }
  return getBill(rows.bill.id);
}

/** Corrects a mistaken opening balance. Only possible while nothing has been paid against it. */
export async function deleteOpeningBalance(billId: string) {
  await prisma.$transaction(async (tx) => {
    const { kind } = await lockBill(tx, billId);
    if (kind !== 'OPENING_BALANCE') throw new ApiError(409, 'NOT_AN_OPENING_BALANCE');
    const payments = await tx.payment.count({ where: { billId } });
    const reports = await tx.paymentReport.count({ where: { billId } });
    if (payments + reports > 0) throw new ApiError(409, 'BILL_HAS_PAYMENTS'); // payments are never deleted (BR-13)
    await tx.bill.delete({ where: { id: billId } });
  });
}
