import { Router } from 'express';
import { staffCreateSchema, staffPermissionsSchema, staffUpdateSchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAdmin, requireAuth } from '../../middleware/auth';
import {
  createStaff,
  getStaff,
  listStaff,
  resetPassword,
  setStaffActive,
  setStaffPermissions,
  updateStaff,
} from './staff.service';

// FR-06: only administrators manage staff accounts and their permissions.
export const staffRouter = Router();
staffRouter.use(requireAuth, requireAdmin);

staffRouter.get('/', asyncHandler(async (_req, res) => res.json(await listStaff())));
staffRouter.post(
  '/',
  asyncHandler(async (req, res) => res.status(201).json(await createStaff(staffCreateSchema.parse(req.body)))),
);
staffRouter.get('/:id', asyncHandler(async (req, res) => res.json(await getStaff(String(req.params.id)))));
staffRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => res.json(await updateStaff(String(req.params.id), staffUpdateSchema.parse(req.body)))),
);
staffRouter.put(
  '/:id/permissions',
  asyncHandler(async (req, res) =>
    res.json(await setStaffPermissions(String(req.params.id), staffPermissionsSchema.parse(req.body).permissions)),
  ),
);
staffRouter.post('/:id/deactivate', asyncHandler(async (req, res) => res.json(await setStaffActive(String(req.params.id), false))));
staffRouter.post('/:id/reactivate', asyncHandler(async (req, res) => res.json(await setStaffActive(String(req.params.id), true))));

/** Mounted at /api/users (admin only). */
export const usersRouter = Router();
usersRouter.use(requireAuth, requireAdmin);
usersRouter.post(
  '/:id/reset-password',
  asyncHandler(async (req, res) => res.json(await resetPassword(req.user!.id, String(req.params.id)))),
);
