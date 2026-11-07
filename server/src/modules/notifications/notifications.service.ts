import { z } from 'zod';
import { notificationListQuerySchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { assertUuid, notFound } from '../../lib/errors';

/** FR-26: a person's own notifications, newest first. Nobody can read anyone else's (NFR-15). */
export async function listNotifications(userId: string, query: z.infer<typeof notificationListQuerySchema>) {
  const where = { userId, ...(query.unread && { readAt: null }) };
  const [total, unread, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return {
    items: rows.map((n) => ({ id: n.id, type: n.type, params: n.params, link: n.link, readAt: n.readAt, createdAt: n.createdAt })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    unread,
  };
}

/** The number on the bell icon (FR-25). */
export async function unreadCount(userId: string) {
  return { unread: await prisma.notification.count({ where: { userId, readAt: null } }) };
}

/** Marking one as read. Someone else's notification is "not found", the same as one that does not exist. */
export async function markRead(userId: string, id: string) {
  assertUuid(id);
  const n = await prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
  if (!n) throw notFound();
  await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  return unreadCount(userId);
}

export async function markAllRead(userId: string) {
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return unreadCount(userId);
}
