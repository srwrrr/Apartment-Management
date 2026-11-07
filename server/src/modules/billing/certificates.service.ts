import type { Prisma } from '@prisma/client';
import { hasPermission } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError, assertUuid, forbidden, notFound } from '../../lib/errors';
import { todayDhaka, ymdDhaka, ymdOf } from '../../lib/dates';
import { fontCss } from '../../pdf/fonts';
import type { AuthUser } from '../../types';
import { notify } from '../notifications/notify';
import { logActivity } from '../activity/activity';
import { dateLabel, esc, monthLabel, strings, type Lang } from './receipt';

type Db = Prisma.TransactionClient | typeof prisma;

const certificateNumber = (year: number, n: number) => `NDC-${year}-${String(n).padStart(5, '0')}`;

/** What a unit owes across all its bills, and the latest month that has been billed (BR-24). */
export async function unitDues(db: Db, unitId: string) {
  const [r] = await db.$queryRaw<{ balance: bigint; bills: number; latest: string | null }[]>`
    SELECT COALESCE(SUM(balance), 0)::bigint AS balance, COUNT(*)::int AS bills, MAX("billingMonth")::text AS latest
    FROM bill_summary WHERE "unitId" = ${unitId}::uuid`;
  return { balance: Number(r!.balance), bills: r!.bills, latest: r!.latest };
}

/**
 * FR-46, BR-24, inside the caller's transaction (the move-out wizard uses this too, so a failure here undoes the
 * whole move-out). The unit row is locked so two people cannot issue at the same moment; the number comes from a
 * yearly counter under the same transaction, so numbers never repeat or skip.
 */
export async function issueCertificateIn(tx: Prisma.TransactionClient, unitId: string, residentId: string, issuer: { id: string }) {
  await tx.$queryRaw`SELECT id FROM "units" WHERE id = ${unitId}::uuid FOR UPDATE`;
  const dues = await unitDues(tx, unitId);
  if (dues.balance !== 0) throw new ApiError(409, 'DUES_OUTSTANDING');
  // With nothing billed there is no month to vouch for, and the certificate would say nothing.
  if (!dues.latest) throw new ApiError(409, 'NOTHING_BILLED');

  const year = Number(todayDhaka().slice(0, 4));
  const [counter] = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "counters" (kind, year, value) VALUES ('NDC', ${year}::int, 1)
    ON CONFLICT (kind, year) DO UPDATE SET value = "counters".value + 1
    RETURNING value`;
  const cert = await tx.noDuesCertificate.create({
    data: { number: certificateNumber(year, counter!.value), unitId, issuedToId: residentId, coversThroughMonth: new Date(`${dues.latest}T00:00:00Z`), issuedById: issuer.id },
    select: { id: true, number: true, unit: { select: { unitNumber: true } } },
  });
  await notify(tx, [residentId], {
    type: 'CERTIFICATE_ISSUED',
    params: { unit: cert.unit.unitNumber, number: cert.number },
    link: '/statement',
    entityId: cert.id,
  });
  await logActivity(tx, 'certificate.issue', { entityType: 'unit', entityId: unitId, details: { unit: cert.unit.unitNumber, number: cert.number } });
  return { id: cert.id, number: cert.number };
}

export async function issueCertificate(unitId: string, residentId: string | undefined, issuer: { id: string }) {
  assertUuid(unitId);
  if (!(await prisma.unit.findUnique({ where: { id: unitId }, select: { id: true } }))) throw notFound();
  const bad = (code: string) => new ApiError(400, 'VALIDATION_FAILED', { residentId: { code } });
  let issuedTo = residentId;
  if (issuedTo) {
    // Only someone who has lived there (BR-24: "the resident it is issued to").
    const stayed = await prisma.occupancy.count({ where: { unitId, residentId: issuedTo } });
    if (stayed === 0) throw bad('INVALID_RESIDENT');
  } else {
    const contact = await prisma.occupancy.findFirst({ where: { unitId, isBillingContact: true, endDate: null }, select: { residentId: true } });
    if (!contact) throw bad('RESIDENT_REQUIRED');
    issuedTo = contact.residentId;
  }
  const resident = issuedTo;
  return prisma.$transaction((tx) => issueCertificateIn(tx, unitId, resident, issuer));
}

const shape = {
  id: true,
  number: true,
  coversThroughMonth: true,
  issuedAt: true,
  unit: { select: { id: true, unitNumber: true } },
  issuedTo: { select: { id: true, fullName: true } },
  issuedBy: { select: { fullName: true } },
} satisfies Prisma.NoDuesCertificateSelect;

type Row = Prisma.NoDuesCertificateGetPayload<{ select: typeof shape }>;
const toDto = (c: Row) => ({
  id: c.id,
  number: c.number,
  coversThroughMonth: ymdOf(c.coversThroughMonth).slice(0, 7),
  issuedAt: c.issuedAt,
  unit: c.unit,
  issuedTo: c.issuedTo,
  issuedBy: c.issuedBy.fullName,
});

/** FR-46: a unit's certificates, and whether another can be issued today. */
export async function listUnitCertificates(unitId: string) {
  assertUuid(unitId);
  if (!(await prisma.unit.findUnique({ where: { id: unitId }, select: { id: true } }))) throw notFound();
  const [rows, dues] = await Promise.all([
    prisma.noDuesCertificate.findMany({ where: { unitId }, orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }], select: shape }),
    unitDues(prisma, unitId),
  ]);
  return { items: rows.map(toDto), balance: dues.balance, canIssue: dues.balance === 0 && dues.bills > 0 };
}

export async function listMyCertificates(userId: string) {
  const rows = await prisma.noDuesCertificate.findMany({ where: { issuedToId: userId }, orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }], select: shape });
  return { items: rows.map(toDto) };
}

/** FR-46: is this number genuine? */
export async function lookupCertificate(number: string) {
  const c = await prisma.noDuesCertificate.findFirst({ where: { number: { equals: number, mode: 'insensitive' } }, select: shape });
  if (!c) throw notFound();
  return toDto(c);
}

/** The PDF is for administrators, billing.view, and the resident it was issued to. */
export async function getCertificateFor(id: string, user: AuthUser) {
  assertUuid(id);
  const c = await prisma.noDuesCertificate.findUnique({ where: { id }, select: shape });
  if (!c) throw notFound();
  if (hasPermission(user, 'billing.view') || c.issuedTo.id === user.id) return toDto(c);
  if (user.role === 'RESIDENT') throw notFound(); // never confirm that someone else's certificate exists
  throw forbidden();
}

export function certificateHtml(c: ReturnType<typeof toDto>, buildingName: string, lang: Lang): string {
  const t = strings[lang].certificate;
  const issued = ymdDhaka(c.issuedAt); // the day in Dhaka, not in UTC
  const row = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
  return `<!doctype html>
<html lang="${lang === 'BN' ? 'bn' : 'en'}"><head><meta charset="utf-8"><title>${esc(c.number)}</title>
<style>
${fontCss()}
*{box-sizing:border-box}
body{font-family:'Noto Sans','Noto Sans Bengali',sans-serif;color:#111;font-size:14px;line-height:1.6;margin:0}
.sheet{border:2px solid #0b5546;border-radius:8px;padding:32px 36px}
.building{font-size:18px;font-weight:700;text-align:center}
h1{margin:4px 0 2px;font-size:26px;color:#0b5546;text-align:center}
.no{text-align:center;font-size:13px;margin-bottom:22px}.no strong{letter-spacing:.5px}
.statement{font-size:15px;margin-bottom:18px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #d5dedb}
th{width:40%;font-weight:400;color:#51605b}
td{font-weight:700}
.limit{margin-top:14px;font-size:12px;color:#51605b}
.sign{margin-top:64px;display:flex;justify-content:space-between;gap:32px}
.sign div{flex:1;border-top:1px solid #111;padding-top:4px;text-align:center;font-size:12px}
.foot{margin-top:24px;font-size:11px;color:#51605b}
</style></head><body><div class="sheet">
<div class="building">${esc(buildingName)}</div>
<h1>${esc(t.title)}</h1>
<div class="no">${esc(t.number)}: <strong>${esc(c.number)}</strong></div>
<p class="statement">${esc(t.body)}</p>
<table>
${row(t.unit, c.unit.unitNumber)}
${row(t.resident, c.issuedTo.fullName)}
${row(t.coversThrough, monthLabel(c.coversThroughMonth, lang))}
${row(t.issuedOn, dateLabel(issued, lang))}
${row(t.issuedBy, c.issuedBy)}
</table>
<p class="limit">${esc(t.limit)}</p>
<div class="sign"><div>${esc(t.signature)}</div><div>${esc(t.seal)}</div></div>
<div class="foot">${esc(strings[lang].receipt.computerGenerated)}</div>
</div></body></html>`;
}
