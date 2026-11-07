import { Router } from 'express';
import { occupancyCreateSchema, occupancyUpdateSchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { createOccupancy, listUnitOccupancies, updateOccupancy } from './occupancies.service';

const guard = [requireAuth, requirePermission('residents.manage')];

/** Mounted at /api/units/:unitId/occupancies */
export const unitOccupanciesRouter = Router({ mergeParams: true });
unitOccupanciesRouter.use(...guard);
unitOccupanciesRouter.get(
  '/',
  asyncHandler(async (req, res) => res.json({ items: await listUnitOccupancies(String(req.params.unitId)) })),
);
unitOccupanciesRouter.post(
  '/',
  asyncHandler(async (req, res) =>
    res.status(201).json(await createOccupancy(String(req.params.unitId), occupancyCreateSchema.parse(req.body))),
  ),
);

/** Mounted at /api/occupancies */
export const occupanciesRouter = Router();
occupanciesRouter.use(...guard);
occupanciesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) =>
    res.json(await updateOccupancy(String(req.params.id), occupancyUpdateSchema.parse(req.body))),
  ),
);
