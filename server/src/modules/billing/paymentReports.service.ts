import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { paymentReportCreateSchema, paymentReportListQuerySchema, paymentReportRejectSchema, paymentReportVerifySchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, forbidden, notFound } from '../../lib/errors';
import { dateOnly, todayDhaka, ymdOf } from '../../lib/dates';
import { removeStored, storeDocument } from '../../lib/files';
import type { AuthUser } from '../../types';
import { notify } from '../notifications/notify';
import { canReadAllBills, residentCanSeeBill } from './access';
import { getBill, lockBill, summaryFor } from './bills.service';
import { recordPaymentIn } from './payments.service';

type Tx = Prisma.TransactionClient;

/** Who checks reported payments: administrators and staff with payments.record (FR-40). */
async function paymentStaff(tx: Tx): Promise<string[]> {
  const rows = await tx.user.findMany({
    where: { isActive: true, OR: [{ role: 'ADMIN' }, { role: 'STAFF', permissions: { some: { permission: 'payments.record' } } }] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Money already reported on this bill and waiting to be checked. */
async function pendingTotal(tx: Tx, billId: string): Promise<number> {
  const r = await tx.paymentReport.aggregate({ where: { billId, status: 'PENDING' }, _sum: { amount: true } });
  return r._sum.amount ?? 0;
}

/**
 * FR-39, BR-21: a resident says they have paid. Nothing about the bill changes until someone verifies it.
 * The bill is locked so two reports at the same moment cannot together exceed the balance.
 */
export async function createReport(billId: string, input: z.infer<typeof paymentReportCreateSchema>, file: Express.Multer.File | undefined, user: AuthUser) {
  assertUuid(billId);
  if (!(await residentCanSeeBill(user.id, billId))) throw notFound(); // never confirm that someone else's bill exists
  if (input.paidOn > todayDhaka()) throw new ApiError(400, 'VALIDATION_FAILED', { paidOn: { code: 'PAID_ON_FUTURE' } });

  const stored = await storeDocument(file, 'screenshot');
  try {
    return await prisma.$transaction(async (tx) => {
      await lockBill(tx, billId);
      const { balance } = await summaryFor(tx, billId);
      const available = balance - (await pendingTotal(tx, billId));
      if (input.amount > available) {
        throw new ApiError(400, 'VALIDATION_FAILED', { amount: { code: 'AMOUNT_EXCEEDS_BALANCE', params: { balance: Math.max(available, 0) } } });
      }
      const report = await tx.paymentReport.create({
        data: { billId, reportedById: user.id, amount: input.amount, paidOn: dateOnly(input.paidOn), method: input.method, reference: input.reference },
        select: { id: true, bill: { select: { unit: { select: { unitNumber: true } } } } },
      });
      if (stored[0]) await tx.attachment.create({ data: { ...stored[0], uploadedById: user.id, paymentReportId: report.id } });
      await notify(tx, await paymentStaff(tx), {
        type: 'PAYMENT_REPORT_NEW',
        params: { unit: report.bill.unit.unitNumber, amount: input.amount },
        link: '/payment-reports',
        entityId: report.id,
      });
      return { id: report.id, status: 'PENDING' as const };
    });
  } catch (e) {
    await removeStored(stored.map((s) => s.storedName));
    throw e;
  }
}

/** FR-39: everything reported on one bill, for anyone who may see that bill. */
export async function listBillReports(billId: string, user: AuthUser) {
  assertUuid(billId);
  if (!canReadAllBills(user)) {
    if (user.role !== 'RESIDENT') throw forbidden();
    if (!(await residentCanSeeBill(user.id, billId))) throw notFound();
  }
  const [rows, bill] = await Promise.all([
    prisma.paymentReport.findMany({
      where: { billId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: { screenshot: { select: { id: true } }, reportedBy: { select: { fullName: true } } },
    }),
    getBill(billId),
  ]);
  const pending = rows.filter((r) => r.status === 'PENDING').reduce((s, r) => s + r.amount, 0);
  return {
    // The most a resident can still report (FR-39).
    available: Math.max(bill.balance - pending, 0),
    items: rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      paidOn: ymdOf(r.paidOn),
      method: r.method,
      reference: r.reference,
      status: r.status,
      rejectReason: r.rejectReason,
      reportedBy: r.reportedBy.fullName,
      screenshotId: r.screenshot?.id ?? null,
      createdAt: r.createdAt,
    })),
  };
}

/** FR-40: the queue, oldest first, with a warning on any transaction ID that was already used. */
export async function listReports(query: z.infer<typeof paymentReportListQuerySchema>) {
  const offset = (query.page - 1) * query.pageSize;
  const order = query.status === 'PENDING' ? Prisma.sql`r."createdAt" ASC` : Prisma.sql`r."reviewedAt" DESC`;
  const [total, rows] = await Promise.all([
    prisma.paymentReport.count({ where: { status: query.status } }),
    prisma.$queryRaw<
      {
        id: string; billId: string; amount: number; paidOn: string; method: string; reference: string; status: string; rejectReason: string | null; createdAt: Date;
        unitNumber: string; billingMonth: string; billKind: string; balance: bigint; reportedBy: string; screenshotId: string | null; duplicate: boolean;
      }[]
    >`
      SELECT r.id::text AS id, r."billId"::text AS "billId", r.amount, r."paidOn"::text AS "paidOn", r.method::text AS method, r.reference,
             r.status::text AS status, r."rejectReason", r."createdAt", u."unitNumber", b."billingMonth"::text AS "billingMonth", b.kind::text AS "billKind",
             s.balance, ru."fullName" AS "reportedBy", a.id::text AS "screenshotId",
             (EXISTS (SELECT 1 FROM "payments" p WHERE p.method = r.method AND lower(p.reference) = lower(r.reference) AND p."voidedAt" IS NULL AND p.id IS DISTINCT FROM r."paymentId")
              OR EXISTS (SELECT 1 FROM "payment_reports" o WHERE o.id <> r.id AND o.method = r.method AND lower(o.reference) = lower(r.reference) AND o.status = 'PENDING')) AS duplicate
      FROM "payment_reports" r
      JOIN "bills" b ON b.id = r."billId"
      JOIN "units" u ON u.id = b."unitId"
      JOIN bill_summary s ON s."billId" = b.id
      JOIN "users" ru ON ru.id = r."reportedById"
      LEFT JOIN "attachments" a ON a."paymentReportId" = r.id
      WHERE r.status = ${query.status}::"PaymentReportStatus"
      ORDER BY ${order}, r.id
      LIMIT ${query.pageSize} OFFSET ${offset}`,
  ]);
  return {
    items: rows.map((r) => ({ ...r, balance: Number(r.balance), billingMonth: r.billingMonth.slice(0, 7) })),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

/** The report row, locked, so two people cannot decide the same report at once. */
async function lockPending(tx: Tx, id: string) {
  assertUuid(id);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "payment_reports" WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw notFound();
  const r = await tx.paymentReport.findUniqueOrThrow({ where: { id }, include: { bill: { select: { unit: { select: { unitNumber: true } } } } } });
  if (r.status !== 'PENDING') throw new ApiError(409, 'REPORT_ALREADY_REVIEWED');
  return r;
}

/**
 * FR-40: verifying creates the payment, with every FR-11 rule and a receipt. The payment, the report's new status
 * and the notification are saved together or not at all (NFR-14).
 */
export async function verifyReport(id: string, input: z.infer<typeof paymentReportVerifySchema>, actor: { id: string }) {
  return prisma.$transaction(async (tx) => {
    const r = await lockPending(tx, id);
    const amount = input.amount ?? r.amount;
    const paymentId = await recordPaymentIn(
      tx,
      r.billId,
      { amount, paidOn: input.paidOn ?? ymdOf(r.paidOn), method: r.method, reference: r.reference, confirm: input.confirm },
      actor,
      { id: r.id, reportedById: r.reportedById },
    );
    await tx.paymentReport.update({ where: { id }, data: { status: 'VERIFIED', reviewedById: actor.id, reviewedAt: new Date(), paymentId } });
    await notify(tx, [r.reportedById], {
      type: 'PAYMENT_REPORT_VERIFIED',
      params: { unit: r.bill.unit.unitNumber, amount },
      link: `/bills/${r.billId}`,
      entityId: id,
    });
    return { id, status: 'VERIFIED' as const, paymentId };
  });
}

/** FR-40: a rejection always says why, and the resident sees the reason. */
export async function rejectReport(id: string, input: z.infer<typeof paymentReportRejectSchema>, actor: { id: string }) {
  return prisma.$transaction(async (tx) => {
    const r = await lockPending(tx, id);
    await tx.paymentReport.update({ where: { id }, data: { status: 'REJECTED', reviewedById: actor.id, reviewedAt: new Date(), rejectReason: input.reason } });
    await notify(tx, [r.reportedById], {
      type: 'PAYMENT_REPORT_REJECTED',
      params: { unit: r.bill.unit.unitNumber, amount: r.amount, reason: input.reason },
      link: `/bills/${r.billId}`,
      entityId: id,
    });
    return { id, status: 'REJECTED' as const };
  });
}
