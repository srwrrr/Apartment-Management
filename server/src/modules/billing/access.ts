import { BILL_READ_PERMISSIONS, hasPermission } from '@apt/shared';
import type { AuthUser } from '../../types';
import { prisma } from '../../lib/prisma';

/** Admin, or staff holding any permission that needs to see bills (SRS Appendix B). */
export const canReadAllBills = (user: AuthUser) => BILL_READ_PERMISSIONS.some((p) => hasPermission(user, p));

/** Residents (and household members) see a bill only through the bill_access view (BR-08, BR-22, BR-27). */
export async function residentCanSeeBill(userId: string, billId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT 1 AS n FROM bill_access WHERE "userId" = ${userId}::uuid AND "billId" = ${billId}::uuid LIMIT 1`;
  return rows.length > 0;
}
