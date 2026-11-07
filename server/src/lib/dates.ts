// "Today" always means today in Asia/Dhaka (UTC+6), not the server's local time.
const dhaka = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' });

/** 'YYYY-MM-DD' for today in Dhaka. */
export const todayDhaka = (): string => dhaka.format(new Date());

/** A date-only value as a UTC-midnight Date, suitable for Prisma @db.Date filters. */
export const dateOnly = (ymd: string): Date => new Date(`${ymd}T00:00:00Z`);
