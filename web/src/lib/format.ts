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
