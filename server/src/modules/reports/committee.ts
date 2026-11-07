import { formatBDT } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { addMonths } from '../../lib/dates';
import { fontCss } from '../../pdf/fonts';
import { esc, monthLabel, strings, type Lang } from '../billing/receipt';
import { incomeExpenseReport } from '../expenses/expenses.service';
import { dashboard, duesReport, maintenanceReport } from './reports.service';

const TOP_DUES = 10;

/** FR-57: every figure comes from the same service as the matching report, so the two cannot disagree. */
export async function committeeData(month: string) {
  const start = new Date(`${month}-01T00:00:00+06:00`);
  const end = new Date(`${addMonths(month, 1)}-01T00:00:00+06:00`);
  const [overview, dues, money, maintenance, announcements] = await Promise.all([
    dashboard(month),
    duesReport(),
    incomeExpenseReport(month, month),
    maintenanceReport(month, month),
    prisma.announcement.count({ where: { recipientsResolvedAt: { not: null }, publishedAt: { gte: start, lt: end } } }),
  ]);
  return {
    month,
    building: overview.building,
    billing: overview.billing,
    trend: overview.trend,
    topDues: dues.units.slice(0, TOP_DUES),
    money,
    maintenance,
    announcements,
  };
}

type Data = Awaited<ReturnType<typeof committeeData>>;

/** Two bars a month on one scale, printed in solid dark and hatched light so it still reads in black and white. */
function trendSvg(trend: Data['trend'], lang: Lang): string {
  const W = 680;
  const H = 190;
  const base = 150;
  const top = 18;
  const max = Math.max(...trend.map((m) => m.billed), 1);
  const slot = W / trend.length;
  const bar = 30;
  const height = (v: number) => Math.round((v / max) * (base - top));
  const bars = trend
    .map((m, i) => {
      const x = i * slot + slot / 2 - bar - 1;
      const b = height(m.billed);
      const c = height(m.collected);
      const label = monthLabel(m.month, lang);
      return `<rect x="${x}" y="${base - b}" width="${bar}" height="${b}" fill="url(#hatch)" stroke="#111" stroke-width="1"/>
<rect x="${x + bar + 2}" y="${base - c}" width="${bar}" height="${c}" fill="#0b5546"/>
<text x="${i * slot + slot / 2}" y="${base + 16}" text-anchor="middle" font-size="10">${esc(label)}</text>
<text x="${i * slot + slot / 2}" y="${base + 31}" text-anchor="middle" font-size="11" font-weight="700">${m.rate === null ? '—' : `${m.rate}%`}</text>`;
    })
    .join('\n');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fff"/><line x1="0" y1="0" x2="0" y2="6" stroke="#555" stroke-width="1.5"/></pattern></defs>
<line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="#111"/>
${bars}</svg>`;
}

export function committeeHtml(d: Data, buildingName: string, lang: Lang): string {
  const all = strings[lang];
  const t = all.committee;
  const row = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
  const category = (c: string) => (all.expenses.categories as Record<string, string>)[c] ?? c;
  const m = d.maintenance;
  const resolved = m.byCategory.reduce((s, c) => s + c.resolved, 0);
  return `<!doctype html>
<html lang="${lang === 'BN' ? 'bn' : 'en'}"><head><meta charset="utf-8"><title>${esc(t.title)}</title>
<style>
${fontCss()}
*{box-sizing:border-box}
body{font-family:'Noto Sans','Noto Sans Bengali',sans-serif;color:#111;font-size:12.5px;line-height:1.45;margin:0}
.building{font-size:15px;font-weight:700}
h1{margin:0;font-size:23px;color:#0b5546}
.head{border-bottom:2px solid #0b5546;padding-bottom:10px;margin-bottom:12px}
h2{font-size:15px;color:#0b5546;margin:16px 0 5px;break-after:avoid}
section{break-inside:avoid}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #d5dedb;vertical-align:top}
th{font-weight:400;color:#40504a}
td{font-weight:700}
table:not(.list) th{width:70%}
table:not(.list) td{text-align:right}
.list th{font-weight:700;color:#111;border-bottom:1.5px solid #111}
.list td{font-weight:400}
.num{text-align:right}
.legend{display:flex;gap:18px;font-size:11px;margin:2px 0 6px}
.key{display:inline-block;width:12px;height:12px;margin-inline-end:5px;vertical-align:-1px;border:1px solid #111}
.dark{background:#0b5546}
.hatch{background:repeating-linear-gradient(45deg,#fff 0 2px,#555 2px 3px)}
.foot{margin-top:14px;font-size:10.5px;color:#40504a}
</style></head><body>
<div class="head"><div class="building">${esc(buildingName)}</div><h1>${esc(t.title)}</h1><div>${esc(monthLabel(d.month, lang))}</div></div>

<section><h2>${esc(t.occupancy)}</h2><table>
${row(t.totalUnits, String(d.building.totalUnits))}
${row(t.occupied, String(d.building.occupied))}
${row(t.vacant, String(d.building.vacant))}
</table></section>

<section><h2>${esc(t.billing)}</h2><table>
${row(t.billed, formatBDT(d.billing.billed))}
${row(t.collected, formatBDT(d.billing.collected))}
${row(t.rate, d.billing.rate === null ? t.noRate : `${d.billing.rate}%`)}
${row(t.outstanding, formatBDT(d.billing.outstanding))}
</table></section>

<section><h2>${esc(t.trend)}</h2>
<div class="legend"><span><span class="key hatch"></span>${esc(t.billed)}</span><span><span class="key dark"></span>${esc(t.collected)}</span></div>
${trendSvg(d.trend, lang)}</section>

<section><h2>${esc(t.topDues)}</h2>
${
  d.topDues.length === 0
    ? `<p>${esc(t.noDues)}</p>`
    : `<table class="list"><thead><tr><th>${esc(t.unit)}</th><th>${esc(t.contact)}</th><th class="num">${esc(t.owed)}</th></tr></thead><tbody>
${d.topDues.map((u) => `<tr><td>${esc(u.unit.unitNumber)}</td><td>${esc(u.contact?.name ?? '–')}</td><td class="num">${esc(formatBDT(u.owed))}</td></tr>`).join('\n')}
</tbody></table>`
}</section>

<section><h2>${esc(t.expenses)}</h2>
${
  d.money.byCategory.length === 0
    ? `<p>${esc(t.noExpenses)}</p>`
    : `<table class="list"><tbody>
${d.money.byCategory.map((c) => `<tr><td>${esc(category(c.category))}</td><td class="num">${esc(formatBDT(c.amount))}</td></tr>`).join('\n')}
</tbody></table>`
}
<table>
${row(t.income, formatBDT(d.money.income))}
${row(t.totalExpenses, formatBDT(d.money.expenses))}
${row(t.net, formatBDT(d.money.net))}
</table></section>

<section><h2>${esc(t.maintenance)}</h2><table>
${row(t.opened, String(m.total))}
${row(t.resolved, String(resolved))}
${row(t.overdue, String(m.overdue))}
${row(t.average, m.averageHours === null ? t.noAverage : t.hours.replace('{{hours}}', String(m.averageHours)))}
${row(t.rating, m.averageRating === null ? t.noRating : `${m.averageRating} / 5`)}
</table></section>

<section><h2>${esc(t.announcements)}</h2><table>${row(t.published, String(d.announcements))}</table></section>
<p class="foot">${esc(t.note)}</p>
</body></html>`;
}
