import { Router } from 'express';
import { householdMemberCreateSchema, moveOutSchema, occupancyCreateSchema, occupancyUpdateSchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAdmin, requireAuth, requirePermission } from '../../middleware/auth';
import { createOccupancy, listUnitOccupancies, updateOccupancy } from './occupancies.service';
import { moveOut, moveOutPreview } from './moveOut.service';
import { addHouseholdMember, removeHouseholdMember } from './household.service';

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
occupanciesRouter.use(requireAuth);
// FR-56: the move-out wizard is for administrators (it can deactivate accounts and issue certificates).
occupanciesRouter.get('/:id/move-out-preview', requireAdmin, asyncHandler(async (req, res) => res.json(await moveOutPreview(String(req.params.id)))));
occupanciesRouter.post('/:id/move-out', requireAdmin, asyncHandler(async (req, res) => res.json(await moveOut(String(req.params.id), moveOutSchema.parse(req.body), req.user!))));
occupanciesRouter.use(guard[1]!);
// FR-54.
occupanciesRouter.post('/:id/members', asyncHandler(async (req, res) => res.status(201).json(await addHouseholdMember(String(req.params.id), householdMemberCreateSchema.parse(req.body)))));
occupanciesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) =>
    res.json(await updateOccupancy(String(req.params.id), occupancyUpdateSchema.parse(req.body))),
  ),
);

/** Mounted at /api/household-members */
export const householdMembersRouter = Router();
householdMembersRouter.use(...guard);
householdMembersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await removeHouseholdMember(String(req.params.id));
    res.status(204).end();
  }),
);
