import { Router } from 'express';
import { settingsUpdateSchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAdmin, requireAuthAllowTempPassword } from '../../middleware/auth';
import { getPublicSettings, getSettings, updateSettings } from './settings.service';

export const settingsRouter = Router();

// Any logged-in user (even on a temporary password) can read the building name for the page header.
settingsRouter.get('/public', requireAuthAllowTempPassword, asyncHandler(async (_req, res) => res.json(await getPublicSettings())));

settingsRouter.get('/', requireAdmin, asyncHandler(async (_req, res) => res.json(await getSettings())));
settingsRouter.put(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await updateSettings(settingsUpdateSchema.parse(req.body)))),
);
