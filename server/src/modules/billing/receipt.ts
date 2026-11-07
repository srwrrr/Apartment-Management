import { formatBDT } from '@apt/shared';
import en from '@apt/shared/src/locales/en.json';
import bn from '@apt/shared/src/locales/bn.json';
import { fontCss } from '../../pdf/fonts';
import type { ReceiptData } from './payments.service';

export type Lang = 'EN' | 'BN';
export const strings = { EN: en, BN: bn };

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "November 2026" in the reader's language, with Western digits everywhere (BR-28). */
export function monthLabel(ym: string, lang: Lang): string {
  const date = new Date(`${ym}-01T00:00:00Z`);
  return new Intl.DateTimeFormat(lang === 'BN' ? 'bn-BD-u-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}
export function dateLabel(ymd: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'BN' ? 'bn-BD-u-nu-latn' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));
}

/**
 * The receipt as an HTML page, ready to be turned into PDF (FR-14, BR-14). A voided payment's receipt carries a VOID
 * mark and its reason. Every value is escaped, because names and references are typed by people.
 */
export function receiptHtml(r: ReceiptData, buildingName: string, lang: Lang): string {
  const t = strings[lang].receipt;
  const method = (strings[lang].paymentMethods as Record<string, string>)[r.method] ?? r.method;
  const forWhat = r.billKind === 'OPENING_BALANCE' ? strings[lang].billing.openingBalance : monthLabel(r.billMonth, lang);
  const row = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
  return `<!doctype html>
<html lang="${lang === 'BN' ? 'bn' : 'en'}"><head><meta charset="utf-8"><title>${esc(r.receiptNo)}</title>
<style>
${fontCss()}
*{box-sizing:border-box}
body{font-family:'Noto Sans','Noto Sans Bengali',sans-serif;color:#111;font-size:14px;line-height:1.5;margin:0}
.sheet{position:relative;border:2px solid #0b5546;border-radius:8px;padding:28px 32px}
h1{margin:0;font-size:24px;color:#0b5546}
.building{font-size:16px;font-weight:700;margin-bottom:2px}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0b5546;padding-bottom:14px;margin-bottom:18px}
.no{text-align:right;font-size:13px}.no strong{display:block;font-size:18px;letter-spacing:.5px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:9px 6px;border-bottom:1px solid #d5dedb;vertical-align:top}
th{width:38%;font-weight:400;color:#51605b}
td{font-weight:700}
.amount td{font-size:22px;color:#0b5546}
.foot{margin-top:26px;font-size:12px;color:#51605b;display:flex;justify-content:space-between}
.sign{margin-top:46px;display:flex;justify-content:flex-end}.sign div{border-top:1px solid #111;padding-top:4px;width:200px;text-align:center;font-size:12px}
.void{position:absolute;top:36%;left:8%;right:8%;text-align:center;font-size:96px;font-weight:700;color:rgba(179,38,30,.28);transform:rotate(-20deg);border:8px solid rgba(179,38,30,.28);border-radius:12px;padding:0 8px}
.voidnote{margin-top:14px;padding:10px 12px;background:#fdecea;border-left:4px solid #b3261e;font-weight:700;color:#b3261e}
</style></head><body><div class="sheet">
${r.voided ? `<div class="void">${esc(t.void)}</div>` : ''}
<div class="head"><div><div class="building">${esc(buildingName)}</div><h1>${esc(t.title)}</h1></div>
<div class="no">${esc(t.receiptNo)}<strong>${esc(r.receiptNo)}</strong></div></div>
<table>
${row(t.receivedFrom, r.residentName ?? '–')}
${row(t.unit, r.unitNumber)}
${row(t.billFor, forWhat)}
<tr class="amount"><th>${esc(t.amount)}</th><td>${esc(formatBDT(r.amount))}</td></tr>
${row(t.paymentDate, dateLabel(r.paidOn, lang))}
${row(t.method, method)}
${r.reference ? row(t.reference, r.reference) : ''}
${row(t.balanceAfter, formatBDT(r.balanceAfter))}
${row(t.recordedBy, r.recordedBy)}
</table>
${r.voided ? `<div class="voidnote">${esc(t.void)}${r.voidReason ? ` — ${esc(t.voidReason)}: ${esc(r.voidReason)}` : ''}</div>` : ''}
<div class="sign"><div>${esc(t.signature)}</div></div>
<div class="foot"><span>${esc(t.computerGenerated)}</span><span>${esc(buildingName)}</span></div>
</div></body></html>`;
}
