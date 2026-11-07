import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { activityListQuerySchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';

const include = { actor: { select: { id: true, fullName: true } } } satisfies Prisma.ActivityLogInclude;
type Row = Prisma.ActivityLogGetPayload<{ include: typeof include }>;

const toDto = (r: Row) => ({
  id: r.id,
  action: r.action,
  entityType: r.entityType,
  entityId: r.entityId,
  details: r.details,
  actor: r.actor,
  ip: r.ip,
  createdAt: r.createdAt,
});

/** FR-34: newest first, filtered by person, action and date. Dates mean days in Dhaka. */
export async function listActivity(query: z.infer<typeof activityListQuerySchema>) {
  const where: Prisma.ActivityLogWhereInput = {
    ...(query.actorId && { actorId: query.actorId }),
    ...(query.action && { action: query.action }),
    ...((query.from || query.to) && {
      createdAt: {
        ...(query.from && { gte: new Date(`${query.from}T00:00:00+06:00`) }),
        ...(query.to && { lt: new Date(Date.parse(`${query.to}T00:00:00+06:00`) + 86_400_000) }),
      },
    }),
  };
  const [total, rows] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include,
    }),
  ]);
  return { items: rows.map(toDto), page: query.page, pageSize: query.pageSize, total };
}

/** Everyone who appears in the log, for the filter. */
export async function listActors() {
  const rows = await prisma.user.findMany({
    where: { activities: { some: {} } },
    orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    select: { id: true, fullName: true },
  });
  return { items: rows };
}

/** FR-30: the latest entries, for the dashboard. */
export async function recentActivity(take = 10) {
  const rows = await prisma.activityLog.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, include });
  return rows.map(toDto);
}
