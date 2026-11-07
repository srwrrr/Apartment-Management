import { Router } from 'express';
import { activityListQuerySchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAdmin, requireAuth } from '../../middleware/auth';
import { listActivity, listActors } from './activity.service';

// FR-34: administrators only, and never grantable (Appendix B). There are no routes that write or change entries.
export const activityRouter = Router();
activityRouter.use(requireAuth, requireAdmin);
activityRouter.get('/', asyncHandler(async (req, res) => res.json(await listActivity(activityListQuerySchema.parse(req.query)))));
activityRouter.get('/actors', asyncHandler(async (_req, res) => res.json(await listActors())));
