// Money is stored as integer poisha (1 BDT = 100 poisha). See SRS BR-15.

const fmt = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 1250000 -> "৳ 12,500.00"; 12500000 -> "৳ 1,25,000.00" (lakh grouping). */
export function formatBDT(poisha: number): string {
  if (!Number.isInteger(poisha)) throw new Error('poisha must be an integer');
  const sign = poisha < 0 ? '-' : '';
  return `${sign}৳ ${fmt.format(Math.abs(poisha) / 100)}`;
}

/** Parse a user-typed taka amount ("12,500.5") to poisha. Returns null if invalid. */
export function parseTaka(input: string): number | null {
  const s = input.replace(/[,\s৳]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
