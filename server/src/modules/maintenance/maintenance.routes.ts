import { Router } from 'express';
import multer from 'multer';
import {
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  requestAssignSchema,
  requestCreateSchema,
  requestListQuerySchema,
  requestNoteSchema,
  requestPrioritySchema,
  requestTransitionSchema,
} from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { readStored } from '../../lib/files';
import { asyncHandler, assertUuid, notFound } from '../../lib/errors';
import { requireAnyPermission, requireAuth, requirePermission, requireRole } from '../../middleware/auth';
import {
  addNote,
  assignRequest,
  createRequest,
  getRequest,
  listAssignees,
  listMyRequests,
  listMyTasks,
  listRequests,
  requireRequestAccess,
  setPriority,
  transition,
} from './requests.service';

// Photos arrive in memory so each one can be checked by its real content before anything is written (BR-19, NFR-06).
const photos = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS, fields: 12 } }).array('photos', MAX_PHOTOS);

const param = (v: unknown) => String(v);
const files = (req: { files?: unknown }) => (Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : []);

// ------------------------------------------------------------------ requests
export const requestsRouter = Router();
requestsRouter.use(requireAuth);

// FR-16, FR-17: residents report a problem; their name and unit are filled in for them.
requestsRouter.post(
  '/',
  requireRole('RESIDENT'),
  photos,
  asyncHandler(async (req, res) => res.status(201).json(await createRequest(req.user!, requestCreateSchema.parse(req.body), files(req)))),
);

// Staff who look after maintenance: the full list (FR-18, FR-22).
const listers = requireAnyPermission('maintenance.view_all', 'maintenance.review', 'maintenance.assign');
requestsRouter.get('/', listers, asyncHandler(async (req, res) => res.json(await listRequests(requestListQuerySchema.parse(req.query), req.user!))));

// Who a request can be assigned to. Must come before '/:id'.
requestsRouter.get('/assignees', requirePermission('maintenance.assign'), asyncHandler(async (_req, res) => res.json(await listAssignees())));

requestsRouter.get('/:id', asyncHandler(async (req, res) => res.json(await getRequest(param(req.params.id), req.user!))));

requestsRouter.patch(
  '/:id/priority',
  requirePermission('maintenance.review'),
  asyncHandler(async (req, res) => res.json(await setPriority(param(req.params.id), requestPrioritySchema.parse(req.body).priority, req.user!))),
);
requestsRouter.post(
  '/:id/assign',
  requirePermission('maintenance.assign'),
  asyncHandler(async (req, res) => res.json(await assignRequest(param(req.params.id), requestAssignSchema.parse(req.body).staffId, req.user!))),
);
requestsRouter.post(
  '/:id/transition',
  asyncHandler(async (req, res) => {
    const { to, note } = requestTransitionSchema.parse(req.body);
    res.json(await transition(param(req.params.id), to, note, req.user!));
  }),
);
requestsRouter.post(
  '/:id/notes',
  photos,
  asyncHandler(async (req, res) => res.status(201).json(await addNote(param(req.params.id), requestNoteSchema.parse(req.body), files(req), req.user!))),
);

// ---------------------------------------------------------------- photo files
export const attachmentsRouter = Router();
attachmentsRouter.use(requireAuth);

/** A photo is only served to someone who may see the request it belongs to; internal notes' photos never reach residents. */
attachmentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = param(req.params.id);
    assertUuid(id);
    const att = await prisma.attachment.findUnique({ where: { id }, include: { requestUpdate: { select: { requestId: true, isInternal: true } } } });
    if (!att) throw notFound();
    const requestId = att.requestId ?? att.requestUpdate!.requestId;
    const { audience } = await requireRequestAccess(requestId, req.user!);
    if (audience === 'resident' && att.requestUpdate?.isInternal) throw notFound();
    let bytes: Buffer;
    try {
      bytes = await readStored(att.storedName);
    } catch {
      throw notFound();
    }
    res.setHeader('Content-Type', att.mimeType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  }),
);

// ----------------------------------------------------------------- my lists
export const myRequestsRouter = Router();
myRequestsRouter.use(requireAuth, requireRole('RESIDENT'));
myRequestsRouter.get('/', asyncHandler(async (req, res) => res.json(await listMyRequests(req.user!.id))));

export const myTasksRouter = Router();
myTasksRouter.use(requireAuth, requireRole('STAFF'));
myTasksRouter.get('/', asyncHandler(async (req, res) => res.json(await listMyTasks(req.user!.id))));
