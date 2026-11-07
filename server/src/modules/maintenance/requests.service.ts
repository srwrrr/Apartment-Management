import { Prisma, type RequestPriority, type RequestStatus } from '@prisma/client';
import { z } from 'zod';
import { hasPermission, requestCreateSchema, requestListQuerySchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, forbidden, notFound } from '../../lib/errors';
import { removeStored, storeImages } from '../../lib/files';
import { todayDhaka } from '../../lib/dates';
import type { AuthUser } from '../../types';
import { slaHours, getSla, type Sla } from './sla';
import { householdOf, maintenanceStaff, notify } from '../notifications/notify';
import { logActivity } from '../activity/activity';

type Tx = Prisma.TransactionClient;

/** Statuses where nothing more is expected to happen: they are never "overdue" (BR-17). */
const FINISHED: RequestStatus[] = ['RESOLVED', 'CLOSED', 'REJECTED', 'CANCELLED'];
const OPEN_FOR_STAFF: RequestStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS'];

// ------------------------------------------------------------ who may do what

const isAdmin = (u: AuthUser) => u.role === 'ADMIN';
const canReview = (u: AuthUser) => hasPermission(u, 'maintenance.review');
const canAssign = (u: AuthUser) => hasPermission(u, 'maintenance.assign');
/** Staff who look after maintenance in general (the full list). Others see only what is assigned to them. */
export const seesAllRequests = (u: AuthUser) =>
  u.role === 'ADMIN' || ['maintenance.view_all', 'maintenance.review', 'maintenance.assign'].some((p) => u.permissions.includes(p));

interface Access {
  /** a resident who is the submitter, or lives in the same household (BR-27) */
  household: boolean;
  staff: boolean;
  assignee: boolean;
}

async function accessTo(user: AuthUser, r: { submittedById: string; assignedToId: string | null }): Promise<Access> {
  const staff = user.role !== 'RESIDENT' && seesAllRequests(user);
  const assignee = user.role !== 'RESIDENT' && r.assignedToId === user.id;
  let household = false;
  if (user.role === 'RESIDENT') {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM household_peers WHERE "userId" = ${user.id}::uuid AND "peerId" = ${r.submittedById}::uuid LIMIT 1`;
    household = rows.length > 0;
  }
  return { household, staff, assignee };
}

// ------------------------------------------------------------------- shaping

const requestInclude = {
  submittedBy: { select: { id: true, fullName: true, phone: true } },
  unit: { select: { id: true, unitNumber: true, floor: true } },
  assignedTo: { select: { id: true, fullName: true } },
  attachments: { select: { id: true, originalName: true, mimeType: true, requestUpdateId: true }, orderBy: { createdAt: 'asc' } },
  updates: {
    orderBy: { seq: 'asc' },
    include: {
      author: { select: { fullName: true } },
      attachments: { select: { id: true, originalName: true, mimeType: true } },
    },
  },
} satisfies Prisma.MaintenanceRequestInclude;

type FullRequest = Prisma.MaintenanceRequestGetPayload<{ include: typeof requestInclude }>;

const isOverdue = (r: { status: RequestStatus; dueAt: Date }, now = new Date()) => !FINISHED.includes(r.status) && r.dueAt < now;

/** One request as the API returns it. Residents never get internal notes, the submitter's phone, or staff-only fields. */
function toDto(r: FullRequest, audience: 'staff' | 'resident') {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    description: r.description,
    category: r.category,
    location: r.location,
    priority: r.priority,
    status: r.status,
    overdue: isOverdue(r),
    dueAt: r.dueAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    resolvedAt: r.resolvedAt,
    closedAt: r.closedAt,
    unit: r.unit,
    assignedTo: r.assignedTo,
    submittedBy: audience === 'staff' ? r.submittedBy : { id: r.submittedBy.id, fullName: r.submittedBy.fullName },
    photos: r.attachments.filter((a) => a.requestUpdateId === null).map((a) => ({ id: a.id, name: a.originalName })),
    updates: r.updates
      .filter((u) => audience === 'staff' || !u.isInternal)
      .map((u) => ({
        id: u.id,
        kind: u.kind,
        fromValue: u.fromValue,
        toValue: u.toValue,
        note: u.note,
        isInternal: u.isInternal,
        createdAt: u.createdAt,
        author: u.author?.fullName ?? null, // null means the system itself
        photos: u.attachments.map((a) => ({ id: a.id, name: a.originalName })),
      })),
  };
}

async function loadFull(id: string): Promise<FullRequest> {
  assertUuid(id);
  const r = await prisma.maintenanceRequest.findUnique({ where: { id }, include: requestInclude });
  if (!r) throw notFound();
  return r;
}

/** Loads a request for this person, or refuses. Residents get "not found" for other people's requests (NFR-24). */
async function loadFor(id: string, user: AuthUser) {
  const r = await loadFull(id);
  const access = await accessTo(user, r);
  if (user.role === 'RESIDENT' ? !access.household : !(access.staff || access.assignee)) {
    if (user.role === 'RESIDENT') throw notFound();
    throw forbidden();
  }
  return { r, access, audience: (user.role === 'RESIDENT' ? 'resident' : 'staff') as 'resident' | 'staff' };
}

export async function getRequest(id: string, user: AuthUser) {
  const { r, audience } = await loadFor(id, user);
  return toDto(r, audience);
}

/** Can this person see the request that an attachment belongs to? (for photo downloads) */
export async function requireRequestAccess(id: string, user: AuthUser) {
  return loadFor(id, user);
}

// ----------------------------------------------------------------- history

async function lockRequest(tx: Tx, id: string) {
  assertUuid(id); // a malformed ID can never match, so it is "not found", not a database error
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "maintenance_requests" WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw notFound();
  const r = await tx.maintenanceRequest.findUniqueOrThrow({ where: { id } });
  return r;
}

const note = (tx: Tx, data: Prisma.RequestUpdateUncheckedCreateInput) => tx.requestUpdate.create({ data, select: { id: true } });

// ----------------------------------------------------------- notifications (FR-21, FR-25)

async function facts(tx: Tx, id: string) {
  const r = await tx.maintenanceRequest.findUniqueOrThrow({
    where: { id },
    select: { number: true, title: true, submittedById: true, assignedToId: true, unit: { select: { unitNumber: true } } },
  });
  return { number: r.number, title: r.title, unit: r.unit.unitNumber, submittedById: r.submittedById, assignedToId: r.assignedToId };
}

/**
 * Tells the people who care about a change on a request, except the person who made it. The submitter's household
 * hears about every status change and shared note; the assignee hears about changes made by others.
 * Internal notes tell nobody. Runs inside the action's own transaction, so a rolled-back change tells nobody.
 */
async function tellAboutRequest(tx: Tx, id: string, actorId: string | null, params: Record<string, unknown>, opts: { assignee?: boolean } = {}) {
  const f = await facts(tx, id);
  const audience = new Set(await householdOf(tx, [f.submittedById]));
  if (f.assignedToId && opts.assignee !== false) audience.add(f.assignedToId);
  if (actorId) audience.delete(actorId);
  await notify(tx, audience, { type: 'REQUEST_UPDATE', params: { number: f.number, title: f.title, unit: f.unit, ...params }, link: `/requests/${id}`, entityId: id });
}

// -------------------------------------------------------------- submitting (FR-16, FR-17)

/** The units this person lives in right now (their own stay, or as a household member). */
async function activeUnitsOf(userId: string) {
  const today = todayDhaka();
  return prisma.$queryRaw<{ id: string; unitNumber: string }[]>`
    SELECT DISTINCT u.id::text AS id, u."unitNumber"
    FROM unit_access ua JOIN "units" u ON u.id = ua."unitId"
    WHERE ua."userId" = ${userId}::uuid AND ua."startDate" <= ${today}::date AND (ua."endDate" IS NULL OR ua."endDate" >= ${today}::date)
    ORDER BY u."unitNumber"`;
}

export async function createRequest(user: AuthUser, input: z.infer<typeof requestCreateSchema>, files: Express.Multer.File[]) {
  // The resident's name and unit are filled in by the system, never typed, so they cannot be wrong (FR-17).
  const units = await activeUnitsOf(user.id);
  const bad = (code: string) => new ApiError(400, 'VALIDATION_FAILED', { unitId: { code } });
  let unitId: string;
  if (input.unitId) {
    if (!units.some((u) => u.id === input.unitId)) throw bad('INVALID_UNIT');
    unitId = input.unitId;
  } else if (units.length === 1) unitId = units[0]!.id;
  else if (units.length === 0) throw bad('NO_ACTIVE_UNIT');
  else throw bad('UNIT_REQUIRED');

  const sla = await getSla();
  const stored = await storeImages(files); // checks every photo before anything is saved
  try {
    const created = await prisma.$transaction(async (tx) => {
    const c = await tx.maintenanceRequest.create({
      data: {
        submittedById: user.id,
        unitId,
        location: input.location,
        category: input.category,
        title: input.title,
        description: input.description,
        dueAt: new Date(Date.now() + sla.reviewDeadlineHours * 3_600_000), // must be reviewed within 2 days (BR-17)
        attachments: { create: stored.map((s) => ({ ...s, uploadedById: user.id })) },
        updates: { create: { authorId: user.id, kind: 'STATUS_CHANGE', toValue: 'SUBMITTED' } },
      },
      select: { id: true, number: true },
    });
    // The people who look after maintenance hear about it at once.
    const staff = (await maintenanceStaff(tx)).filter((s) => s !== user.id);
    await notify(tx, staff, {
      type: 'REQUEST_NEW',
      params: { number: c.number, title: input.title, unit: units.find((u) => u.id === unitId)!.unitNumber },
      link: `/requests/${c.id}`,
      entityId: c.id,
    });
    return c;
    });
    return getRequest(created.id, user);
  } catch (e) {
    await removeStored(stored.map((s) => s.storedName)); // nothing was saved, so the files go too
    throw e;
  }
}

// ------------------------------------------------------------------ lists

/** The full list for staff who look after maintenance (FR-18, FR-22). */
export async function listRequests(query: z.infer<typeof requestListQuerySchema>, user: AuthUser) {
  const where: Prisma.MaintenanceRequestWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.category) where.category = query.category;
  if (query.priority) where.priority = query.priority;
  if (query.unitId) where.unitId = query.unitId;
  if (query.assignedTo === 'me') where.assignedToId = user.id;
  else if (query.assignedTo === 'none') where.assignedToId = null;
  else if (query.assignedTo) where.assignedToId = query.assignedTo;
  if (query.overdue) {
    where.status = { in: OPEN_FOR_STAFF };
    where.dueAt = { lt: new Date() };
  }
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from && { gte: new Date(`${query.from}T00:00:00+06:00`) }), // dates mean Dhaka days
      ...(query.to && { lt: new Date(Date.parse(`${query.to}T00:00:00+06:00`) + 86_400_000) }),
    };
  }
  if (query.q) {
    const n = /^#?(\d{1,9})$/.exec(query.q);
    where.OR = [
      { title: { contains: query.q, mode: 'insensitive' } },
      { unit: { unitNumber: { contains: query.q, mode: 'insensitive' } } },
      ...(n ? [{ number: Number(n[1]) }] : []),
    ];
  }
  const [total, rows] = await Promise.all([
    prisma.maintenanceRequest.count({ where }),
    prisma.maintenanceRequest.findMany({
      where,
      orderBy: [{ createdAt: query.sort === 'oldest' ? 'asc' : 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { unit: { select: { id: true, unitNumber: true } }, assignedTo: { select: { id: true, fullName: true } }, submittedBy: { select: { fullName: true } } },
    }),
  ]);
  const now = new Date();
  return {
    items: rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      category: r.category,
      priority: r.priority,
      status: r.status,
      overdue: isOverdue(r, now),
      createdAt: r.createdAt,
      dueAt: r.dueAt,
      unit: r.unit,
      assignedTo: r.assignedTo,
      submittedBy: r.submittedBy.fullName,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

/** A resident's own requests, and their household's (FR-21, BR-27). */
export async function listMyRequests(userId: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT r.id::text AS id FROM "maintenance_requests" r
    WHERE EXISTS (SELECT 1 FROM household_peers hp WHERE hp."userId" = ${userId}::uuid AND hp."peerId" = r."submittedById")
    ORDER BY r."createdAt" DESC, r.id LIMIT 200`;
  const requests = await prisma.maintenanceRequest.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    include: { unit: { select: { id: true, unitNumber: true } }, assignedTo: { select: { fullName: true } } },
  });
  const order = new Map(rows.map((r, i) => [r.id, i]));
  requests.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    items: requests.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      category: r.category,
      status: r.status,
      priority: r.priority,
      createdAt: r.createdAt,
      unit: r.unit,
      assignedTo: r.assignedTo?.fullName ?? null,
    })),
  };
}

/** What is assigned to this staff member and still needs work (FR-19, FR-20). */
export async function listMyTasks(staffId: string) {
  const rows = await prisma.maintenanceRequest.findMany({
    where: { assignedToId: staffId, status: { in: ['UNDER_REVIEW', 'IN_PROGRESS'] } },
    orderBy: [{ priority: { sort: 'desc', nulls: 'last' } }, { dueAt: 'asc' }, { id: 'asc' }],
    include: { unit: { select: { id: true, unitNumber: true } } },
  });
  const now = new Date();
  return {
    items: rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      category: r.category,
      status: r.status,
      priority: r.priority,
      overdue: isOverdue(r, now),
      dueAt: r.dueAt,
      unit: r.unit,
    })),
  };
}

/** The active staff members a request can be assigned to. */
export async function listAssignees() {
  const staff = await prisma.user.findMany({ where: { role: 'STAFF', isActive: true }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true } });
  return { items: staff };
}

// ----------------------------------------------------- priority (FR-18)

export async function setPriority(id: string, priority: RequestPriority, user: AuthUser) {
  if (!isAdmin(user) && !canReview(user)) throw forbidden();
  const sla = await getSla();
  await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id);
    if (!OPEN_FOR_STAFF.includes(r.status)) throw new ApiError(409, 'REQUEST_FINISHED');
    if (r.priority === priority) return; // already that priority
    // The deadline follows the priority, counted from when the request was submitted (BR-17).
    const dueAt = new Date(r.createdAt.getTime() + slaHours(sla, priority) * 3_600_000);
    await tx.maintenanceRequest.update({ where: { id }, data: { priority, dueAt, ...(r.status === 'SUBMITTED' && { status: 'UNDER_REVIEW' }) } });
    await note(tx, { requestId: id, authorId: user.id, kind: 'PRIORITY_CHANGE', fromValue: r.priority, toValue: priority });
    await logActivity(tx, 'request.priority', { entityType: 'request', entityId: id, details: { from: r.priority, to: priority } });
    if (r.status === 'SUBMITTED') {
      await note(tx, { requestId: id, authorId: user.id, kind: 'STATUS_CHANGE', fromValue: 'SUBMITTED', toValue: 'UNDER_REVIEW' });
      await tellAboutRequest(tx, id, user.id, { status: 'UNDER_REVIEW' });
    }
  });
  return getRequest(id, user);
}

// ---------------------------------------------------------- assignment (FR-19)

export async function assignRequest(id: string, staffId: string, user: AuthUser) {
  if (!isAdmin(user) && !canAssign(user)) throw forbidden();
  const staff = await prisma.user.findFirst({ where: { id: staffId, role: 'STAFF', isActive: true }, select: { id: true, fullName: true } });
  if (!staff) throw new ApiError(400, 'VALIDATION_FAILED', { staffId: { code: 'STAFF_NOT_FOUND' } });

  await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id);
    if (!OPEN_FOR_STAFF.includes(r.status)) throw new ApiError(409, 'REQUEST_FINISHED');
    if (r.assignedToId === staff.id) return;
    const previous = r.assignedToId ? await tx.user.findUnique({ where: { id: r.assignedToId }, select: { fullName: true } }) : null;
    await tx.maintenanceRequest.update({ where: { id }, data: { assignedToId: staff.id, ...(r.status === 'SUBMITTED' && { status: 'UNDER_REVIEW' }) } });
    await note(tx, { requestId: id, authorId: user.id, kind: 'ASSIGNMENT', fromValue: previous?.fullName ?? null, toValue: staff.fullName });
    await logActivity(tx, 'request.assign', { entityType: 'request', entityId: id, details: { from: previous?.fullName ?? null, to: staff.fullName } });
    if (r.status === 'SUBMITTED') await note(tx, { requestId: id, authorId: user.id, kind: 'STATUS_CHANGE', fromValue: 'SUBMITTED', toValue: 'UNDER_REVIEW' });
    // The new person is told it is theirs; the resident is told it is being looked at.
    const f = await facts(tx, id);
    if (staff.id !== user.id) {
      await notify(tx, [staff.id], { type: 'REQUEST_ASSIGNED', params: { number: f.number, title: f.title, unit: f.unit }, link: `/requests/${id}`, entityId: id });
    }
    if (r.status === 'SUBMITTED') await tellAboutRequest(tx, id, user.id, { status: 'UNDER_REVIEW' }, { assignee: false });
  });
  return getRequest(id, user);
}

// ------------------------------------------------------ status changes (FR-18, FR-20, FR-35)

type Who = 'reviewer' | 'worker' | 'household';
/** BR-16 and Appendix A: which moves exist, and who may make each one. */
const TRANSITIONS: Partial<Record<RequestStatus, Partial<Record<RequestStatus, Who>>>> = {
  SUBMITTED: { UNDER_REVIEW: 'reviewer', CANCELLED: 'household', REJECTED: 'reviewer' },
  UNDER_REVIEW: { IN_PROGRESS: 'worker', REJECTED: 'reviewer' },
  IN_PROGRESS: { RESOLVED: 'worker' },
  RESOLVED: { CLOSED: 'household', IN_PROGRESS: 'household' }, // confirm, or reopen
};

export async function transition(id: string, to: RequestStatus, text: string | undefined, user: AuthUser) {
  const sla = await getSla();
  await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id);
    const who = TRANSITIONS[r.status]?.[to];
    if (!who) throw new ApiError(409, 'INVALID_TRANSITION');

    const access = await accessTo(user, r);
    const allowed =
      who === 'reviewer' ? isAdmin(user) || canReview(user) : who === 'worker' ? isAdmin(user) || access.assignee : access.household;
    if (!allowed) {
      // Residents learn nothing about requests that are not theirs.
      if (user.role === 'RESIDENT' && !access.household) throw notFound();
      throw forbidden();
    }

    const reopening = r.status === 'RESOLVED' && to === 'IN_PROGRESS';
    // Resolving, rejecting and reopening each need an explanation (FR-18, FR-20, FR-35).
    if ((to === 'RESOLVED' || to === 'REJECTED' || reopening) && !text) {
      throw new ApiError(400, 'VALIDATION_FAILED', { note: { code: 'NOTE_REQUIRED' } });
    }
    if (reopening && r.resolvedAt && Date.now() - r.resolvedAt.getTime() > sla.autoCloseDays * 86_400_000) {
      throw new ApiError(409, 'REOPEN_WINDOW_PASSED'); // BR-18
    }

    const now = new Date();
    await tx.maintenanceRequest.update({
      where: { id },
      data: {
        status: to,
        ...(to === 'RESOLVED' && { resolvedAt: now }),
        ...(reopening && { resolvedAt: null }),
        ...(to === 'CLOSED' && { closedAt: now }),
      },
    });
    await note(tx, { requestId: id, authorId: user.id, kind: 'STATUS_CHANGE', fromValue: r.status, toValue: to, note: text ?? null });
    await logActivity(tx, 'request.status', { entityType: 'request', entityId: id, details: { from: r.status, to } });
    await tellAboutRequest(tx, id, user.id, { status: to });
  });
  return getRequest(id, user);
}

// ---------------------------------------------------------------- notes (FR-20)

export async function addNote(id: string, input: { note: string; isInternal: boolean }, files: Express.Multer.File[], user: AuthUser) {
  const stored = await storeImages(files);
  try {
    await prisma.$transaction(async (tx) => {
      const r = await lockRequest(tx, id);
      const access = await accessTo(user, r);
      // Assigned staff, reviewers and administrators write notes. Others cannot.
      if (!(isAdmin(user) || canReview(user) || access.assignee)) {
        // A resident must not be able to tell a neighbour's request from one that does not exist (NFR-24).
        if (user.role === 'RESIDENT' && !access.household) throw notFound();
        throw forbidden();
      }
      if (['CLOSED', 'REJECTED', 'CANCELLED'].includes(r.status)) throw new ApiError(409, 'REQUEST_FINISHED');
      const update = await note(tx, { requestId: id, authorId: user.id, kind: 'NOTE', note: input.note, isInternal: input.isInternal });
      if (stored.length) {
        await tx.attachment.createMany({ data: stored.map((s) => ({ ...s, uploadedById: user.id, requestUpdateId: update.id })) });
      }
      if (!input.isInternal) await tellAboutRequest(tx, id, user.id, { note: true });
    });
  } catch (e) {
    await removeStored(stored.map((s) => s.storedName));
    throw e;
  }
  return getRequest(id, user);
}

// ------------------------------------------------------- automatic close (BR-18)

/** Resolved requests the resident never answered are closed after the waiting period. Safe to run any time. */
export async function autoCloseResolved(now = new Date()): Promise<number> {
  const sla = await getSla();
  const cutoff = new Date(now.getTime() - sla.autoCloseDays * 86_400_000);
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "maintenance_requests" WHERE status = 'RESOLVED' AND "resolvedAt" < ${cutoff} FOR UPDATE`;
    for (const { id } of due) {
      await tx.maintenanceRequest.update({ where: { id }, data: { status: 'CLOSED', closedAt: now } });
      await note(tx, { requestId: id, authorId: null, kind: 'STATUS_CHANGE', fromValue: 'RESOLVED', toValue: 'CLOSED' });
      await logActivity(tx, 'request.status', { actorId: null, entityType: 'request', entityId: id, details: { from: 'RESOLVED', to: 'CLOSED', automatic: true } });
      await tellAboutRequest(tx, id, null, { status: 'CLOSED' });
    }
    return due.length;
  });
}

export type { Sla };
