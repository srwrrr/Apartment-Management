// Money is stored as integer poisha (1 BDT = 100 poisha). See SRS BR-15.

const fmt = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats an amount of money for people to read, in Bangladeshi taka with lakh grouping.
 *
 * Money is always stored and passed around as whole poisha (1 taka = 100 poisha), so there
 * are no floating-point rounding errors (SRS BR-15). Only this function turns it into text.
 *
 * @param poisha - The amount in poisha. Must be a whole number; negative amounts get a leading minus.
 * @returns The amount as `৳` followed by taka with two decimals and lakh grouping.
 * @throws Error if `poisha` is not an integer (for example `12.5`).
 *
 * @example
 * ```ts
 * formatBDT(1250000);  // "৳ 12,500.00"
 * formatBDT(12500000); // "৳ 1,25,000.00"
 * formatBDT(-5000);    // "-৳ 50.00"
 * ```
 */
export function formatBDT(poisha: number): string {
  if (!Number.isInteger(poisha)) throw new Error('poisha must be an integer');
  const sign = poisha < 0 ? '-' : '';
  return `${sign}৳ ${fmt.format(Math.abs(poisha) / 100)}`;
}

/**
 * Reads an amount of taka that a person typed into a form, and converts it to poisha.
 *
 * Commas, spaces and the `৳` sign are ignored, so people can type the amount the way they write it.
 * At most two decimal places are accepted, because a poisha is the smallest unit.
 *
 * @param input - What the person typed, for example `"12,500.5"` or `"৳ 3000"`.
 * @returns The amount in whole poisha, or `null` if the text is not a valid non-negative amount.
 *
 * @example
 * ```ts
 * parseTaka('12,500.5'); // 1250050
 * parseTaka('৳ 3000');   // 300000
 * parseTaka('12.345');   // null (more than two decimals)
 * parseTaka('-5');       // null (negative)
 * ```
 *
 * @see {@link formatBDT} for turning poisha back into text.
 */
export function parseTaka(input: string): number | null {
  const s = input.replace(/[,\s৳]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
