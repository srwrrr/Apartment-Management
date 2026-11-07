import { currentLang } from './i18n';

/** "07 Nov 2026" / "০৭ নভেম্বর…" is avoided on purpose: Western digits everywhere (BR-28). */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const locale = currentLang() === 'bn' ? 'bn-BD-u-nu-latn' : 'en-GB';
  // Date-only values arrive as midnight UTC, so format in UTC to avoid showing the day before.
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** <input type="date"> value (YYYY-MM-DD) for today in Dhaka. */
export function todayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
}

/** True for an ISO date-time whose date part is today or earlier (a stay that has started). */
export const ymd = (value: string) => value.slice(0, 10);

/** "November 2026" for a 'YYYY-MM' or 'YYYY-MM-DD', in the reader's language, with Western digits (BR-28). */
export function monthLabel(value: string): string {
  const ym = value.slice(0, 7);
  const date = new Date(`${ym}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  const locale = currentLang() === 'bn' ? 'bn-BD-u-nu-latn' : 'en-GB';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** 'YYYY-MM' for this month in Dhaka, for <input type="month">. */
export const thisMonth = (): string => todayYmd().slice(0, 7);

/** "07 Nov 2026, 14:30" in Dhaka time, with Western digits (BR-28). */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const locale = currentLang() === 'bn' ? 'bn-BD-u-nu-latn' : 'en-GB';
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dhaka' }).format(date);
}

/** Poisha as a plain taka string for an input box: 300000 -> "3000", 250050 -> "2500.50". */
export function takaString(poisha: number): string {
  const s = (poisha / 100).toFixed(2);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}
