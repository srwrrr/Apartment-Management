import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/errors';
import { requireAuth } from '../../middleware/auth';

/** Mounted at /api/me/preferences. Any logged-in user (FR-47 language, FR-55 text size). */
export const preferencesRouter = Router();
preferencesRouter.use(requireAuth);

const schema = z
  .object({ language: z.enum(['EN', 'BN']).optional(), textSize: z.enum(['NORMAL', 'LARGE']).optional() })
  .strict();

preferencesRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data,
      select: { language: true, textSize: true },
    });
    res.json(user);
  }),
);
