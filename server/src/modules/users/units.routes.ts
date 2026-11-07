import { Router } from 'express';
import { asyncHandler } from '../../lib/errors';
import { requireAuth, requirePermission } from '../../middleware/auth';
import {
  createUnit,
  createUnitSchema,
  getUnit,
  listUnits,
  listUnitsSchema,
  updateUnit,
  updateUnitSchema,
} from './units.service';

export const unitsRouter = Router();

// FR-04. Admin, or staff granted units.manage (Appendix B).
unitsRouter.use(requireAuth, requirePermission('units.manage'));

unitsRouter.get('/', asyncHandler(async (req, res) => res.json(await listUnits(listUnitsSchema.parse(req.query)))));
unitsRouter.get('/:id', asyncHandler(async (req, res) => res.json(await getUnit(String(req.params.id)))));
unitsRouter.post(
  '/',
  asyncHandler(async (req, res) => res.status(201).json(await createUnit(createUnitSchema.parse(req.body)))),
);
unitsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) =>
    res.json(await updateUnit(String(req.params.id), updateUnitSchema.parse(req.body))),
  ),
);
