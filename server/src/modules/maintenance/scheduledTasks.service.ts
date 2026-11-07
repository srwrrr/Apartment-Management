import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { scheduledTaskCreateSchema, scheduledTaskUpdateSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, notFound } from '../../lib/errors';
import { dateOnly, todayDhaka, ymdOf } from '../../lib/dates';
import { changes, logActivity } from '../activity/activity';
import { maintenanceStaff, notify } from '../notifications/notify';

type Tx = Prisma.TransactionClient;

/** BR-25: the request appears this many days before the job is due. */
export const LEAD_DAYS = 7;
const UPCOMING_DAYS = 90;

export const addDays = (ymd: string, days: number) => ymdOf(new Date(dateOnly(ymd).getTime() + days * 86_400_000));

/** The same day a number of months later, or the month's last day when it is shorter (31 Jan -> 28 Feb). */
export function addMonthsToDate(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return ymdOf(new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))));
}

const shape = { defaultAssignee: { select: { id: true, fullName: true } } } satisfies Prisma.ScheduledTaskInclude;
type Row = Prisma.ScheduledTaskGetPayload<{ include: typeof shape }>;
const toDto = (t: Row) => ({
  id: t.id,
  title: t.title,
  description: t.description,
  category: t.category,
  intervalMonths: t.intervalMonths,
  nextDueDate: ymdOf(t.nextDueDate),
  defaultAssignee: t.defaultAssignee,
  isPaused: t.isPaused,
});

async function checkAssignee(staffId: string | null | undefined) {
  if (!staffId) return;
  const staff = await prisma.user.findFirst({ where: { id: staffId, role: 'STAFF', isActive: true }, select: { id: true } });
  if (!staff) throw new ApiError(400, 'VALIDATION_FAILED', { defaultAssigneeId: { code: 'STAFF_NOT_FOUND' } });
}

function checkDueDate(ymd: string) {
  if (ymd < todayDhaka()) throw new ApiError(400, 'VALIDATION_FAILED', { nextDueDate: { code: 'DATE_IN_PAST' } });
}

export async function listScheduledTasks() {
  const rows = await prisma.scheduledTask.findMany({ include: shape, orderBy: [{ isPaused: 'asc' }, { nextDueDate: 'asc' }, { id: 'asc' }] });
  return { items: rows.map(toDto) };
}

/** FR-49: every time a task falls due in the next 90 days. Paused tasks are not coming up. */
export async function upcomingScheduledTasks(today = todayDhaka()) {
  const end = addDays(today, UPCOMING_DAYS);
  const rows = await prisma.scheduledTask.findMany({ where: { isPaused: false, nextDueDate: { lte: dateOnly(end) } }, include: shape });
  const items: { taskId: string; title: string; category: string; dueDate: string; assignee: string | null }[] = [];
  for (const t of rows) {
    for (let due = ymdOf(t.nextDueDate); due <= end; due = addMonthsToDate(due, t.intervalMonths)) {
      items.push({ taskId: t.id, title: t.title, category: t.category, dueDate: due, assignee: t.defaultAssignee?.fullName ?? null });
    }
  }
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  return { items };
}

export async function createScheduledTask(input: z.infer<typeof scheduledTaskCreateSchema>, actor: { id: string }) {
  checkDueDate(input.nextDueDate);
  await checkAssignee(input.defaultAssigneeId);
  return prisma.$transaction(async (tx) => {
    const t = await tx.scheduledTask.create({
      data: { ...input, nextDueDate: dateOnly(input.nextDueDate), defaultAssigneeId: input.defaultAssigneeId ?? null, createdById: actor.id },
      include: shape,
    });
    await logActivity(tx, 'scheduled_task.create', { entityType: 'scheduled_task', entityId: t.id, details: { title: t.title, intervalMonths: t.intervalMonths } });
    return toDto(t);
  });
}

export async function updateScheduledTask(id: string, input: z.infer<typeof scheduledTaskUpdateSchema>) {
  assertUuid(id);
  const before = await prisma.scheduledTask.findUnique({ where: { id } });
  if (!before) throw notFound();
  if (input.nextDueDate) checkDueDate(input.nextDueDate);
  await checkAssignee(input.defaultAssigneeId);
  return prisma.$transaction(async (tx) => {
    const t = await tx.scheduledTask.update({
      where: { id },
      data: { ...input, ...(input.nextDueDate && { nextDueDate: dateOnly(input.nextDueDate) }) },
      include: shape,
    });
    const { nextDueDate: _due, ...rest } = input;
    await logActivity(tx, 'scheduled_task.update', { entityType: 'scheduled_task', entityId: id, details: { title: t.title, changes: changes(before, rest) } });
    return toDto(t);
  });
}

export async function setPaused(id: string, isPaused: boolean) {
  assertUuid(id);
  return prisma.$transaction(async (tx) => {
    const t = await tx.scheduledTask.findUnique({ where: { id } });
    if (!t) throw notFound();
    if (t.isPaused === isPaused) return toDto(await tx.scheduledTask.findUniqueOrThrow({ where: { id }, include: shape }));
    // Dates missed while paused are skipped, not caught up: "paused tasks create nothing" (BR-25).
    let next = ymdOf(t.nextDueDate);
    if (!isPaused) for (const today = todayDhaka(); next < today; ) next = addMonthsToDate(next, t.intervalMonths);
    const updated = await tx.scheduledTask.update({ where: { id }, data: { isPaused, nextDueDate: dateOnly(next) }, include: shape });
    await logActivity(tx, isPaused ? 'scheduled_task.pause' : 'scheduled_task.resume', { entityType: 'scheduled_task', entityId: id, details: { title: t.title } });
    return toDto(updated);
  });
}

/** The end of the due date in Dhaka: BR-25 makes this the request's deadline, not the usual target. */
const endOfDay = (ymd: string) => new Date(`${ymd}T23:59:59+06:00`);

async function createRequestFor(tx: Tx, task: { id: string; title: string; description: string; category: Prisma.ScheduledTaskCreateInput['category']; defaultAssigneeId: string | null }, dueDate: string) {
  const assignee = task.defaultAssigneeId
    ? await tx.user.findFirst({ where: { id: task.defaultAssigneeId, role: 'STAFF', isActive: true }, select: { id: true } })
    : null;
  const r = await tx.maintenanceRequest.create({
    data: {
      scheduledTaskId: task.id,
      location: 'COMMON_AREA',
      category: task.category,
      title: task.title,
      description: task.description,
      priority: 'MEDIUM',
      status: 'UNDER_REVIEW',
      assignedToId: assignee?.id ?? null,
      dueAt: endOfDay(dueDate),
      updates: { create: { authorId: null, kind: 'STATUS_CHANGE', toValue: 'UNDER_REVIEW' } },
    },
    select: { id: true, number: true },
  });
  // With nobody assigned, the people who look after maintenance need to pick it up.
  await notify(tx, assignee ? [assignee.id] : await maintenanceStaff(tx), {
    type: 'REQUEST_SCHEDULED',
    params: { number: r.number, title: task.title, dueDate },
    link: `/requests/${r.id}`,
    entityId: r.id,
  });
  await logActivity(tx, 'request.scheduled', { actorId: null, entityType: 'request', entityId: r.id, details: { title: task.title, dueDate } });
}

/**
 * BR-25: creates the requests that have come within reach, moving each task's date forward in the same transaction.
 * A locked task is skipped and picked up next time. Safe to run any time, and after downtime it catches up.
 */
export async function createDueScheduledRequests(today = todayDhaka()): Promise<number> {
  const horizon = addDays(today, LEAD_DAYS);
  const due = await prisma.scheduledTask.findMany({ where: { isPaused: false, nextDueDate: { lte: dateOnly(horizon) } }, select: { id: true } });
  let created = 0;
  for (const { id } of due) {
    created += await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "scheduled_tasks" WHERE id = ${id}::uuid AND NOT "isPaused" FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return 0;
      const task = await tx.scheduledTask.findUniqueOrThrow({ where: { id } });
      let next = ymdOf(task.nextDueDate);
      let n = 0;
      while (next <= horizon) {
        await createRequestFor(tx, task, next);
        next = addMonthsToDate(next, task.intervalMonths);
        n++;
      }
      await tx.scheduledTask.update({ where: { id }, data: { nextDueDate: dateOnly(next) } });
      return n;
    });
  }
  return created;
}
