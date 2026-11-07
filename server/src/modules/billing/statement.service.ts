import { Prisma } from '@prisma/client';
import { formatBDT } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { assertUuid, notFound } from '../../lib/errors';
import { fontCss } from '../../pdf/fonts';
import { dateLabel, esc, monthLabel, strings, type Lang } from './receipt';

export interface StatementRow {
  date: string;
  kind: 'BILL' | 'PAYMENT';
  billId: string;
  billKind: 'REGULAR' | 'OPENING_BALANCE';
  billingMonth: string;
  paymentId: string | null;
  receiptNo: string | null;
  method: string | null;
  charged: number;
  paid: number;
  balance: number;
}

export interface Statement {
  unit: { id: string; unitNumber: string; floor: number };
  from: string;
  to: string;
  opening: number;
  totalCharged: number;
  totalPaid: number;
  closing: number;
  rows: StatementRow[];
}

/**
 * FR-45: every bill and valid payment of a unit in date order, with a running balance.
 * `viewerId` limits it to the bills that resident may see (BR-08); without it, every bill of the unit.
 *
 * A bill is dated by its billing month, or by the day it was created if that is earlier: a bill generated ahead for
 * next month is already owed, so a statement "up to today" still ends on the outstanding balance (FR-13).
 */
export async function getStatement(unitId: string, from: string, to: string, viewerId?: string): Promise<Statement> {
  assertUuid(unitId);
  const unit = await prisma.unit.findUnique({ where: { id: unitId }, select: { id: true, unitNumber: true, floor: true } });
  if (!unit) throw notFound();

  const visible = viewerId ? Prisma.sql`AND EXISTS (SELECT 1 FROM bill_access ba WHERE ba."userId" = ${viewerId}::uuid AND ba."billId" = b.id)` : Prisma.empty;
  const bills = await prisma.$queryRaw<{ id: string; kind: 'REGULAR' | 'OPENING_BALANCE'; month: string; date: string; total: bigint }[]>`
    SELECT b.id::text AS id, b.kind::text AS kind, to_char(b."billingMonth", 'YYYY-MM') AS month,
           LEAST(b."billingMonth", (b."createdAt" AT TIME ZONE 'Asia/Dhaka')::date)::text AS date, s.total
    FROM "bills" b JOIN bill_summary s ON s."billId" = b.id
    WHERE b."unitId" = ${unitId}::uuid ${visible}`;
  if (viewerId && bills.length === 0) throw notFound(); // nothing here is theirs: the same answer as a unit that does not exist

  const payments = await prisma.$queryRaw<{ id: string; billId: string; date: string; amount: number; receiptNo: string; method: string; seq: Date }[]>`
    SELECT p.id::text AS id, p."billId"::text AS "billId", p."paidOn"::text AS date, p.amount, p."receiptNo", p.method::text AS method, p."createdAt" AS seq
    FROM "payments" p JOIN "bills" b ON b.id = p."billId"
    WHERE b."unitId" = ${unitId}::uuid AND p."voidedAt" IS NULL ${visible}`;

  const byId = new Map(bills.map((b) => [b.id, b]));
  const entries = [
    ...bills.map((b) => ({
      date: b.date,
      order: 0, // on the same day a bill comes before the payment against it
      tie: b.month + b.id,
      kind: 'BILL' as const,
      billId: b.id,
      billKind: b.kind,
      billingMonth: b.month,
      paymentId: null,
      receiptNo: null,
      method: null,
      charged: Number(b.total),
      paid: 0,
    })),
    ...payments.map((p) => ({
      date: p.date,
      order: 1,
      tie: p.seq.toISOString() + p.id,
      kind: 'PAYMENT' as const,
      billId: p.billId,
      billKind: byId.get(p.billId)!.kind,
      billingMonth: byId.get(p.billId)!.month,
      paymentId: p.id,
      receiptNo: p.receiptNo,
      method: p.method,
      charged: 0,
      paid: p.amount,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.tie.localeCompare(b.tie));

  const opening = entries.filter((e) => e.date < from).reduce((s, e) => s + e.charged - e.paid, 0);
  let balance = opening;
  const rows: StatementRow[] = [];
  for (const { order: _o, tie: _t, ...e } of entries) {
    if (e.date < from || e.date > to) continue;
    balance += e.charged - e.paid;
    rows.push({ ...e, balance });
  }
  return {
    unit,
    from,
    to,
    opening,
    totalCharged: rows.reduce((s, r) => s + r.charged, 0),
    totalPaid: rows.reduce((s, r) => s + r.paid, 0),
    closing: balance,
    rows,
  };
}

/** The units a resident can ask for a statement of: those with a bill they may see. */
export async function myStatementUnits(userId: string) {
  return prisma.$queryRaw<{ id: string; unitNumber: string }[]>`
    SELECT DISTINCT u.id::text AS id, u."unitNumber"
    FROM bill_access ba JOIN "bills" b ON b.id = ba."billId" JOIN "units" u ON u.id = b."unitId"
    WHERE ba."userId" = ${userId}::uuid
    ORDER BY u."unitNumber"`;
}

/** The statement as an HTML page for the PDF renderer. Every value is escaped. */
export function statementHtml(s: Statement, buildingName: string, lang: Lang): string {
  const all = strings[lang];
  const t = all.statement;
  const money = (n: number) => (n === 0 ? '' : esc(formatBDT(n)));
  const describe = (r: Statement['rows'][number]) => {
    const what = r.billKind === 'OPENING_BALANCE' ? all.billing.openingBalance : monthLabel(r.billingMonth, lang);
    if (r.kind === 'BILL') return `${esc(t.bill)}: ${esc(what)}`;
    const method = (all.paymentMethods as Record<string, string>)[r.method!] ?? r.method!;
    return `${esc(t.payment)}: ${esc(what)} · ${esc(method)} · ${esc(r.receiptNo!)}`;
  };
  return `<!doctype html>
<html lang="${lang === 'BN' ? 'bn' : 'en'}"><head><meta charset="utf-8"><title>${esc(t.title)}</title>
<style>
${fontCss()}
*{box-sizing:border-box}
body{font-family:'Noto Sans','Noto Sans Bengali',sans-serif;color:#111;font-size:12px;line-height:1.45;margin:0}
.building{font-size:16px;font-weight:700}
h1{margin:0;font-size:22px;color:#0b5546}
.head{border-bottom:2px solid #0b5546;padding-bottom:10px;margin-bottom:12px}
.meta{display:flex;justify-content:space-between;margin-bottom:12px;font-size:13px}
table{width:100%;border-collapse:collapse}
th,td{padding:6px;border-bottom:1px solid #d5dedb;text-align:left;vertical-align:top}
thead{display:table-header-group}
tr{page-break-inside:avoid}
th{color:#51605b;font-weight:400}
.n{text-align:right;white-space:nowrap}
.sum td{font-weight:700;background:#eef5f3}
.foot{margin-top:18px;font-size:11px;color:#51605b}
</style></head><body>
<div class="head"><div class="building">${esc(buildingName)}</div><h1>${esc(t.title)}</h1></div>
<div class="meta"><span>${esc(t.unit)}: <strong>${esc(s.unit.unitNumber)}</strong></span><span>${esc(dateLabel(s.from, lang))} – ${esc(dateLabel(s.to, lang))}</span></div>
<table>
<thead><tr><th>${esc(t.date)}</th><th>${esc(t.description)}</th><th class="n">${esc(t.charged)}</th><th class="n">${esc(t.paid)}</th><th class="n">${esc(t.balance)}</th></tr></thead>
<tbody>
<tr class="sum"><td colspan="4">${esc(t.opening)}</td><td class="n">${esc(formatBDT(s.opening))}</td></tr>
${s.rows
  .map((r) => `<tr><td>${esc(dateLabel(r.date, lang))}</td><td>${describe(r)}</td><td class="n">${money(r.charged)}</td><td class="n">${money(r.paid)}</td><td class="n">${esc(formatBDT(r.balance))}</td></tr>`)
  .join('\n')}
<tr class="sum"><td colspan="2">${esc(t.closing)}</td><td class="n">${esc(formatBDT(s.totalCharged))}</td><td class="n">${esc(formatBDT(s.totalPaid))}</td><td class="n">${esc(formatBDT(s.closing))}</td></tr>
</tbody></table>
<div class="foot">${esc(all.receipt.computerGenerated)}</div>
</body></html>`;
}
