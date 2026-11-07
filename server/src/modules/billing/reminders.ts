import { prisma } from '../../lib/prisma';
import { householdsOf } from '../notifications/notify';

/** BR-20: a household is reminded this many days before the due date. */
export const REMIND_DAYS_BEFORE = 3;

/**
 * Reminds households about unpaid bills that are due within REMIND_DAYS_BEFORE days, and about bills that are
 * overdue. Each person is reminded once per bill and kind (a unique index), so running the job again, or after
 * downtime, never sends the same reminder twice. Returns how many notifications were created.
 */
export async function sendBillReminders(): Promise<number> {
  const rows = await prisma.$queryRaw<{ billId: string; contactId: string; unitNumber: string; kind: 'BILL_DUE_SOON' | 'BILL_OVERDUE'; balance: bigint; dueDate: string }[]>`
    SELECT s."billId"::text AS "billId", b."billingContactId"::text AS "contactId", u."unitNumber",
           CASE WHEN s.status = 'OVERDUE' THEN 'BILL_OVERDUE' ELSE 'BILL_DUE_SOON' END AS kind,
           s.balance, s."dueDate"::text AS "dueDate"
    FROM bill_summary s
    JOIN "bills" b ON b.id = s."billId"
    JOIN "units" u ON u.id = s."unitId"
    WHERE s.balance > 0 AND b."billingContactId" IS NOT NULL
      AND (s.status = 'OVERDUE' OR s."dueDate" <= (now() AT TIME ZONE 'Asia/Dhaka')::date + ${REMIND_DAYS_BEFORE}::int)`;
  if (rows.length === 0) return 0;

  const households = await householdsOf(prisma, [...new Set(rows.map((r) => r.contactId))]);
  const data = rows.flatMap((r) =>
    (households.get(r.contactId) ?? []).map((userId) => ({
      userId,
      type: r.kind,
      params: { unit: r.unitNumber, amount: Number(r.balance), dueDate: r.dueDate },
      link: `/bills/${r.billId}`,
      entityId: r.billId,
    })),
  );
  if (data.length === 0) return 0;
  return (await prisma.notification.createMany({ data, skipDuplicates: true })).count;
}
