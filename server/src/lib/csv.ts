import type { Response } from 'express';

type Cell = string | number | null | undefined;

/** Poisha as plain taka for a spreadsheet, so the column can be added up. */
export const taka = (poisha: number) => Number((poisha / 100).toFixed(2));

function cell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  // A typed value starting like a formula would run when the file is opened, so it is marked as text.
  // Phone numbers start with "+", but cannot be formulas.
  const safe = /^[=+\-@\t\r]/.test(v) && !/^\+?\d+$/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** FR-38: the byte order mark makes Excel read Bangla correctly. */
export function toCsv(headers: string[], rows: Cell[][]): string {
  return `\uFEFF${[headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

export function sendCsv(res: Response, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(csv);
}
