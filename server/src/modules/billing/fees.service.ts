import type { Prisma, UnitFee } from '@prisma/client';
import { z } from 'zod';
import { feeListSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { assertUuid, notFound } from '../../lib/errors';

type FeeInput = z.infer<typeof feeListSchema>['fees'];
const dto = (f: UnitFee) => ({ chargeType: f.chargeType, amount: f.amount, description: f.description });
const order = { chargeType: 'asc' } as const; // enum order: service, rent, water, gas, electricity

/** FR-32: the building-wide defaults, and which units override them. */
export async function getFees() {
  const [defaults, overrides] = await Promise.all([
    prisma.unitFee.findMany({ where: { unitId: null }, orderBy: order }),
    prisma.unitFee.findMany({
      where: { unitId: { not: null } },
      orderBy: [{ unit: { floor: 'asc' } }, { unit: { unitNumber: 'asc' } }, order],
      include: { unit: { select: { id: true, unitNumber: true } } },
    }),
  ]);
  const units = new Map<string, { unitId: string; unitNumber: string; fees: ReturnType<typeof dto>[] }>();
  for (const o of overrides) {
    const entry = units.get(o.unitId!) ?? { unitId: o.unitId!, unitNumber: o.unit!.unitNumber, fees: [] };
    entry.fees.push(dto(o));
    units.set(o.unitId!, entry);
  }
  return { defaults: defaults.map(dto), units: [...units.values()] };
}

export async function getUnitFees(unitId: string) {
  assertUuid(unitId);
  if (!(await prisma.unit.findUnique({ where: { id: unitId }, select: { id: true } }))) throw notFound();
  const fees = await prisma.unitFee.findMany({ where: { unitId }, orderBy: order });
  return { fees: fees.map(dto) };
}

/** Replaces the whole list. Only bills generated afterwards are affected, never existing ones. */
async function replace(unitId: string | null, fees: FeeInput, tx: Prisma.TransactionClient) {
  await tx.unitFee.deleteMany({ where: { unitId } });
  if (fees.length) await tx.unitFee.createMany({ data: fees.map((f) => ({ ...f, unitId })) });
}

export async function setDefaultFees(fees: FeeInput) {
  await prisma.$transaction((tx) => replace(null, fees, tx));
  return getFees();
}

export async function setUnitFees(unitId: string, fees: FeeInput) {
  await getUnitFees(unitId); // 404 if the unit is unknown
  await prisma.$transaction((tx) => replace(unitId, fees, tx));
  return getUnitFees(unitId);
}
