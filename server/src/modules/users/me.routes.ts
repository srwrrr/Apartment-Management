import { Router } from 'express';
import { selfProfileUpdateSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/errors';
import { requireAuth, requireRole } from '../../middleware/auth';
import { normPhone, optionalPhone, publicUserSelect } from './accounts';

/** Mounted at /api/me. A resident's own pages: always scoped to the logged-in user (NFR-24). */
export const meRouter = Router();
meRouter.use(requireAuth, requireRole('RESIDENT'));

async function loadProfile(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      ...publicUserSelect,
      profile: { select: { altPhone: true, emergencyContactName: true, emergencyContactPhone: true } },
      occupancies: {
        orderBy: { startDate: 'desc' },
        select: {
          id: true,
          type: true,
          startDate: true,
          endDate: true,
          isBillingContact: true,
          unit: { select: { id: true, unitNumber: true, floor: true, sizeSqft: true, bedrooms: true } },
        },
      },
    },
  });
}

// FR-07: my profile and my unit(s).
meRouter.get('/profile', asyncHandler(async (req, res) => res.json(await loadProfile(req.user!.id))));

// FR-37: I can change my contact details, but not my name, login ID, or unit.
meRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const input = selfProfileUpdateSchema.strict().parse(req.body);
    const profile = {
      ...(input.altPhone !== undefined && { altPhone: optionalPhone(input.altPhone) }),
      ...(input.emergencyContactName !== undefined && { emergencyContactName: input.emergencyContactName || null }),
      ...(input.emergencyContactPhone !== undefined && { emergencyContactPhone: optionalPhone(input.emergencyContactPhone) }),
    };
    await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...(input.phone !== undefined && { phone: normPhone(input.phone) }),
        profile: { upsert: { create: profile, update: profile } },
      },
    });
    res.json(await loadProfile(req.user!.id));
  }),
);
