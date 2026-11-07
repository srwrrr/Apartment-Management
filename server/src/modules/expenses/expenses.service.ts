import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { expenseCreateSchema, expenseListQuerySchema, expenseUpdateSchema, expenseVoidSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, notFound } from '../../lib/errors';
import { currentMonthDhaka, dateOnly, monthRange, todayDhaka, ymdOf } from '../../lib/dates';
import { removeStored, storeDocument } from '../../lib/files';
import { getSettings } from '../settings/settings.service';
import { changes, logActivity } from '../activity/activity';

const include = {
  receipt: { select: { id: true } },
  recordedBy: { select: { fullName: true } },
  voidedBy: { select: { fullName: true } },
} satisfies Prisma.ExpenseInclude;

type Row = Prisma.ExpenseGetPayload<{ include: typeof include }>;
const toDto = (e: Row) => ({
  id: e.id,
  spentOn: ymdOf(e.spentOn),
  category: e.category,
  amount: e.amount,
  payee: e.payee,
  description: e.description,
  receiptId: e.receipt?.id ?? null,
  recordedBy: e.recordedBy.fullName,
  voided: e.voidedAt !== null,
  voidedAt: e.voidedAt,
  voidedBy: e.voidedBy?.fullName ?? null,
  voidReason: e.voidReason,
});

const noFutureDate = (ymd: string | undefined) => {
  if (ymd && ymd > todayDhaka()) throw new ApiError(400, 'VALIDATION_FAILED', { spentOn: { code: 'SPENT_ON_FUTURE' } });
};

/** FR-43. The total leaves out voided expenses, like every other figure (BR-23). */
export async function listExpenses(query: z.infer<typeof expenseListQuerySchema>) {
  const range = query.month ? monthRange(query.month) : null;
  const where: Prisma.ExpenseWhereInput = {
    ...(query.category && { category: query.category }),
    ...(range && { spentOn: { gte: range.start, lte: range.end } }), // monthRange ends on the last day
  };
  const [total, sum, rows] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where: { ...where, voidedAt: null }, _sum: { amount: true } }),
    prisma.expense.findMany({
      where,
      orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include,
    }),
  ]);
  return { items: rows.map(toDto), page: query.page, pageSize: query.pageSize, total, totalAmount: sum._sum.amount ?? 0 };
}

export async function createExpense(input: z.infer<typeof expenseCreateSchema>, file: Express.Multer.File | undefined, actor: { id: string }) {
  noFutureDate(input.spentOn);
  const stored = await storeDocument(file, 'receipt');
  try {
    const row = await prisma.$transaction(async (tx) => {
      const e = await tx.expense.create({
        data: { spentOn: dateOnly(input.spentOn), category: input.category, amount: input.amount, payee: input.payee, description: input.description ?? null, recordedById: actor.id },
        select: { id: true },
      });
      if (stored[0]) await tx.attachment.create({ data: { ...stored[0], uploadedById: actor.id, expenseId: e.id } });
      await logActivity(tx, 'expense.create', { entityType: 'expense', entityId: e.id, details: { category: input.category, amount: input.amount, payee: input.payee } });
      return tx.expense.findUniqueOrThrow({ where: { id: e.id }, include });
    });
    return toDto(row);
  } catch (e) {
    await removeStored(stored.map((s) => s.storedName));
    throw e;
  }
}

/** FR-43: details can be corrected, and a new receipt replaces the old one. A voided expense stays as it was. */
export async function updateExpense(id: string, input: z.infer<typeof expenseUpdateSchema>, file: Express.Multer.File | undefined, actor: { id: string }) {
  assertUuid(id);
  noFutureDate(input.spentOn);
  const stored = await storeDocument(file, 'receipt');
  let replaced: string | null = null;
  try {
    const row = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ voidedAt: Date | null }[]>`SELECT "voidedAt" FROM "expenses" WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw notFound();
      if (locked[0]!.voidedAt) throw new ApiError(409, 'EXPENSE_VOIDED');
      const before = await tx.expense.findUniqueOrThrow({ where: { id } });
      await tx.expense.update({
        where: { id },
        data: {
          ...(input.spentOn !== undefined && { spentOn: dateOnly(input.spentOn) }),
          ...(input.category !== undefined && { category: input.category }),
          ...(input.amount !== undefined && { amount: input.amount }),
          ...(input.payee !== undefined && { payee: input.payee }),
          ...(input.description !== undefined && { description: input.description || null }),
        },
      });
      if (stored[0]) {
        const old = await tx.attachment.findUnique({ where: { expenseId: id } });
        if (old) {
          await tx.attachment.delete({ where: { id: old.id } });
          replaced = old.storedName;
        }
        await tx.attachment.create({ data: { ...stored[0], uploadedById: actor.id, expenseId: id } });
      }
      const { spentOn: _d, ...plain } = input;
      await logActivity(tx, 'expense.update', {
        entityType: 'expense',
        entityId: id,
        details: { payee: before.payee, changes: changes(before, plain), receiptReplaced: !!stored[0], ...(input.spentOn && { spentOn: input.spentOn }) },
      });
      return tx.expense.findUniqueOrThrow({ where: { id }, include });
    });
    if (replaced) await removeStored([replaced]);
    return toDto(row);
  } catch (e) {
    await removeStored(stored.map((s) => s.storedName));
    throw e;
  }
}

/** BR-23: expenses are never deleted. */
export async function voidExpense(id: string, input: z.infer<typeof expenseVoidSchema>, actor: { id: string }) {
  assertUuid(id);
  const row = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ voidedAt: Date | null }[]>`SELECT "voidedAt" FROM "expenses" WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound();
    if (locked[0]!.voidedAt) throw new ApiError(409, 'EXPENSE_VOIDED');
    const voided = await tx.expense.update({ where: { id }, data: { voidedAt: new Date(), voidedById: actor.id, voidReason: input.reason }, include });
    await logActivity(tx, 'expense.void', { entityType: 'expense', entityId: id, details: { amount: voided.amount, payee: voided.payee, reason: input.reason } });
    return voided;
  });
  return toDto(row);
}

// ------------------------------------------------------------------ reports

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** Expenses by category for a period of months, leaving out voided ones. */
async function byCategory(firstDay: string, lastMonthFirstDay: string) {
  const rows = await prisma.$queryRaw<{ category: string; amount: bigint }[]>`
    SELECT category::text AS category, SUM(amount)::bigint AS amount
    FROM "expenses"
    WHERE "voidedAt" IS NULL AND "spentOn" >= ${firstDay}::date AND "spentOn" < (${lastMonthFirstDay}::date + interval '1 month')
    GROUP BY category ORDER BY category`;
  return rows.map((r) => ({ category: r.category, amount: num(r.amount) }));
}

/**
 * FR-44, on a cash basis: money actually received (valid payments, by the day paid) against money actually spent
 * (expenses that are not voided, by the day spent). This differs from "collected" in FR-15, which follows the
 * billing month of each bill.
 */
export async function incomeExpenseReport(from: string, to: string) {
  const first = `${from}-01`;
  const last = `${to}-01`;
  const [income, spent, categories] = await Promise.all([
    prisma.$queryRaw<{ month: string; amount: bigint }[]>`
      SELECT to_char("paidOn", 'YYYY-MM') AS month, SUM(amount)::bigint AS amount FROM "payments"
      WHERE "voidedAt" IS NULL AND "paidOn" >= ${first}::date AND "paidOn" < (${last}::date + interval '1 month')
      GROUP BY 1`,
    prisma.$queryRaw<{ month: string; amount: bigint }[]>`
      SELECT to_char("spentOn", 'YYYY-MM') AS month, SUM(amount)::bigint AS amount FROM "expenses"
      WHERE "voidedAt" IS NULL AND "spentOn" >= ${first}::date AND "spentOn" < (${last}::date + interval '1 month')
      GROUP BY 1`,
    byCategory(first, last),
  ]);
  const inc = new Map(income.map((r) => [r.month, num(r.amount)]));
  const out = new Map(spent.map((r) => [r.month, num(r.amount)]));
  const months: { month: string; income: number; expenses: number; net: number }[] = [];
  for (let d = new Date(`${first}T00:00:00Z`); ymdOf(d) <= last; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const month = ymdOf(d).slice(0, 7);
    const i = inc.get(month) ?? 0;
    const e = out.get(month) ?? 0;
    months.push({ month, income: i, expenses: e, net: i - e });
  }
  const totalIncome = months.reduce((s, m) => s + m.income, 0);
  const totalExpenses = months.reduce((s, m) => s + m.expenses, 0);
  return { from, to, income: totalIncome, expenses: totalExpenses, net: totalIncome - totalExpenses, months, byCategory: categories };
}

/** FR-44: what residents may see, only when the administrator has turned it on. Category totals, nothing else. */
export async function buildingSummary(month: string = currentMonthDhaka()) {
  if (!(await getSettings()).shareExpenseSummary) throw notFound();
  const categories = await byCategory(`${month}-01`, `${month}-01`);
  return { month, total: categories.reduce((s, c) => s + c.amount, 0), byCategory: categories };
}
