import { z } from 'zod';
import { paymentInputSchema, voidPaymentSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, forbidden, notFound } from '../../lib/errors';
import { dateOnly, todayDhaka, ymdOf } from '../../lib/dates';
import type { AuthUser } from '../../types';
import { canReadAllBills, residentCanSeeBill } from './access';
import { getBill, lockBill, summaryFor } from './bills.service';

type Actor = { id: string };

const receiptNumber = (year: number, n: number) => `RCPT-${year}-${String(n).padStart(5, '0')}`;

/**
 * FR-11: record a payment against a bill. The bill row is locked first, so two people paying the same bill at the
 * same moment cannot overpay it (BR-11). The receipt number comes from a yearly counter under the same transaction,
 * so numbers never repeat or skip (BR-14).
 */
export async function recordPayment(billId: string, input: z.infer<typeof paymentInputSchema>, actor: Actor) {
  if (input.paidOn > todayDhaka()) {
    throw new ApiError(400, 'VALIDATION_FAILED', { paidOn: { code: 'PAID_ON_FUTURE' } });
  }
  const paymentId = await prisma.$transaction(async (tx) => {
    await lockBill(tx, billId);
    const s = await summaryFor(tx, billId);
    if (input.amount > s.balance) {
      throw new ApiError(400, 'VALIDATION_FAILED', { amount: { code: 'AMOUNT_EXCEEDS_BALANCE', params: { balance: s.balance } } });
    }
    if (input.reference && !input.confirm) {
      // The same transaction ID used twice is usually a double entry: ask before saving.
      const dup = await tx.payment.findFirst({
        where: { method: input.method, reference: { equals: input.reference, mode: 'insensitive' }, voidedAt: null },
        select: { id: true },
      });
      if (dup) throw new ApiError(409, 'DUPLICATE_REFERENCE');
    }
    const year = Number(input.paidOn.slice(0, 4));
    const [counter] = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO "counters" (kind, year, value) VALUES ('RCPT', ${year}::int, 1)
      ON CONFLICT (kind, year) DO UPDATE SET value = "counters".value + 1
      RETURNING value`;
    const payment = await tx.payment.create({
      data: {
        billId,
        amount: input.amount,
        paidOn: dateOnly(input.paidOn),
        method: input.method,
        reference: input.reference ?? null,
        receiptNo: receiptNumber(year, counter!.value),
        recordedById: actor.id,
      },
      select: { id: true },
    });
    return payment.id;
  });
  return { paymentId, bill: await getBill(billId) };
}

/** BR-13: payments are never deleted. A wrong one is voided with a reason, and stays visible in the history. */
export async function voidPayment(paymentId: string, input: z.infer<typeof voidPaymentSchema>, actor: Actor) {
  assertUuid(paymentId);
  const billId = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ billId: string; voidedAt: Date | null }[]>`
      SELECT "billId", "voidedAt" FROM "payments" WHERE id = ${paymentId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound();
    if (rows[0]!.voidedAt) throw new ApiError(409, 'PAYMENT_ALREADY_VOIDED');
    await tx.payment.update({ where: { id: paymentId }, data: { voidedAt: new Date(), voidedById: actor.id, voidReason: input.reason } });
    return rows[0]!.billId;
  });
  return getBill(billId);
}

export interface ReceiptData {
  receiptNo: string;
  paidOn: string;
  amount: number;
  method: string;
  reference: string | null;
  balanceAfter: number;
  billMonth: string;
  billKind: 'REGULAR' | 'OPENING_BALANCE';
  unitNumber: string;
  residentName: string | null;
  recordedBy: string;
  voided: boolean;
  voidReason: string | null;
}

/** The facts printed on a receipt, after checking that this person may see it (FR-14, NFR-24). */
export async function getReceiptData(paymentId: string, user: AuthUser): Promise<ReceiptData> {
  assertUuid(paymentId);
  const p = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      recordedBy: { select: { fullName: true } },
      bill: { include: { unit: { select: { unitNumber: true } }, billingContact: { select: { fullName: true } } } },
    },
  });
  if (!p) throw notFound();

  if (!canReadAllBills(user)) {
    if (user.role !== 'RESIDENT') throw forbidden();
    if (!(await residentCanSeeBill(user.id, p.billId))) throw notFound(); // never confirm that another resident's receipt exists
  }

  // Balance remaining after this payment: the bill total less every valid payment up to and including this one.
  const [after] = await prisma.$queryRaw<{ balance: bigint }[]>`
    SELECT (SELECT COALESCE(SUM(c.amount), 0) FROM "charges" c WHERE c."billId" = p1."billId")
         - (SELECT COALESCE(SUM(p2.amount), 0) FROM "payments" p2
            WHERE p2."billId" = p1."billId" AND p2."voidedAt" IS NULL AND (p2."createdAt", p2.id) <= (p1."createdAt", p1.id)) AS balance
    FROM "payments" p1 WHERE p1.id = ${paymentId}::uuid`;

  return {
    receiptNo: p.receiptNo,
    paidOn: ymdOf(p.paidOn),
    amount: p.amount,
    method: p.method,
    reference: p.reference,
    balanceAfter: Number(after!.balance),
    billMonth: ymdOf(p.bill.billingMonth).slice(0, 7),
    billKind: p.bill.kind,
    unitNumber: p.bill.unit.unitNumber,
    residentName: p.bill.billingContact?.fullName ?? null,
    recordedBy: p.recordedBy.fullName,
    voided: p.voidedAt !== null,
    voidReason: p.voidReason,
  };
}
