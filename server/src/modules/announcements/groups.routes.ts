import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { emergencyContactsSchema, groupInputSchema, groupMembersSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, asyncHandler, notFound } from '../../lib/errors';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { logActivity } from '../activity/activity';

const manage = requirePermission('announcements.manage');

function mapNameTaken(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new ApiError(409, 'CONFLICT', { name: { code: 'GROUP_NAME_TAKEN' } });
  }
  throw e;
}

async function getGroup(id: string) {
  assertUuid(id);
  const g = await prisma.residentGroup.findUnique({
    where: { id },
    include: { members: { include: { user: { select: { id: true, fullName: true, phone: true, isActive: true } } }, orderBy: { user: { fullName: 'asc' } } } },
  });
  if (!g) throw notFound();
  return { id: g.id, name: g.name, members: g.members.map((m) => m.user) };
}

// FR-36: named sets of residents, for announcements.
export const groupsRouter = Router();
groupsRouter.use(requireAuth, manage);

groupsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.residentGroup.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { members: true } } } });
    res.json({ items: rows.map((g) => ({ id: g.id, name: g.name, members: g._count.members })) });
  }),
);

// Names only, for choosing members: this permission does not open the residents pages. Must come before '/:id'.
groupsRouter.get(
  '/residents',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const items = q
      ? await prisma.user.findMany({
          where: { role: 'RESIDENT', isActive: true, fullName: { contains: q, mode: 'insensitive' } },
          orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
          take: 10,
          select: { id: true, fullName: true },
        })
      : [];
    res.json({ items });
  }),
);

groupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = groupInputSchema.parse(req.body);
    const g = await prisma
      .$transaction(async (tx) => {
        const created = await tx.residentGroup.create({ data: { name } });
        await logActivity(tx, 'group.create', { entityType: 'group', entityId: created.id, details: { name } });
        return created;
      })
      .catch(mapNameTaken);
    res.status(201).json(await getGroup(g.id));
  }),
);

groupsRouter.get('/:id', asyncHandler(async (req, res) => res.json(await getGroup(String(req.params.id)))));

groupsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const before = await getGroup(id);
    const { name } = groupInputSchema.parse(req.body);
    await prisma
      .$transaction(async (tx) => {
        await tx.residentGroup.update({ where: { id }, data: { name } });
        await logActivity(tx, 'group.update', { entityType: 'group', entityId: id, details: { name, from: before.name } });
      })
      .catch(mapNameTaken);
    res.json(await getGroup(id));
  }),
);

groupsRouter.put(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const group = await getGroup(id);
    const userIds = [...new Set(groupMembersSchema.parse(req.body).userIds)];
    const found = await prisma.user.count({ where: { id: { in: userIds }, role: 'RESIDENT' } });
    if (found !== userIds.length) throw new ApiError(400, 'VALIDATION_FAILED', { userIds: { code: 'RESIDENT_NOT_FOUND' } });
    await prisma.$transaction(async (tx) => {
      await tx.residentGroupMember.deleteMany({ where: { groupId: id } });
      await tx.residentGroupMember.createMany({ data: userIds.map((userId) => ({ groupId: id, userId })) });
      await logActivity(tx, 'group.members', { entityType: 'group', entityId: id, details: { name: group.name, members: userIds.length } });
    });
    res.json(await getGroup(id));
  }),
);

// Deleting a group leaves announcements already sent to it as they were (FR-36).
groupsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const group = await getGroup(id);
    await prisma.$transaction(async (tx) => {
      await tx.residentGroup.delete({ where: { id } });
      await logActivity(tx, 'group.delete', { entityType: 'group', entityId: id, details: { name: group.name } });
    });
    res.status(204).end();
  }),
);

// FR-52: everyone who is logged in can read these; the list is saved whole, in its new order.
export const emergencyContactsRouter = Router();
emergencyContactsRouter.use(requireAuth);

const listContacts = () => prisma.emergencyContact.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, role: true, phone: true, hours: true } });

emergencyContactsRouter.get('/', asyncHandler(async (_req, res) => res.json({ items: await listContacts() })));

emergencyContactsRouter.put(
  '/',
  manage,
  asyncHandler(async (req, res) => {
    const { contacts } = emergencyContactsSchema.parse(req.body);
    await prisma.$transaction(async (tx) => {
      await tx.emergencyContact.deleteMany();
      await tx.emergencyContact.createMany({ data: contacts.map((c, sortOrder) => ({ ...c, sortOrder })) });
      await logActivity(tx, 'emergency_contacts.update', { details: { contacts: contacts.length } });
    });
    res.json({ items: await listContacts() });
  }),
);
