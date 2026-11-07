// "Today" always means today in Asia/Dhaka (UTC+6), not the server's local time.
const dhaka = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' });

/** 'YYYY-MM-DD' for today in Dhaka. */
export const todayDhaka = (): string => dhaka.format(new Date());

/** A date-only value as a UTC-midnight Date, suitable for Prisma @db.Date filters. */
export const dateOnly = (ymd: string): Date => new Date(`${ymd}T00:00:00Z`);

/** 'YYYY-MM-DD' for a date-only value read from the database (stored as midnight UTC). */
export const ymdOf = (d: Date): string => d.toISOString().slice(0, 10);

/** 'YYYY-MM' of today in Dhaka. */
export const currentMonthDhaka = (): string => todayDhaka().slice(0, 7);

/** The month after / before a 'YYYY-MM'. */
export function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** First and last day of a 'YYYY-MM', as date-only values. */
export function monthRange(ym: string): { start: Date; end: Date } {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 0)) };
}
