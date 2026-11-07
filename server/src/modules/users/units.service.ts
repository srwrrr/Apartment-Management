import { Prisma, type Unit } from '@prisma/client';
import { z } from 'zod';
import { unitInputSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, notFound } from '../../lib/errors';
import { dateOnly, todayDhaka } from '../../lib/dates';

export const createUnitSchema = unitInputSchema;
export const updateUnitSchema = unitInputSchema.partial().extend({ isAvailable: z.boolean().optional() });
export const listUnitsSchema = z.object({
  q: z.string().trim().max(20).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type UnitStatus = 'OCCUPIED' | 'VACANT' | 'UNAVAILABLE';

/** BR-05: Occupied/Vacant is calculated from occupancy records, never typed in. */
function withStatus(unit: Unit, activeOccupancies: number) {
  const status: UnitStatus = activeOccupancies > 0 ? 'OCCUPIED' : unit.isAvailable ? 'VACANT' : 'UNAVAILABLE';
  return { ...unit, status, activeOccupancies };
}

/** The end date is the day they left, so a stay ending today no longer counts: the unit shows Vacant at once (BR-05, FR-56). */
export const activeOccupancyWhere = (): Prisma.OccupancyWhereInput => {
  const today = dateOnly(todayDhaka());
  return { startDate: { lte: today }, OR: [{ endDate: null }, { endDate: { gt: today } }] };
};

function mapUniqueError(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new ApiError(409, 'CONFLICT', { unitNumber: { code: 'UNIT_NUMBER_TAKEN' } }); // BR-04
  }
  throw e;
}

export async function listUnits(input: z.infer<typeof listUnitsSchema>) {
  const where: Prisma.UnitWhereInput = input.q
    ? { unitNumber: { contains: input.q, mode: 'insensitive' } }
    : {};
  const [total, units] = await Promise.all([
    prisma.unit.count({ where }),
    prisma.unit.findMany({
      where,
      orderBy: [{ floor: 'asc' }, { unitNumber: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: { _count: { select: { occupancies: { where: activeOccupancyWhere() } } } },
    }),
  ]);
  return {
    items: units.map(({ _count, ...u }) => withStatus(u, _count.occupancies)),
    page: input.page,
    pageSize: input.pageSize,
    total,
  };
}

export async function getUnit(id: string) {
  const unit = await prisma.unit
    .findUnique({
      where: { id },
      include: { _count: { select: { occupancies: { where: activeOccupancyWhere() } } } },
    })
    .catch(() => null); // malformed UUID -> not found
  if (!unit) throw notFound();
  const { _count, ...u } = unit;
  return withStatus(u, _count.occupancies);
}

export async function createUnit(input: z.infer<typeof createUnitSchema>) {
  try {
    const unit = await prisma.unit.create({ data: input });
    return withStatus(unit, 0);
  } catch (e) {
    return mapUniqueError(e);
  }
}

export async function updateUnit(id: string, input: z.infer<typeof updateUnitSchema>) {
  await getUnit(id); // 404 if missing
  try {
    await prisma.unit.update({ where: { id }, data: input });
  } catch (e) {
    mapUniqueError(e);
  }
  return getUnit(id);
}
