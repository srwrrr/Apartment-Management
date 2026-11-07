import type { NotificationType, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export interface NotifyInput {
  type: NotificationType;
  /** The facts the sentence is built from. The web app writes the sentence in the reader's language. */
  params?: Record<string, unknown>;
  /** Where clicking the notification goes, e.g. /bills/…  */
  link: string;
  /** The bill, request or announcement it is about. */
  entityId?: string;
}

/**
 * Creates a notification for each person (once each). Always pass the transaction of the action that caused it,
 * so a notification can never exist for something that was rolled back (NFR-14).
 * Returns how many were actually created: the reminder notifications are unique per person and bill, so repeating
 * the same call creates nothing new.
 */
export async function notify(db: Db, userIds: Iterable<string>, input: NotifyInput): Promise<number> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return 0;
  const res = await db.notification.createMany({
    data: ids.map((userId) => ({
      userId,
      type: input.type,
      params: (input.params ?? {}) as Prisma.InputJsonValue,
      link: input.link,
      entityId: input.entityId ?? null,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

/**
 * Active people who share a household with any of these users (including the users themselves): the resident
 * of a stay and its household members (BR-27). A bill or request belongs to the whole household.
 */
export async function householdOf(db: Db, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT u.id::text AS id
    FROM household_peers hp JOIN "users" u ON u.id = hp."peerId"
    WHERE hp."userId" = ANY(${userIds}::uuid[]) AND u."isActive"`;
  return rows.map((r) => r.id);
}

/** For many users at once: contact id -> the household's active members. */
export async function householdsOf(db: Db, userIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (userIds.length === 0) return map;
  const rows = await db.$queryRaw<{ userId: string; peerId: string }[]>`
    SELECT hp."userId"::text AS "userId", hp."peerId"::text AS "peerId"
    FROM household_peers hp JOIN "users" u ON u.id = hp."peerId"
    WHERE hp."userId" = ANY(${userIds}::uuid[]) AND u."isActive"`;
  for (const r of rows) map.set(r.userId, [...(map.get(r.userId) ?? []), r.peerId]);
  return map;
}

const MAINTENANCE_PERMISSIONS = ['maintenance.view_all', 'maintenance.review', 'maintenance.assign'];

/** Active administrators, and staff who look after maintenance: the people who hear about a new request. */
export async function maintenanceStaff(db: Db): Promise<string[]> {
  const rows = await db.user.findMany({
    where: { isActive: true, OR: [{ role: 'ADMIN' }, { role: 'STAFF', permissions: { some: { permission: { in: MAINTENANCE_PERMISSIONS } } } }] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
