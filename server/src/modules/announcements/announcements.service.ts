import { Prisma } from '@prisma/client';
import { changes, logActivity } from '../activity/activity';
import { z } from 'zod';
import type { AnnouncementAudience } from '@apt/shared';
import { announcementCreateSchema, announcementListQuerySchema, announcementUpdateSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, notFound } from '../../lib/errors';
import { todayDhaka, ymdDhaka } from '../../lib/dates';
import { fontCss } from '../../pdf/fonts';
import { dateLabel, esc, type Lang } from '../billing/receipt';
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
    case 'GROUP':
      rows = await db.$queryRaw`
        SELECT u.id::text AS id FROM resident_group_members m JOIN "users" u ON u.id = m."userId"
        WHERE m."groupId" = ${audience.groupId}::uuid AND u."isActive" AND u.role = 'RESIDENT'`;
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
  if (audience.type === 'GROUP' && !(await db.residentGroup.findUnique({ where: { id: audience.groupId }, select: { id: true } }))) {
    throw new ApiError(400, 'VALIDATION_FAILED', { audience: { code: 'GROUP_NOT_FOUND' } });
  }
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
  const now = new Date();
  const publishAt = input.publishAt && new Date(input.publishAt) > now ? new Date(input.publishAt) : now;
  const scheduled = publishAt > now; // FR-51: nobody is told, and nobody can see it, until then
  const id = await prisma.$transaction(async (tx) => {
    await checkUnitsExist(tx, input.audience);
    const recipients = await resolveAudience(tx, input.audience);
    if (recipients.length === 0) throw emptyAudience(); // sending to nobody is almost certainly a mistake
    const a = input.audience;
    const group = a.type === 'GROUP' ? await tx.residentGroup.findUniqueOrThrow({ where: { id: a.groupId }, select: { id: true, name: true } }) : null;
    const created = await tx.announcement.create({
      data: {
        title: input.title,
        body: input.body,
        category: input.category,
        isImportant: input.isImportant,
        audienceType: a.type,
        publishedById: user.id,
        publishedAt: publishAt,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        recipientsResolvedAt: scheduled ? null : now,
        audience: {
          create:
            a.type === 'UNITS'
              ? [...new Set(a.unitIds)].map((unitId) => ({ unitId }))
              : a.type === 'FLOORS'
                ? [...new Set(a.floors)].map((floor) => ({ floor }))
                : group
                  ? [{ groupId: group.id, groupName: group.name }]
                  : [],
        },
        recipients: { create: scheduled ? [] : recipients.map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    if (scheduled) {
      await logActivity(tx, 'announcement.schedule', { entityType: 'announcement', entityId: created.id, details: { title: input.title, audience: a.type, publishAt: publishAt.toISOString() } });
      return created.id;
    }
    await tellRecipients(tx, recipients, { id: created.id, title: input.title, category: input.category, isImportant: input.isImportant });
    await logActivity(tx, 'announcement.publish', { entityType: 'announcement', entityId: created.id, details: { title: input.title, audience: a.type, recipients: recipients.length } });
    return created.id;
  });
  return getForManager(id);
}

function tellRecipients(tx: Prisma.TransactionClient, recipients: string[], a: { id: string; title: string; category: string; isImportant: boolean }) {
  return notify(tx, recipients, {
    type: 'ANNOUNCEMENT',
    params: { title: a.title, category: a.category, important: a.isImportant },
    link: `/announcements/${a.id}`,
    entityId: a.id,
  });
}

/** The audience as it was chosen, for an announcement that goes out later. */
function savedAudience(a: { audienceType: string; audience: { unitId: string | null; floor: number | null; groupId: string | null }[] }): AnnouncementAudience | null {
  switch (a.audienceType) {
    case 'UNITS':
      return { type: 'UNITS', unitIds: a.audience.flatMap((r) => (r.unitId ? [r.unitId] : [])) };
    case 'FLOORS':
      return { type: 'FLOORS', floors: a.audience.flatMap((r) => (r.floor !== null ? [r.floor] : [])) };
    case 'GROUP': {
      const groupId = a.audience[0]?.groupId;
      return groupId ? { type: 'GROUP', groupId } : null; // the group was deleted while it was waiting
    }
    default:
      return { type: a.audienceType as 'ALL' | 'OWNERS' | 'TENANTS' };
  }
}

/**
 * FR-51: sends what has reached its publish time, deciding who gets it at that moment. Each one is claimed with a
 * row lock and marked as sent in the same transaction, so running this twice never sends anything twice.
 */
export async function publishDueAnnouncements(now = new Date()): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "announcements"
      WHERE "recipientsResolvedAt" IS NULL AND "publishedAt" <= ${now} AND "archivedAt" IS NULL
      FOR UPDATE SKIP LOCKED`;
    for (const { id } of due) {
      const a = await tx.announcement.findUniqueOrThrow({ where: { id }, include: { audience: true } });
      const audience = savedAudience(a);
      const recipients = audience ? await resolveAudience(tx, audience) : [];
      await tx.announcementRecipient.createMany({ data: recipients.map((userId) => ({ announcementId: id, userId })) });
      await tx.announcement.update({ where: { id }, data: { recipientsResolvedAt: now } });
      await tellRecipients(tx, recipients, a);
      await logActivity(tx, 'announcement.publish', { actorId: null, entityType: 'announcement', entityId: id, details: { title: a.title, audience: a.audienceType, recipients: recipients.length, automatic: true } });
    }
    return due.length;
  });
}

/** Display state (FR-51), worked out from the dates. */
function stateOf(a: { archivedAt: Date | null; recipientsResolvedAt: Date | null; endsAt: Date | null }, now = new Date()) {
  if (a.archivedAt) return 'ARCHIVED' as const;
  if (!a.recipientsResolvedAt) return 'SCHEDULED' as const;
  return a.endsAt && a.endsAt <= now ? ('ENDED' as const) : ('ACTIVE' as const);
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
    endsAt: a.endsAt,
    state: stateOf(a),
    editedAt: a.editedAt,
    archivedAt: a.archivedAt,
    author: a.publishedBy.fullName,
    audience: {
      type: a.audienceType,
      units: a.audience.filter((r) => r.unit).map((r) => r.unit!),
      floors: a.audience.filter((r) => r.floor !== null).map((r) => r.floor!),
      group: a.audience.find((r) => r.groupName)?.groupName ?? null,
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
    endsAt: a.endsAt,
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
        endsAt: a.endsAt,
        state: stateOf(a),
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
  // FR-51: what has ended moves from the main list to past announcements.
  const showing = query.past === 'true' ? Prisma.sql`a."endsAt" <= now()` : Prisma.sql`(a."endsAt" IS NULL OR a."endsAt" > now())`;
  const [counted] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM announcement_recipients r JOIN announcements a ON a.id = r."announcementId"
    WHERE r."userId" = ${user.id}::uuid AND a."archivedAt" IS NULL AND ${showing}`;
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
    WHERE r."userId" = ${user.id}::uuid AND a."archivedAt" IS NULL AND ${showing}
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
  const sent = a.recipientsResolvedAt !== null;
  const { publishAt, endsAt, ...text } = input;
  if (publishAt && sent) throw new ApiError(409, 'ANNOUNCEMENT_ALREADY_SENT');
  const start = publishAt ? new Date(publishAt) : a.publishedAt;
  if (publishAt && start <= new Date()) throw new ApiError(400, 'VALIDATION_FAILED', { publishAt: { code: 'PUBLISH_IN_PAST' } });
  const end = endsAt === undefined ? a.endsAt : endsAt === null ? null : new Date(endsAt);
  if (end && end <= start) throw new ApiError(400, 'VALIDATION_FAILED', { endsAt: { code: 'ENDS_BEFORE_PUBLISH' } });
  await prisma.$transaction(async (tx) => {
    await tx.announcement.update({
      where: { id },
      // "Edited" is for residents who may have read the earlier version, so it only applies once it has gone out.
      data: { ...text, publishedAt: start, endsAt: end, ...(sent && Object.keys(text).length > 0 && { editedAt: new Date() }) },
    });
    await logActivity(tx, 'announcement.update', { entityType: 'announcement', entityId: id, details: { title: a.title, changes: changes(a, text) } });
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

/** FR-53: a notice for the lift lobby. Black on white in large type, so it survives a mono printer and a distance. */
export function noticeHtml(a: { title: string; body: string; publishedAt: Date }, buildingName: string, lang: Lang): string {
  return `<!doctype html>
<html lang="${lang === 'BN' ? 'bn' : 'en'}"><head><meta charset="utf-8"><title>${esc(a.title)}</title>
<style>
${fontCss()}
*{box-sizing:border-box}
body{font-family:'Noto Sans','Noto Sans Bengali',sans-serif;color:#000;background:#fff;margin:0}
.building{font-size:24px;font-weight:700;text-align:center;border-bottom:3px solid #000;padding-bottom:12px}
h1{font-size:44px;line-height:1.25;text-align:center;margin:32px 0 28px;overflow-wrap:anywhere}
.body{font-size:26px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.date{margin-top:36px;font-size:20px;text-align:right}
</style></head><body>
<div class="building">${esc(buildingName)}</div>
<h1>${esc(a.title)}</h1>
<div class="body">${esc(a.body)}</div>
<div class="date">${esc(dateLabel(ymdDhaka(a.publishedAt), lang))}</div>
</body></html>`;
}

export async function getForNotice(id: string) {
  assertUuid(id);
  const a = await prisma.announcement.findUnique({ where: { id }, select: { title: true, body: true, publishedAt: true } });
  if (!a) throw notFound();
  return a;
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
