import { Prisma } from '@prisma/client';
import { changes, logActivity } from '../activity/activity';
import { z } from 'zod';
import type { AnnouncementAudience } from '@apt/shared';
import { announcementCreateSchema, announcementListQuerySchema, announcementUpdateSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, notFound } from '../../lib/errors';
import { todayDhaka } from '../../lib/dates';
import { notify } from '../notifications/notify';
import type { AuthUser } from '../../types';

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Who an announcement reaches right now (FR-24): active residents only, by who lives where today.
 * Household members count with their household (BR-27).
 */
export async function resolveAudience(db: Db, audience: AnnouncementAudience): Promise<string[]> {
  const today = todayDhaka();
  let rows: { id: string }[];
  switch (audience.type) {
    case 'ALL':
      rows = await db.$queryRaw`SELECT id::text AS id FROM "users" WHERE role = 'RESIDENT' AND "isActive"`;
      break;
    case 'UNITS':
      rows = await db.$queryRaw`
        SELECT DISTINCT ua."userId"::text AS id
        FROM unit_access ua JOIN "users" u ON u.id = ua."userId"
        WHERE ua."unitId" = ANY(${audience.unitIds}::uuid[]) AND u."isActive" AND u.role = 'RESIDENT'
          AND ua."startDate" <= ${today}::date AND (ua."endDate" IS NULL OR ua."endDate" >= ${today}::date)`;
      break;
    case 'FLOORS':
      rows = await db.$queryRaw`
        SELECT DISTINCT ua."userId"::text AS id
        FROM unit_access ua JOIN "users" u ON u.id = ua."userId" JOIN "units" un ON un.id = ua."unitId"
        WHERE un.floor = ANY(${audience.floors}::int[]) AND u."isActive" AND u.role = 'RESIDENT'
          AND ua."startDate" <= ${today}::date AND (ua."endDate" IS NULL OR ua."endDate" >= ${today}::date)`;
      break;
    case 'OWNERS':
    case 'TENANTS':
      rows = await db.$queryRaw`
        WITH stays AS (
          SELECT o.id, o."residentId" FROM "occupancies" o
          WHERE o.type = ${audience.type === 'OWNERS' ? 'OWNER' : 'TENANT'}::"OccupancyType"
            AND o."startDate" <= ${today}::date AND (o."endDate" IS NULL OR o."endDate" >= ${today}::date)
        ), people AS (
          SELECT "residentId" AS uid FROM stays
          UNION
          SELECT hm."userId" FROM "household_members" hm JOIN stays s ON s.id = hm."occupancyId"
          WHERE hm."addedAt" <= ${today}::date AND (hm."removedAt" IS NULL OR hm."removedAt" >= ${today}::date)
        )
        SELECT u.id::text AS id FROM people p JOIN "users" u ON u.id = p.uid WHERE u."isActive" AND u.role = 'RESIDENT'`;
      break;
  }
  return rows.map((r) => r.id);
}

async function checkUnitsExist(db: Db, audience: AnnouncementAudience) {
  if (audience.type !== 'UNITS') return;
  const unique = [...new Set(audience.unitIds)];
  const found = await db.unit.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw new ApiError(400, 'VALIDATION_FAILED', { audience: { code: 'UNIT_NOT_FOUND' } });
}

const emptyAudience = () => new ApiError(400, 'VALIDATION_FAILED', { audience: { code: 'AUDIENCE_EMPTY' } });

/** "This will reach N residents": shown before publishing. */
export async function previewAudience(audience: AnnouncementAudience) {
  await checkUnitsExist(prisma, audience);
  return { count: (await resolveAudience(prisma, audience)).length };
}

/**
 * FR-23 / FR-24: publish. The announcement, the list of who it reached, and everyone's notification are saved
 * together or not at all. The list is fixed now: people who move in later do not receive it.
 */
export async function publish(input: z.infer<typeof announcementCreateSchema>, user: AuthUser) {
  const id = await prisma.$transaction(async (tx) => {
    await checkUnitsExist(tx, input.audience);
    const recipients = await resolveAudience(tx, input.audience);
    if (recipients.length === 0) throw emptyAudience(); // sending to nobody is almost certainly a mistake
    const a = input.audience;
    const created = await tx.announcement.create({
      data: {
        title: input.title,
        body: input.body,
        category: input.category,
        isImportant: input.isImportant,
        audienceType: a.type,
        publishedById: user.id,
        audience: {
          create:
            a.type === 'UNITS' ? [...new Set(a.unitIds)].map((unitId) => ({ unitId })) : a.type === 'FLOORS' ? [...new Set(a.floors)].map((floor) => ({ floor })) : [],
        },
        recipients: { create: recipients.map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    await notify(tx, recipients, {
      type: 'ANNOUNCEMENT',
      params: { title: input.title, category: input.category, important: input.isImportant },
      link: `/announcements/${created.id}`,
      entityId: created.id,
    });
    await logActivity(tx, 'announcement.publish', { entityType: 'announcement', entityId: created.id, details: { title: input.title, audience: a.type, recipients: recipients.length } });
    return created.id;
  });
  return getForManager(id);
}

// ---------------------------------------------------------------- shaping

const authorName = { publishedBy: { select: { fullName: true } } } as const;

async function counts(ids: string[]) {
  if (ids.length === 0) return new Map<string, { recipients: number; read: number }>();
  const rows = await prisma.$queryRaw<{ id: string; recipients: number; read: number }[]>`
    SELECT r."announcementId"::text AS id, COUNT(*)::int AS recipients, COUNT(n."readAt")::int AS read
    FROM announcement_recipients r
    LEFT JOIN "notifications" n ON n."userId" = r."userId" AND n.type = 'ANNOUNCEMENT' AND n."entityId" = r."announcementId"
    WHERE r."announcementId" = ANY(${ids}::uuid[])
    GROUP BY r."announcementId"`;
  return new Map(rows.map((r) => [r.id, { recipients: r.recipients, read: r.read }]));
}

async function getForManager(id: string) {
  assertUuid(id);
  const a = await prisma.announcement.findUnique({
    where: { id },
    include: { ...authorName, audience: { include: { unit: { select: { id: true, unitNumber: true } } } } },
  });
  if (!a) throw notFound();
  const c = (await counts([id])).get(id) ?? { recipients: 0, read: 0 };
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    category: a.category,
    isImportant: a.isImportant,
    publishedAt: a.publishedAt,
    editedAt: a.editedAt,
    archivedAt: a.archivedAt,
    author: a.publishedBy.fullName,
    audience: {
      type: a.audienceType,
      units: a.audience.filter((r) => r.unit).map((r) => r.unit!),
      floors: a.audience.filter((r) => r.floor !== null).map((r) => r.floor!),
    },
    recipients: c.recipients,
    read: c.read,
  };
}

/** A resident may open an announcement only if it was sent to them and has not been archived. */
async function getForResident(id: string, userId: string) {
  assertUuid(id);
  const a = await prisma.announcement.findFirst({
    where: { id, archivedAt: null, recipients: { some: { userId } } },
    include: authorName,
  });
  if (!a) throw notFound(); // someone else's announcement looks exactly like one that does not exist
  const read = await prisma.notification.findFirst({ where: { userId, type: 'ANNOUNCEMENT', entityId: id, readAt: { not: null } }, select: { id: true } });
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    category: a.category,
    isImportant: a.isImportant,
    publishedAt: a.publishedAt,
    editedAt: a.editedAt,
    author: a.publishedBy.fullName,
    read: read !== null,
  };
}

export async function getAnnouncement(id: string, user: AuthUser, canManage: boolean) {
  return canManage ? getForManager(id) : getForResident(id, user.id);
}

// ------------------------------------------------------------------ lists

export async function listAnnouncements(query: z.infer<typeof announcementListQuerySchema>, user: AuthUser, canManage: boolean) {
  const offset = (query.page - 1) * query.pageSize;

  if (canManage) {
    const where: Prisma.AnnouncementWhereInput = query.archived === 'all' ? {} : query.archived === 'true' ? { archivedAt: { not: null } } : { archivedAt: null };
    const [total, rows] = await Promise.all([
      prisma.announcement.count({ where }),
      prisma.announcement.findMany({
        where,
        orderBy: [{ isImportant: 'desc' }, { publishedAt: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: query.pageSize,
        include: authorName,
      }),
    ]);
    const c = await counts(rows.map((r) => r.id));
    return {
      items: rows.map((a) => ({
        id: a.id,
        title: a.title,
        category: a.category,
        isImportant: a.isImportant,
        audienceType: a.audienceType,
        publishedAt: a.publishedAt,
        editedAt: a.editedAt,
        archivedAt: a.archivedAt,
        author: a.publishedBy.fullName,
        recipients: c.get(a.id)?.recipients ?? 0,
        read: c.get(a.id)?.read ?? 0,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  // Everyone else sees only what was sent to them (staff who are not residents receive none).
  const [counted] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM announcement_recipients r JOIN announcements a ON a.id = r."announcementId"
    WHERE r."userId" = ${user.id}::uuid AND a."archivedAt" IS NULL`;
  const n = counted?.n ?? 0;
  const rows = await prisma.$queryRaw<
    { id: string; title: string; category: string; isImportant: boolean; publishedAt: Date; editedAt: Date | null; preview: string; author: string; read: boolean }[]
  >`
    SELECT a.id::text AS id, a.title, a.category::text AS category, a."isImportant", a."publishedAt", a."editedAt",
           left(a.body, 160) AS preview, u."fullName" AS author, (n."readAt" IS NOT NULL) AS read
    FROM announcement_recipients r
    JOIN announcements a ON a.id = r."announcementId"
    JOIN "users" u ON u.id = a."publishedById"
    LEFT JOIN "notifications" n ON n."userId" = r."userId" AND n.type = 'ANNOUNCEMENT' AND n."entityId" = a.id
    WHERE r."userId" = ${user.id}::uuid AND a."archivedAt" IS NULL
    ORDER BY a."isImportant" DESC, a."publishedAt" DESC, a.id
    LIMIT ${query.pageSize} OFFSET ${offset}`;
  return { items: rows, page: query.page, pageSize: query.pageSize, total: n };
}

// ------------------------------------------------------ edit, archive, read

/** FR-23: corrections only. Residents see that it was edited and when; nobody is notified again. */
export async function updateAnnouncement(id: string, input: z.infer<typeof announcementUpdateSchema>) {
  assertUuid(id);
  const a = await prisma.announcement.findUnique({ where: { id } });
  if (!a) throw notFound();
  if (a.archivedAt) throw new ApiError(409, 'ANNOUNCEMENT_ARCHIVED');
  await prisma.$transaction(async (tx) => {
    await tx.announcement.update({ where: { id }, data: { ...input, editedAt: new Date() } });
    await logActivity(tx, 'announcement.update', { entityType: 'announcement', entityId: id, details: { title: a.title, changes: changes(a, input) } });
  });
  return getForManager(id);
}

/** FR-23: archived announcements leave residents' pages but stay on record. */
export async function archiveAnnouncement(id: string) {
  assertUuid(id);
  const a = await prisma.announcement.findUnique({ where: { id }, select: { archivedAt: true, title: true } });
  if (!a) throw notFound();
  if (!a.archivedAt) {
    await prisma.$transaction(async (tx) => {
      await tx.announcement.update({ where: { id }, data: { archivedAt: new Date() } });
      await logActivity(tx, 'announcement.archive', { entityType: 'announcement', entityId: id, details: { title: a.title } });
    });
  }
  return getForManager(id);
}

/** Opening the announcement counts as reading it (FR-26). Only people it was sent to can do this. */
export async function markAnnouncementRead(id: string, userId: string) {
  await getForResident(id, userId); // 404 unless it was sent to this person and is still showing
  await prisma.notification.updateMany({ where: { userId, type: 'ANNOUNCEMENT', entityId: id, readAt: null }, data: { readAt: new Date() } });
  return getForResident(id, userId);
}

/** FR-26: how many have read it, and who has not. */
export async function readStatus(id: string) {
  assertUuid(id);
  if (!(await prisma.announcement.findUnique({ where: { id }, select: { id: true } }))) throw notFound();
  const today = todayDhaka();
  const c = (await counts([id])).get(id) ?? { recipients: 0, read: 0 };
  const unread = await prisma.$queryRaw<{ id: string; fullName: string; units: string | null }[]>`
    SELECT u.id::text AS id, u."fullName",
           (SELECT string_agg(DISTINCT un."unitNumber", ', ' ORDER BY un."unitNumber")
            FROM unit_access ua JOIN "units" un ON un.id = ua."unitId"
            WHERE ua."userId" = u.id AND ua."startDate" <= ${today}::date AND (ua."endDate" IS NULL OR ua."endDate" >= ${today}::date)) AS units
    FROM announcement_recipients r
    JOIN "users" u ON u.id = r."userId"
    LEFT JOIN "notifications" n ON n."userId" = r."userId" AND n.type = 'ANNOUNCEMENT' AND n."entityId" = r."announcementId"
    WHERE r."announcementId" = ${id}::uuid AND (n.id IS NULL OR n."readAt" IS NULL)
    ORDER BY u."fullName", u.id
    LIMIT 500`;
  return { recipients: c.recipients, read: c.read, unread };
}
