import { Router } from 'express';
import { residentCreateSchema, residentUpdateSchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAuth, requirePermission } from '../../middleware/auth';
import {
  createResident,
  deactivateResident,
  deactivateSchema,
  getResident,
  listResidents,
  listResidentsSchema,
  reactivateResident,
  updateResident,
} from './residents.service';

export const residentsRouter = Router();

// FR-03. Admin, or staff granted residents.manage (Appendix B).
residentsRouter.use(requireAuth, requirePermission('residents.manage'));

residentsRouter.get('/', asyncHandler(async (req, res) => res.json(await listResidents(listResidentsSchema.parse(req.query)))));
residentsRouter.post(
  '/',
  asyncHandler(async (req, res) => res.status(201).json(await createResident(residentCreateSchema.parse(req.body)))),
);
residentsRouter.get('/:id', asyncHandler(async (req, res) => res.json(await getResident(String(req.params.id)))));
residentsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) =>
    res.json(await updateResident(String(req.params.id), residentUpdateSchema.parse(req.body))),
  ),
);
residentsRouter.post(
  '/:id/deactivate',
  asyncHandler(async (req, res) =>
    res.json(await deactivateResident(String(req.params.id), deactivateSchema.parse(req.body ?? {}).endDate)),
  ),
);
residentsRouter.post(
  '/:id/reactivate',
  asyncHandler(async (req, res) => res.json(await reactivateResident(String(req.params.id)))),
);
