import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/errors';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { activeOccupancyWhere } from './units.service';

// FR-08: who lives in which unit. Admin, or staff granted directory.view (Appendix B).
// Shows names, units, owner/tenant and phone numbers only: never bills, payments or requests.
export const directoryRouter = Router();
directoryRouter.use(requireAuth, requirePermission('directory.view'));

const querySchema = z.object({
  q: z.string().trim().max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

directoryRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, page, pageSize } = querySchema.parse(req.query);
    // Only people who currently live in a unit, and whose account is active.
    const where: Prisma.OccupancyWhereInput = { ...activeOccupancyWhere(), resident: { isActive: true } };
    if (q) {
      // Partial matches: "rah" finds "Rahman", "4b" finds unit 4B, "0171" finds a phone number.
      where.AND = [
        {
          OR: [
            { resident: { fullName: { contains: q, mode: 'insensitive' } } },
            { resident: { phone: { contains: q.replace(/[\s-]/g, '') } } },
            { unit: { unitNumber: { contains: q, mode: 'insensitive' } } },
          ],
        },
      ];
    }
    const [total, rows] = await Promise.all([
      prisma.occupancy.count({ where }),
      prisma.occupancy.findMany({
        where,
        orderBy: [{ unit: { floor: 'asc' } }, { unit: { unitNumber: 'asc' } }, { type: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          resident: { select: { id: true, fullName: true, phone: true } },
          unit: { select: { id: true, unitNumber: true, floor: true } },
        },
      }),
    ]);
    res.json({ items: rows, page, pageSize, total });
  }),
);
