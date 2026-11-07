import type { ActivityAction } from '@apt/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { currentRequest } from '../../lib/requestContext';

type Db = PrismaClient | Prisma.TransactionClient;

export interface ActivityEntry {
  entityType?: string;
  entityId?: string | null;
  /** The facts of the action. Never a password, a hash or a temporary password. */
  details?: Record<string, unknown>;
  /** Only when the request has no logged-in user yet (logging in). Otherwise it comes from the request. */
  actorId?: string | null;
}

/**
 * FR-34. Pass the transaction of the action, so a change and its record are saved together or not at all (NFR-14).
 */
export async function logActivity(db: Db, action: ActivityAction, entry: ActivityEntry = {}) {
  const { actorId, ip } = currentRequest();
  await db.activityLog.create({
    data: {
      action,
      actorId: entry.actorId !== undefined ? entry.actorId : actorId,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      details: (entry.details ?? {}) as Prisma.InputJsonValue,
      ip,
    },
  });
}

/** What changed between two versions: { field: [before, after] }, for the fields that differ. */
export function changes<T extends object>(before: T, after: Partial<T>, fields: (keyof T)[] = Object.keys(after) as (keyof T)[]) {
  const out: Record<string, [unknown, unknown]> = {};
  for (const f of fields) {
    if (after[f] !== undefined && after[f] !== before[f]) out[String(f)] = [before[f], after[f]];
  }
  return out;
}
