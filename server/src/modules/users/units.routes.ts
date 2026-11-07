import { Router } from 'express';
import { asyncHandler } from '../../lib/errors';
import { requireAnyPermission, requireAuth, requirePermission } from '../../middleware/auth';
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

// FR-04. Anyone who manages units or residents may look units up (needed to assign residents);
// only units.manage may change them (Appendix B).
unitsRouter.use(requireAuth);
const canRead = requireAnyPermission('units.manage', 'residents.manage');
const canWrite = requirePermission('units.manage');

unitsRouter.get('/', canRead, asyncHandler(async (req, res) => res.json(await listUnits(listUnitsSchema.parse(req.query)))));
unitsRouter.get('/:id', canRead, asyncHandler(async (req, res) => res.json(await getUnit(String(req.params.id)))));
unitsRouter.post(
  '/',
  canWrite,
  asyncHandler(async (req, res) => res.status(201).json(await createUnit(createUnitSchema.parse(req.body)))),
);
unitsRouter.patch(
  '/:id',
  canWrite,
  asyncHandler(async (req, res) =>
    res.json(await updateUnit(String(req.params.id), updateUnitSchema.parse(req.body))),
  ),
);
